import { ErrorCode, SforgeError } from '@staticforge/core';
import type { ProfileInput } from './spec.js';

export interface SubjectPrefixOptions {
  env: NodeJS.ProcessEnv;
  purpose?: ProfileInput['purpose'] | undefined;
  fetch?: typeof fetch;
}

/**
 * The start of the `sub` claim of the repository's GitHub Actions OIDC tokens:
 * `repo:owner/repo`, or `repo:owner@<id>/repo@<id>` for repositories that use
 * immutable subjects (the default for repositories created since July 2026).
 * Read from GitHub unless `ci.subjectPrefix` is set; a token in GH_TOKEN or
 * GITHUB_TOKEN is needed for private repositories.
 */
export async function githubSubjectPrefix(
  ci: { repo: string; subjectPrefix?: string | undefined },
  options: SubjectPrefixOptions,
): Promise<string> {
  if (ci.subjectPrefix !== undefined) return ci.subjectPrefix;
  // Reading outputs never applies the trust policies.
  if (options.purpose === 'outputs') return `repo:${ci.repo}`;
  const url = `https://api.github.com/repos/${ci.repo}/actions/oidc/customization/sub`;
  const token = options.env.GH_TOKEN ?? options.env.GITHUB_TOKEN;
  const hint =
    'Set GH_TOKEN to a token that can read the repository, or set ci.subjectPrefix to the ' +
    `sub_claim_prefix of \`gh api repos/${ci.repo}/actions/oidc/customization/sub\`.`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(token && { authorization: `Bearer ${token}` }),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SforgeError(
      ErrorCode.CloudAuth,
      `Could not read the OIDC subject format of ${ci.repo} from GitHub: ${(error as Error).message}`,
      { hint },
    );
  }
  if (!response.ok) {
    throw new SforgeError(
      ErrorCode.CloudAuth,
      `Could not read the OIDC subject format of ${ci.repo} from GitHub (HTTP ${response.status})`,
      { hint },
    );
  }
  const body = (await response.json()) as { use_default?: boolean; sub_claim_prefix?: string };
  if (body.use_default === false) {
    throw new SforgeError(
      ErrorCode.Unsupported,
      `${ci.repo} uses a custom OIDC subject template, which staticforge cannot match`,
      {
        hint: `Reset it with \`gh api -X PUT repos/${ci.repo}/actions/oidc/customization/sub -F use_default=true\`.`,
      },
    );
  }
  return body.sub_claim_prefix ?? `repo:${ci.repo}`;
}
