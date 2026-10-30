import { describe, expect, it } from 'vitest';
import { ErrorCode, SforgeError } from '@staticforge/core';
import { GoogleApiError, createFirebaseDeployer } from '../src/index.js';
import {
  type FakeFirebase,
  SITE,
  deployerContext,
  fakeFirebase,
  firebaseConfig,
  makeBuild,
} from './fakes.js';

const NOW = new Date('2026-10-30T12:00:00Z');
const LATER = new Date('2026-10-31T12:00:00Z');

function setup(target: Record<string, unknown> = {}) {
  const fake = fakeFirebase();
  const deployer = createFirebaseDeployer(deployerContext(firebaseConfig(target)), fake.clients);
  return { fake, deployer };
}

const liveReleases = (fake: FakeFirebase) => fake.releases.get(`${SITE}/live`) ?? [];

describe('deploying', () => {
  it('creates, fills, finalizes and releases a version', async () => {
    const { fake, deployer } = setup();
    const result = await deployer.deploy({
      buildDir: makeBuild({ 'index.html': '<h1>Hello</h1>', 'about/index.html': 'About' }),
      now: NOW,
    });

    expect(result).toMatchObject({
      provider: 'firebase',
      versionId: '20261030T120000Z-abc1234',
      url: `https://${SITE}.web.app`,
      preview: false,
      uploaded: 2,
      copied: 0,
      dryRun: false,
    });
    const [release] = liveReleases(fake);
    expect(release?.version?.status).toBe('FINALIZED');
    expect(release?.message).toBe('sforge 20261030T120000Z-abc1234');
    expect(release?.version?.labels).toEqual({
      'sforge-version': '20261030t120000z-abc1234',
      'sforge-sha': 'abc1234',
    });
  });

  it('sends the paths with a leading slash, keyed by the hash of the gzipped bytes', async () => {
    const { fake, deployer } = setup();
    await deployer.deploy({ buildDir: makeBuild({ 'a/b.html': 'content' }), now: NOW });
    const [version] = fake.versions.values();
    const hash = version!.files['/a/b.html'];
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // The fake refuses bytes that do not hash to what was promised.
    expect(fake.stored.get(hash!)).toBe('content');
  });

  it('never publishes dot-paths such as the build manifest', async () => {
    const { fake, deployer } = setup();
    await deployer.deploy({
      buildDir: makeBuild({ 'index.html': 'x', '.well-known/secret.txt': 'y' }),
      now: NOW,
    });
    const [version] = fake.versions.values();
    expect(Object.keys(version!.files)).toEqual(['/index.html']);
  });

  it('uploads only what Firebase does not have', async () => {
    const { fake, deployer } = setup();
    await deployer.deploy({ buildDir: makeBuild({ 'a.html': 'same', 'b.html': 'old' }), now: NOW });
    fake.uploads.length = 0;

    const result = await deployer.deploy({
      buildDir: makeBuild({ 'a.html': 'same', 'b.html': 'new', 'c.html': 'added' }),
      now: LATER,
    });

    expect(fake.uploads).toHaveLength(2);
    expect(result).toMatchObject({ uploaded: 2, copied: 1 });
  });

  it('uploads files with the same content once', async () => {
    const { fake, deployer } = setup();
    const result = await deployer.deploy({
      buildDir: makeBuild({ 'a.html': 'same', 'b.html': 'same' }),
      now: NOW,
    });
    expect(fake.uploads).toHaveLength(1);
    expect(result).toMatchObject({ uploaded: 1, copied: 1 });
  });

  it('sends the file list in batches', async () => {
    const { fake, deployer } = setup();
    const files = Object.fromEntries(
      Array.from({ length: 1001 }, (_, i) => [`f${i}.html`, `content ${i}`]),
    );
    await deployer.deploy({ buildDir: makeBuild(files), now: NOW });
    expect(fake.populateCalls).toBe(2);
    expect(fake.uploads).toHaveLength(1001);
  });

  it('sets the number of versions the site keeps, once', async () => {
    const { fake, deployer } = setup({ retainVersions: 3 });
    const set = fake.api.setMaxVersions;
    let calls = 0;
    fake.api.setMaxVersions = async (site, max) => {
      calls++;
      await set(site, max);
    };
    await deployer.deploy({ buildDir: makeBuild({ 'a.html': '1' }), now: NOW });
    await deployer.deploy({ buildDir: makeBuild({ 'a.html': '2' }), now: LATER });
    expect(fake.maxVersions).toBe(3);
    expect(calls).toBe(1);
  });

  it('reports the version it replaced', async () => {
    const { deployer } = setup();
    await deployer.deploy({ buildDir: makeBuild({ 'a.html': '1' }), now: NOW });
    const second = await deployer.deploy({ buildDir: makeBuild({ 'a.html': '2' }), now: LATER });
    expect(second.previousVersionId).toBe('20261030T120000Z-abc1234');
  });

  it('abandons the version when an upload fails, and leaves production alone', async () => {
    const { fake, deployer } = setup();
    await deployer.deploy({ buildDir: makeBuild({ 'a.html': '1' }), now: NOW });
    fake.failUpload.error = new GoogleApiError('Could not upload: HTTP 400 no', 400);

    await expect(
      deployer.deploy({ buildDir: makeBuild({ 'a.html': '2' }), now: LATER }),
    ).rejects.toMatchObject({ code: ErrorCode.DeployFailed });

    expect([...fake.versions.values()].map((v) => v.status)).toEqual(['FINALIZED', 'ABANDONED']);
    expect(liveReleases(fake)).toHaveLength(1);
  });

  it('reports refused access as a sign-in problem, with what to do', async () => {
    const { fake, deployer } = setup();
    fake.api.createVersion = async () => {
      throw new GoogleApiError('Could not create a version: HTTP 403 denied', 403);
    };
    const error = await deployer
      .deploy({ buildDir: makeBuild({ 'a.html': '1' }), now: NOW })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SforgeError);
    expect(error).toMatchObject({ code: ErrorCode.CloudAuth });
    expect((error as SforgeError).hint).toContain('application-default login');
  });

  it('changes nothing on a dry run', async () => {
    const { fake, deployer } = setup();
    const result = await deployer.deploy({
      buildDir: makeBuild({ 'a.html': '1' }),
      now: NOW,
      dryRun: true,
    });
    expect(result).toMatchObject({ dryRun: true, uploaded: 1, url: `https://${SITE}.web.app` });
    expect(fake.versions.size).toBe(0);
    expect(fake.maxVersions).toBeUndefined();
  });
});

