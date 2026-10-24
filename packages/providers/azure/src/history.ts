import type { ContainerClient } from '@azure/storage-blob';
import { ErrorCode, SforgeError } from '@staticforge/core';

/** A production deploy, as recorded in the history. */
export interface VersionEntry {
  id: string;
  createdAt: string;
  gitSha?: string;
  /** Deployed from a working tree with uncommitted changes: a rebuild would not match it. */
  dirty?: boolean;
  files: number;
  bytes: number;
  /** Set when this deploy was a rollback: the version it rebuilt. */
  rollbackOf?: string;
}

/**
 * Static Web Apps keeps no versions of its own, so sforge records production
 * deploys (newest first) in the state container, next to the state files.
 */
export interface HistoryDoc {
  schema: 1;
  active: string | null;
  versions: VersionEntry[];
}

export const emptyHistory = (): HistoryDoc => ({ schema: 1, active: null, versions: [] });

/** Another deploy changed the history since it was read. */
export class HistoryConflict extends Error {
  constructor() {
    super('The deploy history changed while it was being updated');
    this.name = 'HistoryConflict';
  }
}

export interface HistoryStore {
  read(): Promise<{ doc: HistoryDoc; etag: string | undefined }>;
  /** Writes only if the document is still at `etag` (or does not exist, when undefined). */
  write(doc: HistoryDoc, etag: string | undefined): Promise<void>;
}

const statusOf = (error: unknown): number | undefined =>
  (error as { statusCode?: number } | null)?.statusCode;

export function blobHistoryStore(container: ContainerClient, blobName: string): HistoryStore {
  const blob = container.getBlockBlobClient(blobName);
  return {
    async read() {
      try {
        const response = await blob.download();
        const chunks: Buffer[] = [];
        for await (const chunk of response.readableStreamBody as AsyncIterable<Buffer | string>) {
          chunks.push(Buffer.from(chunk));
        }
        const doc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HistoryDoc;
        if (doc.schema !== 1 || !Array.isArray(doc.versions)) {
          throw new SforgeError(
            ErrorCode.DeployFailed,
            `${blobName} is not a staticforge deploy history`,
          );
        }
        return { doc, etag: response.etag };
      } catch (error) {
        if (statusOf(error) === 404) return { doc: emptyHistory(), etag: undefined };
        throw error;
      }
    },
    async write(doc, etag) {
      const body = Buffer.from(`${JSON.stringify(doc, null, 2)}\n`);
      try {
        await blob.upload(body, body.length, {
          blobHTTPHeaders: { blobContentType: 'application/json' },
          conditions: etag === undefined ? { ifNoneMatch: '*' } : { ifMatch: etag },
        });
      } catch (error) {
        if (statusOf(error) === 412 || statusOf(error) === 409) throw new HistoryConflict();
        throw error;
      }
    },
  };
}
