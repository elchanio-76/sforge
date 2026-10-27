// staticforge sign-in for private AWS targets (Lambda, Node.js 24, behind
// CloudFront at /_sforge/auth/*). It runs only while someone signs in; every
// other request is checked by the router function, which verifies the
// session cookie this Lambda sets.
//
//   login     Starts Cognito's authorization code flow with PKCE. The state,
//             the code verifier and the return URL wait in a short cookie.
//   callback  Exchanges the code, verifies the ID token against the user
//             pool's keys, sets the session cookie and returns to the page.
//             A preview host (pr-7.<previewDomain>) gets its own cookie
//             through a 60-second handoff token: Cognito allows no wildcard
//             callback URLs, so one callback on the domain serves every preview.
//   logout    Clears the cookie, then signs out of Cognito's managed login.
//
// The session cookie is base64url(JSON claims).hex(HMAC-SHA256) with the key
// the router reads from the KeyValueStore; this Lambda reads the same key from
// an SSM SecureString parameter (sforge writes both). Its settings come from a
// second parameter, so the function does not depend on the user pool client,
// whose callback URLs depend on the distribution in front of the function.

import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  verify as verifySignature,
} from 'node:crypto';

const SESSION = '__Host-sforge_session';
const LOGIN = '__Host-sforge_login';
const HANDOFF_SECONDS = 60;
const LOGIN_SECONDS = 600;
/** Clock skew tolerated when checking the ID token's expiry. */
const SKEW_SECONDS = 60;

const base64url = (buffer) => Buffer.from(buffer).toString('base64url');
const decodeJson = (text) => JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));

