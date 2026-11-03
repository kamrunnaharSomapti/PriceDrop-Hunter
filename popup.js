/*
 * PriceDrop Hunter - popup dashboard
 * Lists tracked products from chrome.storage.local with a small SVG sparkline.
 */
'use strict';

const KEY_PREFIX = 'p:';
const SVG_NS = 'http://www.w3.org/2000/svg';

let products = [];
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

function render() {
  const list = document.getElementById('list');
  const onSale = products.filter((p) => p.sale?.onSale);
  const shown = filter === 'sale' ? onSale : products;

  document.getElementById('count').textContent = `${products.length} item${products.length === 1 ? '' : 's'} tracked`;
  document.getElementById('sale-count').textContent = onSale.length ? `(${onSale.length})` : '';
  document.getElementById('clear').disabled = products.length === 0;

  list.replaceChildren(...shown.map(card));
  const empty = document.getElementById('empty');
  empty.hidden = shown.length > 0;
  empty.textContent = filter === 'sale' && products.length
    ? 'No sales found yet among your tracked products.'
    : 'Nothing tracked yet. Open any product page in an online store and its price will be saved here.';
}

async function load() {
  const all = await chrome.storage.local.get(null);
  products = Object.entries(all)
    .filter(([key, value]) => key.startsWith(KEY_PREFIX) && value?.history?.length)
    .map(([, value]) => value)
    .sort((a, b) => new Date(b.lastChecked) - new Date(a.lastChecked));
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
  if (!confirm(`Delete price history for all ${products.length} tracked items? This cannot be undone.`)) return;
  const keys = (await chrome.storage.local.get(null));
  await chrome.storage.local.remove(Object.keys(keys).filter((k) => k.startsWith(KEY_PREFIX)));
  await load();
});

load();
