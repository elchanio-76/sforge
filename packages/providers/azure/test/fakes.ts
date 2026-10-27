import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { type SforgeConfig, validateConfig } from '@staticforge/core';
import {
  type AzureClients,
  HistoryConflict,
  type HistoryDoc,
  type HistoryStore,
  type UploadRequest,
  type Uploader,
} from '../src/index.js';

export const SUBSCRIPTION = '07be2078-a22e-42b2-a654-91c56c8ebcdd';

export interface FakeBuild {
  buildId: string;
  hostname: string;
  status: string;
  createdTimeUtc: Date;
  lastUpdatedOn: Date;
}

export interface FakeAzure {
  clients: AzureClients;
  builds: FakeBuild[];
  /** Subscriptions the clients were asked for. */
  subscriptions: Set<string>;
  history: { doc: HistoryDoc | undefined; etag: number; writes: number; conflicts: number };
  tokenCalls: number;
  deletedBuilds: string[];
  /** Listings a deleted environment still shows up in (Azure removes it in the background). */
  deleteLag: number;
  secretCalls: number;
  /** Storage resources that exist: `account` and `container` (set undefined for missing). */
  storage: { account: boolean; container: boolean; error?: unknown };
  signIn: { error?: unknown };
  azOutput: string | undefined;
  /** Users of the app as Static Web Apps lists them (roles comma-separated). */
  users: { provider: string; userId: string; displayName: string; roles: string }[];
  invitations: Record<string, unknown>[];
  deletedUsers: string[];
}

export function fakeAzure(): FakeAzure {
  const state: FakeAzure = {
    clients: undefined as unknown as AzureClients,
    builds: [],
    subscriptions: new Set(),
    history: { doc: undefined, etag: 0, writes: 0, conflicts: 0 },
    tokenCalls: 0,
    deletedBuilds: [],
    deleteLag: 0,
    secretCalls: 0,
    storage: { account: true, container: true },
    signIn: {},
    azOutput: SUBSCRIPTION,
    users: [],
    invitations: [],
    deletedUsers: [],
  };

  const store: HistoryStore = {
    async read() {
      const doc = state.history.doc;
      return {
        doc: doc === undefined ? { schema: 1, active: null, versions: [] } : structuredClone(doc),
        etag: doc === undefined ? undefined : String(state.history.etag),
      };
    },
    async write(doc, etag) {
      if (state.history.conflicts > 0) {
        state.history.conflicts--;
        throw new HistoryConflict();
      }
      const current = state.history.doc === undefined ? undefined : String(state.history.etag);
      if (etag !== current) throw new HistoryConflict();
      state.history.doc = structuredClone(doc);
      state.history.etag++;
      state.history.writes++;
    },
  };

  const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 });

  // Deleted environments, with the number of listings they still show up in.
  const removing: Record<string, number> = {};
  state.clients = {
    credential: () => ({
      async getToken() {
        state.tokenCalls++;
        if (state.signIn.error !== undefined) throw state.signIn.error;
        return { token: 'jwt', expiresOnTimestamp: Date.now() + 3_600_000 };
      },
    }),
    webSites: (subscriptionId) => {
      state.subscriptions.add(subscriptionId);
      return {
        staticSites: {
          async listStaticSiteSecrets() {
            state.secretCalls++;
            return { properties: { apiKey: 'SECRET-DEPLOYMENT-TOKEN' } };
          },
          listStaticSiteUsers(_group: string, _name: string, provider: string) {
            const snapshot = state.users.filter(
              (u) => provider === 'all' || u.provider === provider,
            );
            return (async function* () {
              yield* snapshot;
            })();
          },
          async createUserRolesInvitationLink(
            _group: string,
            _name: string,
            envelope: Record<string, unknown>,
          ) {
            state.invitations.push(envelope);
            return {
              invitationUrl: `https://${String(envelope.domain)}/.auth/invitations/abc`,
              expiresOn: new Date('2026-11-03T12:00:00Z'),
            };
          },
          async deleteStaticSiteUser(_group: string, _name: string, provider: string, id: string) {
            state.deletedUsers.push(`${provider}/${id}`);
            state.users = state.users.filter((u) => u.userId !== id);
          },
          listStaticSiteBuilds() {
            for (const id of Object.keys(removing)) {
              if (removing[id]-- === 0) {
                state.builds = state.builds.filter((b) => b.buildId !== id);
                delete removing[id];
              }
            }
            const snapshot = [...state.builds];
            return (async function* () {
              yield* snapshot;
            })();
          },
          deleteStaticSiteBuild(_group: string, _name: string, id: string) {
            return {
              async submitted() {
                state.deletedBuilds.push(id);
                removing[id] = state.deleteLag;
              },
              async pollUntilDone() {
                throw new Error(
                  'polling needs Microsoft.Web/locations/*/read at subscription scope',
                );
              },
            };
          },
        },
      };
    },
    storage: () =>
      ({
        storageAccounts: {
          async getProperties() {
            if (state.storage.error !== undefined) throw state.storage.error;
            if (!state.storage.account) throw notFound();
            return {};
          },
        },
        blobContainers: {
          async get() {
            if (!state.storage.container) throw notFound();
            return {};
          },
        },
      }) as unknown as ReturnType<AzureClients['storage']>,
    history: () => store,
    az: async () => state.azOutput,
  } as unknown as AzureClients;
  return state;
}

