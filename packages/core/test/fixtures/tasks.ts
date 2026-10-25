import { threadId } from 'node:worker_threads';

export function double({ items }: { items: number[] }): number[] {
  return items.map((n) => n * 2);
}

export function where(): number {
  return threadId;
}

export async function fail(): Promise<never> {
  throw new Error('task failed');
}

export function crash(): never {
  process.exit(7);
}
