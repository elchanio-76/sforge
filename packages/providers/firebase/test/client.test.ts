import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@staticforge/core';
import type { GoogleAuth } from 'google-auth-library';
import {
  GoogleApiError,
  type GoogleSession,
  createGoogleSession,
  createHostingApi,
  firebaseError,
} from '../src/index.js';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  headers: Headers;
}

/** A session that answers from a queue and records the requests. */
function fakeSession(answers: (Response | ((url: string) => Response))[] = []) {
  const requests: Recorded[] = [];
  const session: GoogleSession = {
    assertSignedIn: async () => undefined,
    async fetch(url, init = {}) {
      requests.push({
        url,
        method: init.method ?? 'GET',
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
        headers: new Headers(init.headers),
      });
      const answer = answers.shift() ?? Response.json({});
      return typeof answer === 'function' ? answer(url) : answer;
    },
  };
  return { session, requests, api: createHostingApi(session) };
}

const HOSTING = 'https://firebasehosting.googleapis.com/v1beta1';

describe('the Hosting API', () => {
  it('creates a version on the site', async () => {
    const { api, requests } = fakeSession([Response.json({ name: 'sites/s/versions/v1' })]);
    const version = await api.createVersion('s', {
      config: { headers: [], cleanUrls: true },
      labels: { a: 'b' },
    });
    expect(version.name).toBe('sites/s/versions/v1');
    expect(requests[0]).toMatchObject({
      url: `${HOSTING}/sites/s/versions`,
      method: 'POST',
      body: { config: { cleanUrls: true }, labels: { a: 'b' } },
    });
  });

  it('copes with a populate answer that asks for nothing', async () => {
    const { api, requests } = fakeSession([Response.json({})]);
    expect(await api.populateFiles('sites/s/versions/v1', { '/a': 'hash' })).toEqual({
      uploadRequiredHashes: [],
    });
    expect(requests[0]?.url).toBe(`${HOSTING}/sites/s/versions/v1:populateFiles`);
    expect(requests[0]?.body).toEqual({ files: { '/a': 'hash' } });
  });

  it('uploads gzipped bytes to the URL plus the hash', async () => {
    const { api, requests } = fakeSession([new Response(null, { status: 200 })]);
    const bytes = new Uint8Array([1, 2, 3]);
    await api.upload('https://upload.example/files', 'abc', bytes);
    expect(requests[0]).toMatchObject({ url: 'https://upload.example/files/abc', method: 'POST' });
    expect(requests[0]?.body).toBe(bytes);
    expect(requests[0]?.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('finalizes a version with an update mask', async () => {
    const { api, requests } = fakeSession();
    await api.setVersionStatus('sites/s/versions/v1', 'FINALIZED');
    expect(requests[0]).toMatchObject({
      url: `${HOSTING}/sites/s/versions/v1?updateMask=status`,
      method: 'PATCH',
      body: { status: 'FINALIZED' },
    });
  });

  it('releases a version to a channel', async () => {
    const { api, requests } = fakeSession();
    await api.createRelease('s', 'live', 'sites/s/versions/v1', 'message');
    expect(requests[0]?.url).toBe(
      `${HOSTING}/sites/s/channels/live/releases?versionName=sites%2Fs%2Fversions%2Fv1`,
    );
    expect(requests[0]?.body).toEqual({ message: 'message' });
  });

  it('reads every page of a list', async () => {
    const { api, requests } = fakeSession([
      Response.json({ releases: [{ name: 'r1' }], nextPageToken: 'more' }),
      Response.json({ releases: [{ name: 'r2' }] }),
    ]);
    expect((await api.listReleases('s', 'live')).map((r) => r.name)).toEqual(['r1', 'r2']);
    expect(requests[1]?.url).toContain('pageToken=more');
  });

  it('creates a channel with a time to live', async () => {
    const { api, requests } = fakeSession();
    await api.createChannel('s', 'pr-1', 3600);
    expect(requests[0]?.url).toBe(`${HOSTING}/sites/s/channels?channelId=pr-1`);
    expect(requests[0]?.body).toMatchObject({ ttl: '3600s' });
  });

  it('treats a missing channel or domain as nothing, not as an error', async () => {
    const missing = () => new Response('{}', { status: 404 });
    const { api } = fakeSession([missing(), missing(), missing()]);
    expect(await api.getChannel('s', 'pr-1')).toBeUndefined();
    expect(await api.deleteChannel('s', 'pr-1')).toBe(false);
    expect(await api.getCustomDomain('p', 's', 'a.example.com')).toBeUndefined();
  });

  it('sends the retention limit as the string the API wants', async () => {
    const { api, requests } = fakeSession([Response.json({ maxVersions: '7' })]);
    expect(await api.getMaxVersions('s')).toBe(7);
    await api.setMaxVersions('s', 9);
    expect(requests[1]).toMatchObject({
      url: `${HOSTING}/sites/s/config?updateMask=maxVersions`,
      body: { maxVersions: '9' },
    });
  });

  it('turns an error answer into a GoogleApiError with what Google said', async () => {
    const { api } = fakeSession([
      Response.json({ error: { message: 'Site not found', status: 'NOT_FOUND' } }, { status: 400 }),
    ]);
    const error = await api.listChannels('s').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GoogleApiError);
    expect(error).toMatchObject({ status: 400, reason: 'NOT_FOUND' });
    expect((error as Error).message).toContain('Site not found');
  });
});

describe('firebaseError', () => {
  it('maps refused access to SF_CLOUD_AUTH with a hint', () => {
    const error = firebaseError(new GoogleApiError('denied', 403), 'Could not deploy');
    expect(error.code).toBe(ErrorCode.CloudAuth);
    expect(error.hint).toContain('set-quota-project');
  });

  it('keeps the given code for anything else', () => {
    expect(firebaseError(new GoogleApiError('oops', 400), 'Could not deploy').code).toBe(
      ErrorCode.DeployFailed,
    );
  });
});

describe('the Google session', () => {
  /** A login that needs no network. */
  const fakeAuth = (error?: Error) =>
    ({
      getClient: async () => {
        if (error !== undefined) throw error;
        return {
          getAccessToken: async () => ({ token: 'token' }),
          getRequestHeaders: async () => new Headers({ authorization: 'Bearer token' }),
        };
      },
    }) as unknown as GoogleAuth;

  it('adds the login to requests, and keeps the caller headers', async () => {
    let seen: Headers | undefined;
    const session = createGoogleSession({
      project: 'p',
      auth: fakeAuth(),
      fetch: (async (_url: string, init: RequestInit) => {
        seen = new Headers(init.headers);
        return new Response('{}');
      }) as typeof fetch,
    });
    await session.fetch('https://example.com', { headers: { 'content-type': 'text/plain' } });
    expect(seen?.get('authorization')).toBe('Bearer token');
    expect(seen?.get('content-type')).toBe('text/plain');
  });

  it('retries overload and network failures, then succeeds', async () => {
    const answers: (Response | Error)[] = [
      new Response('', { status: 503 }),
      new Error('socket hang up'),
      new Response('ok'),
    ];
    let calls = 0;
    const session = createGoogleSession({
      project: 'p',
      auth: fakeAuth(),
      retryDelayMs: 1,
      fetch: (async () => {
        calls++;
        const answer = answers.shift()!;
        if (answer instanceof Error) throw answer;
        return answer;
      }) as typeof fetch,
    });
    expect(await (await session.fetch('https://example.com')).text()).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up after a few attempts, returning the last answer', async () => {
    let calls = 0;
    const session = createGoogleSession({
      project: 'p',
      auth: fakeAuth(),
      retryDelayMs: 1,
      fetch: (async () => {
        calls++;
        return new Response('', { status: 503 });
      }) as typeof fetch,
    });
    expect((await session.fetch('https://example.com')).status).toBe(503);
    expect(calls).toBe(4);
  });

  it('does not retry a refusal', async () => {
    let calls = 0;
    const session = createGoogleSession({
      project: 'p',
      auth: fakeAuth(),
      fetch: (async () => {
        calls++;
        return new Response('', { status: 403 });
      }) as typeof fetch,
    });
    expect((await session.fetch('https://example.com')).status).toBe(403);
    expect(calls).toBe(1);
  });

  it('says how to log in when there is no login', async () => {
    const session = createGoogleSession({ project: 'p', auth: fakeAuth(new Error('no login')) });
    await expect(session.assertSignedIn()).rejects.toMatchObject({
      code: ErrorCode.CloudAuth,
      hint: expect.stringContaining('application-default login') as string,
    });
  });
});
