import type { WebSiteManagementClient } from '@azure/arm-appservice';
import { type AzureTargetConfig, ErrorCode, SforgeError } from '@staticforge/core';
import type {
  DeployerContext,
  InviteOptions,
  InviteResult,
  SiteUser,
  UserAdmin,
} from '@staticforge/provider-api';
import { type AzureClients, azureError, defaultClients } from './clients.js';
import { assertSignedIn, resolveSubscription } from './iac.js';
import { MEMBER_ROLE } from './swa-config.js';

/** Users with custom roles a Free plan app may have. */
export const FREE_MEMBER_LIMIT = 25;
/** Hours an invitation link stays valid: Static Web Apps allows 1 to 168. */
const DEFAULT_EXPIRY_HOURS = 168;

const hasRole = (roles: string | undefined, role: string) =>
  (roles ?? '')
    .split(',')
    .map((r) => r.trim())
    .includes(role);

/**
 * Users of a private Azure target: Static Web Apps role invitations. Static
 * Web Apps sends no email, so `invite` returns the link to pass on; the user
 * opens it and signs in with the provider and account it names.
 */
export function createAzureUserAdmin(
  context: DeployerContext,
  clients: AzureClients = defaultClients(),
): UserAdmin {
  const target = context.target as AzureTargetConfig;
  const name = context.targetName;

  function auth() {
    if (target.auth === undefined) {
      throw new SforgeError(ErrorCode.Unsupported, `Target "${name}" is not private`, {
        hint: `Set targets.${name}.auth, then deploy it.`,
      });
    }
    return target.auth;
  }
  const output = (key: string): string => {
    const value = context.outputs[key];
    if (typeof value !== 'string' || value === '') {
      throw new SforgeError(ErrorCode.NotProvisioned, `"${name}" has no "${key}" output`, {
        hint: `Run \`sforge provision ${name}\` first.`,
      });
    }
    return value;
  };

  let opened: Promise<WebSiteManagementClient> | undefined;
  async function sites() {
    opened ??= (async () => {
      const subscriptionId = await resolveSubscription(clients, target, context.env);
      await assertSignedIn(clients);
      return clients.webSites(subscriptionId);
    })();
    return (await opened).staticSites;
  }

  async function members(): Promise<SiteUser[]> {
    auth();
    const found: SiteUser[] = [];
    for await (const user of (await sites()).listStaticSiteUsers(
      output('resource_group'),
      output('static_web_app_name'),
      'all',
    )) {
      if (!hasRole(user.roles, MEMBER_ROLE)) continue;
      found.push({
        id: user.userId ?? '',
        name: user.displayName ?? '',
        ...(user.provider !== undefined && { provider: user.provider }),
      });
    }
    return found;
  }

  return {
    async list() {
      try {
        return await members();
      } catch (error) {
        throw azureError(error, `Could not list the users of "${name}"`);
      }
    },

    async invite(options: InviteOptions): Promise<InviteResult> {
      const { providers } = auth();
      const provider = options.provider ?? providers[0]!;
      if (!(providers as string[]).includes(provider)) {
        throw new SforgeError(
          ErrorCode.Usage,
          `"${name}" signs in with ${providers.join(', ')}, not ${provider}`,
          { hint: `Pass --provider ${providers.join(' or --provider ')}.` },
        );
      }
      const hours = options.expiresHours ?? DEFAULT_EXPIRY_HOURS;
      if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
        throw new SforgeError(ErrorCode.Usage, 'Invitations expire after 1 to 168 hours');
      }
      const user = options.user.trim();
      if (provider === 'aad' && !user.includes('@')) {
        throw new SforgeError(ErrorCode.Usage, `"${user}" is not an email address`, {
          hint: 'Microsoft (aad) accounts are invited by email address; GitHub ones by user name.',
        });
      }
      let current: SiteUser[];
      try {
        current = await members();
      } catch (error) {
        throw azureError(error, `Could not list the users of "${name}"`);
      }
      if (
        current.some((u) => u.provider === provider && u.name.toLowerCase() === user.toLowerCase())
      ) {
        throw new SforgeError(ErrorCode.UserExists, `${user} is already a user of "${name}"`);
      }
      if (target.sku === 'Free' && current.length >= FREE_MEMBER_LIMIT) {
        throw new SforgeError(
          ErrorCode.UserLimit,
          `"${name}" has ${current.length} users; the Free plan allows ${FREE_MEMBER_LIMIT}`,
          { hint: 'Remove a user first (`sforge users remove`).' },
        );
      }
      const domain =
        typeof context.outputs.domain === 'string' && context.outputs.domain !== ''
          ? context.outputs.domain
          : output('default_host_name');
      try {
        const link = await (
          await sites()
        ).createUserRolesInvitationLink(output('resource_group'), output('static_web_app_name'), {
          domain,
          provider,
          userDetails: user,
          roles: MEMBER_ROLE,
          numHoursToExpiration: hours,
        });
        return {
          user,
          provider,
          emailed: false,
          ...(link.invitationUrl !== undefined && { invitationUrl: link.invitationUrl }),
          ...(link.expiresOn !== undefined && { expiresAt: link.expiresOn.toISOString() }),
        };
      } catch (error) {
        throw azureError(error, `Could not invite ${user}`);
      }
    },

    async remove(user: string, provider?: string): Promise<boolean> {
      try {
        const wanted = user.trim().toLowerCase();
        const found = (await members()).filter(
          (u) =>
            u.name.toLowerCase() === wanted && (provider === undefined || u.provider === provider),
        );
        for (const entry of found) {
          await (
            await sites()
          ).deleteStaticSiteUser(
            output('resource_group'),
            output('static_web_app_name'),
            entry.provider ?? 'all',
            entry.id,
          );
        }
        return found.length > 0;
      } catch (error) {
        throw azureError(error, `Could not remove ${user}`);
      }
    },
  };
}
