import type { Logger, SforgeConfig, TargetConfig } from '@staticforge/core';

/** Where OpenTofu/Terraform keeps a workspace's state. */
export interface IacBackend {
  /** `local` writes `terraform.tfstate` into the workspace (experiments only). */
  type: 's3' | 'azurerm' | 'local';
  config: Record<string, unknown>;
}

/**
 * Everything needed to generate a root workspace around one packaged module:
 * providers, the module and its inputs, outputs and the backend.
 */
export interface IacSpec {
  requiredProviders: Record<string, { source: string; version: string }>;
  /** Root provider configurations; several per name for aliases. */
  providers: Record<string, Record<string, unknown>[]>;
  module: {
    /** Name of the module block (and of the vendored copy). */
    name: string;
    /** Absolute directory of the packaged HCL module. */
    dir: string;
    inputs: Record<string, unknown>;
    /** Aliased providers passed to the module, e.g. `{ "aws.us_east_1": "aws.us_east_1" }`. */
    providers?: Record<string, string>;
  };
  /** Module outputs re-exported as root outputs (and cached after apply). */
  outputs: string[];
  backend: IacBackend;
  /** Extra environment variables for the engine. */
  env?: Record<string, string>;
}

/** The remote state backend of a target, and how to create it. */
export interface StateBackend {
  /** Stable id of the backend, e.g. "aws-123456789012-eu-central-1"; names the bootstrap workspace. */
  id: string;
  /** Human description, e.g. "s3://sforge-state-123456789012-eu-central-1". */
  description: string;
  /** Whether the backend's storage exists already. */
  exists: boolean;
  /** Workspace that creates the backend storage (with its own state stored in it once created). */
  bootstrap: IacSpec;
}

export interface ProfileInput {
  rootDir: string;
  config: SforgeConfig;
  targetName: string;
  target: TargetConfig;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  /** Extra module inputs for this run. */
  inputs?: Record<string, unknown>;
  /**
   * `outputs`: the workspace is only used to read outputs (e.g. a deploy in
   * CI), so lookups that only affect inputs can be skipped.
   */
  purpose?: 'provision' | 'outputs';
}

export interface PreparedTarget {
  spec: IacSpec;
  state: StateBackend;
  /**
   * Resources that sforge itself changes outside OpenTofu/Terraform (e.g. the
   * KVS key a deploy switches). Their refresh changes are not reported as drift.
   */
  expectedDrift?: string[];
  /** Module inputs to apply before destroying (e.g. allowing non-empty buckets to be deleted). */
  preDestroyInputs?: Record<string, unknown>;
  /**
   * Resources applied first, on their own (`-target`), e.g. a certificate
   * whose DNS validation records the user must create before the rest can
   * be applied. `describe` turns the outputs into instructions to print.
   */
  prePhase?: {
    targets: string[];
    describe(outputs: Record<string, unknown>): string | undefined;
  };
}

/** Provider-specific IaC knowledge: modules, backends and credentials. */
export interface IacProfile {
  provider: TargetConfig['provider'];
  prepare(input: ProfileInput): Promise<PreparedTarget>;
}

/** `iac.name`, or the host of site.baseUrl as a resource-name-safe slug. */
export function projectName(config: SforgeConfig): string {
  if (config.iac.name !== undefined) return config.iac.name;
  const host = new URL(config.site.baseUrl).hostname.toLowerCase();
  const slug = host
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return /^[a-z]/.test(slug) ? slug : `s-${slug}`.slice(0, 40);
}
