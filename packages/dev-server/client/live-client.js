// staticforge dev client: reloads on rebuilds, hot-swaps CSS and shows build
// problems for the current page. Served only by `sforge dev`.
const source = new EventSource('/__sforge/events');
let current;

function swapStyles() {
  for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) continue;
    url.searchParams.set('sforge', Date.now().toString());
    link.href = url.href;
  }
}

function pageProblems(state) {
  const path = decodeURI(location.pathname);
  const page = state.pages.find((p) => {
    const url = decodeURI(p.url);
    return url === path || url === `${path}/`;
  });
  // Checker findings name their page; build diagnostics only their source file.
  return state.diagnostics.filter(
    (d) =>
      d.severity !== 'info' &&
      (d.url !== undefined
        ? page !== undefined && d.url === page.url
        : d.file === undefined || (page !== undefined && d.file === page.source)),
  );
}

const escape = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const STYLE = `
  :host { all: initial; position: fixed; right: 1rem; bottom: 1rem; z-index: 2147483647; font: 14px/1.4 system-ui, sans-serif; }
  aside { max-width: min(36rem, calc(100vw - 2rem)); background: #1b1b1f; color: #f3f3f6; border-radius: 8px; box-shadow: 0 4px 24px #0006; }
  button { all: unset; cursor: pointer; display: block; padding: .6rem .9rem; font-weight: 600; }
  button:focus-visible { outline: 3px solid #8ab4f8; outline-offset: 2px; border-radius: 8px; }
  ul { margin: 0; padding: 0 .9rem .8rem; list-style: none; max-height: 40vh; overflow: auto; }
  li { padding: .35rem 0; border-top: 1px solid #3a3a42; }
  .error { color: #ff9b9b; }
  .warning { color: #ffd479; }
  code { font: 12px ui-monospace, monospace; color: #b4b4bf; }
`;

function render(state) {
  let host = document.querySelector('sforge-overlay');
  const items = state.error
    ? [{ severity: 'error', ruleId: state.error.code, message: state.error.message }]
    : pageProblems(state);
  if (items.length === 0) {
    host?.remove();
    return;
  }
  if (host === null) {
    host = document.createElement('sforge-overlay');
    host.attachShadow({ mode: 'open' });
    document.body.append(host);
  }

  const errors = items.filter((d) => d.severity === 'error').length;
  const rows = items.map((d) => {
    const where = d.file ? ` · ${escape(d.file)}${d.line ? `:${d.line}` : ''}` : '';
    return `<li><span class="${d.severity}">${d.severity}</span> ${escape(d.message)}<br><code>${escape(d.ruleId)}${where}</code></li>`;
  });
  host.shadowRoot.innerHTML = `<style>${STYLE}</style>
    <aside aria-label="staticforge build problems">
      <button type="button" aria-expanded="true">${plural(errors, 'error')}, ${plural(items.length - errors, 'warning')}</button>
      <ul>${rows.join('')}</ul>
    </aside>`;

  const button = host.shadowRoot.querySelector('button');
  const list = host.shadowRoot.querySelector('ul');
  button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!open));
    list.hidden = open;
  });
}

source.addEventListener('state', (event) => {
  const state = JSON.parse(event.data);
  if (current !== undefined && state.id !== current) {
    if (!state.cssOnly) {
      location.reload();
      return;
    }
    swapStyles();
  }
  current = state.id;
  render(state);
});
