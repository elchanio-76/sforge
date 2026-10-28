import crypto, { createSign, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SITE_MODULE_DIR } from '../src/index.js';

const SECRET = 'a'.repeat(64);
const COOKIE = '__Host-sforge_session';

interface AuthConfig {
  loginHost: string;
  canonicalHost: string;
}

interface RouterResponse {
  statusCode?: number;
  headers?: Record<string, { value: string }>;
  cookies?: Record<string, { value: string; attributes: string }>;
  uri?: string;
}

type Router = (event: unknown) => Promise<RouterResponse>;

/** The router's code as provisioned: comment-only lines removed (router.tf). */
const provisionedRouter = () =>
  readFileSync(join(SITE_MODULE_DIR, 'router.js'), 'utf8').replace(/^[ \t]*\/\/.*\n/gm, '');

/** Load router.js as CloudFront would, with fake `cloudfront` and `crypto` modules. */
function loadRouter(auth: AuthConfig | null, kvs: Map<string, string>, now = Date.now()): Router {
  const source = provisionedRouter()
    .replace("import cf from 'cloudfront';", '')
    .replace("import crypto from 'crypto';", '')
    .replace(
      '__SFORGE_CONFIG__',
      JSON.stringify({ trailingSlash: 'always', previewSuffix: '.preview.example.com', auth }),
    );
  const cf = {
    kvs: () => ({
      async get(key: string) {
        const value = kvs.get(key);
        if (value === undefined) throw new Error(`Key ${key} not found`);
        return value;
      },
    }),
  };
  const clock = { now: () => now };
  return new Function('cf', 'crypto', 'Date', `${source}\nreturn handler;`)(
    cf,
    crypto,
    clock,
  ) as Router;
}

function request(
  uri: string,
  host = 'docs.example.com',
  cookies: Record<string, string> = {},
  querystring: Record<string, { value: string }> = {},
) {
  return {
    request: {
      uri,
      querystring,
      headers: { host: { value: host } },
      cookies: Object.fromEntries(Object.entries(cookies).map(([k, v]) => [k, { value: v }])),
    },
  };
}

interface Lambda {
  createHandler(deps: Record<string, unknown>): (event: unknown) => Promise<LambdaResponse>;
  signToken(claims: Record<string, unknown>, key: string): string;
}

interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  cookies: string[];
  body: string;
}

const lambda = (await import(
  pathToFileURL(join(SITE_MODULE_DIR, 'auth-lambda', 'index.mjs')).href
)) as Lambda;

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const nowSeconds = Math.floor(NOW / 1000);
const kvs = new Map([
  ['active', 'v1'],
  ['host:pr-7', 'pr-7'],
  ['auth:key', SECRET],
]);
const domainAuth = { loginHost: 'docs.example.com', canonicalHost: 'docs.example.com' };
const session = (claims: Record<string, unknown>) =>
  lambda.signToken(
    { sub: 'u1', email: 'ana@example.com', exp: nowSeconds + 3600, ...claims },
    SECRET,
  );

