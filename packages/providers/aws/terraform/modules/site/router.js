// staticforge viewer-request router (CloudFront Functions, cloudfront-js-2.0).
//
// 1. Picks the version to serve from the KeyValueStore: "active", or for a PR
//    preview host (pr-42.<previewDomain>) the key "host:pr-42".
// 2. Maps the URL to an object the way `sforge dev`/`preview` do
//    (resolveRequest in @staticforge/server), by rule:
//      trailingSlash "always": /a/ → a/index.html, /a → 301 /a/
//      trailingSlash "never":  /a → a.html,        /a/ → 301 /a
//      /file.ext → file.ext; dot-segments and malformed paths → 404
//    Files that break the rule (a section index with "never", an
//    extensionless file, ...) are listed per version in the KVS as
//    "r:<version>:<path>" exceptions by `sforge deploy`.
// 3. Prefixes the object with v/<version>/. The rewritten URI is the cache
//    key, so a new version never serves stale cached objects.
//
// Private targets (auth) first check the session cookie, which the sign-in
// Lambda (/_sforge/auth/*) issues: base64url(JSON claims).hex(HMAC-SHA256),
// keyed with "auth:key" from the KVS. The claims bind it to one host and an
// expiry. A preview host gets its cookie from a handoff token
// (/_sforge/session?t=…): a cookie value that also carries a 60-second "hx"
// deadline, so it can only be exchanged right after signing in.
// Lines holding only a comment are removed when the function is provisioned
// (functions are limited to 10 KB).

import cf from 'cloudfront';
import crypto from 'crypto';

// Replaced at provision time, e.g. {"trailingSlash":"always","previewSuffix":".preview.example.com",
// "auth":{"loginHost":"docs.example.com","canonicalHost":"docs.example.com"}}; auth is null when public.
const CONFIG = __SFORGE_CONFIG__;
const kvs = cf.kvs();
const COOKIE = '__Host-sforge_session';

async function lookup(key) {
  try {
    return await kvs.get(key);
  } catch (e) {
    return null;
  }
}

function route(uri) {
  if (uri.charAt(0) !== '/') return { missing: true };
  const raw = uri.slice(1).split('/');
  const trailing = raw[raw.length - 1] === '';
  if (trailing) raw.pop();
  const canonical = [];
  for (let i = 0; i < raw.length; i++) {
    let segment;
    try {
      segment = decodeURIComponent(raw[i]);
    } catch (e) {
      return { missing: true };
    }
    if (
      segment === '' ||
      segment.charAt(0) === '.' ||
      segment.indexOf('\\') !== -1 ||
      segment.indexOf('\0') !== -1
    ) {
      return { missing: true };
    }
    canonical.push(encodeURIComponent(segment));
  }
  if (raw.length === 0) return { file: 'index.html' };

  const path = raw.join('/');
  const key = '/' + canonical.join('/') + (trailing ? '/' : '');
  if (trailing) {
    if (CONFIG.trailingSlash === 'always') return { file: path + '/index.html', key: key };
    // "/style.css/" is not a page; only pages lose their slash.
    return raw[raw.length - 1].indexOf('.') !== -1
      ? { missing: true, key: key }
      : { redirect: '/' + path, key: key };
  }
  if (raw[raw.length - 1].indexOf('.') !== -1) return { file: path };
  return CONFIG.trailingSlash === 'always'
    ? { redirect: '/' + path + '/', key: key }
    : { file: path + '.html', key: key };
}

function exception(value) {
  if (value === '404') return { missing: true };
  if (value.slice(0, 2) === 'f:') return { file: value.slice(2) };
  if (value.slice(0, 2) === 'r:') return { redirect: value.slice(2) };
  return null;
}

function queryString(querystring) {
  const parts = [];
  for (const name in querystring) {
    const entry = querystring[name];
    const values = entry.multiValue ? entry.multiValue : [entry];
    for (let i = 0; i < values.length; i++) {
      parts.push(values[i].value === '' ? name : name + '=' + values[i].value);
    }
  }
  return parts.length > 0 ? '?' + parts.join('&') : '';
}

