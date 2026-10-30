# Releasing

All packages (`staticforge` and the `@staticforge/*` packages it depends on) are published
together, with the same version.

## Once: set up npm

1. Create the npm organization `staticforge` (free for public packages), so the `@staticforge`
   scope exists.
2. Publish the first version from your machine, signed in to npm (`npm login`, with 2FA):

   ```sh
   pnpm install && pnpm build && pnpm test && pnpm test:pack
   node scripts/publish.mjs            # add --dry-run first to see what would be published
   ```

   With 2FA, npm asks for each package: it either prints a link to approve the publish in the
   browser (tick "skip for the next 5 minutes" to approve the rest at once) or asks for a
   one-time password. An authenticator code is valid for about 30 seconds, so passing one with
   `--otp=<code>` only helps when few packages are left; a re-run skips the ones already
   published.

   npm can only set up trusted publishing for packages that exist.

3. For each of the 16 packages, on npmjs.com → the package → Settings → Trusted publishing, add a
   GitHub Actions publisher: repository `elchanio-76/sforge`, workflow `release.yml`, environment
   `npm`, and under Allowed actions tick **npm publish**. New entries only allow staged
   publishing, where every package waits for a manual approval. Then disallow token-based
   publishing.
   - The CLI package `staticforge` has no scope, so it is not listed under the `staticforge`
     organization: find it at npmjs.com/package/staticforge.
   - All fields must match exactly, and npm does not check them when you save. A mismatch shows
     up only at release time, as `404 Not Found - PUT https://registry.npmjs.org/<package>`;
     `403 … OIDC permission denied for this action` means npm publish is not ticked.
4. In the GitHub repository, create the environment `npm` (Settings → Environments), with
   required reviewers if releases should be approved. The repository must be public: npm only
   accepts provenance from public repositories, and a private one fails with
   `422 … Unsupported GitHub Actions source repository visibility`.

## Adding a package

npm can only set up trusted publishing for a package that exists, so a new `@staticforge/*`
package (such as `@staticforge/cloudflare`, added in 0.2.0) is published once from your machine
before the release that first includes it, then set up as in step 3:

```sh
pnpm build
cd packages/providers/<package> && pnpm publish --access public --no-git-checks
```

That first version carries no provenance; every later one comes from the release workflow.

## Every release

```sh
node scripts/version.mjs 0.2.0      # every package.json and the default theme's theme.json
pnpm install                        # refresh the lockfile
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

A prerelease such as `0.2.0-rc.1` (tag `v0.2.0-rc.1`) is published under the npm dist-tag `next`:
install it with `npm i -D staticforge@next`, while `npm i staticforge` keeps the latest release.

The tag starts `.github/workflows/release.yml`: it checks that the tag matches the versions,
builds, runs the tests and the tarball smoke test, and publishes with provenance through npm
trusted publishing (no npm token is stored anywhere). `scripts/publish.mjs` skips versions that
are already published, so a failed release can be re-run (`gh run rerun <run id> --failed`).
The `npm error 404 No match found for version` lines in its log are that check and are expected.
New versions take a minute or so to appear in `npm view` and `npm install`.

Two failures seen with 0.3.0, both fixed by waiting and re-running:

- `TLOG_CREATE_ENTRY_ERROR … (409) an equivalent entry already exists in the transparency log`:
  Sigstore's log answered slowly and npm's retry collided with its own entry. Nothing was
  published for that package; a re-run signs again.
- `409 Conflict … Cannot publish over previously staged version`: npm accepted an earlier
  publish (`+ <package>@<version>` in the log) but has not made it visible yet. This took six
  minutes once. `npm stage list <package>` (npm 11) shows nothing to approve; wait until
  `npm view <package>@<version>` answers, then re-run.
