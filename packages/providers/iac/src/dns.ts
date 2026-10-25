import { ErrorCode, SforgeError } from '@staticforge/core';
import {
  type IacRef,
  type IacSpec,
  type PreparedDns,
  type ProfileInput,
  projectName,
} from './spec.js';

/** One module instance of DNS records, fed from an output of the target's module. */
export interface DnsRecordSet {
  name: string;
  records: IacRef;
}

/**
 * Check `targets.<n>.dns` and prepare its provider. `names` are the hostnames
 * the records are for (the domain, preview wildcards); they must lie inside
 * the zone. Undefined when the target has no `dns`.
 */
export async function prepareDns(
  input: ProfileInput,
  names: string[],
): Promise<PreparedDns | undefined> {
  const dns = input.target.dns;
  if (dns === undefined) return undefined;
  const where = `targets.${input.targetName}.dns`;
  if (input.target.domain === undefined) {
    throw new SforgeError(ErrorCode.ConfigInvalid, `${where} needs a domain`, {
      hint: 'dns creates the records of the custom domain: set targets.<name>.domain too.',
    });
  }
  for (const name of names) {
    if (name !== dns.zone && !name.endsWith(`.${dns.zone}`)) {
      throw new SforgeError(
        ErrorCode.ConfigInvalid,
        `${name} is not in the DNS zone ${dns.zone} (${where}.zone)`,
      );
    }
  }
  if (input.dns === undefined || input.dns.provider !== dns.provider) {
    throw new SforgeError(ErrorCode.Internal, `No DNS provider "${dns.provider}" was loaded`);
  }
  return input.dns.prepare({
    dns,
    owner: `${projectName(input.config)}/${input.targetName}`,
    env: input.env,
    logger: input.logger,
    ...(input.purpose && { purpose: input.purpose }),
  });
}

/** Add a DNS provider's providers and one records module per set to a spec. */
export function withDns(spec: IacSpec, dns: PreparedDns, sets: DnsRecordSet[]): IacSpec {
  return {
    ...spec,
    requiredProviders: { ...spec.requiredProviders, ...dns.requiredProviders },
    providers: { ...spec.providers, ...dns.providers },
    additionalModules: [
      ...(spec.additionalModules ?? []),
      ...sets.map((set) => dns.records(set.name, set.records)),
    ],
  };
}
