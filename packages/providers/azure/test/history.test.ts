import type { ContainerClient } from '@azure/storage-blob';
import { describe, expect, it } from 'vitest';
import { HistoryConflict, blobHistoryStore, emptyHistory } from '../src/index.js';

/** A single-blob stand-in for a container client, with ETag conditions. */
function fakeContainer() {
  const state = { body: undefined as string | undefined, etag: 0, last: undefined as unknown };
  const container = {
    getBlockBlobClient: () => ({
      async download() {
        if (state.body === undefined)
          throw Object.assign(new Error('missing'), { statusCode: 404 });
        const body = state.body;
        return {
          etag: `"${state.etag}"`,
          readableStreamBody: (async function* () {
            yield Buffer.from(body.slice(0, 5));
            yield Buffer.from(body.slice(5));
          })(),
        };
      },
      async upload(body: Buffer, _length: number, options: { conditions: Record<string, string> }) {
        state.last = options;
        const { ifMatch, ifNoneMatch } = options.conditions;
        const exists = state.body !== undefined;
        if (
          (ifNoneMatch === '*' && exists) ||
          (ifMatch !== undefined && ifMatch !== `"${state.etag}"`)
        ) {
          throw Object.assign(new Error('condition'), { statusCode: 412 });
        }
        state.body = body.toString('utf8');
        state.etag++;
      },
    }),
  } as unknown as ContainerClient;
  return { container, state };
}

describe('blob history store', () => {
  it('starts empty when the blob does not exist', async () => {
    const { container } = fakeContainer();
    const { doc, etag } = await blobHistoryStore(container, 'h.json').read();
    expect(doc).toEqual(emptyHistory());
    expect(etag).toBeUndefined();
  });

  it('writes a new document only if none exists, then only at the ETag it read', async () => {
    const { container } = fakeContainer();
    const store = blobHistoryStore(container, 'h.json');
    const first = { ...emptyHistory(), active: 'a' };
    await store.write(first, undefined);
    await expect(store.write(first, undefined)).rejects.toBeInstanceOf(HistoryConflict);

    const read = await store.read();
    expect(read.doc.active).toBe('a');
    await store.write({ ...read.doc, active: 'b' }, read.etag);
    await expect(store.write({ ...read.doc, active: 'c' }, read.etag)).rejects.toBeInstanceOf(
      HistoryConflict,
    );
    expect((await store.read()).doc.active).toBe('b');
  });

  it('rejects a blob that is not a deploy history', async () => {
    const { container, state } = fakeContainer();
    state.body = '{"hello":"world"}';
    await expect(blobHistoryStore(container, 'h.json').read()).rejects.toThrow(/deploy history/);
  });
});
