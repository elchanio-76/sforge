import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { stringify as toYaml } from 'yaml';
import {
  CONFIG_FILE_NAMES,
  ErrorCode,
  SforgeError,
  type SforgeConfigInput,
  validateConfig,
} from '@staticforge/core';
import { ProjectDirs } from './project.js';
import { type UrlOptions, routeFor } from './routes.js';

export const SCHEMA_PATH = './node_modules/staticforge/schema/staticforge.schema.json';

export interface ScaffoldResult {
  rootDir: string;
  /** Project-relative paths written. */
  created: string[];
  /** Project-relative paths left alone because they already existed. */
  skipped: string[];
}

export interface InitOptions {
  /** Absolute project directory; created if missing. */
  dir: string;
  title?: string;
  baseUrl?: string;
  language?: string;
  format?: 'ts' | 'json' | 'yaml';
  /** Add a "staging" deploy target for this provider. */
  provider?: 'aws' | 'azure' | 'firebase';
  /** Google Cloud project of a Firebase target. */
  project?: string | undefined;
  /** AWS region or Azure location for the target. */
  region?: string;
  /** Overwrite existing files. */
  force?: boolean;
}

const humanize = (name: string): string => {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words === '' ? 'My site' : words.charAt(0).toUpperCase() + words.slice(1);
};

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'site';

/** Render a config object as a TypeScript literal with unquoted keys and single quotes. */
function toTsLiteral(value: unknown, indent = ''): string {
  const next = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((v) => toTsLiteral(v, next)).join(', ')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    const lines = entries.map(([k, v]) => {
      const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`;
      return `${next}${key}: ${toTsLiteral(v, next)},`;
    });
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return String(value);
}

function configSource(config: SforgeConfigInput, format: 'ts' | 'json' | 'yaml'): string {
  switch (format) {
    case 'ts':
      return `import { defineConfig } from 'staticforge';\n\nexport default defineConfig(${toTsLiteral(config)});\n`;
    case 'json':
      return `${JSON.stringify({ $schema: SCHEMA_PATH, ...config }, null, 2)}\n`;
    case 'yaml':
      return `# yaml-language-server: $schema=${SCHEMA_PATH}\n${toYaml(config)}`;
  }
}

function writeFiles(
  rootDir: string,
  files: Record<string, string>,
  force: boolean,
): ScaffoldResult {
  const result: ScaffoldResult = { rootDir, created: [], skipped: [] };
  for (const [path, contents] of Object.entries(files)) {
    const full = join(rootDir, path);
    if (existsSync(full) && !force) {
      result.skipped.push(path);
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
    result.created.push(path);
  }
  return result;
}

/** Create a new project: config, starter content, a site stylesheet and .gitignore. */
export function initProject(options: InitOptions): ScaffoldResult & { configPath: string } {
  const { dir, format = 'ts', force = false } = options;
  const existing = CONFIG_FILE_NAMES.find((name) => existsSync(join(dir, name)));
  if (existing !== undefined && !force) {
    throw new SforgeError(ErrorCode.FileExists, `${join(dir, existing)} already exists`, {
      hint: 'This directory is already a staticforge project. Pass --force to overwrite the starter files.',
    });
  }

  const name = basename(dir);
  const title = options.title ?? humanize(name);
  const config: SforgeConfigInput = {
    site: {
      title,
      baseUrl: options.baseUrl ?? 'https://example.com',
      language: options.language ?? 'en',
    },
    styles: ['/assets/css/site.css'],
  };
  if (options.provider === 'aws') {
    config.targets = { staging: { provider: 'aws', region: options.region ?? 'us-east-1' } };
  } else if (options.provider === 'azure') {
    config.targets = {
      staging: {
        provider: 'azure',
        resourceGroup: `rg-${slugify(name)}`,
        location: options.region ?? 'westeurope',
      },
    };
  } else if (options.provider === 'firebase') {
    config.targets = {
      staging: { provider: 'firebase', project: options.project ?? 'my-project-id' },
    };
  }
  validateConfig(config, 'generated config'); // guard against scaffolding drifting from the schema

  const configName = `staticforge.config.${format}`;
  const files: Record<string, string> = {
    [configName]: configSource(config, format),
    [`${ProjectDirs.content}/index.md`]: `---
${toYaml({ title, description: `Welcome to ${title}.` })}---

This site is built with staticforge.

## Next steps

- Edit this page in \`content/index.md\`.
- Add a page with \`sforge new page <name>\`, or a blog post with \`sforge new post <name>\`.
- Build the site into \`dist/\` with \`sforge build\`.
`,
    [`${ProjectDirs.content}/about.md`]: `---
title: About
description: What this site is about.
nav:
  order: 1
---

Tell visitors who you are and what they will find here.
`,
    [`${ProjectDirs.assets}/css/site.css`]: `/*
 * Site styles, loaded after the theme. Override theme variables here, e.g.:
 *
 * :root { --color-link: #0b6e4f; }
 */
`,
    '.gitignore':
      'node_modules/\ndist/\n.sforge/cache/\n.sforge/state/\n.sforge/iac/**/.terraform/\n',
  };

  const result = writeFiles(dir, files, force);
  return { ...result, configPath: join(dir, configName) };
}

export interface NewContentOptions {
  rootDir: string;
  kind: 'page' | 'post';
  /** Path inside content/, e.g. "about" or "blog/hello-world". Posts default to blog/. */
  path: string;
  title?: string;
  format?: 'md' | 'html';
  draft?: boolean;
  force?: boolean;
  /** Post date; defaults to today. */
  date?: Date;
  urls: UrlOptions;
}

/** Create a page or post with front-matter; returns its file and future URL. */
export function newContent(options: NewContentOptions): { file: string; url: string } {
  const { kind, format = 'md' } = options;
  let path = options.path.replace(/^\.?\/?(content\/)?/, '').replace(/\.(md|markdown|html?)$/i, '');
  if (kind === 'post' && !path.includes('/')) path = `blog/${path}`;

  const segments = path.split('/');
  if (path === '' || segments.some((s) => !/^[a-z0-9][a-z0-9_-]*$/i.test(s))) {
    throw new SforgeError(ErrorCode.Usage, `Invalid content path "${options.path}"`, {
      hint: 'Use letters, digits, "-" and "_" in each segment, e.g. "guides/getting-started".',
    });
  }

  const contentPath = `${path}.${format}`;
  const file = `${ProjectDirs.content}/${contentPath}`;
  const full = join(options.rootDir, file);
  if (existsSync(full) && !options.force) {
    throw new SforgeError(ErrorCode.FileExists, `${file} already exists`, {
      hint: 'Pass --force to overwrite it.',
    });
  }

  const frontMatter: Record<string, unknown> = {
    title: options.title ?? humanize(segments.at(-1) ?? path),
  };
  if (kind === 'post') {
    frontMatter.layout = 'post';
    frontMatter.date = (options.date ?? new Date()).toISOString().slice(0, 10);
    frontMatter.tags = [];
  }
  if (options.draft) frontMatter.draft = true;

  const body = format === 'md' ? 'Write your content here.\n' : '<p>Write your content here.</p>\n';
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `---\n${toYaml(frontMatter)}---\n\n${body}`);

  return { file, url: routeFor(contentPath, undefined, options.urls).url };
}
