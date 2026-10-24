import { existsSync, readdirSync } from 'node:fs';
import { ErrorCode, SforgeError } from '@staticforge/core';
import { type StaticServer, startStaticServer } from './static-server.js';

export interface PreviewServerOptions {
  /** Absolute path of a built site, usually build.outDir. */
  dir: string;
  host: string;
  port: number;
  trailingSlash: 'always' | 'never';
}

/** Serve an existing build, without watching or live reload. */
export async function startPreviewServer(options: PreviewServerOptions): Promise<StaticServer> {
  if (!existsSync(options.dir) || readdirSync(options.dir).length === 0) {
    throw new SforgeError(
      ErrorCode.NotBuilt,
      `Nothing to preview: ${options.dir} is missing or empty`,
      {
        hint: 'Run `sforge build` first, or use `sforge dev` to build and serve with live reload.',
      },
    );
  }
  return startStaticServer({
    root: () => options.dir,
    host: options.host,
    port: options.port,
    trailingSlash: options.trailingSlash,
  });
}