describe('router.js on a private target', () => {
  const router = loadRouter(domainAuth, kvs, NOW);

  it('serves pages with a valid session cookie for this host', async () => {
    const cookie = session({ host: 'docs.example.com' });
    expect((await router(request('/about/', 'docs.example.com', { [COOKIE]: cookie }))).uri).toBe(
      '/v/v1/about/index.html',
    );
  });

  it('sends everyone else to sign in, keeping the URL to return to', async () => {
    const expected = (uri: string) =>
      `https://docs.example.com/_sforge/auth/login?return=${encodeURIComponent(`https://docs.example.com${uri}`)}`;
    const cases: Record<string, string>[] = [
      {},
      { [COOKIE]: session({ host: 'docs.example.com', exp: nowSeconds - 1 }) },
      { [COOKIE]: session({ host: 'pr-7.preview.example.com' }) },
      { [COOKIE]: `${session({ host: 'docs.example.com' }).slice(0, -1)}0` },
      {
        [COOKIE]: lambda.signToken(
          { sub: 'u1', host: 'docs.example.com', exp: nowSeconds + 60 },
          'b'.repeat(64),
        ),
      },
      { [COOKIE]: 'garbage' },
    ];
    for (const cookies of cases) {
      const response = await router(request('/guides/', 'docs.example.com', cookies));
      expect(response.statusCode).toBe(302);
      expect(response.headers?.location?.value).toBe(expected('/guides/'));
      expect(response.headers?.['cache-control']?.value).toBe('no-store');
    }
    const withQuery = await router(
      request('/search/', 'docs.example.com', {}, { q: { value: 'tofu' } }),
    );
    expect(withQuery.headers?.location?.value).toBe(expected('/search/?q=tofu'));
  });

  it('protects the 404 page and every bookkeeping path too', async () => {
    for (const uri of ['/_sforge/errors/404.html', '/_sforge/versions.json', '/sitemap.xml']) {
      expect((await router(request(uri))).statusCode).toBe(302);
    }
    const cookie = { [COOKIE]: session({ host: 'docs.example.com' }) };
    expect(
      (await router(request('/_sforge/errors/404.html', 'docs.example.com', cookie))).uri,
    ).toBe('/_sforge/errors/404.html');
  });

  it('passes sign-in requests to the Lambda with the viewer host', async () => {
    const event = request('/_sforge/auth/login', 'pr-7.preview.example.com');
    const response = await router(event);
    expect(response.uri).toBe('/_sforge/auth/login');
    expect(response.headers?.['x-sforge-host']).toEqual({ value: 'pr-7.preview.example.com' });
  });

  it('redirects the CloudFront host to the domain', async () => {
    const response = await router(request('/a/', 'd111.cloudfront.net', {}, { x: { value: '1' } }));
    expect(response).toMatchObject({
      statusCode: 301,
      headers: { location: { value: 'https://docs.example.com/a/?x=1' } },
    });
  });

  it('signs previews in on the domain', async () => {
    const response = await router(request('/x/', 'pr-7.preview.example.com'));
    expect(response.headers?.location?.value).toBe(
      `https://docs.example.com/_sforge/auth/login?return=${encodeURIComponent('https://pr-7.preview.example.com/x/')}`,
    );
  });

  it('exchanges a fresh handoff token for a cookie on the preview host', async () => {
    const token = session({ host: 'pr-7.preview.example.com', hx: nowSeconds + 60 });
    const response = await router(
      request(
        '/_sforge/session',
        'pr-7.preview.example.com',
        {},
        {
          t: { value: token },
          r: { value: encodeURIComponent('/guides/?a=1') },
        },
      ),
    );
    expect(response.statusCode).toBe(302);
    expect(response.headers?.location?.value).toBe('/guides/?a=1');
    expect(response.cookies?.[COOKIE]?.value).toBe(token);
    expect(response.cookies?.[COOKIE]?.attributes).toBe(
      'Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600',
    );
    // The cookie it set is accepted on that host.
    expect((await router(request('/', 'pr-7.preview.example.com', { [COOKIE]: token }))).uri).toBe(
      '/v/pr-7/index.html',
    );
  });

  it('refuses stale, misdirected or ordinary tokens as handoffs, and foreign return paths', async () => {
    const tokens = [
      session({ host: 'pr-7.preview.example.com', hx: nowSeconds - 1 }),
      session({ host: 'pr-8.preview.example.com', hx: nowSeconds + 60 }),
      session({ host: 'pr-7.preview.example.com' }),
    ];
    for (const token of tokens) {
      const response = await router(
        request('/_sforge/session', 'pr-7.preview.example.com', {}, { t: { value: token } }),
      );
      expect(response.statusCode).toBe(403);
    }
    const token = session({ host: 'pr-7.preview.example.com', hx: nowSeconds + 60 });
    for (const r of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example/',
      '%E0%A4%A',
      '/\t/evil.example',
      '/\n/evil.example',
      '/ok\\evil.example',
    ]) {
      const response = await router(
        request(
          '/_sforge/session',
          'pr-7.preview.example.com',
          {},
          {
            t: { value: token },
            r: { value: encodeURIComponent(r) },
          },
        ),
      );
      expect(response.headers?.location?.value).toBe('/');
    }
  });

  it('answers 503 until sforge has written the session key', async () => {
    const unset = loadRouter(
      domainAuth,
      new Map([
        ['active', 'v1'],
        ['auth:key', 'none'],
      ]),
      NOW,
    );
    expect((await unset(request('/'))).statusCode).toBe(503);
  });

  it('signs in on the request host without a domain', async () => {
    const router = loadRouter({ loginHost: '', canonicalHost: '' }, kvs, NOW);
    const response = await router(request('/', 'd111.cloudfront.net'));
    expect(response.headers?.location?.value).toBe(
      `https://d111.cloudfront.net/_sforge/auth/login?return=${encodeURIComponent('https://d111.cloudfront.net/')}`,
    );
  });

  it('leaves public targets alone', async () => {
    const router = loadRouter(null, kvs, NOW);
    expect((await router(request('/'))).uri).toBe('/v/v1/index.html');
    expect((await router(request('/_sforge/errors/404.html'))).uri).toBe(
      '/_sforge/errors/404.html',
    );
  });

  it('fits the 10 KB limit of CloudFront Functions once provisioned', () => {
    const config = JSON.stringify({
      trailingSlash: 'always',
      previewSuffix: `.${'p'.repeat(240)}`,
      auth: { loginHost: 'h'.repeat(253), canonicalHost: 'h'.repeat(253) },
    });
    const code = provisionedRouter().replace('__SFORGE_CONFIG__', config);
    expect(code.length).toBeLessThanOrEqual(10 * 1024);
  });
});

