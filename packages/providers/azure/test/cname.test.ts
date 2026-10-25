import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@staticforge/core';
import { type CnameLookup, waitForCname } from '../src/index.js';

function recordingLogger() {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      level: 'debug' as const,
      error: (m: string) => lines.push(`error ${m}`),
      warn: (m: string) => lines.push(`warn ${m}`),
      info: (m: string) => lines.push(`info ${m}`),
      debug: (m: string) => lines.push(`debug ${m}`),
    },
  };
}

/** Answers per round: each round maps a nameserver to its CNAME answer. */
function scripted(rounds: Record<string, string | undefined | Error>[]) {
  let round = 0;
  const lookup: CnameLookup = {
    nameservers: async () => ['ns1.example.net', 'ns2.example.net'],
    async cname(_name, nameserver) {
      const answer = rounds[Math.min(round, rounds.length - 1)]![nameserver];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  const sleep = async () => {
    round++;
  };
  return { lookup, sleep, rounds: () => round };
}

const host = 'ashy-glacier-04c73d70f.3.azurestaticapps.net';

describe('waitForCname', () => {
  it('returns at once when every nameserver answers with the target', async () => {
    const { lookup, sleep, rounds } = scripted([
      { 'ns1.example.net': `${host}.`, 'ns2.example.net': host.toUpperCase() },
    ]);
    const { logger, lines } = recordingLogger();
    await waitForCname('www.example.com', host, logger, { lookup, sleep });
    expect(rounds()).toBe(0);
    expect(lines).toEqual([]);
  });

  it('waits until all nameservers have the record', async () => {
    const { lookup, sleep, rounds } = scripted([
      { 'ns1.example.net': undefined, 'ns2.example.net': undefined },
      { 'ns1.example.net': host, 'ns2.example.net': undefined },
      { 'ns1.example.net': host, 'ns2.example.net': host },
    ]);
    const { logger, lines } = recordingLogger();
    await waitForCname('www.example.com', host, logger, { lookup, sleep });
    expect(rounds()).toBe(2);
    expect(lines).toEqual([
      `info Waiting until www.example.com is a CNAME to ${host} (ns1.example.net, ns2.example.net)`,
      `info www.example.com resolves to ${host}`,
    ]);
  });

  it('warns once about a CNAME to the wrong host and keeps waiting', async () => {
    const { lookup, sleep } = scripted([
      { 'ns1.example.net': 'old.example.net', 'ns2.example.net': 'old.example.net' },
      { 'ns1.example.net': 'old.example.net', 'ns2.example.net': 'old.example.net' },
      { 'ns1.example.net': host, 'ns2.example.net': host },
    ]);
    const { logger, lines } = recordingLogger();
    await waitForCname('www.example.com', host, logger, { lookup, sleep });
    expect(lines.filter((l) => l.startsWith('warn'))).toEqual([
      `warn www.example.com is a CNAME to old.example.net; it must point to ${host}`,
    ]);
  });

  it('retries failed lookups and gives up after the timeout', async () => {
    const { lookup, sleep } = scripted([
      { 'ns1.example.net': new Error('ETIMEOUT'), 'ns2.example.net': undefined },
    ]);
    const { logger, lines } = recordingLogger();
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      await expect(
        waitForCname('www.example.com', host, logger, {
          lookup,
          timeoutMs: 30_000,
          intervalMs: 10_000,
          sleep: async (ms) => {
            now += ms;
            await sleep();
          },
        }),
      ).rejects.toMatchObject({
        code: ErrorCode.IacFailed,
        message: `www.example.com did not become a CNAME to ${host} in time`,
      });
    } finally {
      Date.now = realNow;
    }
    expect(lines.some((l) => l.startsWith('debug DNS lookup for www.example.com failed'))).toBe(
      true,
    );
  });
});
