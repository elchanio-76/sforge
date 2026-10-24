import type { Logger, SforgeConfig, TargetConfig } from '@staticforge/core';
import type { IacProfile } from '@staticforge/iac';

/** A deployed version (production) or preview, as recorded by the provider. */
export interface DeployedVersion {
  id: string;
  createdAt: string;
  gitSha?: string;
  files: number;
  bytes: number;
  /** True for the version production currently serves. */
  active: boolean;
  /** PR previews are separate from the production history. */
  preview: boolean;
  url?: string;
}

export interface DeployResult {
  target: string;
  provider: TargetConfig['provider'];
  versionId: string;
  url: string;
  preview: boolean;
  /** Files sent from this machine. */
  uploaded: number;
  /** Identical files copied server-side from the previous version. */
  copied: number;
  /** Identical files already in place (preview redeploys). */
  skipped: number;
  /** Files removed (preview redeploys). */
  deleted: number;
  bytes: number;
  /** Older versions removed beyond retainVersions. */
  pruned: string[];
  invalidated: boolean;
  dryRun: boolean;
  previousVersionId?: string;
}

export interface RollbackResult {
  target: string;
  versionId: string;
  previousVersionId: string | null;
  url: string;
}

export interface PreviewDestroyResult {
  target: string;
  previewId: string;
  deleted: number;
  existed: boolean;
}

export interface DeployOptions {
  /** Directory of a finished build (with .sforge/build-manifest.json). */
  buildDir: string;
  /** Deploy as a PR preview with this id instead of to production. */
  preview?: string;
  /** Invalidate the CDN cache afterwards (normally unnecessary). */
  invalidate?: boolean;
  /** Compute what would change without changing anything. */
  dryRun?: boolean;
  gitSha?: string;
  now?: Date;
}

/** Runtime operations on provisioned infrastructure, which change on every deploy. */
export interface Deployer {
  deploy(options: DeployOptions): Promise<DeployResult>;
  versions(): Promise<DeployedVersion[]>;
  rollback(to?: string): Promise<RollbackResult>;
  destroyPreview(previewId: string): Promise<PreviewDestroyResult>;
  /** The URL production is served at, and the active version. */
  current(): Promise<{ url: string; versionId: string | null }>;
}

export interface DeployerContext {
  rootDir: string;
  config: SforgeConfig;
  targetName: string;
  target: TargetConfig;
  /** Non-secret outputs of the target's infrastructure (`.sforge/state/<target>.json`). */
  outputs: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  logger: Logger;
}

/** What a cloud provider plugs into sforge. */
export interface Provider {
  id: TargetConfig['provider'];
  iac: IacProfile;
  createDeployer(context: DeployerContext): Deployer;
  /** Outputs a deployer needs; deploys fail early when one is missing. */
  requiredOutputs: string[];
}
