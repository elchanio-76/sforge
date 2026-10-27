import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { type AzureTargetConfig, ErrorCode, SforgeError } from '@staticforge/core';
import {
  type IacBackend,
  type IacProfile,
  type IacSpec,
  type PreparedTarget,
  type ProfileInput,
  githubSubjectPrefix,
  iacRef,
  prepareDns,
  projectName,
  withDns,
} from '@staticforge/iac';
import { type CnameLookup, waitForCname, waitForRecord } from './cname.js';
import { type AzureClients, azureError, defaultClients, httpStatus } from './clients.js';

/** Packaged HCL, next to src/ and dist/. */
const terraformDir = (path: string) =>
  fileURLToPath(new URL(`../terraform/${path}`, import.meta.url));

export const SITE_MODULE_DIR = terraformDir('modules/site');
export const CI_MODULE_DIR = terraformDir('modules/ci-oidc');
export const STATE_BOOTSTRAP_DIR = terraformDir('state-bootstrap');

type CiConfig = NonNullable<AzureTargetConfig['ci']>;

const AZURERM_PROVIDER = { source: 'hashicorp/azurerm', version: '>= 4.0, < 5.0' };
const AZUREAD_PROVIDER = { source: 'hashicorp/azuread', version: '>= 3.0, < 4.0' };
const TIME_PROVIDER = { source: 'hashicorp/time', version: '>= 0.12, < 1.0' };

/** Where Azure offers Static Web Apps. */
export const SWA_LOCATIONS = ['westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia'];

const MANAGEMENT_SCOPE = 'https://management.azure.com/.default';

export interface StateLocation {
  subscriptionId: string;
  resourceGroup: string;
  storageAccount: string;
  container: string;
  key: string;
}

/** `sfstate<hash of the subscription>` in resource group `sforge-state`, key `<site>/<target>.tfstate`. */
export function stateLocation(
  target: AzureTargetConfig,
  subscriptionId: string,
  project: string,
  targetName: string,
): StateLocation {
  return {
    subscriptionId,
    resourceGroup: target.state.resourceGroup ?? 'sforge-state',
    storageAccount:
      target.state.storageAccount ??
      `sfstate${createHash('sha256').update(subscriptionId.toLowerCase()).digest('hex').slice(0, 12)}`,
    container: target.state.container,
    key: `${project}/${targetName}.tfstate`,
  };
}

/** Blob that holds a target's deploy history, in the state container. */
export const historyBlobName = (project: string, targetName: string): string =>
  `_sforge/${project}/${targetName}/versions.json`;

/**
 * `targets.<n>.subscriptionId`, else AZURE_SUBSCRIPTION_ID / ARM_SUBSCRIPTION_ID,
 * else the subscription `az login` selected.
 */
export async function resolveSubscription(
  clients: AzureClients,
  target: AzureTargetConfig,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const id =
    target.subscriptionId ??
    env.AZURE_SUBSCRIPTION_ID ??
    env.ARM_SUBSCRIPTION_ID ??
    (await clients.az(['account', 'show', '--query', 'id', '-o', 'tsv']));
  if (id === undefined || id === '') {
    throw new SforgeError(ErrorCode.CloudAuth, 'Could not tell which Azure subscription to use', {
      hint: 'Run `az login`, or set targets.<name>.subscriptionId or AZURE_SUBSCRIPTION_ID.',
    });
  }
  return id;
}

/** Fail early, with a useful message, when no credential works. */
export async function assertSignedIn(clients: AzureClients): Promise<void> {
  try {
    await clients.credential().getToken(MANAGEMENT_SCOPE);
  } catch (error) {
    throw azureError(error, 'Could not sign in to Azure', ErrorCode.CloudAuth);
  }
}

const NOT_FOUND = new Set(['ResourceNotFound', 'ResourceGroupNotFound', 'ContainerNotFound']);

const isNotFound = (error: unknown): boolean =>
  httpStatus(error) === 404 || NOT_FOUND.has((error as { code?: string } | null)?.code ?? '');

