import { threadId } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { type WorkerPool, createWorkerPool, mapInPool, poolSize } from '../src/pool.js';
import { double } from './fixtures/tasks.js';

const tasks = new URL('./fixtures/tasks.ts', import.meta.url).href;
const task = (fn: string) => ({ module: tasks, fn });

let pool: WorkerPool | undefined;
afterEach(async () => {
  await pool?.close();
  pool = undefined;
});

describe('worker pool', () => {
  it('runs tasks in worker threads, keeping the order of the items', async () => {
    pool = createWorkerPool(3);
    const items = Array.from({ length: 100 }, (_, i) => i);
    const doubled = await mapInPool(pool, task('double'), items, {}, double);
    expect(doubled).toEqual(items.map((n) => n * 2));
    expect(await pool.run(task('where'), undefined)).not.toBe(threadId);
  });

  it('runs in this thread without a pool, or for fewer items than minItems', async () => {
    let calls = 0;
    const local = (input: { items: number[] }) => {
      calls++;
      return double(input);
    };
    expect(await mapInPool(undefined, task('double'), [1, 2], {}, local)).toEqual([2, 4]);
    pool = createWorkerPool(2);
    expect(await mapInPool(pool, task('double'), [3], {}, local, { minItems: 5 })).toEqual([6]);
    expect(calls).toBe(2);
  });

  it('rejects with the error of a failing task and keeps working', async () => {
    pool = createWorkerPool(1);
    await expect(pool.run(task('fail'), undefined)).rejects.toThrow('task failed');
    await expect(pool.run(task('missing'), undefined)).rejects.toThrow('has no function "missing"');
    expect(await pool.run(task('double'), { items: [4] })).toEqual([8]);
  });

  it('replaces a worker that exits', async () => {
    pool = createWorkerPool(1);
    await expect(pool.run(task('crash'), undefined)).rejects.toThrow('exited with code 7');
    expect(await pool.run(task('double'), { items: [5] })).toEqual([10]);
  });

  it('rejects queued tasks when closed', async () => {
    pool = createWorkerPool(1);
    const running = expect(pool.run(task('double'), { items: [1] })).rejects.toThrow('closed');
    const queued = expect(pool.run(task('double'), { items: [2] })).rejects.toThrow('closed');
    await pool.close();
    await Promise.all([running, queued]);
    await expect(pool.run(task('double'), { items: [3] })).rejects.toThrow('closed');
  });

  it('sizes the pool from the setting, overridden by SFORGE_WORKERS', () => {
    expect(poolSize(3, {})).toBe(3);
    expect(poolSize('auto', {})).toBeGreaterThanOrEqual(1);
    expect(poolSize('auto', { SFORGE_WORKERS: '0' })).toBe(0);
    expect(poolSize(4, { SFORGE_WORKERS: 'many' })).toBe(4);
  });
});
