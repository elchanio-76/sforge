import type { LoadedConfig, Logger, SforgeConfig, TargetConfig } from '@staticforge/core';
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
  /**
   * The URL a preview will be served at, used as `site.baseUrl` when building it.
   * Undefined when the provider cannot serve previews or does not know the URL. Firebase
   * learns it from the channel, so a real deploy creates the channel here; a dry run must not.
   */
  previewBaseUrl?(
    previewId: string,
    options?: { dryRun?: boolean },
  ): string | undefined | Promise<string | undefined>;
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
  /**
   * Load the project config of another checkout of the same project (config files
   * may import `staticforge`, which only the CLI knows how to resolve). Providers
   * that roll back by rebuilding an older commit need it.
   */
  loadConfig?(dir: string): Promise<LoadedConfig>;
}

/** A user allowed to sign in to a private target. */
export interface SiteUser {
  /** Stable id: the Cognito `sub`, or the Static Web Apps user id. */
  id: string;
  /** Email address, or the GitHub user name. */
  name: string;
  /** Sign-in provider (Azure: "aad", "github"). */
  provider?: string;
  /** Account state, e.g. Cognito's FORCE_CHANGE_PASSWORD or CONFIRMED. */
  status?: string;
  enabled?: boolean;
  createdAt?: string;
}

export interface InviteOptions {
  /** Email address, or the GitHub user name. */
  user: string;
  /** Sign-in provider (Azure); defaults to the target's first. */
  provider?: string;
  /** Hours an invitation link stays valid (Azure, 1–168). */
  expiresHours?: number;
}

export interface InviteResult {
  user: string;
  provider?: string;
  /** True when the cloud emails the invitation (Cognito); false when the link must be passed on. */
  emailed: boolean;
  /** The invitation link (Azure). */
  invitationUrl?: string;
  expiresAt?: string;
}

/** Users of a private target (`targets.<n>.auth`), managed with the admin's sign-in. */
export interface UserAdmin {
  list(): Promise<SiteUser[]>;
  invite(options: InviteOptions): Promise<InviteResult>;
  /** False when there was no such user. */
  remove(user: string, provider?: string): Promise<boolean>;
  /** Sign every user out by replacing the session key (AWS). */
  revokeSessions?(): Promise<void>;
}

/** What a cloud provider plugs into sforge. */
export interface Provider {
  id: TargetConfig['provider'];
  iac: IacProfile;
  createDeployer(context: DeployerContext): Deployer;
  /** Outputs a deployer needs; deploys fail early when one is missing. */
  requiredOutputs: string[];
  /** Users of private targets; undefined when the provider has none. */
  createUserAdmin?(context: DeployerContext): UserAdmin;
}
