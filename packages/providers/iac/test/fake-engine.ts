import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Engine } from '../src/index.js';

/** What the fake engine does for one subcommand (`init`, `plan`, …). */
export interface FakeStep {
  /** Lines written to stdout (objects are written as JSON lines). */
  stdout?: (string | Record<string, unknown>)[];
  stderr?: string;
  exitCode?: number;
  /** Files created in the working directory, e.g. a lock file or state. */
  files?: Record<string, string>;
}

export type FakeScript = Record<string, FakeStep | FakeStep[]>;

export interface FakeEngine {
  engine: Engine;
  /** Every invocation: argv and working directory. */
  calls(): { args: string[]; cwd: string; env: Record<string, string | undefined> }[];
  /** Replace the script (steps for repeated subcommands are used in order). */
  script(script: FakeScript): void;
}

const SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const args = process.argv.slice(2);
const log = path.join(dir, 'calls.jsonl');
fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd(), env: { TF_IN_AUTOMATION: process.env.TF_IN_AUTOMATION, TF_PLUGIN_CACHE_DIR: process.env.TF_PLUGIN_CACHE_DIR, AWS_REGION: process.env.AWS_REGION } }) + '\n');
if (args[0] === 'version') {
  process.stdout.write(JSON.stringify({ terraform_version: process.env.FAKE_ENGINE_VERSION || '1.13.1' }));
  process.exit(0);
}
const script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'));
const counters = fs.existsSync(path.join(dir, 'counters.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'counters.json'), 'utf8')) : {};
const key = args[0] === 'providers' ? 'providers' : args[0];
let step = script[key] || {};
if (Array.isArray(step)) {
  const i = counters[key] || 0;
  counters[key] = i + 1;
  fs.writeFileSync(path.join(dir, 'counters.json'), JSON.stringify(counters));
  step = step[Math.min(i, step.length - 1)] || {};
}
for (const [name, content] of Object.entries(step.files || {})) fs.writeFileSync(path.join(process.cwd(), name), content);
for (const line of step.stdout || []) process.stdout.write((typeof line === 'string' ? line : JSON.stringify(line)) + '\n');
if (step.stderr) process.stderr.write(step.stderr);
process.exit(step.exitCode || 0);
`;

/** A fake `tofu` binary, for testing the runner without a real engine or cloud. */
export function fakeEngine(script: FakeScript = {}): FakeEngine {
  const dir = mkdtempSync(join(tmpdir(), 'sforge-fake-engine-'));
  const path = join(dir, 'tofu');
  // An absolute interpreter path: tests run the engine with an empty environment.
  writeFileSync(path, `#!${process.execPath}${SOURCE}`);
  chmodSync(path, 0o755);
  const setScript = (s: FakeScript) => {
    writeFileSync(join(dir, 'script.json'), JSON.stringify(s));
    writeFileSync(join(dir, 'counters.json'), '{}');
  };
  setScript(script);
  return {
    engine: { name: 'tofu', path, version: '1.13.1', source: 'env' },
    calls() {
      let text: string;
      try {
        text = readFileSync(join(dir, 'calls.jsonl'), 'utf8');
      } catch {
        return [];
      }
      return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    script: setScript,
  };
}

/** Recorded `-json` lines of a plan that creates one resource. */
export function planCreates(...addresses: string[]): FakeStep {
  return {
    exitCode: addresses.length > 0 ? 2 : 0,
    stdout: [
      { '@level': 'info', '@message': 'OpenTofu 1.13.1', type: 'version', terraform: '1.13.1' },
      ...addresses.map((addr) => ({
        '@level': 'info',
        '@message': `${addr}: Plan to create`,
        type: 'planned_change',
        change: { resource: { addr }, action: 'create' },
      })),
      {
        '@level': 'info',
        '@message': `Plan: ${addresses.length} to add, 0 to change, 0 to destroy.`,
        type: 'change_summary',
        changes: { add: addresses.length, change: 0, remove: 0, import: 0, operation: 'plan' },
      },
    ],
  };
}

export function applyCreates(...addresses: string[]): FakeStep {
  return {
    stdout: [
      ...addresses.flatMap((addr) => [
        {
          '@level': 'info',
          '@message': `${addr}: Creating...`,
          type: 'apply_start',
          hook: { resource: { addr }, action: 'create' },
        },
        {
          '@level': 'info',
          '@message': `${addr}: Creation complete after 1s`,
          type: 'apply_complete',
          hook: { resource: { addr }, action: 'create' },
        },
      ]),
      {
        '@level': 'info',
        '@message': `Apply complete! Resources: ${addresses.length} added, 0 changed, 0 destroyed.`,
        type: 'change_summary',
        changes: { add: addresses.length, change: 0, remove: 0, import: 0, operation: 'apply' },
      },
    ],
  };
}
