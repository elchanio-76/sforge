# GitHub Actions

`sforge ci init` writes GitHub Actions workflows that check every pull request, deploy it as a
preview, and deploy the main branch to your targets. The workflows sign in to AWS and Azure with
GitHub's OIDC tokens through the identity `sforge provision` creates for each target, so the
repository holds no cloud secrets.

## Setting up

1. Give each target that CI deploys a `ci` option and provision it (as an administrator):

   ```ts
   targets: {
     aws: {
       provider: 'aws',
       region: 'eu-north-1',
       domain: 'aws.docs.example.com',
       previewDomain: 'preview.aws.docs.example.com',
       ci: { repo: 'acme/docs', branches: ['main'] },
     },
     azure: {
       provider: 'azure',
       resourceGroup: 'rg-docs',
       location: 'eastus2',
       ci: { repo: 'acme/docs', branches: [], environments: ['production'] },
     },
   }
   ```

   ```sh
   sforge provision aws
   sforge provision azure
   ```

2. Write the workflows and set the repository variables it prints:

   ```sh
   sforge ci init
   gh variable set SFORGE_AWS_ROLE_ARN --repo acme/docs --body arn:aws:iam::…
   # …and SFORGE_AZURE_CLIENT_ID, SFORGE_AZURE_TENANT_ID, SFORGE_AZURE_SUBSCRIPTION_ID
   ```

   The variables are identifiers (a role ARN, client, tenant and subscription IDs), not secrets.
   Run `sforge ci init` again after provisioning if it said a target was not provisioned yet;
   existing workflow files are kept unless you pass `--force`.

3. Create the GitHub environments the targets name (here `production`) under Settings →
   Environments, with required reviewers and limited to the deploying branch.

4. Commit the workflows and `.sforge/iac/<target>/.terraform.lock.hcl`: in CI, `deploy` reads the
   target's outputs from the remote state with the same providers.

Options: `--targets aws,azure` (default: every target with `ci`), `--package-manager pnpm|npm`
(default: from the lockfile) and `--force`.

## What the workflows do

`.github/workflows/sforge.yml`, on pull requests and pushes:

- **Build and check**: installs the dependencies and Chromium, runs
  `sforge check --headless --format sarif`, and uploads the findings to code scanning, which shows
  them on the pull request. Problems at or above `check.failOn` fail the job and block the deploys.
- **Preview on `<target>`** (pull requests): `sforge deploy <target> --preview pr-<number>`, for
  targets with `ci.pullRequests` that can serve previews (Azure always; AWS with `domain` and
  `previewDomain`). Then one comment on the pull request lists the preview URLs, updated on every
  push.
- **Deploy `<target>`** (pushes to the first of `ci.branches`, `main` without any): a production
  deploy. A target with `ci.environments` deploys inside the first environment, so its protection
  rules apply (for example, a required reviewer approves each deploy).

`.github/workflows/sforge-preview-cleanup.yml` removes a pull request's previews when it closes.
`.github/workflows/sforge-rollback.yml` is started by hand (Actions → Roll back → Run workflow)
with a target and, optionally, the version to serve.

Pull requests from forks get no OIDC token, so they are built and checked but never deployed.
Every job starts with no permissions and gets only what it needs: `id-token: write` for the jobs
that sign in to a cloud, `security-events: write` for the upload, `pull-requests: write` for the
comment. Deploys to one target never run at the same time.

## Which workflows can deploy

A target's `ci` option decides which GitHub OIDC subjects its identity accepts:

| `ci`                           | Accepted subject                        | Used by                                      |
| ------------------------------ | --------------------------------------- | -------------------------------------------- |
| `branches: ['main']`           | `repo:acme/docs:ref:refs/heads/main`    | deploy jobs without an environment           |
| `environments: ['production']` | `repo:acme/docs:environment:production` | deploy and rollback jobs in that environment |
| `pullRequests: true`           | `repo:acme/docs:pull_request`           | preview and cleanup jobs                     |

A job that names an environment presents the environment subject, not the branch: give a target
either branches or environments for production. On AWS the role's trust policy lists the
subjects; on Azure each subject is a federated login of the target's Entra application.

Repositories created since July 2026 (and older ones that opted in) use **immutable subjects**,
which add the owner's and the repository's numeric IDs: `repo:acme@1001/docs@2002:pull_request`.
A recreated repository with the same name gets new IDs, so it cannot deploy. `sforge provision`
reads the repository's subject format from GitHub
(`GET /repos/acme/docs/actions/oidc/customization/sub`) and builds the subjects from it. That
works without a token for a public repository; for a private one, set `GH_TOKEN` (for example
`GH_TOKEN=$(gh auth token)`). Alternatively, set the prefix yourself:
`ci: { repo: 'acme/docs', subjectPrefix: 'repo:acme@1001/docs@2002' }`. If you switch a repository
to immutable subjects later, run `sforge provision` again. Custom subject templates
(`use_default: false`) are not supported.

## Pinned actions

The workflows use each action at a full commit SHA with its version in a comment
(`actions/checkout@<sha> # v7.0.1`), because a tag can be moved and a commit cannot. Dependabot
or Renovate can keep them current. In the staticforge repository, `node scripts/ci-pins.mjs`
updates the versions `ci init` writes.
