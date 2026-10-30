import { ErrorCode, SforgeError } from '@staticforge/core';
import { GoogleAuth, UserRefreshClient } from 'google-auth-library';

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const HOSTING = 'https://firebasehosting.googleapis.com/v1beta1';
const FIREBASE = 'https://firebase.googleapis.com/v1beta1';
const STORAGE = 'https://storage.googleapis.com/storage/v1';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 120_000;
const PAGE_SIZE = 100;

/** A failed Google API call. */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** `error.status` of the response, e.g. `PERMISSION_DENIED`. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export const httpStatus = (error: unknown): number | undefined =>
  error instanceof GoogleApiError ? error.status : undefined;

const SIGN_IN_HINT =
  'Run `gcloud auth application-default login`, then `gcloud auth application-default set-quota-project <project>`.';

/** An error from Google as an SforgeError with a stable code and, for sign-in problems, a hint. */
export function firebaseError(
  error: unknown,
  message: string,
  code: ErrorCode = ErrorCode.DeployFailed,
): SforgeError {
  if (error instanceof SforgeError) return error;
  const status = httpStatus(error);
  const detail = error instanceof Error ? error.message : String(error);
  const denied = status === 401 || status === 403;
  return new SforgeError(denied ? ErrorCode.CloudAuth : code, `${message}: ${detail}`, {
    ...(denied && { hint: SIGN_IN_HINT }),
  });
}

/** Authorized requests to Google, injectable for tests. */
export interface GoogleSession {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Fails when no login works. */
  assertSignedIn(): Promise<void>;
}

