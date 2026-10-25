import { z } from 'zod';

const targetName = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{0,31}$/,
    'must be lowercase letters, digits or "-", starting with a letter',
  );

const hostname = z
  .string()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'must be a lowercase DNS hostname such as "www.example.com"',
  );

const githubRepo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'must be "owner/repo"');

/** GitHub Actions OIDC identity that CI uses to deploy, created by `sforge provision`. */
const ciSchema = z.strictObject({
  repo: githubRepo.describe('GitHub repository allowed to deploy, as "owner/repo".'),
  branches: z
    .array(z.string().min(1))
    .default(['main'])
    .describe('Branches whose workflows may deploy.'),
  environments: z
    .array(z.string().min(1))
    .default([])
    .describe('GitHub deployment environments whose workflows may deploy.'),
  pullRequests: z
    .boolean()
    .default(true)
    .describe('Allow pull_request workflows to deploy previews.'),
});

const awsTargetSchema = z.strictObject({
  provider: z.literal('aws'),
  region: z
    .string()
    .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'must be an AWS region such as "eu-central-1"'),
  domain: hostname.optional().describe('Custom domain. Omit to use the *.cloudfront.net URL.'),
  hostedZone: hostname
    .optional()
    .describe('Route 53 hosted zone for automatic DNS validation and alias records.'),
  previewDomain: hostname
    .optional()
    .describe(
      'Wildcard parent for PR previews (pr-<n>.<previewDomain>). Requires a custom domain.',
    ),
  retainVersions: z.int().min(1).max(100).default(10),
  logging: z.boolean().default(false).describe('Enable CloudFront standard access logs.'),
  wafWebAclArn: z.string().startsWith('arn:aws:wafv2:').optional(),
  state: z
    .strictObject({
      bucket: z
        .string()
        .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'must be an S3 bucket name')
        .optional()
        .describe('State bucket. Defaults to "sforge-state-<accountId>-<region>".'),
      region: z
        .string()
        .regex(/^[a-z]{2}(-[a-z]+)+-\d$/, 'must be an AWS region such as "eu-central-1"')
        .optional()
        .describe("Region of the state bucket. Defaults to the target's region."),
      kmsKeyArn: z
        .string()
        .startsWith('arn:aws:kms:')
        .optional()
        .describe('Encrypt state with this KMS key instead of SSE-S3.'),
    })
    .prefault({})
    .describe('Remote state backend (S3 with native locking), created by --bootstrap-state.'),
  ci: ciSchema.optional(),
});

const azureTargetSchema = z.strictObject({
  provider: z.literal('azure'),
  subscriptionId: z
    .uuid()
    .optional()
    .describe('Defaults to the subscription of the active credential.'),
  resourceGroup: z.string().min(1).max(90),
  createResourceGroup: z
    .boolean()
    .default(true)
    .describe('Create the resource group (and delete it on destroy). False uses an existing one.'),
  location: z
    .string()
    .min(1)
    .describe(
      'Azure region, e.g. "westeurope". Static Web Apps exist in westus2, centralus, eastus2, westeurope and eastasia.',
    ),
  sku: z.enum(['Free', 'Standard']).default('Free'),
  retainVersions: z
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe('Deployed versions kept in the history that rollback chooses from.'),
  domain: hostname.optional(),
  dnsZone: z
    .string()
    .optional()
    .describe('Azure DNS zone resource ID for automatic CNAME records.'),
  state: z
    .strictObject({
      resourceGroup: z.string().min(1).max(90).optional().describe('Defaults to "sforge-state".'),
      storageAccount: z
        .string()
        .regex(/^[a-z0-9]{3,24}$/, 'must be 3-24 lowercase letters and digits')
        .optional()
        .describe('Defaults to "sfstate" + a hash of the subscription ID.'),
      container: z.string().min(3).max(63).default('tfstate'),
      location: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Region of the state storage account. Defaults to the target's location; set it when Azure is not accepting new storage accounts there.",
        ),
    })
    .prefault({})
    .describe('Remote state backend (Azure Blob Storage), created by --bootstrap-state.'),
  ci: ciSchema.optional(),
});

/**
 * Default Content-Security-Policy: everything from the site itself, images,
 * media and frames also over https, inline style attributes (code highlighting).
 */
export const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  "frame-src 'self' https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  'upgrade-insecure-requests',
].join('; ');

export const targetSchema = z.discriminatedUnion('provider', [awsTargetSchema, azureTargetSchema]);

const collectionSchema = z.strictObject({
  dir: z.string().min(1).describe('Content directory of the collection, relative to the project.'),
  sortBy: z.enum(['date', 'title', 'order']).default('date'),
  perPage: z.int().min(1).max(500).default(10),
  feed: z
    .strictObject({
      rss: z.boolean().default(true),
      atom: z.boolean().default(true),
    })
    .prefault({}),
});

