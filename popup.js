/*
 * PriceDrop Hunter - popup dashboard
 * Lists tracked products from chrome.storage.local with a small SVG sparkline.
 */
'use strict';

const KEY_PREFIX = 'p:';   // tracked products
const STORE_PREFIX = 's:'; // stores with an ongoing sale
const SVG_NS = 'http://www.w3.org/2000/svg';

let products = [];
let stores = [];
let filter = 'all';

function formatPrice(value, currency) {
  try {
    if (currency) return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  } catch { /* unknown currency code */ }
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

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

/** One store with an ongoing sale: item count, biggest discount, a few items. */
function storeCard(store) {
  const item = el('article', 'card store-card');
  item.tabIndex = 0;
  item.title = store.pageUrl;
  const open = () => chrome.tabs.create({ url: store.pageUrl });
  item.addEventListener('click', open);
  item.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });

  const maxOff = Math.max(...store.items.map((i) => i.percentOff));
  const info = el('div', 'info');
  const head = el('div', 'prices');
  head.append(el('span', 'title', store.site));
  head.append(el('span', 'tag', `up to ${maxOff}% off`));
  info.append(head);
  info.append(el('div', 'site', `${store.items.length} sale item${store.items.length === 1 ? '' : 's'} · seen ${timeAgo(store.lastSeen)}`));

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
  stores: 'No store sales yet. Open a store\'s sale page (or any page with crossed-out prices) and it will show up here.',
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
    .filter(([key, value]) => key.startsWith(STORE_PREFIX) && value?.items?.length)
    .map(([, value]) => value)
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
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX) || k.startsWith(STORE_PREFIX)));
  await load();
});

load();
