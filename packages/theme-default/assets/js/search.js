// Progressive enhancement for layouts/search.njk: query the Pagefind index
// written at build time and announce the results.
const form = document.querySelector('[data-search-form]');
const status = document.querySelector('[data-search-status]');
const list = document.querySelector('[data-search-results]');

let pagefind;
const load = async () => (pagefind ??= await import('/pagefind/pagefind.js'));

function result(data) {
  const item = document.createElement('li');
  const heading = document.createElement('h2');
  const link = document.createElement('a');
  link.href = data.url;
  link.textContent = data.meta?.title ?? data.url;
  heading.append(link);
  const excerpt = document.createElement('p');
  // Pagefind escapes page text and marks matches with <mark>.
  excerpt.innerHTML = data.excerpt;
  item.append(heading, excerpt);
  return item;
}

async function run(query) {
  list.replaceChildren();
  if (query.trim() === '') {
    status.textContent = '';
    return;
  }
  status.textContent = 'Searching…';
  try {
    const search = await (await load()).search(query);
    const results = await Promise.all(search.results.slice(0, 20).map((r) => r.data()));
    list.replaceChildren(...results.map(result));
    const count = search.results.length;
    status.textContent =
      count === 0
        ? `No results for “${query}”.`
        : `${count} result${count === 1 ? '' : 's'} for “${query}”${count > 20 ? ', showing the first 20' : ''}.`;
  } catch {
    status.textContent = 'Search is unavailable right now.';
  }
}

if (form && status && list) {
  const input = form.querySelector('input[type="search"]');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = new URL(location.href);
    url.searchParams.set('q', input.value);
    history.replaceState(null, '', url);
    void run(input.value);
  });
  const initial = new URLSearchParams(location.search).get('q');
  if (initial) {
    input.value = initial;
    void run(initial);
  }
}