/** Whether the state storage account and container exist. */
async function stateExists(clients: AzureClients, location: StateLocation): Promise<boolean> {
  const storage = clients.storage(location.subscriptionId);
  try {
    await storage.storageAccounts.getProperties(location.resourceGroup, location.storageAccount);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw azureError(
      error,
      `Could not check the state storage account ${location.storageAccount}`,
      ErrorCode.CloudAuth,
    );
  }
  try {
    await storage.blobContainers.get(
      location.resourceGroup,
      location.storageAccount,
      location.container,
    );
  } catch (error) {
    if (isNotFound(error)) {
      throw new SforgeError(
        ErrorCode.StateMissing,
        `The storage account ${location.storageAccount} exists but has no container "${location.container}"`,
        {
          hint: 'Create the container, or point targets.<name>.state at another storage account.',
        },
      );
    }
    throw azureError(error, 'Could not check the state container', ErrorCode.CloudAuth);
  }
  return true;
}

function azurermBackend(location: StateLocation, key = location.key): IacBackend {
  return {
    type: 'azurerm',
    config: {
      subscription_id: location.subscriptionId,
      resource_group_name: location.resourceGroup,
      storage_account_name: location.storageAccount,
      container_name: location.container,
      key,
      // Entra ID (the az login or the CI identity), never account keys.
      use_azuread_auth: true,
    },
  };
}

/** Resource providers the modules use, registered by the azurerm provider itself. */
const RESOURCE_PROVIDERS = ['Microsoft.Web', 'Microsoft.Storage'];

const azurermProvider = (subscriptionId: string) => ({
  features: {},
  subscription_id: subscriptionId,
  // Storage is managed through the management plane: account keys are disabled.
  storage_use_azuread: true,
  // Register only what the modules need (the default "core" set registers dozens).
  resource_provider_registrations: 'none',
  resource_providers_to_register: RESOURCE_PROVIDERS,
});

/**
 * Static Web Apps validate apex domains with a TXT token instead of a CNAME,
 * which sforge does not support yet. Without a DNS zone to compare with, a
 * name of two labels is taken to be an apex.
 */
function assertNotApex(target: AzureTargetConfig, name: string): void {
  const domain = target.domain;
  if (domain === undefined) return;
  const apex = target.dns !== undefined ? domain === target.dns.zone : domain.split('.').length < 3;
  if (apex) {
    throw new SforgeError(
      ErrorCode.Unsupported,
      `targets.${name}.domain ${domain} is the apex of its zone, which Azure targets do not support yet`,
      { hint: `Use a subdomain such as www.${domain}.` },
    );
  }
}

/** Entra allows 20 federated logins per application: one per branch, environment and pull requests. */
const FEDERATED_LIMIT = 20;

function assertFederatedLimit(ci: CiConfig, name: string): void {
  const subjects = ci.branches.length + ci.environments.length + (ci.pullRequests ? 1 : 0);
  if (subjects > FEDERATED_LIMIT) {
    throw new SforgeError(
      ErrorCode.ConfigInvalid,
      `targets.${name}.ci allows ${subjects} branches, environments and pull requests; Azure allows ${FEDERATED_LIMIT}`,
      { hint: 'Deploy from fewer branches, or through a GitHub environment.' },
    );
  }
}