/** A Cognito-like issuer: an RSA key, its JWKS, and ID tokens signed with it. */
function fakeIssuer() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const idToken = (claims: Record<string, unknown>, kid = 'k1') => {
    const head = b64({ alg: 'RS256', kid });
    const body = b64({
      iss: 'https://cognito-idp.eu-north-1.amazonaws.com/pool',
      aud: 'client-1',
      token_use: 'id',
      sub: 'u1',
      email: 'zoë@example.com',
      exp: nowSeconds + 3600,
      ...claims,
    });
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
    return `${head}.${body}.${signature.toString('base64url')}`;
  };
  return { jwk, idToken };
}

const settings = {
  clientId: 'client-1',
  cognitoDomain: 'https://sforge-abc.auth.eu-north-1.amazoncognito.com',
  issuer: 'https://cognito-idp.eu-north-1.amazonaws.com/pool',
  hosts: ['docs.example.com'],
  previewSuffix: '.preview.example.com',
  sessionHours: 8,
};

function lambdaHandler(idToken: string, jwk: Record<string, unknown>) {
  const requests: { url: string; body?: string }[] = [];
  const handler = lambda.createHandler({
    configParameter: '/sforge/docs-staging/auth/config',
    keyParameter: '/sforge/docs-staging/auth/key',
    parameter: async (name: string) =>
      name.endsWith('/config') ? JSON.stringify(settings) : SECRET,
    now: () => NOW,
    fetch: async (url: string, init?: { body?: string }) => {
      requests.push({ url, ...(init?.body !== undefined && { body: init.body }) });
      if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
      if (url.endsWith('/oauth2/token')) return Response.json({ id_token: idToken });
      return new Response('', { status: 404 });
    },
  });
  return { handler, requests };
}

const lambdaEvent = (
  path: string,
  host: string,
  query: Record<string, string> = {},
  cookies: string[] = [],
) => ({
  rawPath: path,
  headers: { 'x-sforge-host': host },
  queryStringParameters: query,
  cookies,
});

/** Sign in from `back` through the Lambda; returns the callback response. */
async function signIn(back: string, idToken?: string) {
  const issuer = fakeIssuer();
  const { handler, requests } = lambdaHandler(idToken ?? issuer.idToken({}), issuer.jwk);
  const login = await handler(
    lambdaEvent('/_sforge/auth/login', 'docs.example.com', { return: back }),
  );
  expect(login.statusCode).toBe(302);
  const authorize = new URL(login.headers.location!);
  const pending = login.cookies[0]!.split(';')[0]!;
  const callback = await handler(
    lambdaEvent(
      '/_sforge/auth/callback',
      'docs.example.com',
      { code: 'the-code', state: authorize.searchParams.get('state')! },
      [pending],
    ),
  );
  return { authorize, callback, requests, issuer, handler, pending };
}

