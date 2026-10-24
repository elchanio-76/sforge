import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import { type BuildResult, buildSite } from '@staticforge/build';
import {
  type Diagnostic,
  type LoadedConfig,
  type Logger,
  type SerializedError,
  toSforgeError,
} from '@staticforge/core';
import { LiveReload, type LiveState, injectClient } from './live-reload.js';
import { type StaticServer, startStaticServer } from './static-server.js';

export interface DevServerOptions {
  /** Loads (and re-loads, when it changes) the project config. */
  loadConfig: () => Promise<LoadedConfig>;
  host: string;
  port: number;
  drafts?: boolean;
  generator?: string;
  logger?: Logger;
  /** Called after every build attempt, including the first. */
  onBuild?: (state: DevBuildState) => void;
  /** Milliseconds to wait for more file changes before rebuilding (minimum 60). */
  debounceMs?: number;
}

export interface DevBuildState {
  id: number;
  ok: boolean;
  /** Project-relative paths that triggered this build (empty for the first). */
  changed: string[];
  result?: BuildResult;
  /** Set when the build could not run; the previous build keeps being served. */
  error?: SerializedError;
}

export interface DevServer extends StaticServer {
  rootDir: string;
  /** The most recent build attempt. */
  readonly state: DevBuildState;
  /** Resolves after the next build attempt completes. */
  nextBuild(): Promise<DevBuildState>;
}

/** chokidar's per-file throttle window for `change` events. */
const CHOKIDAR_CHANGE_THROTTLE_MS = 50;

/** Old build directories are removed after a grace period so in-flight responses can finish. */
const RETIRE_AFTER_MS = 5_000;

/**
 * Build the site into a temp directory, serve it with live reload, and
 * rebuild on every change to the project. Never writes to build.outDir.
 */
export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const { logger } = options;
  let loaded = await options.loadConfig();
  const rootDir = loaded.rootDir;
  const scratch = mkdtempSync(join(tmpdir(), 'sforge-dev-'));
  const live = new LiveReload();

  let servedDir = join(scratch, 'empty');
  let buildCount = 0;
  let state: DevBuildState = { id: 0, ok: false, changed: [] };
  let waiters: ((s: DevBuildState) => void)[] = [];
  const retiring = new Set<NodeJS.Timeout>();

  const publish = (cssOnly: boolean) => {
    const liveState: LiveState = {
      id: state.id,
      cssOnly,
      diagnostics: state.result?.diagnostics ?? [],
      pages: state.result?.pages.map((p) => ({ url: p.url, source: p.source })) ?? [],
      ...(state.error !== undefined && { error: state.error }),
    };
    live.publish(liveState);
  };

  const build = async (changed: string[]): Promise<void> => {
    const id = ++buildCount;
    if (changed.includes(relative(rootDir, loaded.path).split(sep).join('/'))) {
      try {
        loaded = await options.loadConfig();
      } catch (error) {
        state = { id, ok: false, changed, error: toSforgeError(error).toJSON() };
        publish(false);
        return;
      }
    }

    const outDir = join(scratch, `build-${id}`);
    try {
      const result = await buildSite({
        rootDir,
        config: loaded.config,
        scratchDir: outDir,
        ...(options.drafts !== undefined && { drafts: options.drafts }),
        ...(options.generator !== undefined && { generator: options.generator }),
        ...(logger !== undefined && { logger }),
      });
      const previous = servedDir;
      servedDir = outDir;
      const timer = setTimeout(() => {
        retiring.delete(timer);
        rmSync(previous, { recursive: true, force: true });
      }, RETIRE_AFTER_MS);
      timer.unref();
      retiring.add(timer);
      state = { id, ok: result.ok, changed, result };
    } catch (error) {
      rmSync(outDir, { recursive: true, force: true });
      state = { id, ok: false, changed, error: toSforgeError(error).toJSON() };
    }
    publish(changed.length > 0 && changed.every((path) => path.endsWith('.css')));
  };

  const finish = () => {
    options.onBuild?.(state);
    const pending = waiters;
    waiters = [];
    for (const resolveWaiter of pending) resolveWaiter(state);
  };

  await build([]);
  finish();

  // chokidar drops repeat `change` events for a file within 50ms of the last
  // one (leading-edge throttle, no trailing event). Waiting longer than that
  // after the last event before every build means each build reads the
  // latest contents even when a repeat event was dropped.
  const quietMs = Math.max(options.debounceMs ?? 75, CHOKIDAR_CHANGE_THROTTLE_MS + 10);
  let lastChange = 0;
  let building = false;
  let queued = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  // Serialize builds: changes during a build schedule exactly one more.
  const run = async () => {
    if (building) return;
    building = true;
    while (queued.size > 0) {
      const wait = lastChange + quietMs - Date.now();
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const changed = [...queued].sort();
      queued = new Set();
      await build(changed);
      finish();
    }
    building = false;
  };
  const schedule = (path: string) => {
    lastChange = Date.now();
    queued.add(relative(rootDir, path).split(sep).join('/'));
    clearTimeout(timer);
    timer = setTimeout(() => void run(), quietMs);
  };

  const outDir = resolve(rootDir, loaded.config.build.outDir);
  const ignored = (path: string): boolean => {
    const rel = relative(rootDir, path);
    if (rel === '' || rel.startsWith('..')) return false;
    if (path === outDir || path.startsWith(outDir + sep)) return true;
    return rel.split(sep).some((part) => part.startsWith('.') || part === 'node_modules');
  };
  const watcher: FSWatcher = watch(rootDir, { ignoreInitial: true, ignored });
  watcher.on('all', (_event, path) => schedule(path));
  await new Promise<void>((resolveReady) => watcher.once('ready', () => resolveReady()));

  let server: StaticServer;
  try {
    server = await startStaticServer({
      root: () => servedDir,
      host: options.host,
      port: options.port,
      trailingSlash: loaded.config.build.trailingSlash,
      transformHtml: injectClient,
      handle: live.handle,
      cacheControl: 'no-store',
    });
  } catch (error) {
    await watcher.close();
    live.close();
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }

  return {
    ...server,
    rootDir,
    get state() {
      return state;
    },
    nextBuild: () => new Promise((resolveWaiter) => waiters.push(resolveWaiter)),
    close: async () => {
      clearTimeout(timer);
      for (const t of retiring) clearTimeout(t);
      await watcher.close();
      live.close();
      await server.close();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/** Diagnostics worth printing for a build, errors first. */
export function problemsOf(state: DevBuildState): Diagnostic[] {
  return state.result?.diagnostics.filter((d) => d.severity !== 'info') ?? [];
}
