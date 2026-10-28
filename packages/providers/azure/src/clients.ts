import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSiteManagementClient } from '@azure/arm-appservice';
import { StorageManagementClient } from '@azure/arm-storage';
import { type TokenCredential, DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { ErrorCode, SforgeError } from '@staticforge/core';
import { type HistoryStore, blobHistoryStore } from './history.js';

const run = promisify(execFile);

/** Azure SDK clients, injectable for tests. Credentials come from `DefaultAzureCredential`. */
export interface AzureClients {
  credential(): TokenCredential;
  webSites(subscriptionId: string): WebSiteManagementClient;
  storage(subscriptionId: string): StorageManagementClient;
  /** The deploy history document in the state container. */
  history(account: string, container: string, blobName: string): HistoryStore;
  /** Output of `az <args>`, or undefined when the Azure CLI is not installed or fails. */
  az(args: string[]): Promise<string | undefined>;
}

export function defaultClients(): AzureClients {
  const cache = new Map<string, unknown>();
  const once = <T>(key: string, create: () => T): T => {
    if (!cache.has(key)) cache.set(key, create());
    return cache.get(key) as T;
  };
  const credential = () => once('credential', () => new DefaultAzureCredential());
  return {
    credential,
    webSites: (subscriptionId) =>
      once(
        `web:${subscriptionId}`,
        () => new WebSiteManagementClient(credential(), subscriptionId),
      ),
    storage: (subscriptionId) =>
      once(
        `storage:${subscriptionId}`,
        () => new StorageManagementClient(credential(), subscriptionId),
      ),
    history: (account, container, blobName) =>
      blobHistoryStore(
        once(
          `blob:${account}`,
          () => new BlobServiceClient(`https://${account}.blob.core.windows.net`, credential()),
        ).getContainerClient(container),
        blobName,
      ),
    async az(args) {
      try {
        const { stdout } = await run('az', args, { timeout: 30_000 });
        return stdout.trim();
      } catch {
        return undefined;
      }
    },
  };
}

const AUTH_ERRORS = new Set([
  'CredentialUnavailableError',
  'AuthenticationRequiredError',
  'AggregateAuthenticationError',
  'AuthenticationError',
  'ExpiredAuthenticationToken',
]);

/** Status code of an SDK error. */
export function httpStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

/** Error name or service error code ("ResourceNotFound", "AuthorizationFailed", …). */
export function errorName(error: unknown): string {
  if (error === null || typeof error !== 'object') return '';
  const e = error as { code?: string; name?: string };
  return e.code ?? e.name ?? '';
}

/** Wrap an SDK error: credential and permission problems → SF_CLOUD_AUTH, the rest → `code`. */
export function azureError(
  error: unknown,
  what: string,
  code: SforgeError['code'] = ErrorCode.DeployFailed,
): SforgeError {
  if (error instanceof SforgeError) return error;
  const name = errorName(error);
  const status = httpStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  if (
    AUTH_ERRORS.has(name) ||
    status === 401 ||
    /az login|AADSTS|credential|token.{0,100}expired|no accounts were found/i.test(message)
  ) {
    return new SforgeError(ErrorCode.CloudAuth, `${what}: ${firstLine(message)}`, {
      cause: error,
      hint: 'Sign in to Azure with `az login` (or set AZURE_CLIENT_ID, AZURE_TENANT_ID and AZURE_CLIENT_SECRET / federated credentials) and try again.',
    });
  }
  if (
    status === 403 ||
    name === 'AuthorizationFailed' ||
    name === 'AuthorizationPermissionMismatch' ||
    name === 'AuthorizationFailure'
  ) {
    return new SforgeError(ErrorCode.CloudAuth, `${what}: access denied (${firstLine(message)})`, {
      cause: error,
      hint: 'The Azure identity in use lacks a permission this operation needs. Reading and writing state or deploy history needs "Storage Blob Data Contributor" on the state storage account; role assignments can take a few minutes to apply.',
    });
  }
  return new SforgeError(code, `${what}: ${firstLine(message)}`, {
    cause: error,
    details: { error: name },
  });
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? text;
}