/** JSON with non-ASCII characters escaped: the router decodes it with atob. */
const asciiJson = (value) =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** A token the router accepts: base64url(claims).hex(HMAC-SHA256(key)). */
export function signToken(claims, key) {
  const body = Buffer.from(asciiJson(claims), 'utf8').toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('hex')}`;
}

const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;

function readCookies(event) {
  const found = {};
  for (const entry of event.cookies ?? []) {
    const eq = entry.indexOf('=');
    if (eq > 0) found[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
  }
  return found;
}

function redirect(location, cookies = []) {
  return {
    statusCode: 302,
    headers: { location, 'cache-control': 'no-store' },
    cookies,
    body: '',
  };
}

const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

function page(statusCode, title, message, cookies = []) {
  const body =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head>` +
    `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
    '<p><a href="/">Try again</a></p></main></body></html>';
  return {
    statusCode,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    cookies,
    body,
  };
}

/**
 * The handler, with its dependencies injectable for tests:
 * `parameter(name)` reads an SSM parameter, `fetch` reaches Cognito.
 */
export function createHandler(deps) {
  const fetchImpl = deps.fetch ?? fetch;
  const clock = deps.now ?? (() => Date.now());
  let settings;
  let keys;

  async function config() {
    settings ??= JSON.parse(await deps.parameter(deps.configParameter));
    return settings;
  }

  const isPreviewHost = (cfg, host) =>
    cfg.previewSuffix !== '' &&
    host.endsWith(cfg.previewSuffix) &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host.slice(0, -cfg.previewSuffix.length));

  /** Where to go after signing in: a URL on one of the site's hosts, never elsewhere. */
  function safeReturn(cfg, value, home) {
    try {
      const url = new URL(value);
      const host = url.host.toLowerCase();
      if (url.protocol === 'https:' && (cfg.hosts.includes(host) || isPreviewHost(cfg, host))) {
        return url.href;
      }
    } catch {
      // Not a URL: go home.
    }
    return `https://${home}/`;
  }

  async function signingKeys(refresh) {
    if (keys === undefined || refresh) {
      const cfg = await config();
      const response = await fetchImpl(`${cfg.issuer}/.well-known/jwks.json`);
      if (!response.ok) throw new Error(`JWKS: HTTP ${response.status}`);
      keys = (await response.json()).keys ?? [];
    }
    return keys;
  }

  /** The claims of a Cognito ID token, after checking its signature, issuer, audience and expiry. */
  async function verifyIdToken(token) {
    const cfg = await config();
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new Error('malformed ID token');
    const [head, payload, signature] = parts;
    const header = decodeJson(head);
    if (header.alg !== 'RS256') throw new Error(`unexpected algorithm ${header.alg}`);
    let jwk = (await signingKeys(false)).find((k) => k.kid === header.kid);
    // The pool may have rotated its keys since they were fetched.
    jwk ??= (await signingKeys(true)).find((k) => k.kid === header.kid);
    if (jwk === undefined) throw new Error('unknown signing key');
    const valid = verifySignature(
      'RSA-SHA256',
      Buffer.from(`${head}.${payload}`),
      createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(signature, 'base64url'),
    );
    if (!valid) throw new Error('bad signature');
    const claims = decodeJson(payload);
    const now = Math.floor(clock() / 1000);
    if (claims.iss !== cfg.issuer) throw new Error('wrong issuer');
    if (claims.aud !== cfg.clientId) throw new Error('wrong audience');
    if (claims.token_use !== 'id') throw new Error('not an ID token');
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < now) {
      throw new Error('expired');
    }
    if (typeof claims.sub !== 'string') throw new Error('no subject');
    return claims;
  }

  function login(cfg, query, host, home) {
    // The login cookie must be set on the host Cognito returns to.
    if (host !== home) {
      const back = query.return ?? `https://${host}/`;
      return redirect(`https://${home}/_sforge/auth/login?return=${encodeURIComponent(back)}`);
    }
    const state = base64url(randomBytes(16));
    const verifier = base64url(randomBytes(32));
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const pending = base64url(
      JSON.stringify({ state, verifier, back: safeReturn(cfg, query.return, home) }),
    );
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: `https://${home}/_sforge/auth/callback`,
      scope: 'openid email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return redirect(`${cfg.cognitoDomain}/oauth2/authorize?${params}`, [
      cookie(LOGIN, pending, LOGIN_SECONDS),
    ]);
  }

  async function callback(cfg, query, cookies, host, home) {
    const cleared = [cookie(LOGIN, '', 0)];
    if (query.error !== undefined) {
      return page(403, 'Sign-in failed', query.error_description ?? query.error, cleared);
    }
    let pending;
    try {
      pending = decodeJson(cookies[LOGIN] ?? '');
    } catch {
      pending = undefined;
    }
    if (host !== home || pending === undefined || query.state !== pending.state || !query.code) {
      return page(400, 'Sign-in expired', 'The sign-in took too long or was started elsewhere.');
    }
    const redirectUri = `https://${home}/_sforge/auth/callback`;
    const response = await fetchImpl(`${cfg.cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: cfg.clientId,
        code: query.code,
        redirect_uri: redirectUri,
        code_verifier: pending.verifier,
      }).toString(),
    });
    if (!response.ok) {
      console.error(`Token exchange failed: HTTP ${response.status}`);
      return page(
        502,
        'Sign-in failed',
        'The sign-in service did not accept the sign-in.',
        cleared,
      );
    }
    let identity;
    try {
      identity = await verifyIdToken((await response.json()).id_token);
    } catch (error) {
      console.error(`ID token rejected: ${error.message}`);
      return page(401, 'Sign-in failed', 'The sign-in could not be verified.', cleared);
    }
    const key = await deps.parameter(deps.keyParameter);
    if (!key || key === 'none') {
      return page(503, 'Sign-in is not set up yet', 'Run `sforge provision` for this target.');
    }
    const now = Math.floor(clock() / 1000);
    const claims = {
      sub: identity.sub,
      email: identity.email ?? '',
      exp: now + cfg.sessionHours * 3600,
    };
    const session = cookie(SESSION, signToken({ ...claims, host }, key), claims.exp - now);
    const back = new URL(pending.back);
    if (back.host === host) return redirect(back.href, [session, ...cleared]);
    // A preview: hand the sign-in over to its host, which sets its own cookie.
    const handoff = signToken({ ...claims, host: back.host, hx: now + HANDOFF_SECONDS }, key);
    const path = encodeURIComponent(back.pathname + back.search);
    return redirect(`https://${back.host}/_sforge/session?t=${handoff}&r=${path}`, [
      session,
      ...cleared,
    ]);
  }

  function logout(cfg, host, home) {
    const cleared = [cookie(SESSION, '', 0)];
    if (host !== home) return redirect(`https://${home}/_sforge/auth/logout`, cleared);
    const params = new URLSearchParams({ client_id: cfg.clientId, logout_uri: `https://${home}/` });
    return redirect(`${cfg.cognitoDomain}/logout?${params}`, cleared);
  }

  return async function handler(event) {
    try {
      const cfg = await config();
      const host = String(event.headers?.['x-sforge-host'] ?? '').toLowerCase();
      const home = cfg.hosts.includes(host) ? host : cfg.hosts[0];
      const query = event.queryStringParameters ?? {};
      switch (event.rawPath) {
        case '/_sforge/auth/login':
          return login(cfg, query, host, home);
        case '/_sforge/auth/callback':
          return await callback(cfg, query, readCookies(event), host, home);
        case '/_sforge/auth/logout':
          return logout(cfg, host, home);
        default:
          return page(404, 'Not found', 'There is no such page.');
      }
    } catch (error) {
      console.error(error);
      return page(500, 'Sign-in failed', 'Something went wrong. Try again in a moment.');
    }
  };
}

let ssm;

/** An SSM parameter, decrypted (the SDK is part of the Lambda runtime). */
async function ssmParameter(name) {
  const { GetParameterCommand, SSMClient } = await import('@aws-sdk/client-ssm');
  ssm ??= new SSMClient({});
  const result = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return result.Parameter?.Value;
}

export const handler = createHandler({
  parameter: ssmParameter,
  configParameter: process.env.SFORGE_CONFIG_PARAMETER,
  keyParameter: process.env.SFORGE_KEY_PARAMETER,
});
