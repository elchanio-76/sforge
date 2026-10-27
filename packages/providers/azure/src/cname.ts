import { Resolver } from 'node:dns/promises';
import { ErrorCode, type Logger, SforgeError } from '@staticforge/core';

/** DNS lookups for `waitForRecord`, injectable for tests. */
export interface CnameLookup {
  /** Host names of the nameservers of the zone that holds `name`. */
  nameservers(name: string): Promise<string[]>;
  /** The CNAME target of `name` according to `nameserver`; undefined while it has none. */
  cname(name: string, nameserver: string): Promise<string | undefined>;
  /** The TXT values of `name` according to `nameserver`; empty while it has none. */
  txt?(name: string, nameserver: string): Promise<string[]>;
}

/** A record `waitForRecord` waits for. */
export interface ExpectedRecord {
  type: 'CNAME' | 'TXT';
  value: string;
}

const NO_ANSWER = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);
const isNoAnswer = (error: unknown) => NO_ANSWER.has((error as { code?: string }).code ?? '');
const normalize = (name: string) => name.toLowerCase().replace(/\.$/, '');

/**
 * Lookups with Node's resolver. The CNAME is asked of the zone's own
 * nameservers: a recursive resolver asked before the record exists would
 * cache "no such name" for as long as the zone says (often 30 minutes).
 */
export function systemCnameLookup(): CnameLookup {
  const resolver = new Resolver();
  return {
    async nameservers(name) {
      const labels = name.split('.');
      // The name itself has a CNAME (or nothing yet), so its zone is a parent.
      for (let i = 1; i < labels.length - 1; i++) {
        try {
          return await resolver.resolveNs(labels.slice(i).join('.'));
        } catch (error) {
          if (!isNoAnswer(error)) throw error;
        }
      }
      throw new Error(`No nameservers found for ${name}`);
    },
    async cname(name, nameserver) {
      const direct = new Resolver();
      direct.setServers(await resolver.resolve4(nameserver));
      try {
        return (await direct.resolveCname(name))[0];
      } catch (error) {
        if (isNoAnswer(error)) return undefined;
        throw error;
      }
    },
    async txt(name, nameserver) {
      const direct = new Resolver();
      direct.setServers(await resolver.resolve4(nameserver));
      try {
        // Long TXT values arrive in chunks of up to 255 characters.
        return (await direct.resolveTxt(name)).map((chunks) => chunks.join(''));
      } catch (error) {
        if (isNoAnswer(error)) return [];
        throw error;
      }
    },
  };
}

export interface WaitForCnameOptions {
  lookup?: CnameLookup;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const HOUR = 60 * 60_000;

/**
 * Resolve once every nameserver of the zone answers `name` with a CNAME to
 * `target`. Azure checks the CNAME when a custom domain is added and refuses
 * it (`CNAME Record is invalid`) if it does not resolve yet.
 */
export function waitForCname(
  name: string,
  target: string,
  logger: Logger,
  options: WaitForCnameOptions = {},
): Promise<void> {
  return waitForRecord(name, { type: 'CNAME', value: target }, logger, options);
}

/**
 * Resolve once every nameserver of the zone that holds `name` answers with the
 * record: a CNAME to the value, or a TXT record with the value among others
 * (domain validation tokens).
 */
export async function waitForRecord(
  name: string,
  record: ExpectedRecord,
  logger: Logger,
  options: WaitForCnameOptions = {},
): Promise<void> {
  const lookup = options.lookup ?? systemCnameLookup();
  const interval = options.intervalMs ?? 10_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (options.timeoutMs ?? HOUR);
  const cname = record.type === 'CNAME';
  const wanted = cname ? normalize(record.value) : record.value;
  // "is a CNAME to …", "has the TXT value …"
  const state = cname ? `is a CNAME to ${record.value}` : `has the TXT value ${record.value}`;
  let announced = false;
  let wrong: string | undefined;
  for (;;) {
    try {
      const servers = await lookup.nameservers(name);
      let found: boolean[];
      if (cname) {
        const answers = await Promise.all(servers.map((s) => lookup.cname(name, s)));
        const targets = answers.map((a) => (a === undefined ? undefined : normalize(a)));
        found = targets.map((a) => a === wanted);
        const other = targets.find((a) => a !== undefined && a !== wanted);
        if (other !== undefined && other !== wrong) {
          wrong = other;
          logger.warn(`${name} is a CNAME to ${other}; it must point to ${record.value}`);
        }
      } else {
        if (lookup.txt === undefined) throw new Error('TXT lookups are not supported');
        const answers = await Promise.all(servers.map((s) => lookup.txt!(name, s)));
        found = answers.map((values) => values.includes(wanted));
      }
      if (servers.length > 0 && found.every(Boolean)) {
        if (announced) {
          logger.info(cname ? `${name} resolves to ${record.value}` : `${name} ${state}`);
        }
        return;
      }
      if (!announced) {
        announced = true;
        logger.info(`Waiting until ${name} ${state} (${servers.join(', ')})`);
      }
    } catch (error) {
      logger.debug(`DNS lookup for ${name} failed: ${(error as Error).message}`);
    }
    if (Date.now() >= deadline) {
      const missing = cname
        ? `become a CNAME to ${record.value}`
        : `get the TXT value ${record.value}`;
      throw new SforgeError(ErrorCode.IacFailed, `${name} did not ${missing} in time`, {
        hint: 'Check the record at your DNS provider, then run `sforge provision` again.',
      });
    }
    await sleep(interval);
  }
}
