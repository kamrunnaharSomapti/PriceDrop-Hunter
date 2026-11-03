/*
 * PriceDrop Hunter - popup dashboard
 * Lists tracked products from chrome.storage.local with a small SVG sparkline.
 */
'use strict';

const { KEY_PREFIX, STORE_PREFIX, SETTINGS_KEY, SOURCE_LABEL, formatPrice, activeSale, saveStoreSale,
  describeSummary, categoryWords, siteOf, getSettings } = globalThis.PDH;
const SVG_NS = 'http://www.w3.org/2000/svg';

let products = [];
let stores = [];
let filter = 'all';

function timeAgo(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text; // textContent only: titles come from web pages
  return node;
}

/** Inline SVG sparkline. One point = dot, 2+ points = line with gradient fill. */
function sparkline(history, id) {
  const width = 96;
  const height = 32;
  const pad = 3;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.classList.add('spark');

  const prices = history.map((h) => h.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const x = (i) => (prices.length === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (prices.length - 1));
  const y = (p) => (max === min ? height / 2 : pad + (1 - (p - min) / range) * (height - pad * 2));

  if (prices.length === 1) {
    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', x(0));
    dot.setAttribute('cy', y(prices[0]));
    dot.setAttribute('r', 3);
    dot.classList.add('spark-dot');
    svg.append(dot);
    return svg;
  }

  const gradId = `grad-${id}`;
  const defs = document.createElementNS(SVG_NS, 'defs');
  const grad = document.createElementNS(SVG_NS, 'linearGradient');
  grad.id = gradId;
  grad.setAttribute('x1', 0); grad.setAttribute('y1', 0);
  grad.setAttribute('x2', 0); grad.setAttribute('y2', 1);
  for (const [offset, opacity] of [[0, 0.35], [1, 0]]) {
    const stop = document.createElementNS(SVG_NS, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', 'currentColor');
    stop.setAttribute('stop-opacity', opacity);
    grad.append(stop);
  }
  defs.append(grad);

  const points = prices.map((p, i) => `${x(i).toFixed(1)},${y(p).toFixed(1)}`);
  const area = document.createElementNS(SVG_NS, 'path');
  area.setAttribute('d', `M${points[0]} L${points.slice(1).join(' L')} L${x(prices.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`);
  area.setAttribute('fill', `url(#${gradId})`);

  const line = document.createElementNS(SVG_NS, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.classList.add('spark-line');

  const last = document.createElementNS(SVG_NS, 'circle');
  last.setAttribute('cx', x(prices.length - 1));
  last.setAttribute('cy', y(prices[prices.length - 1]));
  last.setAttribute('r', 2.5);
  last.classList.add('spark-dot');

  svg.append(defs, area, line, last);
  return svg;
}

function card(product, index) {
  const item = el('article', 'card');
  item.tabIndex = 0;
  item.title = product.url;
  const open = () => chrome.tabs.create({ url: product.url });
  item.addEventListener('click', open);
  item.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });

  const prices = product.history.map((h) => h.price);
  const lowest = Math.min(...prices);
  const fmt = (v) => formatPrice(v, product.currency);

  const info = el('div', 'info');
  info.append(el('div', 'title', product.title));
  info.append(el('div', 'site', `${product.site} · checked ${timeAgo(product.lastChecked)}`));

  const priceRow = el('div', 'prices');
  priceRow.append(el('span', 'current', fmt(product.price)));
  priceRow.append(el('span', 'lowest', `Low ${fmt(lowest)}`));
  if (product.sale?.onSale) priceRow.append(el('span', 'tag', `-${product.sale.percentOff}%`));
  info.append(priceRow);

  const trend = el('div', 'trend');
  const spark = sparkline(product.history, index);
  const first = prices[0];
  spark.classList.add(product.price < first ? 'down' : product.price > first ? 'up' : 'flat');
  trend.append(spark);

  item.append(info, trend);
  return item;
}

/** One store with an ongoing sale: discount, where it was seen, top items. */
function storeCard(store) {
  const target = store.pageUrl || store.summary?.sourceUrl || store.website;
  const item = el('article', 'card store-card');
  item.tabIndex = 0;
  item.title = target || '';
  const open = () => target && chrome.tabs.create({ url: target });
  item.addEventListener('click', open);
  item.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });

  const info = el('div', 'info');
  const head = el('div', 'prices');
  head.append(el('span', 'title', store.name || store.site));
  if (store.maxOff) head.append(el('span', 'tag', `${store.summary?.upTo || store.items.length ? 'up to ' : ''}${store.maxOff}% off`));
  info.append(head);

  const facts = [];
  if (store.items.length) facts.push(`${store.items.length} sale item${store.items.length === 1 ? '' : 's'}`);
  // The % is already in the tag; here just say until when and where it was seen.
  if (store.summary) facts.push(`${describeSummary({ ...store.summary, percentOff: 0 })} (${SOURCE_LABEL[store.summary.source] || 'web'})`);
  facts.push(`seen ${timeAgo(store.lastSeen)}`);
  info.append(el('div', 'site', facts.join(' · ')));

  if (store.summary?.note && !store.items.length) info.append(el('div', 'store-item', `“${store.summary.note}”`));
  const top = [...store.items].sort((a, b) => b.percentOff - a.percentOff).slice(0, 3);
  for (const sale of top) {
    const cur = sale.currency || store.currency;
    info.append(el('div', 'store-item', `${sale.title} · ${formatPrice(sale.price, cur)} (−${sale.percentOff}%)`));
  }
  item.append(info);
  return item;
}

