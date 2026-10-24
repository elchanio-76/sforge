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

import cf from 'cloudfront';

// Replaced at provision time, e.g. {"trailingSlash":"always","previewSuffix":".preview.example.com"}.
const CONFIG = __SFORGE_CONFIG__;
const kvs = cf.kvs();

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

async function handler(event) {
  const request = event.request;
  // The error page fetched by CloudFront's custom error responses; nothing
  // else outside v/<version>/ (such as _sforge/versions.json) is reachable.
  if (request.uri === '/_sforge/errors/404.html') return request;

  const host = request.headers.host ? request.headers.host.value.toLowerCase() : '';
  const suffix = CONFIG.previewSuffix;
  let key = 'active';
  if (suffix !== '' && host.length > suffix.length && host.slice(-suffix.length) === suffix) {
    key = 'host:' + host.slice(0, host.length - suffix.length);
  }
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