describe('previews', () => {
  it('creates a channel with the configured time to live, and serves from its URL', async () => {
    const { fake, deployer } = setup({ previewTtlDays: 3 });
    const result = await deployer.deploy({
      buildDir: makeBuild({ 'a.html': '1' }),
      preview: 'pr-42',
      now: NOW,
    });
    expect(result).toMatchObject({
      preview: true,
      versionId: 'pr-42',
      url: `https://${SITE}--pr-42-abc123.web.app`,
    });
    const channel = fake.channels.get(`${SITE}/pr-42`);
    expect(channel?.expireTime).toBe(`+${3 * 86400}s`);
    expect(channel?.release?.version?.status).toBe('FINALIZED');
    expect(liveReleases(fake)).toHaveLength(0);
  });

  it('gives the build the channel URL, before the deploy', async () => {
    const { fake, deployer } = setup();
    expect(await deployer.previewBaseUrl?.('pr-7')).toBe(`https://${SITE}--pr-7-abc123.web.app`);
    expect(fake.channels.has(`${SITE}/pr-7`)).toBe(true);
  });

  it('does not create a channel for a dry run', async () => {
    const { fake, deployer } = setup();
    expect(await deployer.previewBaseUrl?.('pr-7', { dryRun: true })).toBeUndefined();
    expect(fake.channels.size).toBe(0);
  });

  it('renews the time to live when a preview is deployed again', async () => {
    const { fake, deployer } = setup();
    const buildDir = makeBuild({ 'a.html': '1' });
    await deployer.deploy({ buildDir, preview: 'pr-42', now: NOW });
    await deployer.deploy({ buildDir, preview: 'pr-42', now: LATER });
    expect(fake.channels.get(`${SITE}/pr-42`)?.expireTime).toContain('renewed');
  });

  it('removes a channel, and says when there was none', async () => {
    const { deployer } = setup();
    await deployer.deploy({ buildDir: makeBuild({ 'a.html': '1' }), preview: 'pr-1', now: NOW });
    expect(await deployer.destroyPreview('pr-1')).toMatchObject({ existed: true });
    expect(await deployer.destroyPreview('pr-1')).toMatchObject({ existed: false });
  });

  it('refuses the production channel as a preview', async () => {
    const { fake, deployer } = setup();
    await expect(
      deployer.deploy({ buildDir: makeBuild({ 'a.html': '1' }), preview: 'live', now: NOW }),
    ).rejects.toMatchObject({ code: ErrorCode.Usage });
    await expect(deployer.destroyPreview('live')).rejects.toMatchObject({ code: ErrorCode.Usage });
    expect(fake.versions.size).toBe(0);
  });
});