const EMPTY_TEXT = {
  all: 'Nothing tracked yet. Open any product page in an online store and its price will be saved here.',
  sale: 'No sales found yet among your tracked products.',
  stores: 'No store sales yet. Open a store\'s sale page or its Facebook page, or add one below.',
};

function render() {
  const list = document.getElementById('list');
  const onSale = products.filter((p) => p.sale?.onSale);

  document.getElementById('count').textContent =
    `${products.length} item${products.length === 1 ? '' : 's'} tracked · ${stores.length} store${stores.length === 1 ? '' : 's'} on sale`;
  document.getElementById('sale-count').textContent = onSale.length ? `(${onSale.length})` : '';
  document.getElementById('store-count').textContent = stores.length ? `(${stores.length})` : '';
  document.getElementById('clear').disabled = products.length === 0 && stores.length === 0;

  const cards = filter === 'stores' ? stores.map(storeCard) : (filter === 'sale' ? onSale : products).map(card);
  list.replaceChildren(...cards);
  const empty = document.getElementById('empty');
  empty.hidden = cards.length > 0;
  empty.textContent = EMPTY_TEXT[filter];
}

async function load() {
  const all = await chrome.storage.local.get(null);
  products = Object.entries(all)
    .filter(([key, value]) => key.startsWith(KEY_PREFIX) && value?.history?.length)
    .map(([, value]) => value)
    .sort((a, b) => new Date(b.lastChecked) - new Date(a.lastChecked));
  stores = Object.entries(all)
    .filter(([key]) => key.startsWith(STORE_PREFIX))
    .map(([, value]) => activeSale(value))
    .filter(Boolean)
    .sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  render();
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    filter = tab.dataset.filter;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    render();
  });
});

document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm(`Delete all ${products.length} tracked items and ${stores.length} store sales? This cannot be undone.`)) return;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all)
    .filter((k) => k.startsWith(KEY_PREFIX) || k.startsWith(STORE_PREFIX) || k.startsWith('ai:')));
  await load();
});

// ---------------------------------------------------------------------------
// "This site has a sale" (manual entry for the current tab)
// ---------------------------------------------------------------------------

let currentTab = null;

async function setupMarkForm() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const details = document.getElementById('mark');
  let url = null;
  try { url = currentTab?.url ? new URL(currentTab.url) : null; } catch { /* no URL */ }
  if (!url || !/^https?:$/.test(url.protocol)) {
    details.hidden = true;
    return;
  }
  document.getElementById('mark-site').textContent = siteOf(url.hostname);
}

document.getElementById('mark-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = new URL(currentTab.url);
  const pct = Math.max(0, Math.min(95, Number(document.getElementById('mark-pct').value) || 0));
  const endDate = document.getElementById('mark-end').value || null;
  const category = document.getElementById('mark-cat').value;
  await saveStoreSale({
    site: url.hostname,
    name: currentTab.title?.split(/[|–—-]/).pop().trim().slice(0, 60) || null,
    pageUrl: currentTab.url,
    summary: { percentOff: pct, upTo: document.getElementById('mark-upto').checked, endDate,
      note: '', source: 'manual', sourceUrl: currentTab.url },
    keywords: categoryWords(category),
  });
  document.getElementById('mark').open = false;
  filter = 'stores';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.filter === 'stores'));
  await load();
});

// ---------------------------------------------------------------------------
// On-device AI switch
// ---------------------------------------------------------------------------

async function renderAi() {
  const statusEl = document.getElementById('ai-status');
  const button = document.getElementById('ai-toggle');
  const settings = await getSettings();
  const status = await PDH_AI.status();
  button.hidden = true;

  if (status === 'unsupported' || status === 'unavailable') {
    statusEl.textContent = 'Not available in this Chrome or on this computer (needs Chrome 138+, ~22 GB free disk, 16 GB RAM or a GPU). Normal sale detection still works.';
    return;
  }
  if (status === 'downloading') {
    statusEl.textContent = 'Downloading the model…';
    return;
  }
  button.hidden = false;
  if (status === 'downloadable') {
    statusEl.textContent = 'Reads sale banners the normal rules miss. One-time model download (a few GB). Runs on this computer.';
    button.textContent = 'Turn on';
    return;
  }
  statusEl.textContent = settings.aiEnabled
    ? 'On. Used only when a page mentions a sale the rules can\'t read.'
    : 'Ready, but off.';
  button.textContent = settings.aiEnabled ? 'Turn off' : 'Turn on';
}

document.getElementById('ai-toggle').addEventListener('click', async () => {
  const settings = await getSettings();
  const statusEl = document.getElementById('ai-status');
  if (!settings.aiEnabled && await PDH_AI.status() !== 'available') {
    statusEl.textContent = 'Downloading the model… you can close this popup.';
    try {
      await PDH_AI.enable((loaded) => { statusEl.textContent = `Downloading the model… ${Math.round(loaded * 100)}%`; });
    } catch (err) {
      statusEl.textContent = `Couldn't start the download: ${err.message}`;
      return;
    }
  }
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, aiEnabled: !settings.aiEnabled } });
  await renderAi();
});

load();
setupMarkForm();
renderAi();
