import { type Command, InvalidArgumentError } from 'commander';
import type { Logger } from '@staticforge/core';

export interface ServerFlags {
  port: number;
  host: string | true | undefined;
  open?: boolean;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError('must be an integer from 0 to 65535 (0 picks a free port)');
  }
  return port;
}

/** Options shared by `dev` and `preview`. */
export function addServerOptions(command: Command, defaultPort: number): Command {
  return command
    .option('-p, --port <port>', 'port to listen on (0 picks a free port)', parsePort, defaultPort)
    .option('--host [address]', 'address to listen on; without a value, all interfaces (0.0.0.0)')
    .option('--open', 'open the site in a browser');
}

/** Listen on loopback unless asked otherwise, and warn when exposing to the network. */
export function hostFrom(flags: ServerFlags, logger: Logger): string {
  if (flags.host === undefined) return '127.0.0.1';
  const host = flags.host === true ? '0.0.0.0' : flags.host;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    logger.warn(`Listening on ${host}: the site is reachable from other machines on the network`);
  }
  return host;
}