describe('sign-in Lambda', () => {
  it('starts the code flow with PKCE on the domain', async () => {
    const { authorize, pending, requests } = await signIn('https://docs.example.com/guides/');
    expect(authorize.origin + authorize.pathname).toBe(
      'https://sforge-abc.auth.eu-north-1.amazoncognito.com/oauth2/authorize',
    );
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'client-1',
      redirect_uri: 'https://docs.example.com/_sforge/auth/callback',
      scope: 'openid email',
      code_challenge_method: 'S256',
    });
    const verifier = new URLSearchParams(requests.find((r) => r.url.endsWith('/token'))!.body).get(
      'code_verifier',
    )!;
    expect(crypto.createHash('sha256').update(verifier).digest('base64url')).toBe(
      authorize.searchParams.get('code_challenge'),
    );
    expect(pending.startsWith('__Host-sforge_login=')).toBe(true);
  });

  it('issues a session cookie the router accepts, and returns to the page', async () => {
    const { callback } = await signIn('https://docs.example.com/guides/');
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('https://docs.example.com/guides/');
    const set = callback.cookies.find((c) => c.startsWith(`${COOKIE}=`))!;
    expect(set).toContain('Secure; HttpOnly; SameSite=Lax; Max-Age=28800');
    expect(callback.cookies.some((c) => c.startsWith('__Host-sforge_login=;'))).toBe(true);
    const value = set.slice(COOKIE.length + 1, set.indexOf(';'));
    const router = loadRouter(domainAuth, kvs, NOW);
    expect((await router(request('/guides/', 'docs.example.com', { [COOKIE]: value }))).uri).toBe(
      '/v/v1/guides/index.html',
    );
  });

  it('hands a preview over through its host', async () => {
    const { callback } = await signIn('https://pr-7.preview.example.com/x/?y=1');
    const location = new URL(callback.headers.location!);
    expect(location.origin + location.pathname).toBe(
      'https://pr-7.preview.example.com/_sforge/session',
    );
    const router = loadRouter(domainAuth, kvs, NOW);
    const response = await router(
      request(
        '/_sforge/session',
        'pr-7.preview.example.com',
        {},
        {
          t: { value: location.searchParams.get('t')! },
          r: { value: encodeURIComponent(location.searchParams.get('r')!) },
        },
      ),
    );
    expect(response.headers?.location?.value).toBe('/x/?y=1');
    expect(response.cookies?.[COOKIE]).toBeDefined();
  });

  it('never returns to another site', async () => {
    const { callback } = await signIn('https://evil.example/');
    expect(callback.headers.location).toBe('https://docs.example.com/');
  });

  it('rejects ID tokens of another client or issuer, expired or unsigned', async () => {
    const issuer = fakeIssuer();
    const other = fakeIssuer();
    for (const token of [
      issuer.idToken({ aud: 'client-2' }),
      issuer.idToken({ iss: 'https://cognito-idp.eu-north-1.amazonaws.com/other' }),
      issuer.idToken({ token_use: 'access' }),
      issuer.idToken({ exp: nowSeconds - 3600 }),
      other.idToken({}),
      issuer.idToken({}, 'k9'),
    ]) {
      const { handler } = lambdaHandler(token, issuer.jwk);
      const login = await handler(lambdaEvent('/_sforge/auth/login', 'docs.example.com'));
      const state = new URL(login.headers.location!).searchParams.get('state')!;
      const callback = await handler(
        lambdaEvent('/_sforge/auth/callback', 'docs.example.com', { code: 'c', state }, [
          login.cookies[0]!.split(';')[0]!,
        ]),
      );
      expect(callback.statusCode).toBe(401);
      expect(callback.cookies.some((c) => c.startsWith(`${COOKIE}=`))).toBe(false);
    }
  });

  it('rejects a callback whose state does not match its login', async () => {
    const issuer = fakeIssuer();
    const { handler } = lambdaHandler(issuer.idToken({}), issuer.jwk);
    const login = await handler(lambdaEvent('/_sforge/auth/login', 'docs.example.com'));
    const callback = await handler(
      lambdaEvent('/_sforge/auth/callback', 'docs.example.com', { code: 'c', state: 'forged' }, [
        login.cookies[0]!.split(';')[0]!,
      ]),
    );
    expect(callback.statusCode).toBe(400);
    const none = await handler(
      lambdaEvent('/_sforge/auth/callback', 'docs.example.com', { code: 'c', state: 'x' }),
    );
    expect(none.statusCode).toBe(400);
  });

  it('sends sign-ins and sign-outs from other hosts to the domain', async () => {
    const issuer = fakeIssuer();
    const { handler } = lambdaHandler(issuer.idToken({}), issuer.jwk);
    const login = await handler(
      lambdaEvent('/_sforge/auth/login', 'pr-7.preview.example.com', {
        return: 'https://pr-7.preview.example.com/a/',
      }),
    );
    expect(login.headers.location).toBe(
      `https://docs.example.com/_sforge/auth/login?return=${encodeURIComponent('https://pr-7.preview.example.com/a/')}`,
    );
    const away = await handler(lambdaEvent('/_sforge/auth/logout', 'pr-7.preview.example.com'));
    expect(away.headers.location).toBe('https://docs.example.com/_sforge/auth/logout');
    expect(away.cookies).toEqual([`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`]);
    const out = await handler(lambdaEvent('/_sforge/auth/logout', 'docs.example.com'));
    expect(out.headers.location).toBe(
      `https://sforge-abc.auth.eu-north-1.amazoncognito.com/logout?client_id=client-1&logout_uri=${encodeURIComponent('https://docs.example.com/')}`,
    );
  });

  it('writes ASCII-only claims, which the router decodes with atob', () => {
    const token = lambda.signToken({ email: 'zoë@example.com', exp: 1 }, SECRET);
    const body = Buffer.from(token.split('.')[0]!, 'base64url').toString('latin1');
    expect(body).toBe('{"email":"zo\\u00eb@example.com","exp":1}');
  });
});
