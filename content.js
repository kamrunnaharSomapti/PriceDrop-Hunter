/*
 * PriceDrop Hunter - content script
 *
 * Runs on every page, but only acts on product pages. It finds the product's
 * title and price, saves one price snapshot per day to chrome.storage.local,
 * and shows a small badge with the price history verdict.
 *
 * How a product page is found (first match wins):
 *   1. Store configs (Amazon today) with hand-written selectors.
 *   2. schema.org Product data (JSON-LD) that most online stores publish.
 *   3. Product meta tags (og/product:price, itemprop=price).
 *
 * Nothing leaves the browser.
 */
(() => {
  'use strict';

  if (window.__priceDropHunterLoaded) return;
  window.__priceDropHunterLoaded = true;

  const MAX_SNAPSHOTS = 365;
  const KEY_PREFIX = 'p:';
  const RETRY_DELAYS_MS = [0, 1500, 4000]; // prices often render late

  // ---------------------------------------------------------------------------
  // Store configs. To add a store, add an entry with the same shape.
  // ---------------------------------------------------------------------------
  const STORE_CONFIGS = [
    {
      name: 'Amazon',
      match: (host) => /(^|\.)amazon\.[a-z.]+$/i.test(host),
      getId: (loc) => {
        const m = loc.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
        return m ? m[1].toUpperCase() : null;
      },
      getUrl: (loc, id) => `${loc.origin}/dp/${id}`,
      title: ['#productTitle', '#title'],
      price: [
        '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
        '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen',
        '#apex_desktop .a-price:not(.a-text-price) .a-offscreen',
        '#priceblock_dealprice',
        '#priceblock_ourprice',
        '#price_inside_buybox',
      ],
      originalPrice: [
        '#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen',
        '#corePrice_feature_div .a-text-price .a-offscreen',
        '#apex_desktop .a-text-price .a-offscreen',
      ],
      badgeAnchor: ['#corePriceDisplay_desktop_feature_div', '#corePrice_feature_div', '#apex_desktop'],
    },
  ];

  // Generic "crossed-out / was" price elements, searched only near the price.
  const ORIGINAL_PRICE_SELECTORS = [
    's', 'del', 'strike',
    '[class*="compare-at" i]', '[class*="compare_at" i]', '[class*="price--compare" i]',
    '[class*="was-price" i]', '[class*="original-price" i]', '[class*="old-price" i]',
    '[class*="regular-price" i]', '[class*="list-price" i]', '[class*="strike" i]',
  ].join(',');

  // ---------------------------------------------------------------------------
  // Price parsing
  // ---------------------------------------------------------------------------

  /** Turns "$1,299.99", "1.299,99 €", "Rs. 1,299" into a float, or null. */
  function parsePrice(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return raw > 0 ? raw : null;
    const match = String(raw).replace(/[\s'’]/g, '').match(/\d[\d.,]*/);
    if (!match) return null;
    let s = match[0].replace(/[.,]$/, '');
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');

    if (lastDot !== -1 && lastComma !== -1) {
      // Both present: whichever comes last is the decimal mark.
      const dec = lastDot > lastComma ? '.' : ',';
      const thou = dec === '.' ? ',' : '.';
      s = s.split(thou).join('').replace(dec, '.');
    } else if (lastComma !== -1) {
      // Only commas: "12,99" is decimal, "1,299" / "1,299,000" is thousands.
      const decimals = s.length - lastComma - 1;
      s = (s.split(',').length === 2 && decimals !== 3) ? s.replace(',', '.') : s.split(',').join('');
    } else if (s.split('.').length > 2) {
      s = s.split('.').join(''); // "1.299.000"
    }

    const value = parseFloat(s);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  const SYMBOL_TO_ISO = { '£': 'GBP', '€': 'EUR', '₹': 'INR', '¥': 'JPY', '৳': 'BDT', '₩': 'KRW', '₱': 'PHP', '₺': 'TRY', 'R$': 'BRL', 'C$': 'CAD', 'A$': 'AUD', '$': 'USD' };

  /** Best guess of currency from price text, e.g. "£12.00" -> GBP. */
  function currencyFromText(text) {
    if (!text) return null;
    const iso = String(text).match(/\b([A-Z]{3})\b/);
    if (iso) return iso[1];
    for (const [symbol, code] of Object.entries(SYMBOL_TO_ISO)) {
      if (String(text).includes(symbol)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  const isVisible = (el) => !!(el && (el.offsetParent || el.getClientRects().length));

  function firstMatch(selectors) {
    for (const sel of selectors || []) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  /** Amazon hides the full price in .a-offscreen; fall back to visible text. */
  function priceText(el) {
    if (!el) return '';
    const text = el.textContent.trim();
    if (text) return text;
    const box = el.closest('.a-price');
    return box ? box.innerText.replace(/\n/g, '') : '';
  }

  const metaContent = (selector) => document.querySelector(selector)?.getAttribute('content') || null;

  /** Finds the visible element showing this exact price, to anchor the badge. */
  function findPriceElement(price) {
    const candidates = document.querySelectorAll('[itemprop="price"], [class*="price" i], [data-price]');
    for (const el of candidates) {
      if (!isVisible(el) || el.closest('s, del, strike')) continue;
      const text = el.textContent.trim();
      if (!text || text.length > 40) continue;
      const value = parsePrice(el.getAttribute('content') || text);
      if (value != null && Math.abs(value - price) < 0.005) return el;
    }
    return null;
  }

  /** Looks for a crossed-out "was" price near the current price element. */
  function findOriginalPriceNear(priceEl, price) {
    let scope = priceEl;
    for (let i = 0; i < 3 && scope.parentElement; i++) {
      scope = scope.parentElement;
      for (const el of scope.querySelectorAll(ORIGINAL_PRICE_SELECTORS)) {
        if (!isVisible(el)) continue;
        const text = el.textContent.trim();
        if (!text || text.length > 40) continue;
        const value = parsePrice(text);
        if (value != null && value > price * 1.005 && value < price * 10) return value;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Extractors. Each returns a product object or null.
  // ---------------------------------------------------------------------------

  function extractFromConfig(config) {
    const id = config.getId(location);
    if (!id) return null;
    const titleEl = firstMatch(config.title);
    const priceEl = firstMatch(config.price);
    const text = priceText(priceEl);
    const price = parsePrice(text);
    if (!titleEl || price == null) return null;

    const original = parsePrice(priceText(firstMatch(config.originalPrice)));
    return {
      id: `${config.name.toLowerCase()}:${id}`,
      site: config.name,
      title: titleEl.textContent.trim(),
      url: config.getUrl ? config.getUrl(location, id) : cleanUrl(),
      price,
      currency: currencyFromText(text),
      originalPrice: original && original > price ? original : null,
      anchor: firstMatch(config.badgeAnchor) || priceEl,
    };
  }

  function typesOf(node) {
    const t = node['@type'];
    return (Array.isArray(t) ? t : [t]).filter((x) => typeof x === 'string');
  }

  /** Walks JSON-LD to find a Product node that has offers. */
  function findProductNode(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (Array.isArray(node)) {
      for (const n of node) {
        const found = findProductNode(n, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const types = typesOf(node);
    if (types.includes('Product') && node.offers) return node;
    if (types.includes('ProductGroup') && node.hasVariant) {
      const variant = findProductNode(node.hasVariant, depth + 1);
      if (variant) return { ...variant, name: variant.name || node.name, productGroupID: node.productGroupID };
    }
    return findProductNode(node['@graph'] || node.mainEntity || null, depth + 1);
  }

  /** Reads price, currency and a strikethrough/list price from schema.org offers. */
  function readOffers(offers) {
    const list = [].concat(offers || []).flatMap((o) =>
      o && typesOf(o).includes('AggregateOffer') && o.offers ? [].concat(o.offers) : [o]
    ).filter(Boolean);

    for (const offer of list) {
      const specs = [].concat(offer.priceSpecification || []);
      let original = null;
      let specPrice = null;
      for (const spec of specs) {
        const value = parsePrice(spec.price);
        if (/StrikethroughPrice|ListPrice|MSRP/i.test(spec.priceType || '')) original = value;
        else if (specPrice == null) specPrice = value;
      }
      const price = parsePrice(offer.price) ?? parsePrice(offer.lowPrice) ?? specPrice;
      if (price != null) {
        return {
          price,
          currency: offer.priceCurrency || specs.find((s) => s.priceCurrency)?.priceCurrency || null,
          original: original && original > price ? original : null,
        };
      }
    }
    return null;
  }

  function extractFromJsonLd() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let data;
      try { data = JSON.parse(script.textContent); } catch { continue; }
      const product = findProductNode(data);
      if (!product) continue;
      const offer = readOffers(product.offers);
      const title = (product.name || '').trim() || metaContent('meta[property="og:title"]');
      if (!offer || !title) continue;
      const key = product.sku || product.productID || product.gtin13 || product.gtin || product.mpn;
      return buildGeneric(title, offer.price, offer.currency, offer.original, key);
    }
    return null;
  }

  function extractFromMeta() {
    const priceEl = document.querySelector('[itemprop="price"]');
    const rawPrice =
      metaContent('meta[property="product:price:amount"]') ||
      metaContent('meta[property="og:price:amount"]') ||
      (priceEl && (priceEl.getAttribute('content') || priceEl.textContent));
    const price = parsePrice(rawPrice);
    const title = metaContent('meta[property="og:title"]') || document.querySelector('[itemprop="name"]')?.textContent;
    if (price == null || !title) return null;
    const currency =
      metaContent('meta[property="product:price:currency"]') ||
      metaContent('meta[property="og:price:currency"]') ||
      document.querySelector('[itemprop="priceCurrency"]')?.getAttribute('content') ||
      currencyFromText(rawPrice);
    return buildGeneric(title.trim(), price, currency, null, null);
  }

  function cleanUrl() {
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    if (canonical && canonical.startsWith(location.origin)) return canonical;
    return location.origin + location.pathname + location.search;
  }

  function buildGeneric(title, price, currency, original, productKey) {
    const host = location.hostname.replace(/^www\./, '');
    const url = cleanUrl();
    const priceEl = findPriceElement(price);
    const nearOriginal = !original && priceEl ? findOriginalPriceNear(priceEl, price) : null;
    return {
      id: `${host}:${productKey || new URL(url).pathname}`,
      site: host,
      title,
      url,
      price,
      currency: currency ? String(currency).toUpperCase() : null,
      originalPrice: original || nearOriginal,
      anchor: priceEl,
    };
  }

  function extractProduct() {
    const config = STORE_CONFIGS.find((c) => c.match(location.hostname));
    if (config) return extractFromConfig(config); // known store: trust only its selectors
    return extractFromJsonLd() || extractFromMeta();
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

  /** Saves today's snapshot (one per day) and returns the stored record. */
  async function saveSnapshot(product) {
    const key = KEY_PREFIX + product.id;
    const stored = (await chrome.storage.local.get(key))[key];
    const history = stored?.history ? [...stored.history] : [];
    const date = today();

    const last = history[history.length - 1];
    if (last && last.date === date) last.price = product.price; // keep one per day, latest price wins
    else history.push({ date, price: product.price });
    if (history.length > MAX_SNAPSHOTS) history.splice(0, history.length - MAX_SNAPSHOTS);

    const record = {
      id: product.id,
      site: product.site,
      title: product.title.slice(0, 300),
      url: product.url,
      currency: product.currency || stored?.currency || null,
      price: product.price,
      originalPrice: product.originalPrice || null,
      history,
      firstSeen: stored?.firstSeen || new Date().toISOString(),
      lastChecked: new Date().toISOString(),
    };
    record.sale = computeSale(record);
    await chrome.storage.local.set({ [key]: record });
    return record;
  }

  /**
   * A product is "on sale" if the store shows a crossed-out price, or the price
   * dropped compared with the last different-day snapshot.
   */
  function computeSale(record) {
    const { price, originalPrice, history } = record;
    if (originalPrice && originalPrice > price) {
      return { onSale: true, reason: 'store', was: originalPrice, percentOff: Math.round((1 - price / originalPrice) * 100) };
    }
    const previous = history.length > 1 ? history[history.length - 2] : null;
    if (previous && previous.price > price * 1.005) {
      return { onSale: true, reason: 'drop', was: previous.price, since: previous.date, percentOff: Math.round((1 - price / previous.price) * 100) };
    }
    return { onSale: false };
  }

  // ---------------------------------------------------------------------------
  // Badge (Shadow DOM so store CSS can't touch it and ours can't leak out)
  // ---------------------------------------------------------------------------

  const BADGE_ID = 'pricedrop-hunter-badge';

  const BADGE_CSS = `
    :host { all: initial; display: block; margin: 6px 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    :host(.floating) { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; margin: 0; max-width: 320px; }
    .badge { display: inline-flex; flex-direction: column; gap: 2px; padding: 6px 10px; border-radius: 8px;
             font-size: 13px; line-height: 1.35; border: 1px solid; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
    .low { background: #ecfdf3; color: #05603a; border-color: #a6f4c5; }
    .high { background: #fef3f2; color: #a01d14; border-color: #fecdca; }
    .neutral { background: #f2f4f7; color: #344054; border-color: #d0d5dd; }
    .row { display: flex; align-items: center; gap: 8px; }
    .main { font-weight: 600; }
    .sale { font-weight: 600; color: #b54708; }
    .sub { font-size: 11px; opacity: .75; }
    .close { margin-left: auto; cursor: pointer; border: 0; background: none; color: inherit; font-size: 14px; padding: 0 0 0 6px; opacity: .6; }
    .close:hover { opacity: 1; }
  `;

  function formatPrice(value, currency) {
    try {
      if (currency) return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
    } catch { /* unknown currency code */ }
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function badgeContent(record) {
    const prices = record.history.map((h) => h.price);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const fmt = (v) => formatPrice(v, record.currency);
    const same = (a, b) => Math.abs(a - b) < 0.005;

    let tone = 'neutral';
    let main;
    if (same(min, max)) {
      main = record.history.length === 1 ? '📌 Now tracking this price' : `ℹ️ Price unchanged since ${record.history[0].date}`;
    } else if (same(record.price, min)) {
      tone = 'low'; main = '🔥 Lowest Price Recorded Locally';
    } else if (same(record.price, max)) {
      tone = 'high'; main = '⚠️ Highest Price Recorded Locally';
    } else {
      main = `ℹ️ Normal Price (Range: ${fmt(min)} - ${fmt(max)})`;
    }

    let sale = null;
    if (record.sale?.onSale) {
      sale = record.sale.reason === 'store'
        ? `🏷️ On sale: ${record.sale.percentOff}% off (was ${fmt(record.sale.was)})`
        : `⬇️ Down ${record.sale.percentOff}% since ${record.sale.since} (was ${fmt(record.sale.was)})`;
    }
    const sub = `${record.history.length} day${record.history.length === 1 ? '' : 's'} of history · stored only in your browser`;
    return { tone, main, sale, sub };
  }

  function removeBadge() {
    document.getElementById(BADGE_ID)?.remove();
  }

  function showBadge(record, anchor) {
    removeBadge();
    const host = document.createElement('div');
    host.id = BADGE_ID;
    const root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = BADGE_CSS;

    const { tone, main, sale, sub } = badgeContent(record);
    const badge = document.createElement('div');
    badge.className = `badge ${tone}`;

    const row = document.createElement('div');
    row.className = 'row';
    const mainEl = document.createElement('span');
    mainEl.className = 'main';
    mainEl.textContent = main;
    row.append(mainEl);

    if (!anchor) {
      // No good spot next to the price: float in the corner with a close button.
      host.classList.add('floating');
      const close = document.createElement('button');
      close.className = 'close';
      close.title = 'Hide';
      close.textContent = '✕';
      close.addEventListener('click', removeBadge);
      row.append(close);
    }
    badge.append(row);

    if (sale) {
      const saleEl = document.createElement('span');
      saleEl.className = 'sale';
      saleEl.textContent = sale;
      badge.append(saleEl);
    }
    const subEl = document.createElement('span');
    subEl.className = 'sub';
    subEl.textContent = sub;
    badge.append(subEl);

    root.append(style, badge);
    if (anchor) anchor.insertAdjacentElement('afterend', host);
    else document.body.append(host);
  }

  // ---------------------------------------------------------------------------
  // Main loop: retry while the page renders, and re-run on SPA navigation.
  // ---------------------------------------------------------------------------

  let runToken = 0;

  function scheduleRuns() {
    const token = ++runToken;
    let done = false;
    for (const delay of RETRY_DELAYS_MS) {
      setTimeout(async () => {
        if (done || token !== runToken) return;
        const product = extractProduct();
        if (!product) return;
        done = true;
        try {
          const record = await saveSnapshot(product);
          if (token === runToken) showBadge(record, product.anchor);
        } catch (err) {
          // Extension was reloaded or storage failed; stay quiet on the page.
          console.debug('[PriceDrop Hunter]', err);
        }
      }, delay);
    }
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    removeBadge();
    scheduleRuns();
  }, 1000);

  scheduleRuns();
})();