export const configSchema = z
  .strictObject({
    $schema: z.string().optional(),
    site: z.strictObject({
      title: z.string().min(1),
      baseUrl: z
        .url({ protocol: /^https?$/ })
        .describe('Absolute production URL, used for canonical links, feeds and sitemaps.'),
      language: z
        .string()
        .regex(
          /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/,
          'must be a BCP 47 language tag such as "en" or "el-GR"',
        )
        .default('en'),
      description: z.string().optional(),
      author: z.string().optional(),
    }),
    theme: z
      .string()
      .min(1)
      .default('default')
      .describe('"default", a path to a theme directory, or an npm package name.'),
    build: z
      .strictObject({
        outDir: z.string().min(1).default('dist'),
        cleanUrls: z.boolean().default(true),
        trailingSlash: z.enum(['always', 'never']).default('always'),
        minify: z.boolean().default(true),
        drafts: z.boolean().default(false),
        workers: z
          .union([z.int().min(0).max(64), z.literal('auto')])
          .default('auto')
          .describe(
            'Worker threads for parsing, rendering and checking: "auto" (all cores but one, at most 8) or a number; 0 uses the main thread only. SFORGE_WORKERS overrides it.',
          ),
      })
      .prefault({}),
    images: z
      .strictObject({
        formats: z
          .array(z.enum(['avif', 'webp', 'jpeg', 'png']))
          .min(1)
          .default(['avif', 'webp']),
        widths: z.array(z.int().min(16).max(8192)).min(1).default([480, 960, 1600]),
        quality: z.int().min(1).max(100).default(75),
        optimize: z
          .boolean()
          .default(true)
          .describe('Resize content images into responsive AVIF/WebP variants.'),
        sizes: z
          .string()
          .min(1)
          .default('(min-width: 45rem) 45rem, 100vw')
          .describe('The `sizes` attribute of responsive images: their width in the layout.'),
      })
      .prefault({}),
    styles: z
      .array(
        z
          .string()
          .regex(
            /^(\/|https?:\/\/)/,
            'must be a root-relative URL (/assets/site.css) or an http(s) URL',
          ),
      )
      .default([])
      .describe(
        'Stylesheets linked on every page, after the theme\'s, e.g. "/assets/css/site.css".',
      ),
    scripts: z
      .array(
        z
          .string()
          .regex(
            /^(\/|https?:\/\/)/,
            'must be a root-relative URL (/assets/site.js) or an http(s) URL',
          ),
      )
      .default([])
      .describe("ES module scripts loaded on every page, after the theme's."),
    collections: z.record(targetName, collectionSchema).default({}),
    search: z.strictObject({ enabled: z.boolean().default(true) }).prefault({}),
    check: z
      .strictObject({
        wcag: z.enum(['2.1-AA', '2.2-AA', '2.2-AAA']).default('2.2-AA'),
        failOn: z.enum(['error', 'warning']).default('error'),
        ignore: z.array(z.string().min(1)).default([]).describe('Rule IDs to skip.'),
        headless: z.boolean().default(true).describe('Run rendered (axe-core + Chromium) checks.'),
      })
      .prefault({}),
    security: z
      .strictObject({
        contentSecurityPolicy: z
          .union([z.string().min(1), z.literal(false)])
          .default(DEFAULT_CSP)
          .describe(
            "Content-Security-Policy of every page; false sends none. The search page also gets 'wasm-unsafe-eval' (Pagefind).",
          ),
        hsts: z
          .union([
            z.strictObject({
              maxAge: z.int().min(0).default(63072000),
              includeSubDomains: z.boolean().default(false),
              preload: z.boolean().default(false),
            }),
            z.literal(false),
          ])
          .prefault({})
          .describe('Strict-Transport-Security; false sends none.'),
        referrerPolicy: z
          .enum([
            'no-referrer',
            'no-referrer-when-downgrade',
            'origin',
            'origin-when-cross-origin',
            'same-origin',
            'strict-origin',
            'strict-origin-when-cross-origin',
            'unsafe-url',
          ])
          .default('strict-origin-when-cross-origin'),
        frameOptions: z
          .union([z.enum(['DENY', 'SAMEORIGIN']), z.literal(false)])
          .default('SAMEORIGIN'),
        permissionsPolicy: z
          .union([z.string().min(1), z.literal(false)])
          .default('camera=(), microphone=(), geolocation=(), payment=(), usb=()'),
      })
      .prefault({})
      .describe('Security headers sent by the hosting providers.'),
    iac: z
      .strictObject({
        name: z
          .string()
          .regex(
            /^[a-z][a-z0-9-]{0,39}$/,
            'must be lowercase letters, digits or "-", starting with a letter',
          )
          .optional()
          .describe(
            'Project name used in state keys and cloud resource names. Defaults to the host of site.baseUrl.',
          ),
        engine: z.enum(['tofu', 'terraform']).default('tofu'),
        version: z.string().optional().describe('Override the pinned engine version.'),
        vendor: z
          .boolean()
          .default(false)
          .describe('Copy HCL modules into the workspace for auditing.'),
      })
      .prefault({}),
    targets: z.record(targetName, targetSchema).default({}),
  })
  .describe('staticforge project configuration');

/** Fully-resolved configuration, with defaults applied. */
export type SforgeConfig = z.output<typeof configSchema>;
/** Configuration as authored by users (defaults optional). */
export type SforgeConfigInput = z.input<typeof configSchema>;
export type TargetConfig = z.output<typeof targetSchema>;
export type AwsTargetConfig = Extract<TargetConfig, { provider: 'aws' }>;
export type AzureTargetConfig = Extract<TargetConfig, { provider: 'azure' }>;

/** Identity helper giving editor completion and type checking in `staticforge.config.ts`. */
export function defineConfig(config: SforgeConfigInput): SforgeConfigInput {
  return config;
}
