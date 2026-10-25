/**
 * GitHub Actions used by the workflows `sforge ci init` writes, pinned to a
 * commit (a tag can be moved; a commit cannot). Refresh with
 * `node scripts/ci-pins.mjs`, which looks up each action's newest release.
 */
export const ACTIONS = {
  checkout: {
    repo: 'actions/checkout',
    sha: '3d3c42e5aac5ba805825da76410c181273ba90b1',
    version: 'v7.0.1',
  },
  setupNode: {
    repo: 'actions/setup-node',
    sha: '949feb2413d6458794dcd2491c4babbbce0c15c1',
    version: 'v7.1.0',
  },
  setupPnpm: {
    repo: 'pnpm/action-setup',
    sha: 'ea17c68df8912ef543352723c149a84f56e3d413',
    version: 'v6.1.0',
  },
  cache: {
    repo: 'actions/cache',
    sha: '55cc8345863c7cc4c66a329aec7e433d2d1c52a9',
    version: 'v6.1.0',
  },
  awsLogin: {
    repo: 'aws-actions/configure-aws-credentials',
    sha: 'e1253824e5c10ff9df46874f81ed3ec929e19cfd',
    version: 'v6.3.0',
  },
  azureLogin: {
    repo: 'azure/login',
    sha: 'a641126d1b8aa4d1fa005f4f92df94a3a4c4c906',
    version: 'v3.1.0',
  },
  codeql: {
    repo: 'github/codeql-action',
    sha: '9b3254085494b55a0f7c4c2b3d2d52cc712ce370',
    version: 'v4.39.1',
  },
} as const;

export type ActionName = keyof typeof ACTIONS;

/** A `uses:` value: `owner/repo[/path]@<sha> # <version>`. */
export function uses(name: ActionName, path?: string): string {
  const action = ACTIONS[name];
  return `${action.repo}${path === undefined ? '' : `/${path}`}@${action.sha} # ${action.version}`;
}
