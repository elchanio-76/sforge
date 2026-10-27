# Private sites

A target with `auth` is private: every URL requires signing in. That covers the pages, assets,
the search index, the sitemap and the 404 page. A target is either public or private; there are
no private sections.

sforge manages who may sign in. It never manages the network: the site stays on the internet,
behind sign-in. For a domain that resolves only on a company network, see
[Private DNS](#private-dns).

## AWS: Cognito user pool

```ts
intranet: {
  provider: 'aws',
  region: 'eu-north-1',
  domain: 'intra.example.com',
  dns: { provider: 'cloudflare', zone: 'example.com' },
  auth: {
    sessionHours: 8, // 1 to 24
    mfa: 'optional', // 'off', 'optional' or 'required' (authenticator apps)
  },
},
```

`sforge provision` adds a Cognito user pool (Essentials tier) with Cognito's managed login, and a
small Lambda function that runs only while someone signs in. The router function that serves
every request checks a signed session cookie first; visitors without one go to the sign-in page
and come back to the page they asked for. There is no self sign-up and no federation.

Everything fits the AWS free tiers: Cognito covers 10,000 monthly active users, and the Lambda
runs once per sign-in.

The cookie key is created by `provision` and is never written to state or to a file: it lives in
the target's CloudFront KeyValueStore and in an SSM SecureString parameter. The CI deploy role can
read the KeyValueStore (it switches versions there), so treat a CI role as able to sign in.

### Users

```sh
sforge users invite intranet ana@example.com
sforge users list intranet
sforge users remove intranet ana@example.com
sforge users revoke-sessions intranet
```

Cognito emails each invited user a temporary password, which they replace when they first sign
in. Its default sender allows 50 emails a day; invitations beyond that fail until the next day.

A removed user keeps access until their session ends (at most `sessionHours`).
`revoke-sessions` replaces the cookie key, which signs everyone out at once (the change reaches
all CloudFront edges within minutes). Everyone then signs in again.

Run these commands with your own AWS sign-in. Deploys from CI never touch the user pool.

### Previews and the CloudFront host

PR previews (`previewDomain`) are private too. Sign-in always happens on the domain; a preview
host then gets its own cookie through a one-minute handoff link, so one callback URL serves every
preview.

With a domain, the `*.cloudfront.net` host redirects to it. Set `allowCloudFrontHost: true` to
serve the site and sign in there as well (for example from outside the company network).

## Azure: Static Web Apps roles

```ts
handbook: {
  provider: 'azure',
  resourceGroup: 'rg-handbook',
  location: 'eastus2',
  auth: { providers: ['aad', 'github'] }, // default ['aad']
},
```

Static Web Apps signs visitors in with its preconfigured providers: `aad` (Microsoft accounts and
any Entra ID tenant) and `github`. Visitors are sent to the first provider in the list. Signing in
is not enough: only users invited with the role `member` get in. Everyone else sees a short page
that explains this and offers to sign out.

`sforge deploy` writes the access rules into `staticwebapp.config.json`. A private target cannot
use its own `static/staticwebapp.config.json`: the deploy refuses it, since it could leave the
site public.

### Users

```sh
sforge users invite handbook ana@example.com
sforge users invite handbook octocat --provider github --expires 24
sforge users list handbook
sforge users remove handbook ana@example.com
```

Static Web Apps sends no email: `invite` prints an invitation link (valid 1 to 168 hours, 168 by
default). Send it to the user; they open it and sign in with the account it names (an email
address for `aad`, a user name for `github`).

The Free plan allows 25 users with custom roles per app; `invite` refuses the 26th
(`SF_USER_LIMIT`). Restricting sign-in to one Entra ID tenant, to groups, or to another identity
provider needs the Standard plan and is not supported.

## Private DNS

```ts
privateDns: true, // with domain
```

Use `privateDns` when the domain resolves only in an internal DNS zone (Active Directory DNS,
Infoblox, a VPN's resolver). CloudFront and Static Web Apps still validate domains over public
DNS, so:

- The public zone gets only validation records: the certificate's CNAME records on AWS, a TXT
  record (`_dnsauth.<domain>`) on Azure. sforge creates them through `dns`, or prints them for
  you to create.
- The site's own records (the domain, and the preview wildcard on AWS) are never published.
  `provision` and `status` print them (`dns_private_records` in `--json`) for whoever runs the
  internal DNS:

  ```text
  Add these records to your internal (private) DNS zone:
    intra.example.com CNAME d1234abcd.cloudfront.net
  ```

The site stays reachable through its `*.cloudfront.net` or `*.azurestaticapps.net` host, so
private DNS hides the site but does not protect it. Combine it with `auth`; without `auth`,
`provision` warns.

## Search engines and caches

Private sites are built with `<meta name="robots" content="noindex">`, as previews are. Their
pages are sent with `Cache-Control: private`, so no shared cache keeps a copy.

## Errors

`sforge users` on a public target fails with `SF_UNSUPPORTED`; inviting an existing user with
`SF_USER_EXISTS`, and a user beyond the Azure Free plan's limit with `SF_USER_LIMIT`.