export interface GoogleSessionOptions {
  /** Project that user logins bill API calls to. */
  project: string;
  fetch?: typeof fetch;
  auth?: GoogleAuth;
  /** Milliseconds before the first retry (tests). */
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Application Default Credentials: `gcloud auth application-default login` locally, the
 * file google-github-actions/auth writes in CI. Firebase's APIs bill a user login's calls
 * to a quota project, which is set to the target's project here so that one left over
 * from other work does not apply. Service accounts bill their own project.
 */
export function createGoogleSession(options: GoogleSessionOptions): GoogleSession {
  const fetchImpl = options.fetch ?? fetch;
  const auth = options.auth ?? new GoogleAuth({ scopes: [SCOPE] });
  let client: ReturnType<GoogleAuth['getClient']> | undefined;
  const open = () => {
    client ??= auth.getClient().then((c) => {
      if (c instanceof UserRefreshClient) c.quotaProjectId = options.project;
      return c;
    });
    return client;
  };
  return {
    async assertSignedIn() {
      try {
        const signedIn = await open();
        await signedIn.getAccessToken();
      } catch (error) {
        throw new SforgeError(
          ErrorCode.CloudAuth,
          `Could not sign in to Google Cloud: ${(error as Error).message}`,
          { hint: SIGN_IN_HINT },
        );
      }
    },
    async fetch(url, init = {}) {
      const signedIn = await open();
      for (let attempt = 1; ; attempt++) {
        let response: Response | undefined;
        let failure: unknown;
        try {
          const headers = new Headers(await signedIn.getRequestHeaders(url));
          for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
          response = await fetchImpl(url, {
            ...init,
            headers,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!RETRY_STATUS.has(response.status)) return response;
        } catch (error) {
          failure = error;
        }
        if (attempt >= ATTEMPTS) {
          if (response !== undefined) return response;
          throw failure;
        }
        await sleep((options.retryDelayMs ?? 500) * 2 ** (attempt - 1));
      }
    },
  };
}

async function ensureOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response;
  const text = await response.text();
  let message = text.slice(0, 500);
  let reason: string | undefined;
  try {
    const body = JSON.parse(text) as { error?: { message?: string; status?: string } };
    message = body.error?.message ?? message;
    reason = body.error?.status;
  } catch {
    // Not JSON: keep the text.
  }
  throw new GoogleApiError(`${what}: HTTP ${response.status} ${message}`, response.status, reason);
}

export interface HostingVersion {
  /** `sites/<site>/versions/<id>`. */
  name: string;
  status?: string;
  labels?: Record<string, string>;
  createTime?: string;
  fileCount?: string;
  versionBytes?: string;
}

export interface HostingRelease {
  name: string;
  type?: string;
  releaseTime?: string;
  message?: string;
  version?: HostingVersion;
}

export interface HostingChannel {
  /** `sites/<site>/channels/<id>`. */
  name: string;
  url?: string;
  createTime?: string;
  expireTime?: string;
  release?: HostingRelease;
}

export interface HostingCustomDomain {
  hostState?: string;
  ownershipState?: string;
  cert?: { state?: string };
}

export interface HostingHeaderRule {
  glob?: string;
  regex?: string;
  headers: Record<string, string>;
}

export interface ServingConfig {
  headers: HostingHeaderRule[];
  cleanUrls: boolean;
  trailingSlashBehavior?: 'ADD' | 'REMOVE';
}

export interface PopulateResult {
  uploadRequiredHashes: string[];
  uploadUrl?: string;
}

/** The parts of the Firebase Hosting REST API that sforge uses. */
export interface HostingApi {
  createVersion(
    site: string,
    version: { config: ServingConfig; labels: Record<string, string> },
  ): Promise<HostingVersion>;
  populateFiles(versionName: string, files: Record<string, string>): Promise<PopulateResult>;
  upload(uploadUrl: string, hash: string, gzipped: Uint8Array): Promise<void>;
  setVersionStatus(versionName: string, status: 'FINALIZED' | 'ABANDONED'): Promise<void>;
  createRelease(
    site: string,
    channel: string,
    versionName: string,
    message: string,
  ): Promise<HostingRelease>;
  /** Newest first. */
  listReleases(site: string, channel: string): Promise<HostingRelease[]>;
  getChannel(site: string, channel: string): Promise<HostingChannel | undefined>;
  listChannels(site: string): Promise<HostingChannel[]>;
  createChannel(site: string, channel: string, ttlSeconds: number): Promise<HostingChannel>;
  setChannelTtl(site: string, channel: string, ttlSeconds: number): Promise<HostingChannel>;
  /** False when there was no such channel. */
  deleteChannel(site: string, channel: string): Promise<boolean>;
  getMaxVersions(site: string): Promise<number | undefined>;
  setMaxVersions(site: string, maxVersions: number): Promise<void>;
  getCustomDomain(
    project: string,
    site: string,
    domain: string,
  ): Promise<HostingCustomDomain | undefined>;
}

/** Previews keep their latest release only: older ones would just use up `maxVersions`. */
const PREVIEW_RETAINED_RELEASES = 1;

export function createHostingApi(session: GoogleSession): HostingApi {
  const call = async <T>(what: string, url: string, init: RequestInit = {}): Promise<T> => {
    const response = await ensureOk(
      await session.fetch(url, {
        ...init,
        headers: { 'content-type': 'application/json', ...init.headers },
      }),
      what,
    );
    return (await response.json()) as T;
  };
  const send = (method: string, body: unknown): RequestInit => ({
    method,
    body: JSON.stringify(body),
  });
  const orUndefined = async <T>(request: Promise<T>): Promise<T | undefined> => {
    try {
      return await request;
    } catch (error) {
      if (httpStatus(error) === 404) return undefined;
      throw error;
    }
  };
  const paged = async <T, K extends string>(what: string, url: string, key: K): Promise<T[]> => {
    const all: T[] = [];
    let token: string | undefined;
    do {
      const query = new URLSearchParams({
        pageSize: String(PAGE_SIZE),
        ...(token !== undefined && { pageToken: token }),
      });
      const page = await call<Partial<Record<K, T[]>> & { nextPageToken?: string }>(
        what,
        `${url}?${query}`,
      );
      all.push(...(page[key] ?? []));
      token = page.nextPageToken;
    } while (token !== undefined && token !== '');
    return all;
  };
  const channelUrl = (site: string, channel: string) =>
    `${HOSTING}/sites/${site}/channels/${channel}`;

  return {
    createVersion: (site, version) =>
      call(
        'Could not create a version',
        `${HOSTING}/sites/${site}/versions`,
        send('POST', version),
      ),
    async populateFiles(versionName, files) {
      const result = await call<Partial<PopulateResult>>(
        'Could not list the files of the version',
        `${HOSTING}/${versionName}:populateFiles`,
        send('POST', { files }),
      );
      return {
        uploadRequiredHashes: result.uploadRequiredHashes ?? [],
        ...(result.uploadUrl !== undefined && { uploadUrl: result.uploadUrl }),
      };
    },
    async upload(uploadUrl, hash, gzipped) {
      await ensureOk(
        await session.fetch(`${uploadUrl}/${hash}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: gzipped,
        }),
        `Could not upload ${hash}`,
      );
    },
    async setVersionStatus(versionName, status) {
      await call(
        `Could not mark the version ${status}`,
        `${HOSTING}/${versionName}?updateMask=status`,
        send('PATCH', { status }),
      );
    },
    createRelease: (site, channel, versionName, message) =>
      call(
        'Could not release the version',
        `${channelUrl(site, channel)}/releases?${new URLSearchParams({ versionName })}`,
        send('POST', { message }),
      ),
    listReleases: (site, channel) =>
      paged<HostingRelease, 'releases'>(
        'Could not list the releases',
        `${channelUrl(site, channel)}/releases`,
        'releases',
      ),
    getChannel: (site, channel) =>
      orUndefined(call('Could not read the channel', channelUrl(site, channel))),
    listChannels: (site) =>
      paged<HostingChannel, 'channels'>(
        'Could not list the channels',
        `${HOSTING}/sites/${site}/channels`,
        'channels',
      ),
    createChannel: (site, channel, ttlSeconds) =>
      call(
        'Could not create the channel',
        `${HOSTING}/sites/${site}/channels?${new URLSearchParams({ channelId: channel })}`,
        send('POST', {
          ttl: `${ttlSeconds}s`,
          retainedReleaseCount: PREVIEW_RETAINED_RELEASES,
        }),
      ),
    setChannelTtl: (site, channel, ttlSeconds) =>
      call(
        'Could not extend the channel',
        `${channelUrl(site, channel)}?updateMask=ttl`,
        send('PATCH', { ttl: `${ttlSeconds}s` }),
      ),
    async deleteChannel(site, channel) {
      const response = await session.fetch(channelUrl(site, channel), { method: 'DELETE' });
      if (response.status === 404) return false;
      await ensureOk(response, 'Could not delete the channel');
      return true;
    },
    async getMaxVersions(site) {
      const config = await call<{ maxVersions?: string }>(
        'Could not read the site configuration',
        `${HOSTING}/sites/${site}/config`,
      );
      return config.maxVersions === undefined ? undefined : Number(config.maxVersions);
    },
    async setMaxVersions(site, maxVersions) {
      await call(
        'Could not set how many versions the site keeps',
        `${HOSTING}/sites/${site}/config?updateMask=maxVersions`,
        send('PATCH', { maxVersions: String(maxVersions) }),
      );
    },
    getCustomDomain: (project, site, domain) =>
      orUndefined(
        call(
          'Could not read the custom domain',
          `${HOSTING}/projects/${project}/sites/${site}/customDomains/${domain}`,
        ),
      ),
  };
}

/** Everything sforge asks Google, injectable for tests. */
export interface FirebaseClients {
  assertSignedIn(project: string): Promise<void>;
  hosting(project: string): HostingApi;
  /** Whether the state bucket exists; an error when access is refused. */
  bucketExists(project: string, bucket: string): Promise<boolean>;
  /** Whether Firebase has been added to the project. */
  isFirebaseProject(project: string): Promise<boolean>;
}

export function defaultClients(): FirebaseClients {
  const sessions = new Map<string, GoogleSession>();
  const session = (project: string): GoogleSession => {
    let found = sessions.get(project);
    if (found === undefined) {
      found = createGoogleSession({ project });
      sessions.set(project, found);
    }
    return found;
  };
  return {
    assertSignedIn: (project) => session(project).assertSignedIn(),
    hosting: (project) => createHostingApi(session(project)),
    async bucketExists(project, bucket) {
      const response = await session(project).fetch(`${STORAGE}/b/${bucket}`);
      if (response.status === 404) return false;
      await ensureOk(response, `Could not check the state bucket ${bucket}`);
      return true;
    },
    async isFirebaseProject(project) {
      // Anything but a yes means no: until Firebase is added, its API is usually off (403).
      const response = await session(project).fetch(`${FIREBASE}/projects/${project}`);
      return response.ok;
    },
  };
}