/** Add the GitHub Actions identity (`ci-oidc` module) and re-export what azure/login needs. */
function withCiIdentity(
  spec: IacSpec,
  ci: CiConfig,
  site: {
    project: string;
    name: string;
    subscriptionId: string;
    location: StateLocation;
    subjectPrefix: string;
  },
): IacSpec {
  const { location } = site;
  const container =
    `/subscriptions/${location.subscriptionId}/resourceGroups/${location.resourceGroup}` +
    `/providers/Microsoft.Storage/storageAccounts/${location.storageAccount}` +
    `/blobServices/default/containers/${location.container}`;
  const history = historyBlobName(site.project, site.name);
  return {
    ...spec,
    requiredProviders: { ...spec.requiredProviders, azuread: AZUREAD_PROVIDER },
    additionalModules: [
      ...(spec.additionalModules ?? []),
      {
        name: 'ci',
        dir: CI_MODULE_DIR,
        inputs: {
          name: site.project,
          target: site.name,
          subscription_id: site.subscriptionId,
          repo: ci.repo,
          subject_prefix: site.subjectPrefix,
          branches: ci.branches,
          environments: ci.environments,
          pull_requests: ci.pullRequests,
          resource_group_id: iacRef('module.site.resource_group_id'),
          static_web_app_id: iacRef('module.site.static_web_app_id'),
          state_container_id: container,
          state_key: location.key,
          history_prefix: history.slice(0, history.lastIndexOf('/') + 1),
        },
      },
    ],
    additionalOutputs: {
      ...spec.additionalOutputs,
      ci_client_id: iacRef('module.ci.client_id'),
      ci_tenant_id: iacRef('module.ci.tenant_id'),
      ci_subscription_id: iacRef('module.ci.subscription_id'),
    },
  };
}

/** Instructions for the CNAME the user must create (no DNS provider). */
export function describeCname(outputs: Record<string, unknown>): string | undefined {
  const records = outputs.dns_records as
    { name: string; type: string; value: string }[] | undefined;
  if (records === undefined || records.length === 0) return undefined;
  return [
    'Create this DNS record (provisioning waits until it resolves):',
    ...records.map((r) => `  ${r.name} ${r.type} ${r.value}`),
  ].join('\n');
}

/** Instructions for a private domain: the TXT record to publish, the CNAME for internal DNS. */
export function describePrivateDomain(outputs: Record<string, unknown>): string | undefined {
  const txt = outputs.validation_records as
    { name: string; type: string; value: string }[] | undefined;
  if (txt === undefined || txt.length === 0) return undefined;
  return [
    'Create this DNS record in the public zone to validate the domain (provisioning waits until it resolves):',
    ...txt.map((r) => `  ${r.name} ${r.type} "${r.value}"`),
  ].join('\n');
}

export interface AzureIacOptions {
  /** DNS lookups for the custom domain's CNAME (tests). */
  cname?: CnameLookup;
}