function textResponse(statusCode, statusDescription, text) {
  return {
    statusCode: statusCode,
    statusDescription: statusDescription,
    headers: {
      'content-type': { value: 'text/plain; charset=utf-8' },
      'cache-control': { value: 'no-store' },
    },
    body: { encoding: 'text', data: text },
  };
}

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// The claims of a token signed with secret, or null (forged, malformed, expired).
function verify(token, secret, now) {
  const dot = token ? token.lastIndexOf('.') : -1;
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const expected = sign(body, secret);
  const given = token.slice(dot + 1);
  if (given.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return null;
  let claims;
  try {
    // The Lambda writes ASCII-only JSON, so atob's Latin-1 string is the JSON text.
    const base64 = body.replace(/-/g, '+').replace(/_/g, '/');
    claims = JSON.parse(atob(base64 + '==='.slice((base64.length + 3) % 4)));
  } catch (e) {
    return null;
  }
  return claims && typeof claims.exp === 'number' && claims.exp > now ? claims : null;
}

function redirect(statusCode, location, cookies) {
  const response = {
    statusCode: statusCode,
    statusDescription: statusCode === 301 ? 'Moved Permanently' : 'Found',
    headers: { location: { value: location }, 'cache-control': { value: 'no-store' } },
  };
  if (cookies) response.cookies = cookies;
  return response;
}

// Sign-in for private targets: a response, or undefined to let the request through.
async function authorize(request, host, preview) {
  const auth = CONFIG.auth;
  const query = request.querystring;
  if (auth.canonicalHost !== '' && host !== auth.canonicalHost && !preview) {
    return redirect(301, 'https://' + auth.canonicalHost + request.uri + queryString(query));
  }
  const secret = await lookup('auth:key');
  if (!secret || secret === 'none') {
    return textResponse(503, 'Service Unavailable', 'Sign-in is not set up yet.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (request.uri === '/_sforge/session') {
    const token = query.t ? query.t.value : '';
    const claims = verify(token, secret, now);
    if (!claims || claims.host !== host || !(claims.hx >= now)) {
      return textResponse(403, 'Forbidden', 'This sign-in link has expired. Open the page again.');
    }
    let back;
    try {
      back = query.r ? decodeURIComponent(query.r.value) : '/';
    } catch (e) {
      back = '/';
    }
    // Only paths on this host: never "//other.example" or "/\other.example". Browsers
    // drop tabs and line breaks from URLs, so "/%09/other.example" would become "//other.example".
    // eslint-disable-next-line no-control-regex
    if (back.charAt(0) !== '/' || back.charAt(1) === '/' || /[\\\x00-\x1f\x7f]/.test(back))
      back = '/';
    const cookies = {};
    cookies[COOKIE] = {
      value: token,
      attributes: 'Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + (claims.exp - now),
    };
    return redirect(302, back, cookies);
  }
  const cookie = request.cookies ? request.cookies[COOKIE] : undefined;
  const claims = verify(cookie ? cookie.value : '', secret, now);
  if (claims && claims.host === host) return undefined;
  const back = 'https://' + host + request.uri + queryString(query);
  return redirect(
    302,
    'https://' +
      (auth.loginHost || host) +
      '/_sforge/auth/login?return=' +
      encodeURIComponent(back),
  );
}

async function handler(event) {
  const request = event.request;
  const host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  const suffix = CONFIG.previewSuffix;
  let key = 'active';
  if (suffix !== '' && host.length > suffix.length && host.slice(-suffix.length) === suffix) {
    key = 'host:' + host.slice(0, host.length - suffix.length);
  }

  if (CONFIG.auth) {
    // The sign-in Lambda has its own cache behavior; CloudFront sends the
    // Lambda's host name to it, so it learns the viewer's host from here.
    if (request.uri.slice(0, 14) === '/_sforge/auth/') {
      request.headers['x-sforge-host'] = { value: host };
      return request;
    }
    const denied = await authorize(request, host, key !== 'active');
    if (denied) return denied;
  }

  // The error page fetched by CloudFront's custom error responses; nothing
  // else outside v/<version>/ (such as _sforge/versions.json) is reachable.
  // Those fetches skip this function, so signed-in users still get 404 pages.
  if (request.uri === '/_sforge/errors/404.html') return request;

  const version = await lookup(key);
  if (!version || version === 'none') {
    return key === 'active'
      ? textResponse(503, 'Service Unavailable', 'This site has not been deployed yet.')
      : textResponse(404, 'Not Found', 'No preview is deployed at this address.');
  }

  let target = route(request.uri);
  if (target.key !== undefined) {
    const value = await lookup('r:' + version + ':' + target.key);
    const override = value ? exception(value) : null;
    if (override !== null) target = override;
  }
  if (target.redirect !== undefined) {
    return {
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: { location: { value: target.redirect + queryString(request.querystring) } },
    };
  }
  // A key that never exists, so S3 answers 404 and CloudFront serves the 404 page.
  request.uri = '/v/' + version + '/' + (target.missing ? '_sforge/missing' : target.file);
  return request;
}
