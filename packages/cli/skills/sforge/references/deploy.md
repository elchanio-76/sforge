# Deploying, previews, rollback and users

## Two kinds of work

- **Infrastructure** (bucket, CDN, certificates, DNS, CI identities) is created by
  `sforge provision <target>` with OpenTofu or Terraform. It changes rarely and is an
  administrator's job. Over MCP it exists only with `sforge mcp --allow-infra`; otherwise ask
  the user to run it in a terminal. `sforge_status` reports drift (`data.drifted`).
- **Content** is uploaded by `sforge_deploy`. Every production deploy is a new version with id
  `<UTC time>-<git sha>`, e.g. `20261024T173405Z-6ffcbe4`.

A target is `targets.<name>` in the config with `provider: 'aws' | 'azure' | 'firebase'`.
`SF_NOT_PROVISIONED` means `provision` has not run for it (or its outputs cannot be read).

## A deploy, step by step

1. `sforge_check` until clean (the deploy runs the same check and refuses on failure).
2. `sforge_deploy` with `target` and `dryRun: true`: shows what would be uploaded. No confirmation
   needed.
3. Tell the user the target, the URL it serves (`sforge_status`), and what changes. Ask.
4. `sforge_deploy` with `confirm: true`. The result has the version id and URL.
5. Optionally `sforge_versions` to see it marked active, and open the URL.

The deploy builds with the target's own URL (`targets.<name>.baseUrl`, else
`https://<domain>/`, else `site.baseUrl`) for canonical links, feeds and the sitemap.
Commit first when you can: a version deployed from a dirty working tree cannot be rolled back to
on Azure (rollback rebuilds the commit).

## PR previews

`sforge_deploy` with `preview: "pr-42"` deploys a separate preview instead of production. It
still needs `confirm: true`. Previews get their own URL, are built with it as the base URL, and
carry `noindex`. Deploying the same id again overwrites it. Remove it with
`sforge_preview_destroy` (`target`, `id`, `confirm: true`).

| Provider | Preview needs                | URL                                                   | Limits                                                               |
| -------- | ---------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| AWS      | `domain` and `previewDomain` | `https://pr-42.<previewDomain>`                       | `SF_UNSUPPORTED` without them                                        |
| Azure    | nothing                      | `https://<app>-pr42.<region>.<n>.azurestaticapps.net` | Free plan: 3 previews (Standard 10); `pr-42` and `pr42` are the same |
| Firebase | nothing                      | `https://<site>--pr-42-<hash>.web.app`                | expire after `previewTtlDays` (default 7); `live` is reserved        |

Known issue (Firebase with a custom domain): a new preview channel sometimes answers "Site Not
Found" for ten minutes or more. Check a Firebase preview URL before telling the user it is ready.

## Rollback

`sforge_versions` lists versions newest first with the active one marked, plus previews.
`sforge_rollback` serves the version before the active one, or `to: <versionId>`; it needs
`confirm: true`.

| Provider | How it rolls back                                                                 | How long                                                                                                               |
| -------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| AWS      | switches a KeyValueStore pointer                                                  | seconds at most edges, all within a few minutes                                                                        |
| Azure    | **rebuilds** that version's commit and deploys it as a new version (`rollbackOf`) | a full build + deploy; needs the commit in the repository; not possible for versions deployed with uncommitted changes |
| Firebase | releases the earlier version again                                                | seconds; `to` accepts a version id or 4+ characters of the commit                                                      |

Only `retainVersions` (default 10) versions are kept; older ones cannot be rolled back to.
When verifying an AWS rollback or deploy over HTTP, allow a few minutes before concluding it did
not take effect.

## Private targets (`auth`)

A target with `auth` requires sign-in on every URL. Firebase cannot be private
(`SF_UNSUPPORTED`). Users are managed per target; every change needs `confirm: true`:

| Tool                           | AWS (Cognito)                                                         | Azure (Static Web Apps)                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sforge_users_list`            | Cognito users                                                         | invited `member` users                                                                                                                              |
| `sforge_users_invite` (`user`) | Cognito emails a temporary password (`data.emailed`); 50 emails a day | returns `data.invitationUrl` to send; `provider` `aad` (email) or `github` (user name); `expiresHours` 1–168; Free plan: 25 users (`SF_USER_LIMIT`) |
| `sforge_users_remove`          | access lasts until the session ends (`auth.sessionHours`)             | access lasts until they sign out; cannot be ended early                                                                                             |
| `sforge_users_revoke_sessions` | signs everyone out now                                                | `SF_UNSUPPORTED`                                                                                                                                    |

`SF_USER_EXISTS` for a user already invited. On public targets these tools answer
`SF_UNSUPPORTED`. Treat an Azure invitation URL as a credential: give it to the user, do not paste
it anywhere else.

## Cloud sign-in

The MCP server and the CLI use the sign-in of the environment they were started in:

| Provider   | sforge uses                                 | Typical fix for `SF_CLOUD_AUTH`                                   |
| ---------- | ------------------------------------------- | ----------------------------------------------------------------- |
| AWS        | SDK default chain (`AWS_PROFILE`, SSO, env) | `aws sso login --profile <profile>`                               |
| Azure      | `DefaultAzureCredential` (`az login`, env)  | `az login`                                                        |
| Firebase   | Application Default Credentials             | `gcloud auth application-default login`                           |
| Cloudflare | `CLOUDFLARE_API_TOKEN` (targets with `dns`) | export the token (needed by provision/status/destroy, not deploy) |

These logins open a browser: ask the user to run them. If the MCP server was started without the
right profile or variables, the user has to restart the client from a shell that has them.

## Other errors in this area

| Code                   | Meaning                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SF_CHECK_FAILED`      | The deploy's check failed; `details.diagnostics` has the problems.                                                                                   |
| `SF_DEPLOY_FAILED`     | Upload or switch failed. On AWS, a concurrent deploy to the same target makes the second fail: deploy again.                                         |
| `SF_VERSION_NOT_FOUND` | `to` names no retained version; list them with `sforge_versions`.                                                                                    |
| `SF_ENGINE_MISSING`    | Neither OpenTofu nor Terraform found (Terraform is never downloaded).                                                                                |
| `SF_STATE_MISSING`     | The remote state backend does not exist; `provision --bootstrap-state` creates it (an admin step).                                                   |
| `SF_IAC_FAILED`        | OpenTofu/Terraform failed; `details` has the engine's diagnostics.                                                                                   |
| `SF_UNSUPPORTED`       | The provider cannot do it: AWS previews without `previewDomain`, apex domains on Azure and Firebase, `auth` on Firebase, `revoke-sessions` on Azure. |

## Provider notes worth knowing

- **Azure Free plan**: 250 MB per environment, 15,000 files; `deploy` refuses larger sites
  before uploading. A private Azure target refuses a `static/staticwebapp.config.json` of its
  own.
- **Firebase**: a version's file count and size can show 0 for a few minutes after a deploy.
- **AWS**: previews on a custom domain are public URLs (only `noindex`) unless the target has
  `auth`.
- Changing `iac.name` (or `site.baseUrl` when `iac.name` is unset) renames the project and
  makes the next `provision` recreate everything. Do not change it on a provisioned site without
  the user's explicit decision.
- Do not create DNS records for a target's domain by hand when it uses `dns`; sforge owns them.