export function createAzureIacProfile(
  clients: AzureClients = defaultClients(),
  options: AzureIacOptions = {},
): IacProfile {
  return {
    provider: 'azure',
    async prepare(input: ProfileInput): Promise<PreparedTarget> {
      const target = input.target as AzureTargetConfig;
      const name = input.targetName;

      if (!SWA_LOCATIONS.includes(target.location)) {
        throw new SforgeError(
          ErrorCode.ConfigInvalid,
          `targets.${name}.location "${target.location}" has no Static Web Apps`,
          { hint: `Use one of: ${SWA_LOCATIONS.join(', ')}.` },
        );
      }
      assertNotApex(target, name);
      if (target.ci !== undefined) assertFederatedLimit(target.ci, name);
      const dns = await prepareDns(input, target.domain === undefined ? [] : [target.domain]);

      const project = projectName(input.config);
      const outputsOnly = input.purpose === 'outputs';
      const subscriptionId = await resolveSubscription(clients, target, input.env);
      if (!outputsOnly) await assertSignedIn(clients);
      const location = stateLocation(target, subscriptionId, project, name);
      const exists = outputsOnly ? true : await stateExists(clients, location);

      const tags = { 'sforge:managed-by': 'staticforge' };
      const site: IacSpec = {
        requiredProviders: { azurerm: AZURERM_PROVIDER },
        providers: { azurerm: [azurermProvider(subscriptionId)] },
        module: {
          name: 'site',
          dir: SITE_MODULE_DIR,
          inputs: {
            name: project,
            target: name,
            resource_group_name: target.resourceGroup,
            create_resource_group: target.createResourceGroup,
            location: target.location,
            sku: target.sku,
            domain: target.domain ?? null,
            private_dns: target.privateDns,
            auth_provider: target.auth?.providers[0] ?? null,
            // The custom domain waits for the CNAME the DNS module creates.
            ...(dns && !target.privateDns && { dns_ready: iacRef('module.dns_routing.ids') }),
            tags: { ...tags, 'sforge:site': project, 'sforge:target': name },
          },
        },
        outputs: [
          'static_web_app_name',
          'static_web_app_id',
          'resource_group',
          'location',
          'sku',
          'default_host_name',
          'url',
          'domain',
          'dns_records',
          'validation_records',
          'dns_private_records',
          'sign_in_url',
        ],
        backend: azurermBackend(location),
      };
      // With privateDns, the public zone gets only the TXT validation record.
      let spec = dns
        ? withDns(site, dns, [
            target.privateDns
              ? { name: 'dns_validation', records: iacRef('module.site.dns_validation_records') }
              : { name: 'dns_routing', records: iacRef('module.site.dns_routing_records') },
          ])
        : site;
      if (target.privateDns && target.auth === undefined && !outputsOnly) {
        input.logger.warn(
          `targets.${name} has privateDns but no auth: the site stays public at its *.azurestaticapps.net host`,
        );
      }
      if (target.ci !== undefined) {
        const subjectPrefix = await githubSubjectPrefix(target.ci, {
          env: input.env,
          purpose: input.purpose,
        });
        spec = withCiIdentity(spec, target.ci, {
          project,
          name,
          subscriptionId,
          location,
          subjectPrefix,
        });
      }

      const bootstrap: IacSpec = {
        requiredProviders: { azurerm: AZURERM_PROVIDER, time: TIME_PROVIDER },
        providers: { azurerm: [azurermProvider(subscriptionId)], time: [{}] },
        module: {
          name: 'state',
          dir: STATE_BOOTSTRAP_DIR,
          inputs: {
            resource_group_name: location.resourceGroup,
            location: target.state.location ?? target.location,
            storage_account_name: location.storageAccount,
            container_name: location.container,
            tags,
          },
        },
        outputs: ['resource_group', 'storage_account', 'storage_account_id', 'container'],
        backend: azurermBackend(location, '_sforge/state-bootstrap.tfstate'),
      };

      return {
        spec,
        state: {
          id: `azure-${subscriptionId.slice(0, 8)}-${location.storageAccount}`,
          description: `azure://${location.storageAccount}/${location.container}/${location.key}`,
          exists,
          bootstrap,
        },
        // Azure refuses a custom domain whose CNAME does not resolve yet, and does not
        // retry. So the app (and, with a DNS provider, its CNAME) is created first, then
        // provisioning waits until the zone's nameservers answer with the CNAME (the user
        // creates it from the printed instructions when sforge does not manage DNS).
        // A private domain is validated with a TXT token instead: the app and the
        // domain (which yields the token) come first, then the TXT record, which
        // provisioning waits for.
        ...(target.domain !== undefined &&
          target.privateDns && {
            prePhase: {
              targets: [
                'module.site.azurerm_static_web_app.site',
                'module.site.azurerm_static_web_app_custom_domain.site',
                ...(dns === undefined ? [] : ['module.dns_validation']),
              ],
              describe: dns === undefined ? describePrivateDomain : () => undefined,
              wait: async (outputs, logger) => {
                const [record] = (outputs.validation_records ?? []) as { value: string }[];
                if (record === undefined) return;
                await waitForRecord(
                  `_dnsauth.${target.domain!}`,
                  { type: 'TXT', value: record.value },
                  logger,
                  { ...(options.cname && { lookup: options.cname }) },
                );
              },
            },
          }),
        ...(target.domain !== undefined &&
          !target.privateDns && {
            prePhase: {
              targets: [
                'module.site.azurerm_static_web_app.site',
                ...(dns === undefined ? [] : ['module.dns_routing']),
              ],
              describe: dns === undefined ? describeCname : () => undefined,
              wait: (outputs, logger) =>
                waitForCname(target.domain!, String(outputs.default_host_name), logger, {
                  ...(options.cname && { lookup: options.cname }),
                }),
            },
          }),
      };
    },
  };
}
