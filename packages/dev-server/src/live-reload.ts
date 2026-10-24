import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Diagnostic, SerializedError } from '@staticforge/core';

export const EVENTS_PATH = '/__sforge/events';
export const CLIENT_PATH = '/__sforge/client.js';

/** What the browser client receives after every build. */
export interface LiveState {
  /** Increments with each build; a change tells the client to refresh. */
  id: number;
  /** Only stylesheets changed, so the client swaps them without a reload. */
  cssOnly: boolean;
  diagnostics: Diagnostic[];
  /** Maps URLs to sources, so the overlay shows each page's own problems. */
  pages: { url: string; source: string | undefined }[];
  /** Set when the build could not run at all (e.g. invalid config). */
  error?: SerializedError;
}

/** Browser client (client/live-client.js), resolved from both src/ and dist/. */
const CLIENT = readFileSync(new URL('../client/live-client.js', import.meta.url), 'utf8');

/** Insert the client script into an HTML document. */
export function injectClient(html: string): string {
  const tag = `<script type="module" src="${CLIENT_PATH}"></script>`;
  const head = /<\/head\s*>/i.exec(html);
  return head ? html.slice(0, head.index) + tag + html.slice(head.index) : tag + html;
}

/** Server side of live reload: an SSE stream broadcasting LiveState. */
export class LiveReload {
  private readonly clients = new Set<ServerResponse>();
  private state: LiveState | undefined;
  private readonly heartbeat: NodeJS.Timeout;

  constructor() {
    this.heartbeat = setInterval(() => {
      for (const res of this.clients) res.write(': keep-alive\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  /** Handle the client script and event stream routes; returns false for others. */
  handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === CLIENT_PATH) {
      res
        .writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        .end(CLIENT);
      return true;
    }
    if (path !== EVENTS_PATH) return false;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('retry: 1000\n\n');
    if (this.state !== undefined) res.write(this.format(this.state));
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    return true;
  };

  get clientCount(): number {
    return this.clients.size;
  }

  publish(state: LiveState): void {
    this.state = state;
    const message = this.format(state);
    for (const res of this.clients) res.write(message);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.clients) res.end();
    this.clients.clear();
  }

  private format(state: LiveState): string {
    return `event: state\ndata: ${JSON.stringify(state)}\n\n`;
  }
}
