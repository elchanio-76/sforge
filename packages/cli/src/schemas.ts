import { checkReportJsonSchema } from '@staticforge/checker/report-schema';
import { diagnosticJsonSchema } from '@staticforge/core';

/**
 * JSON Schemas of each command's `data` under `--json`. They are part of the
 * output envelope schema (`sforge schema output`) and the MCP tools' output
 * schemas; tests validate real command output against them.
 */

type Schema = Record<string, unknown>;

const string = (description?: string): Schema => ({
  type: 'string',
  ...(description !== undefined && { description }),
});
const count = (description?: string): Schema => ({
  type: 'integer',
  minimum: 0,
  ...(description !== undefined && { description }),
});
const boolean = (description?: string): Schema => ({
  type: 'boolean',
  ...(description !== undefined && { description }),
});
const strings = (description?: string): Schema => ({
  type: 'array',
  items: { type: 'string' },
  ...(description !== undefined && { description }),
});
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
const nullable = (schema: Schema): Schema => ({ anyOf: [schema, { type: 'null' }] });

/** A closed object: `required` properties first, then optional ones. */
function object(required: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema {
  return {
    type: 'object',
    required: Object.keys(required),
    additionalProperties: false,
    properties: { ...required, ...optional },
  };
}

const described = (schema: Schema, description: string): Schema => ({ ...schema, description });

const outputs = described(
  { type: 'object' },
  'Non-sensitive infrastructure outputs (OpenTofu/Terraform `output` values).',
);

/** Definitions shared by several commands, referenced as `#/$defs/<name>`. */
export function sharedDefs(): Record<string, Schema> {
  return {
    diagnostic: diagnosticJsonSchema(),
    summary: object({ error: count(), warning: count(), info: count() }),
    error: object(
      {
        code: { type: 'string', pattern: '^SF_[A-Z_]+$' },
        message: string(),
      },
      { details: {}, hint: string() },
    ),
    builtPage: object(
      {
        url: string('URL of the page, e.g. "/about/".'),
        output: string('Path of the HTML file relative to the output directory.'),
        layout: string('Layout used, or "document" for HTML documents that pass through.'),
      },
      { source: string('Project-relative source file; absent for generated pages.') },
    ),
    resourceChange: object({
      address: string('Resource address, e.g. "module.site.aws_s3_bucket.site".'),
      action: { enum: ['create', 'update', 'delete', 'replace', 'read', 'noop', 'move'] },
    }),
    plan: object(
      {
        changes: boolean('True when applying the plan would change something.'),
        add: count(),
        change: count(),
        remove: count(),
        import: count(),
        resources: { type: 'array', items: ref('resourceChange') },
        drift: described(
          { type: 'array', items: ref('resourceChange') },
          'Changes made outside OpenTofu/Terraform, found while refreshing.',
        ),
      },
      { planFile: string('Saved plan file.') },
    ),
    engine: object({ name: { enum: ['tofu', 'terraform'] }, version: string() }),
    deployedVersion: object(
      {
        id: string('Version id (`<UTC timestamp>-<git sha>`) or preview id.'),
        createdAt: string('ISO 8601 time of the deploy.'),
        files: count(),
        bytes: count(),
        active: boolean('True for the version production serves.'),
        preview: boolean(),
      },
      { gitSha: string(), url: string() },
    ),
  };
}

function buildData(): Schema {
  return object({
    ok: boolean('False when the build reported errors.'),
    outDir: string('Absolute output directory.'),
    pages: { type: 'array', items: ref('builtPage') },
    fileCount: count('Files written, including pages.'),
    drafts: object({ skipped: strings('Draft sources left out of the build.') }),
    diagnostics: { type: 'array', items: ref('diagnostic') },
    summary: ref('summary'),
    durationMs: count(),
  });
}

/** The check report schema, minus its document-level keys (its `$defs` are shared). */
function checkData(): Schema {
  const schema = checkReportJsonSchema();
  for (const key of ['$schema', '$id', '$defs', 'title']) delete schema[key];
  return schema;
}

const server = {
  url: string('Where the server listens, e.g. "http://127.0.0.1:4321/".'),
  host: string(),
  port: count(),
};

const targetName = string('Target name from the config.');

function deployData(): Schema {
  return object(
    {
      target: targetName,
      provider: { enum: ['aws', 'azure'] },
      versionId: string('The new version id, or the preview id.'),
      url: string('Where the version or preview is served.'),
      preview: boolean(),
      uploaded: count('Files sent from this machine.'),
      copied: count('Unchanged files copied server-side from the previous version.'),
      skipped: count('Unchanged files already in place (preview redeploys).'),
      deleted: count('Files removed (preview redeploys).'),
      bytes: count('Bytes uploaded.'),
      pruned: strings('Older versions removed beyond retainVersions.'),
      invalidated: boolean('Whether the CDN cache was invalidated.'),
      dryRun: boolean('True when nothing was changed.'),
      buildDir: string('The deployed build directory.'),
    },
    {
      previousVersionId: string('The version production served before.'),
      check: object({ summary: ref('summary'), rendered: { enum: ['ran', 'skipped', 'off'] } }),
    },
  );
}

/** Command path (e.g. "config show") → schema of its `data`. `mcp` writes no envelope. */
export function commandDataSchemas(): Record<string, Schema> {
  return {
    init: object({
      rootDir: string(),
      configPath: string(),
      created: strings('Project-relative paths written.'),
      skipped: strings('Project-relative paths left alone because they existed.'),
    }),
    new: object({
      file: string('Project-relative path of the new source file.'),
      url: string('URL the page will have.'),
    }),
    build: buildData(),
    check: checkData(),
    dev: object({
      ...server,
      rootDir: string(),
      build: object(
        {
          ok: boolean(),
          diagnostics: described(
            { type: 'array', items: ref('diagnostic') },
            'Build diagnostics plus the static checker findings.',
          ),
        },
        {
          summary: ref('summary'),
          pages: { type: 'array', items: ref('builtPage') },
          error: described(ref('error'), 'Set when the build could not run.'),
        },
      ),
    }),
    preview: object({ ...server, dir: string('The directory served.') }),
    provision: object(
      {
        target: targetName,
        provider: string(),
        engine: ref('engine'),
        workspace: string('The generated OpenTofu/Terraform workspace.'),
        plan: ref('plan'),
        applied: boolean('False for --diff, when nothing changed, or when declined.'),
        notices: strings('Instructions for the user, e.g. DNS records to create.'),
      },
      {
        bootstrap: object({ backend: string(), description: string(), created: boolean() }),
        apply: object({ add: count(), change: count(), remove: count() }),
        outputs,
        pending: boolean('True when provisioning stopped after the pre-phase (--no-wait).'),
      },
    ),
    status: object(
      {
        target: targetName,
        provider: string(),
        engine: ref('engine'),
        drift: { type: 'array', items: ref('resourceChange') },
        drifted: boolean(),
        outputs,
        versionId: described(nullable(string()), 'The version production serves.'),
      },
      { url: string() },
    ),
    destroy: object({
      target: targetName,
      provider: string(),
      plan: ref('plan'),
      destroyed: boolean(),
    }),
    iac: {
      oneOf: [
        object({
          target: targetName,
          workspace: string(),
          engine: object({
            name: { enum: ['tofu', 'terraform'] },
            path: string(),
            version: string(),
            source: { enum: ['env', 'path', 'cache', 'download'] },
          }),
        }),
        object({
          target: targetName,
          command: string(),
          exitCode: { type: 'integer' },
          workspace: string(),
          diagnostics: {
            type: 'array',
            items: object(
              { severity: { enum: ['error', 'warning'] }, summary: string() },
              { detail: string(), address: string(), file: string(), line: count() },
            ),
          },
        }),
      ],
    },
    deploy: deployData(),
    versions: object({
      target: targetName,
      versions: described(
        { type: 'array', items: ref('deployedVersion') },
        'Production versions (newest first), then previews.',
      ),
    }),
    rollback: object({
      target: targetName,
      versionId: string('The version now served.'),
      previousVersionId: nullable(string()),
      url: string(),
    }),
    'preview-destroy': object({
      target: targetName,
      previewId: string(),
      deleted: count('Files removed.'),
      existed: boolean(),
    }),
    'users list': object({
      target: targetName,
      provider: { enum: ['aws', 'azure'] },
      users: {
        type: 'array',
        items: object(
          {
            id: string('Cognito sub, or the Static Web Apps user id.'),
            name: string('Email address, or GitHub user name.'),
          },
          {
            provider: string('Sign-in provider (Azure: "aad" or "github").'),
            status: string('Cognito account state, e.g. FORCE_CHANGE_PASSWORD or CONFIRMED.'),
            enabled: boolean(),
            createdAt: string(),
          },
        ),
      },
    }),
    'users invite': object(
      {
        target: targetName,
        user: string('Email address, or GitHub user name.'),
        emailed: boolean(
          'True when the cloud emailed the invitation (AWS); false when invitationUrl must be passed on (Azure).',
        ),
      },
      {
        provider: string('Sign-in provider (Azure).'),
        invitationUrl: string('Invitation link to send the user (Azure).'),
        expiresAt: string('When the invitation link expires (Azure).'),
      },
    ),
    'users remove': object({
      target: targetName,
      user: string(),
      removed: boolean('False when there was no such user.'),
    }),
    'users revoke-sessions': object({
      target: targetName,
      revoked: { const: true },
    }),
    'ci init': object({
      directory: string('Where the workflows are, relative to the repository root.'),
      created: strings('Workflow files written, relative to the repository root.'),
      skipped: strings('Workflow files left alone because they existed (see --force).'),
      targets: {
        type: 'array',
        items: object(
          {
            name: targetName,
            provider: { enum: ['aws', 'azure'] },
            branch: string('Pushes to this branch deploy production.'),
            previews: boolean('Pull requests get a preview deploy.'),
          },
          {
            region: string(),
            environment: string('GitHub environment the production deploy runs in.'),
          },
        ),
      },
      variables: {
        type: 'array',
        items: object({
          target: targetName,
          name: string('Repository variable the workflows read.'),
          output: string('The provision output it holds.'),
          value: nullable(string('Null until the target is provisioned.')),
        }),
      },
      commands: strings('`gh variable set` commands for the provisioned values.'),
    }),
    'config validate': object({
      valid: { const: true },
      path: string('The config file.'),
      rootDir: string(),
      targets: strings('Target names.'),
    }),
    'config show': object({
      path: string('The config file.'),
      config: described(
        { type: 'object' },
        'The resolved config with defaults applied (see `sforge schema config`).',
      ),
    }),
    schema: described({ type: 'object' }, 'The requested JSON Schema.'),
    version: object({ version: string(), node: string(), platform: string(), arch: string() }),
  };
}

/** `$defs` key of a command's data schema: "config show" → "config-show-data". */
export function dataDefName(command: string): string {
  return `${command.replace(/ /g, '-')}-data`;
}

/** A command's data schema as a standalone document (MCP tool output schemas). */
export function standaloneDataSchema(command: string): Schema {
  const data = commandDataSchemas()[command];
  if (data === undefined) throw new Error(`No data schema for "${command}"`);
  return { ...data, $defs: sharedDefs() };
}
