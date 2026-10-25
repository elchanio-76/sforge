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

   npm can only set up trusted publishing for packages that exist.

3. For each of the 14 packages, on npmjs.com → the package → Settings → Trusted publishing, add a
   GitHub Actions publisher: repository `elchanio-76/sforge`, workflow `release.yml`, environment
   `npm`. Then disallow token-based publishing.
4. In the GitHub repository, create the environment `npm` (Settings → Environments), with
   required reviewers if releases should be approved.

## Every release

```sh
node scripts/version.mjs 0.2.0      # every package.json and the default theme's theme.json
pnpm install                        # refresh the lockfile
git commit -am "Release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

The tag starts `.github/workflows/release.yml`: it checks that the tag matches the versions,
builds, runs the tests and the tarball smoke test, and publishes with provenance through npm
trusted publishing (no npm token is stored anywhere). `scripts/publish.mjs` skips versions that
are already published, so a failed release can be re-run.
