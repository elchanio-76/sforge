import { fileURLToPath } from 'node:url';
import { ErrorCode, SforgeError } from '@staticforge/core';
import type { DnsProfile, DnsProfileInput, PreparedDns } from '@staticforge/iac';

/** Packaged HCL, next to src/ and dist/. */
export const RECORDS_MODULE_DIR = fileURLToPath(
  new URL('../terraform/modules/records', import.meta.url),
);

const CLOUDFLARE_PROVIDER = { source: 'cloudflare/cloudflare', version: '>= 5.0, < 6.0' };

/** The provider and sforge both read the API token from here; it is never written to a file. */
export const TOKEN_ENV = 'CLOUDFLARE_API_TOKEN';

const API = 'https://api.cloudflare.com/client/v4';

/** Record comments are limited to 100 characters on the Free plan. */
const COMMENT_LIMIT = 100;

export type Fetch = typeof fetch;

function tokenHint(zone: string): string {
  return (
    `Create an API token with Zone → DNS → Edit and Zone → Zone → Read on ${zone} ` +
    `(Cloudflare's "Edit zone DNS" template plus Zone Read) and export it as ${TOKEN_ENV}.`
  );
}

/** The ID of a zone, looked up by name with the API token. */
export async function lookupZone(zone: string, token: string, fetchImpl: Fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}/zones?name=${encodeURIComponent(zone)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new SforgeError(
      ErrorCode.CloudAuth,
      `Could not reach the Cloudflare API: ${String(error)}`,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new SforgeError(
      ErrorCode.CloudAuth,
      `Cloudflare refused the API token in ${TOKEN_ENV} (HTTP ${response.status})`,
      { hint: tokenHint(zone) },
    );
  }
  const body = (await response.json().catch(() => undefined)) as
    | { success?: boolean; result?: { id: string; name: string }[]; errors?: { message: string }[] }
    | undefined;
  if (!response.ok || body?.success !== true) {
    const reason = body?.errors?.map((e) => e.message).join('; ') || `HTTP ${response.status}`;
    throw new SforgeError(
      ErrorCode.CloudAuth,
      `Could not look up the Cloudflare zone ${zone}: ${reason}`,
    );
  }
  const id = body.result?.find((z) => z.name === zone)?.id;
  if (id === undefined) {
    throw new SforgeError(
      ErrorCode.ConfigInvalid,
      `The Cloudflare API token in ${TOKEN_ENV} sees no zone named ${zone}`,
      {
        hint: `Check dns.zone, and that the token covers ${zone} with Zone Read (or set dns.zoneId).`,
      },
    );
  }
  return id;
}

export interface CloudflareDnsOptions {
  fetch?: Fetch;
}

/**
 * Cloudflare DNS: records are created by the `records` module through the
 * cloudflare/cloudflare provider, which reads CLOUDFLARE_API_TOKEN itself.
 * Reading outputs (deploys in CI) needs no token.
 */
export function createCloudflareDns(options: CloudflareDnsOptions = {}): DnsProfile {
  const fetchImpl = options.fetch ?? fetch;
  return {
    provider: 'cloudflare',
    async prepare(input: DnsProfileInput): Promise<PreparedDns> {
      const { dns } = input;
      let zoneId = dns.zoneId;
      if (input.purpose !== 'outputs') {
        const token = input.env[TOKEN_ENV];
        if (token === undefined || token === '') {
          throw new SforgeError(ErrorCode.CloudAuth, `${TOKEN_ENV} is not set`, {
            hint: tokenHint(dns.zone),
          });
        }
        zoneId ??= await lookupZone(dns.zone, token, fetchImpl);
      }
      const comment = `staticforge ${input.owner}`.slice(0, COMMENT_LIMIT);
      return {
        requiredProviders: { cloudflare: CLOUDFLARE_PROVIDER },
        providers: {},
        records: (name, records) => ({
          name,
          dir: RECORDS_MODULE_DIR,
          // The zone ID only matters when planning; reading outputs never evaluates it.
          inputs: { zone_id: zoneId ?? '', comment, records },
        }),
      };
    },
  };
}
