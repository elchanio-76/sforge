import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import { BuildCache, type BuildResult, buildSite } from '@staticforge/build';
import { CheckCache, checkBuild, finalizeDiagnostics } from '@staticforge/checker';
import {
  type Diagnostic,
  type LoadedConfig,
  type Logger,
  type SerializedError,
  createWorkerPool,
  poolSize,
  toSforgeError,
} from '@staticforge/core';
import { type StaticServer, startStaticServer } from '@staticforge/server';
import { LiveReload, type LiveState, injectClient } from './live-reload.js';

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
  /** Run the checker's static rules after each build (default true). */
  check?: boolean;
}

export interface DevBuildState {
  id: number;
  ok: boolean;
  /** Project-relative paths that triggered this build (empty for the first). */
  changed: string[];
  result?: BuildResult;
  /** Build diagnostics plus static checker findings, de-duplicated. */
  diagnostics: Diagnostic[];
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
  // One pool for the server's lifetime, so rebuilds find their workers warm.
  const size = poolSize(loaded.config.build.workers);
  const pool = size > 0 ? createWorkerPool(size) : undefined;
  // Rebuilds parse and render only what changed.
  const cache = new BuildCache();
  const checkCache = new CheckCache();

  let servedDir = join(scratch, 'empty');
  let buildCount = 0;
  let state: DevBuildState = { id: 0, ok: false, changed: [], diagnostics: [] };
  let waiters: ((s: DevBuildState) => void)[] = [];
  const retiring = new Set<NodeJS.Timeout>();
  // Search indexes being written; the scratch directory is removed only after they settle.
  const indexing = new Set<Promise<void>>();
  const removeScratch = async () => {
    await Promise.allSettled([...indexing]);
    rmSync(scratch, { recursive: true, force: true });
  };

  const publish = (cssOnly: boolean) => {
    const liveState: LiveState = {
      id: state.id,
      cssOnly,
      diagnostics: state.diagnostics,
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
        state = { id, ok: false, changed, diagnostics: [], error: toSforgeError(error).toJSON() };
        publish(false);
        return;
      }
    }

    const outDir = join(scratch, `build-${id}`);
    let writeSearchIndex: (() => Promise<void>) | undefined;
    try {
      const result = await buildSite({
        rootDir,
        config: loaded.config,
        scratchDir: outDir,
        // Stable asset URLs let the client swap stylesheets in place; readable
        // output helps debugging.
        fingerprint: false,
        minify: false,
        ...(pool && { pool }),
        cache,
        // The pages are served before the search index is written.
        deferSearch: (write) => {
          writeSearchIndex = write;
        },
        ...(options.drafts !== undefined && { drafts: options.drafts }),
        ...(options.generator !== undefined && { generator: options.generator }),
        ...(logger !== undefined && { logger }),
      });
      const previous = servedDir;
      servedDir = outDir;
      const timer = setTimeout(() => {
        retiring.delete(timer);
        // The previous build's search index may still be being written into it.
        rmSync(previous, { recursive: true, force: true, maxRetries: 3 });
      }, RETIRE_AFTER_MS);
      timer.unref();
      retiring.add(timer);
      let diagnostics = result.diagnostics;
      if (options.check !== false) {
        // Static rules only: the browser-based ones are too slow for every keystroke.
        const checked = await checkBuild({
          rootDir,
          config: loaded.config,
          build: result,
          headless: false,
          ...(pool && { pool }),
          cache: checkCache,
        });
        diagnostics = finalizeDiagnostics(checked.findings, loaded.config.check.ignore);
      }
      state = { id, ok: result.ok, changed, result, diagnostics };
    } catch (error) {
      rmSync(outDir, { recursive: true, force: true });
      state = { id, ok: false, changed, diagnostics: [], error: toSforgeError(error).toJSON() };
    }
    publish(changed.length > 0 && changed.every((path) => path.endsWith('.css')));
    if (writeSearchIndex !== undefined) {
      const indexed = writeSearchIndex()
        .catch((error: unknown) => {
          // A newer build may already have replaced (and removed) this one.
          if (servedDir === outDir) {
            logger?.warn(
              `Search index failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        })
        .finally(() => indexing.delete(indexed));
      indexing.add(indexed);
    }
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
  let closed = false;
  // The running rebuild loop: close() waits for it, or it would write into a removed scratch directory.
  let loop: Promise<void> | undefined;

  // Serialize builds: changes during a build schedule exactly one more.
  const run = async () => {
    if (building) return;
    building = true;
    while (queued.size > 0 && !closed) {
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
    timer = setTimeout(() => {
      if (closed) return;
      loop ??= run().finally(() => (loop = undefined));
    }, quietMs);
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
    await pool?.close();
    await removeScratch();
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
      closed = true;
      clearTimeout(timer);
      for (const t of retiring) clearTimeout(t);
      await watcher.close();
      await loop;
      live.close();
      await server.close();
      await pool?.close();
      await removeScratch();
    },
  };
}

/** Diagnostics worth printing for a build: errors and warnings. */
export function problemsOf(state: DevBuildState): Diagnostic[] {
  return state.diagnostics.filter((d) => d.severity !== 'info');
}