describe('versions and rollback', () => {
  async function deployTwo() {
    const { fake, deployer } = setup();
    await deployer.deploy({ buildDir: makeBuild({ 'a.html': '1' }), now: NOW, gitSha: 'aaaa111' });
    await deployer.deploy({
      buildDir: makeBuild({ 'a.html': '2' }),
      now: LATER,
      gitSha: 'bbbb222',
    });
    return { fake, deployer };
  }

  it('lists versions newest first and marks the active one', async () => {
    const { deployer } = await deployTwo();
    const versions = await deployer.versions();
    expect(versions.map((v) => [v.id, v.active])).toEqual([
      ['20261031T120000Z-bbbb222', true],
      ['20261030T120000Z-aaaa111', false],
    ]);
    expect(versions[0]).toMatchObject({ gitSha: 'bbbb222', files: 1, preview: false });
  });

  it('lists previews after production, without the live channel', async () => {
    const { deployer } = await deployTwo();
    await deployer.deploy({ buildDir: makeBuild({ 'a.html': '3' }), preview: 'pr-5', now: LATER });
    const previews = (await deployer.versions()).filter((v) => v.preview);
    expect(previews.map((v) => v.id)).toEqual(['pr-5']);
    expect(previews[0]?.url).toBe(`https://${SITE}--pr-5-abc123.web.app`);
  });

  it('rolls back by releasing the earlier version again, without new files', async () => {
    const { fake, deployer } = await deployTwo();
    const versionsBefore = fake.versions.size;
    fake.uploads.length = 0;

    const result = await deployer.rollback();

    expect(result).toMatchObject({
      versionId: '20261030T120000Z-aaaa111',
      previousVersionId: '20261031T120000Z-bbbb222',
      url: `https://${SITE}.web.app`,
    });
    expect(fake.versions.size).toBe(versionsBefore);
    expect(fake.uploads).toHaveLength(0);
    expect((await deployer.current()).versionId).toBe('20261030T120000Z-aaaa111');
  });

  it('keeps a version listed once after it has been released twice', async () => {
    const { deployer } = await deployTwo();
    await deployer.rollback();
    const versions = await deployer.versions();
    expect(versions.map((v) => [v.id, v.active])).toEqual([
      ['20261031T120000Z-bbbb222', false],
      ['20261030T120000Z-aaaa111', true],
    ]);
  });

  it('rolls forward to a named version, by id or by commit', async () => {
    const { deployer } = await deployTwo();
    await deployer.rollback();
    expect((await deployer.rollback('bbbb')).versionId).toBe('20261031T120000Z-bbbb222');
    expect((await deployer.rollback('20261030T120000Z-aaaa111')).versionId).toBe(
      '20261030T120000Z-aaaa111',
    );
  });

  it('refuses what cannot be rolled back to', async () => {
    const { deployer } = await deployTwo();
    await expect(deployer.rollback('nope')).rejects.toMatchObject({
      code: ErrorCode.VersionNotFound,
    });
    await expect(deployer.rollback('bbbb222')).rejects.toMatchObject({ code: ErrorCode.Usage });
    await deployer.rollback();
    await expect(deployer.rollback()).rejects.toMatchObject({ code: ErrorCode.VersionNotFound });
  });

  it('refuses to roll back when nothing is live', async () => {
    const { deployer } = setup();
    await expect(deployer.rollback()).rejects.toMatchObject({ code: ErrorCode.VersionNotFound });
    expect((await deployer.current()).versionId).toBeNull();
  });

  it('leaves out versions Firebase has deleted', async () => {
    const { fake, deployer } = await deployTwo();
    const oldest = [...fake.versions.values()][0]!;
    oldest.status = 'DELETED';
    expect((await deployer.versions()).map((v) => v.id)).toEqual(['20261031T120000Z-bbbb222']);
    await expect(deployer.rollback()).rejects.toMatchObject({ code: ErrorCode.VersionNotFound });
  });

  it('shows a version deployed with other tools under its Firebase id', async () => {
    const { fake, deployer } = setup();
    const version = await fake.api.createVersion(SITE, {
      config: { headers: [], cleanUrls: true },
      labels: {},
    });
    await fake.api.setVersionStatus(version.name, 'FINALIZED');
    await fake.api.createRelease(SITE, 'live', version.name, 'by hand');
    expect((await deployer.versions())[0]?.id).toBe(version.name.split('/').pop());
  });

  it('counts a site disabled in the console as nothing live', async () => {
    const { fake, deployer } = await deployTwo();
    const releases = fake.releases.get(`${SITE}/live`)!;
    releases.unshift({ name: 'sites/x/releases/off', type: 'SITE_DISABLE' });
    expect((await deployer.current()).versionId).toBeNull();
  });
});

describe('private targets', () => {
  it('refuses to deploy a target that asks for sign-in', () => {
    const fake = fakeFirebase();
    expect(() =>
      createFirebaseDeployer(
        deployerContext(firebaseConfig({ auth: { providers: ['aad'] } })),
        fake.clients,
      ),
    ).toThrowError(expect.objectContaining({ code: ErrorCode.Unsupported }));
  });
});
