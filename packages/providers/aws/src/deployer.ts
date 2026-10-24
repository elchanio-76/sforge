import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import {
  DescribeKeyValueStoreCommand,
  UpdateKeysCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { type AwsTargetConfig, ErrorCode, SforgeError } from '@staticforge/core';
import {
  type BuildManifest,
  type DeployOptions,
  type DeployResult,
  type DeployedVersion,
  type Deployer,
  type DeployerContext,
  type PreviewDestroyResult,
  type RollbackResult,
  assertPreviewId,
  cacheControl,
  contentType,
  diffManifests,
  gitShortSha,
  mapLimit,
  newVersionId,
  publishedFiles,
  readManifest,
} from '@staticforge/provider-api';
import { type AwsClients, awsError, defaultClients, errorName, httpStatus } from './clients.js';
import { type TrailingSlash, routeExceptions } from './routing.js';

/** Bookkeeping objects; the router never serves them (every URL is prefixed with v/<id>/). */
const VERSIONS_KEY = '_sforge/versions.json';
const ERROR_PAGE_KEY = '_sforge/errors/404.html';
const manifestKey = (id: string) => `_sforge/manifests/${id}.json`;
const versionPrefix = (id: string) => `v/${id}/`;

/** Outputs of terraform/modules/site the deployer needs. */
export const REQUIRED_OUTPUTS = ['bucket', 'bucket_region', 'kvs_arn', 'distribution_id', 'url'];

const UPLOAD_CONCURRENCY = 16;
/** UpdateKeys accepts at most 50 puts and deletes per call. */
const KVS_BATCH = 50;

interface VersionRecord {
  id: string;
  createdAt: string;
  gitSha?: string;
  files: number;
  bytes: number;
  /** Route exception keys stored in the KVS for this version (without the r:<id>: prefix). */
  routes: string[];
}

interface VersionsDocument {
  schemaVersion: 1;
  active: string | null;
  /** Production versions, oldest first. */
  versions: VersionRecord[];
  previews: VersionRecord[];
}

const emptyDocument = (): VersionsDocument => ({
  schemaVersion: 1,
  active: null,
  versions: [],
  previews: [],
});

interface Outputs {
  bucket: string;
  region: string;
  kvsArn: string;
  distributionId: string;
  url: string;
  previewDomain: string | null;
  trailingSlash: TrailingSlash;
}

function readOutputs(context: DeployerContext): Outputs {
  const o = context.outputs;
  const missing = REQUIRED_OUTPUTS.filter((name) => typeof o[name] !== 'string');
  if (missing.length > 0) {
    throw new SforgeError(
      ErrorCode.NotProvisioned,
      `Target "${context.targetName}" is missing infrastructure outputs: ${missing.join(', ')}`,
      { hint: `Run \`sforge provision ${context.targetName}\`.` },
    );
  }
  return {
    bucket: o.bucket as string,
    region: o.bucket_region as string,
    kvsArn: o.kvs_arn as string,
    distributionId: o.distribution_id as string,
    url: o.url as string,
    previewDomain: typeof o.preview_domain === 'string' ? o.preview_domain : null,
    trailingSlash:
      o.trailing_slash === 'never' || o.trailing_slash === 'always'
        ? o.trailing_slash
        : context.config.build.trailingSlash,
  };
}

/** S3 CopySource: bucket/key, URL-encoded per segment. */
const copySource = (bucket: string, key: string) =>
  `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

export function createAwsDeployer(
  context: DeployerContext,
  clients: AwsClients = defaultClients(),
): Deployer {
  const target = context.target as AwsTargetConfig;
  const { logger } = context;
  let resolved: Outputs | undefined;
  const out = () => (resolved ??= readOutputs(context));
  const s3 = () => clients.s3(out().region);

  async function getJson<T>(key: string): Promise<{ value: T; etag: string } | undefined> {
    try {
      const response = await s3().send(new GetObjectCommand({ Bucket: out().bucket, Key: key }));
      const text = await response.Body!.transformToString('utf8');
      return { value: JSON.parse(text) as T, etag: response.ETag! };
    } catch (error) {
      if (errorName(error) === 'NoSuchKey' || httpStatus(error) === 404) return undefined;
      throw awsError(error, `Could not read s3://${out().bucket}/${key}`);
    }
  }

  async function putJson(
    key: string,
    value: unknown,
    condition?: { ifMatch?: string; ifNoneMatch?: string },
  ) {
    try {
      await s3().send(
        new PutObjectCommand({
          Bucket: out().bucket,
          Key: key,
          Body: `${JSON.stringify(value, null, 2)}\n`,
          ContentType: 'application/json',
          CacheControl: 'no-store',
          ...(condition?.ifMatch && { IfMatch: condition.ifMatch }),
          ...(condition?.ifNoneMatch && { IfNoneMatch: condition.ifNoneMatch }),
        }),
      );
    } catch (error) {
      if (
        httpStatus(error) === 412 ||
        errorName(error) === 'PreconditionFailed' ||
        httpStatus(error) === 409
      ) {
        throw new SforgeError(
          ErrorCode.DeployFailed,
          `Another deploy to "${context.targetName}" changed ${key} at the same time`,
          { hint: `Check \`sforge versions ${context.targetName}\`, then deploy again.` },
        );
      }
      throw awsError(error, `Could not write s3://${out().bucket}/${key}`);
    }
  }

  async function loadDocument() {
    const found = await getJson<VersionsDocument>(VERSIONS_KEY);
    return found === undefined
      ? { doc: emptyDocument(), etag: undefined }
      : { doc: found.value, etag: found.etag };
  }

  const saveDocument = (doc: VersionsDocument, etag: string | undefined) =>
    putJson(VERSIONS_KEY, doc, etag === undefined ? { ifNoneMatch: '*' } : { ifMatch: etag });

  async function listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await s3().send(
        new ListObjectsV2Command({
          Bucket: out().bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return keys;
  }

  async function deleteKeys(keys: string[]): Promise<number> {
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      const result = await s3().send(
        new DeleteObjectsCommand({
          Bucket: out().bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      if (result.Errors !== undefined && result.Errors.length > 0) {
        throw new SforgeError(
          ErrorCode.DeployFailed,
          `Could not delete ${result.Errors.length} objects (${result.Errors[0]?.Key}: ${result.Errors[0]?.Message})`,
        );
      }
    }
    return keys.length;
  }

  async function updateKvs(puts: Record<string, string>, deletes: string[] = []): Promise<void> {
    const changes: ({ put: [string, string] } | { del: string })[] = [
      ...Object.entries(puts).map(([k, v]) => ({ put: [k, v] as [string, string] })),
      ...deletes.filter((k) => !(k in puts)).map((k) => ({ del: k })),
    ];
    if (changes.length === 0) return;
    const kvs = clients.kvs();
    let etag = (await kvs.send(new DescribeKeyValueStoreCommand({ KvsARN: out().kvsArn }))).ETag;
    for (let i = 0; i < changes.length; i += KVS_BATCH) {
      const batch = changes.slice(i, i + KVS_BATCH);
      const response = await kvs.send(
        new UpdateKeysCommand({
          KvsARN: out().kvsArn,
          IfMatch: etag,
          Puts: batch.flatMap((c) => ('put' in c ? [{ Key: c.put[0], Value: c.put[1] }] : [])),
          Deletes: batch.flatMap((c) => ('del' in c ? [{ Key: c.del }] : [])),
        }),
      );
      etag = response.ETag;
    }
  }

  const routeKey = (id: string, key: string) => `r:${id}:${key}`;

  /** Point CloudFront's 404 page at a version (error responses bypass the router). */
  async function publishErrorPage(id: string, manifest: BuildManifest | undefined): Promise<void> {
    if (manifest !== undefined && manifest.files['404.html'] === undefined) return;
    await s3().send(
      new CopyObjectCommand({
        Bucket: out().bucket,
        Key: ERROR_PAGE_KEY,
        CopySource: copySource(out().bucket, `${versionPrefix(id)}404.html`),
        MetadataDirective: 'REPLACE',
        ContentType: 'text/html; charset=utf-8',
        CacheControl: 'public, max-age=0, must-revalidate',
      }),
    );
  }

  async function removeVersion(
    record: VersionRecord,
    extraKvsDeletes: string[] = [],
  ): Promise<number> {
    const deleted = await deleteKeys(await listKeys(versionPrefix(record.id)));
    await deleteKeys([manifestKey(record.id)]);
    await updateKvs({}, [...record.routes.map((k) => routeKey(record.id, k)), ...extraKvsDeletes]);
    return deleted;
  }

  const previewUrl = (id: string) => `https://${id}.${out().previewDomain}`;

  return {
    previewBaseUrl: (id) =>
      target.previewDomain === undefined ? undefined : `https://${id}.${target.previewDomain}`,

    async current() {
      const { doc } = await loadDocument();
      return { url: out().url, versionId: doc.active };
    },

    async versions(): Promise<DeployedVersion[]> {
      const { doc } = await loadDocument();
      const toVersion = (r: VersionRecord, preview: boolean): DeployedVersion => ({
        id: r.id,
        createdAt: r.createdAt,
        ...(r.gitSha && { gitSha: r.gitSha }),
        files: r.files,
        bytes: r.bytes,
        active: !preview && r.id === doc.active,
        preview,
        ...(preview && out().previewDomain !== null && { url: previewUrl(r.id) }),
      });
      return [
        ...[...doc.versions].reverse().map((r) => toVersion(r, false)),
        ...doc.previews.map((r) => toVersion(r, true)),
      ];
    },

    async deploy(options: DeployOptions): Promise<DeployResult> {
      const o = out();
      const manifest = readManifest(options.buildDir);
      const preview = options.preview;
      if (preview !== undefined) {
        assertPreviewId(preview);
        if (o.previewDomain === null) {
          throw new SforgeError(
            ErrorCode.Unsupported,
            `Target "${context.targetName}" has no previewDomain, so it cannot serve PR previews`,
            {
              hint:
                'On AWS, previews are served at <id>.<previewDomain> with a wildcard certificate: ' +
                `set targets.${context.targetName}.domain and previewDomain, then run \`sforge provision ${context.targetName}\`.`,
            },
          );
        }
      }

      const { doc, etag } = await loadDocument();
      const gitSha = options.gitSha ?? gitShortSha(context.rootDir, context.env);
      const id = preview ?? newVersionId(options.now ?? new Date(), gitSha);
      if (preview === undefined && doc.versions.some((v) => v.id === id)) {
        throw new SforgeError(
          ErrorCode.DeployFailed,
          `Version ${id} already exists; deploy again in a second`,
        );
      }
      const existingPreview =
        preview === undefined ? undefined : doc.previews.find((p) => p.id === preview);
      const previousId = preview === undefined ? (doc.active ?? undefined) : existingPreview?.id;
      const previous =
        previousId === undefined
          ? undefined
          : (await getJson<BuildManifest>(manifestKey(previousId)))?.value;
      const diff = diffManifests(manifest, previous, preview !== undefined);
      const files = publishedFiles(manifest);
      const routes = routeExceptions(
        files.map(([path]) => path),
        o.trailingSlash,
        id,
      );
      for (const url of routes.skipped)
        logger.warn(`URL too long for the CloudFront router, not served as locally: ${url}`);

      const count = (change: string) => diff.files.filter((f) => f.change === change).length;
      const bytes = diff.files
        .filter((f) => f.change === 'upload')
        .reduce((sum, f) => sum + f.entry.size, 0);
      const url = preview === undefined ? o.url : previewUrl(preview);
      const result: DeployResult = {
        target: context.targetName,
        provider: 'aws',
        versionId: id,
        url,
        preview: preview !== undefined,
        uploaded: count('upload'),
        copied: count('copy'),
        skipped: count('unchanged'),
        deleted: diff.removed.length,
        bytes,
        pruned: [],
        invalidated: false,
        dryRun: options.dryRun === true,
        ...(previousId !== undefined && { previousVersionId: previousId }),
      };
      if (options.dryRun) return result;

      const prefix = versionPrefix(id);
      logger.info(
        `Uploading ${result.uploaded} files to s3://${o.bucket}/${prefix}` +
          (result.copied > 0 ? `, copying ${result.copied} unchanged` : ''),
      );
      try {
        await mapLimit(diff.files, UPLOAD_CONCURRENCY, async (file) => {
          if (file.change === 'unchanged') return;
          const key = `${prefix}${file.path}`;
          if (file.change === 'copy') {
            await s3().send(
              new CopyObjectCommand({
                Bucket: o.bucket,
                Key: key,
                CopySource: copySource(o.bucket, `${versionPrefix(previousId!)}${file.path}`),
              }),
            );
            return;
          }
          await s3().send(
            new PutObjectCommand({
              Bucket: o.bucket,
              Key: key,
              Body: createReadStream(join(options.buildDir, file.path)),
              ContentLength: file.entry.size,
              ContentType: contentType(file.path),
              CacheControl: cacheControl(file.entry.cache),
              ChecksumSHA256: Buffer.from(file.entry.sha256, 'hex').toString('base64'),
              Metadata: { sha256: file.entry.sha256 },
            }),
          );
          logger.debug(`uploaded ${file.path}`);
        });
        if (diff.removed.length > 0)
          await deleteKeys(diff.removed.map((path) => `${prefix}${path}`));
        await putJson(manifestKey(id), manifest);

        const routeKeys = Object.keys(routes.entries);
        await updateKvs(
          Object.fromEntries(Object.entries(routes.entries).map(([k, v]) => [routeKey(id, k), v])),
          (existingPreview?.routes ?? [])
            .filter((k) => !(k in routes.entries))
            .map((k) => routeKey(id, k)),
        );

        // Smoke check: the new version is complete in S3 before it goes live.
        const probe = manifest.files['index.html'] !== undefined ? 'index.html' : files[0]?.[0];
        if (probe !== undefined) {
          await s3().send(new HeadObjectCommand({ Bucket: o.bucket, Key: `${prefix}${probe}` }));
        }

        const record: VersionRecord = {
          id,
          createdAt: (options.now ?? new Date()).toISOString(),
          ...(gitSha && { gitSha }),
          files: files.length,
          bytes: files.reduce((sum, [, entry]) => sum + entry.size, 0),
          routes: routeKeys,
        };
        if (preview === undefined) {
          await publishErrorPage(id, manifest);
          await updateKvs({ active: id });
          logger.info(`Version ${id} is live at ${o.url}`);
          doc.active = id;
          doc.versions.push(record);
          const excess = doc.versions.length - target.retainVersions;
          if (excess > 0) {
            const old = doc.versions.filter((v) => v.id !== id).slice(0, excess);
            for (const version of old) {
              logger.info(`Removing old version ${version.id}`);
              await removeVersion(version);
              result.pruned.push(version.id);
            }
            doc.versions = doc.versions.filter((v) => !result.pruned.includes(v.id));
          }
        } else {
          await updateKvs({ [`host:${preview}`]: id });
          logger.info(`Preview ${preview} is live at ${url}`);
          doc.previews = [...doc.previews.filter((p) => p.id !== preview), record];
        }
        await saveDocument(doc, etag);

        if (options.invalidate) {
          await clients.cloudfront().send(
            new CreateInvalidationCommand({
              DistributionId: o.distributionId,
              InvalidationBatch: {
                CallerReference: `sforge-${id}-${Date.now()}`,
                Paths: { Quantity: 1, Items: ['/*'] },
              },
            }),
          );
          result.invalidated = true;
        }
      } catch (error) {
        throw awsError(error, `Deploy to "${context.targetName}" failed`);
      }
      return result;
    },

    async rollback(to?: string): Promise<RollbackResult> {
      const { doc, etag } = await loadDocument();
      if (doc.active === null) {
        throw new SforgeError(
          ErrorCode.VersionNotFound,
          `Nothing has been deployed to "${context.targetName}"`,
        );
      }
      const index = doc.versions.findIndex((v) => v.id === doc.active);
      const version =
        to === undefined ? doc.versions[index - 1] : doc.versions.find((v) => v.id === to);
      if (version === undefined) {
        const known = doc.versions.map((v) => v.id);
        throw new SforgeError(
          ErrorCode.VersionNotFound,
          to === undefined
            ? `There is no version before ${doc.active} to roll back to`
            : `Version ${to} is not retained for "${context.targetName}"`,
          {
            details: { versions: known },
            hint: `List versions with \`sforge versions ${context.targetName}\`.`,
          },
        );
      }
      const previous = doc.active;
      try {
        const manifest = (await getJson<BuildManifest>(manifestKey(version.id)))?.value;
        await publishErrorPage(version.id, manifest);
        await updateKvs({ active: version.id });
        doc.active = version.id;
        await saveDocument(doc, etag);
      } catch (error) {
        throw awsError(error, `Rollback of "${context.targetName}" failed`);
      }
      logger.info(`"${context.targetName}" now serves ${version.id}`);
      return {
        target: context.targetName,
        versionId: version.id,
        previousVersionId: previous,
        url: out().url,
      };
    },

    async destroyPreview(previewId: string): Promise<PreviewDestroyResult> {
      assertPreviewId(previewId);
      const { doc, etag } = await loadDocument();
      const record = doc.previews.find((p) => p.id === previewId);
      try {
        const deleted = record
          ? await removeVersion(record, [`host:${previewId}`])
          : await deleteKeys(await listKeys(versionPrefix(previewId)));
        if (record !== undefined) {
          doc.previews = doc.previews.filter((p) => p.id !== previewId);
          await saveDocument(doc, etag);
        }
        return { target: context.targetName, previewId, deleted, existed: record !== undefined };
      } catch (error) {
        throw awsError(error, `Removing preview ${previewId} failed`);
      }
    },
  };
}