export interface FakeUpload extends UploadRequest {
  /** Files that were in `dir` during the upload. */
  files: Record<string, string>;
}

/** An uploader that records what it was given and makes the environment Ready in `azure`. */
export function fakeUploader(
  azure: FakeAzure,
  options: { fail?: Error; url?: string; stale?: boolean } = {},
): { uploader: Uploader; uploads: FakeUpload[] } {
  const uploads: FakeUpload[] = [];
  const uploader: Uploader = async (request) => {
    const files: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files[relative(request.dir, path)] = readFileSync(path, 'utf8');
      }
    };
    walk(request.dir);
    uploads.push({ ...request, files });
    if (options.fail !== undefined) throw options.fail;
    // Azure keeps lowercase letters and digits only in environment names ("pr-1" → "pr1").
    const buildId =
      request.environment === 'production'
        ? 'default'
        : request.environment.toLowerCase().replace(/[^a-z0-9]/g, '');
    const when = options.stale ? new Date(Date.now() - 3_600_000) : new Date();
    azure.builds = azure.builds.filter((b) => b.buildId !== buildId);
    azure.builds.push({
      buildId,
      hostname:
        buildId === 'default'
          ? 'lemon-bush-0123456ab.5.azurestaticapps.net'
          : `lemon-bush-0123456ab-${buildId}.westeurope.5.azurestaticapps.net`,
      status: 'Ready',
      createdTimeUtc: when,
      lastUpdatedOn: when,
    });
    return options.url === undefined ? {} : { url: options.url };
  };
  return { uploader, uploads };
}

export function azureConfig(target: Record<string, unknown> = {}): SforgeConfig {
  return validateConfig({
    site: { title: 'Docs', baseUrl: 'https://docs.example.com' },
    targets: {
      prod: {
        provider: 'azure',
        resourceGroup: 'docs-prod',
        location: 'westeurope',
        retainVersions: 3,
        ...target,
      },
    },
  });
}

export const outputs = {
  static_web_app_name: 'docs-example-com-prod',
  resource_group: 'docs-prod',
  default_host_name: 'lemon-bush-0123456ab.5.azurestaticapps.net',
  url: 'https://lemon-bush-0123456ab.5.azurestaticapps.net',
  location: 'westeurope',
};

/** A finished build: files plus .sforge/build-manifest.json. */
export function writeBuild(files: Record<string, string>, immutable: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'sforge-azure-build-'));
  const manifest: Record<string, unknown> = {};
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
    manifest[path] = {
      sha256: createHash('sha256').update(body).digest('hex'),
      size: Buffer.byteLength(body),
      cache: immutable.includes(path) ? 'immutable' : 'revalidate',
    };
  }
  mkdirSync(join(dir, '.sforge'), { recursive: true });
  writeFileSync(
    join(dir, '.sforge', 'build-manifest.json'),
    JSON.stringify({ version: 1, files: manifest }),
  );
  return dir;
}

export const site = {
  'index.html': '<h1>Home</h1>',
  '404.html': '<h1>Not found</h1>',
  'about/index.html': '<h1>About</h1>',
  'assets/site.4f2a.css': 'body{}',
  'assets/site.css': 'body{}',
};
