import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@staticforge/core';
import { githubSubjectPrefix } from '../src/index.js';

const ci = { repo: 'acme/docs' };

function github(status: number, body: unknown = {}) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(body, { status }),
  );
}

describe('githubSubjectPrefix', () => {
  it('reads the prefix of immutable subjects from GitHub', async () => {
    const fetch = github(200, {
      use_default: true,
      use_immutable_subject: true,
      sub_claim_prefix: 'repo:acme@1001/docs@2002',
    });
    await expect(githubSubjectPrefix(ci, { env: {}, fetch })).resolves.toBe(
      'repo:acme@1001/docs@2002',
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/acme/docs/actions/oidc/customization/sub');
    expect(init?.headers).not.toHaveProperty('authorization');
  });

  it('sends GH_TOKEN for private repositories', async () => {
    const fetch = github(200, { use_default: true, sub_claim_prefix: 'repo:acme/docs' });
    await expect(githubSubjectPrefix(ci, { env: { GH_TOKEN: 'secret' }, fetch })).resolves.toBe(
      'repo:acme/docs',
    );
    expect(fetch.mock.calls[0]![1]?.headers).toHaveProperty('authorization', 'Bearer secret');
  });

  it('uses ci.subjectPrefix without asking GitHub', async () => {
    const fetch = github(500);
    await expect(
      githubSubjectPrefix({ ...ci, subjectPrefix: 'repo:acme@1/docs@2' }, { env: {}, fetch }),
    ).resolves.toBe('repo:acme@1/docs@2');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips the lookup when only reading outputs', async () => {
    const fetch = github(500);
    await expect(githubSubjectPrefix(ci, { env: {}, purpose: 'outputs', fetch })).resolves.toBe(
      'repo:acme/docs',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses custom subject templates', async () => {
    const fetch = github(200, { use_default: false, include_claim_keys: ['repo', 'context'] });
    await expect(githubSubjectPrefix(ci, { env: {}, fetch })).rejects.toMatchObject({
      code: ErrorCode.Unsupported,
      hint: expect.stringContaining('use_default=true'),
    });
  });

  it('explains how to proceed when GitHub cannot be read', async () => {
    await expect(githubSubjectPrefix(ci, { env: {}, fetch: github(404) })).rejects.toMatchObject({
      code: ErrorCode.CloudAuth,
      message: expect.stringContaining('HTTP 404'),
      hint: expect.stringContaining('ci.subjectPrefix'),
    });
    const offline = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    });
    await expect(githubSubjectPrefix(ci, { env: {}, fetch: offline })).rejects.toMatchObject({
      code: ErrorCode.CloudAuth,
      message: expect.stringContaining('ENOTFOUND'),
    });
  });
});
