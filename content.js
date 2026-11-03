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
  const KEY_PREFIX = 'p:';     // one tracked product
  const STORE_PREFIX = 's:';   // one store's current sale items
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

  const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf ? Intl.supportedValuesOf('currency') : []);

  /** Best guess of currency from price text, e.g. "£12.00" -> GBP. */
  function currencyFromText(text) {
    if (!text) return null;
    for (const [symbol, code] of Object.entries(SYMBOL_TO_ISO)) {
      if (String(text).includes(symbol)) return code;
    }
    // Only real currency codes, so words like "VAT" or "GST" are ignored.
    for (const [, code] of String(text).matchAll(/\b([A-Z]{3})\b/g)) {
      if (KNOWN_CURRENCIES.has(code)) return code;
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

  /** Text of an element with any crossed-out prices removed. */
  function textWithoutStrike(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('s, del, strike').forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  const BUY_BUTTON_RE = /add to (cart|bag|basket)|buy now|order now/i;

  /**
   * Last resort for stores with no product data in the page (e.g. many custom
   * Next.js / React stores): one visible <h1>, a price right next to it, and a
   * buy button somewhere on the page.
   */
  function extractFromDom() {
    const headings = [...document.querySelectorAll('h1')].filter(isVisible);
    if (headings.length !== 1) return null;
    const title = headings[0].textContent.replace(/\s+/g, ' ').trim();
    if (!title || title.length > 200) return null;

    const hasBuyButton = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')]
      .some((b) => BUY_BUTTON_RE.test(b.textContent || b.value || ''));
    if (!hasBuyButton) return null;

    let scope = headings[0];
    for (let i = 0; i < 3 && scope.parentElement; i++) {
      scope = scope.parentElement;
      for (const el of scope.querySelectorAll('[class*="price" i], [itemprop="price"]')) {
        if (!isVisible(el) || el.closest('s, del, strike')) continue;
        const text = textWithoutStrike(el);
        if (!text || text.length > 60) continue;
        const price = parsePrice(text);
        if (price == null) continue;
        const product = buildGeneric(title, price, currencyFromText(el.textContent), null, null);
        product.anchor = el;
        product.originalPrice = findOriginalPriceNear(el, price);
        return product;
      }
    }
    return null;
  }

  function extractProduct() {
    const config = STORE_CONFIGS.find((c) => c.match(location.hostname));
    if (config) return extractFromConfig(config); // known store: trust only its selectors
    return extractFromJsonLd() || extractFromMeta() || extractFromDom();
  }

  // ---------------------------------------------------------------------------
  // Sale listings: product grids where items show a crossed-out "was" price.
  // ---------------------------------------------------------------------------

  const BUTTON_TEXT_RE = /^(try on|quick ?view|quick ?shop|add to .*|buy now|order now|shop now|view( details| more)?|select options|choose options|details|more info|compare|wishlist)$/i;

  /** Finds every product card on the page that shows a discount. */
  function scanSaleItems() {
    const items = new Map(); // url -> item
    const strikes = document.querySelectorAll(ORIGINAL_PRICE_SELECTORS);

    for (const strike of strikes) {
      if (items.size >= 100) break;
      if (!isVisible(strike) || strike.parentElement?.closest('s, del, strike')) continue;
      const strikeText = strike.textContent.trim();
      if (!strikeText || strikeText.length > 40) continue;
      const was = parsePrice(strikeText);
      if (was == null) continue;

      // Current price: the price box around the crossed-out price, minus that price.
      let price = null;
      let box = strike.parentElement;
      for (let i = 0; i < 2 && box && price == null; i++, box = box.parentElement) {
        const text = textWithoutStrike(box);
        if (text.length <= 60) price = parsePrice(text);
      }
      if (price == null || price >= was || was > price * 10) continue;

      // Card: smallest ancestor that has a product link with a name.
      let card = strike.parentElement;
      let link = null;
      for (let i = 0; i < 8 && card && !link; i++, card = card.parentElement) {
        link = [...card.querySelectorAll('a[href]')]
          .filter((a) => a.textContent.trim().length > 2 && !a.getAttribute('href').startsWith('#'))
          .sort((a, b) => b.textContent.trim().length - a.textContent.trim().length)[0] || null;
      }
      if (!link) continue;
      const title = link.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
      // Skip links that are prices or buttons ("Try On", "Quick view"), not product names.
      if (title.length < 3 || title.length > 150 || BUTTON_TEXT_RE.test(title) || parsePrice(title) === price) continue;

      items.set(link.href, {
        title,
        url: link.href,
        price,
        was,
        percentOff: Math.round((1 - price / was) * 100),
        currency: currencyFromText(strikeText),
      });
    }
    return [...items.values()];
  }

  const SALE_ITEM_TTL_DAYS = 14;
  const MAX_SALE_ITEMS = 60;

  /** Merges discounted items into this store's sale record. */
  async function saveStoreSale(items) {
    if (!items.length) return null;
    const site = location.hostname.replace(/^www\./, '');
    const key = STORE_PREFIX + site;
    const stored = (await chrome.storage.local.get(key))[key];
    const now = new Date().toISOString();
    const cutoff = Date.now() - SALE_ITEM_TTL_DAYS * 86400000;

    const byUrl = new Map((stored?.items || [])
      .filter((it) => new Date(it.seen).getTime() > cutoff)
      .map((it) => [it.url, it]));
    for (const it of items) byUrl.set(it.url, { ...it, seen: now });

    const merged = [...byUrl.values()]
      .sort((a, b) => new Date(b.seen) - new Date(a.seen) || b.percentOff - a.percentOff)
      .slice(0, MAX_SALE_ITEMS);

    // Remember the page that showed the most sale items (usually the store's sale page).
    const bestPage = !stored || items.length >= (stored.bestPageCount || 0)
      ? { url: location.href, count: items.length }
      : { url: stored.pageUrl, count: stored.bestPageCount };

    const record = {
      site,
      pageUrl: bestPage.url,
      bestPageCount: bestPage.count,
      currency: items.find((it) => it.currency)?.currency || stored?.currency || null,
      items: merged,
      firstSeen: stored?.firstSeen || now,
      lastSeen: now,
    };
    await chrome.storage.local.set({ [key]: record });
    return record;
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

  // ---------------------------------------------------------------------------
  // Floating panels (toast + "sales on other sites"), also in Shadow DOM.
  // ---------------------------------------------------------------------------

  const PANEL_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483647; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .panel { background: #ffffff; color: #1d2433; border: 1px solid #e3e6eb; border-radius: 12px;
             box-shadow: 0 8px 24px rgba(16,24,40,.16); padding: 10px 12px; width: 300px; font-size: 13px; line-height: 1.4; }
    .head { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 6px; }
    .close { margin-left: auto; cursor: pointer; border: 0; background: none; color: #667085; font-size: 14px; }
    .store { display: block; padding: 7px 8px; margin: 0 -4px; border-radius: 8px; cursor: pointer; text-decoration: none; color: inherit; }
    .store:hover { background: #f2f4f7; }
    .name { font-weight: 600; }
    .off { color: #b54708; font-weight: 700; }
    .item { color: #667085; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .note { color: #667085; font-size: 11px; margin-top: 4px; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1e2129; color: #e8eaef; border-color: #2d313b; }
      .store:hover { background: #262a34; }
      .item, .note, .close { color: #98a1b2; }
      .off { color: #ffb45c; }
    }
  `;

  function createPanel(id, position) {
    document.getElementById(id)?.remove();
    const host = document.createElement('div');
    host.id = id;
    Object.assign(host.style, position);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    const panel = document.createElement('div');
    panel.className = 'panel';
    root.append(style, panel);
    document.body.append(host);
    return { host, panel };
  }

  function panelHead(text, onClose) {
    const head = document.createElement('div');
    head.className = 'head';
    const label = document.createElement('span');
    label.textContent = text;
    const close = document.createElement('button');
    close.className = 'close';
    close.title = 'Hide';
    close.textContent = '✕';
    close.addEventListener('click', onClose);
    head.append(label, close);
    return head;
  }

  const TOAST_ID = 'pricedrop-hunter-toast';
  const SUGGEST_ID = 'pricedrop-hunter-suggest';

  /** Short confirmation on sale listing pages, hides itself. */
  function showSaleToast(count, maxOff) {
    const { host, panel } = createPanel(TOAST_ID, { top: '16px', right: '16px' });
    panel.append(panelHead(`🏷️ Sale found: ${count} item${count === 1 ? '' : 's'}, up to ${maxOff}% off`, () => host.remove()));
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = 'Saved by PriceDrop Hunter. You will see these when you shop for similar things on other sites.';
    panel.append(note);
    setTimeout(() => host.remove(), 6000);
  }

  // ---------------------------------------------------------------------------
  // "Sales on other sites": match what the user is looking for against the
  // sale items saved from other stores.
  // ---------------------------------------------------------------------------

  const STOP_WORDS = new Set(('the and for with from your you our all new sale off set pack size women womens woman ' +
    'men mens man kids girls boys ladies free shipping best top buy shop online deal deals price cheap').split(' '));

  /** handbags -> handbag, dresses -> dress, accessories -> accessory */
  function stem(word) {
    if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
    if (word.endsWith('sses')) return word.slice(0, -2);
    if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) return word.slice(0, -1);
    return word;
  }

  function keywords(text) {
    return [...new Set(String(text).toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
      .map(stem))];
  }

  // "handbag" matches "bag", "kameez" matches "kameez".
  const wordMatch = (a, b) => a === b || (b.length >= 3 && a.endsWith(b)) || (a.length >= 3 && b.endsWith(a));

  /** The search term in the URL, e.g. ?q=, ?k= (Amazon), ?keywords=, ?search_query=. */
  function currentSearchQuery() {
    const params = new URLSearchParams(location.search);
    for (const name of ['q', 'k', 'keywords', 'field-keywords', 'query', 'search_query', 'search', 'term', 'text', 's']) {
      const value = params.get(name);
      if (value && value.trim().length > 1 && value.length < 100) return value.trim();
    }
    return null;
  }

  async function findMatchingSales(words, minMatches) {
    const site = location.hostname.replace(/^www\./, '');
    const all = await chrome.storage.local.get(null);
    const results = [];
    for (const [key, store] of Object.entries(all)) {
      if (!key.startsWith(STORE_PREFIX) || store.site === site || !store.items?.length) continue;
      const matches = store.items
        .map((item) => {
          const itemWords = keywords(item.title);
          const score = words.filter((w) => itemWords.some((iw) => wordMatch(w, iw))).length;
          return { item, score };
        })
        .filter((m) => m.score >= minMatches)
        .sort((a, b) => b.score - a.score || b.item.percentOff - a.item.percentOff);
      if (matches.length) results.push({ store, matches });
    }
    return results.sort((a, b) => b.matches.length - a.matches.length).slice(0, 3);
  }

  function formatSite(site) {
    return site.replace(/\.(com|net|org|co|shop|store)(\.[a-z]{2})?$/i, '');
  }

  async function showSuggestions(product) {
    const query = currentSearchQuery();
    // A typed search is a strong signal; a product title is noisy, so ask for 2 shared words.
    const source = query || product?.title;
    if (!source) return;
    const words = keywords(source).slice(0, 8);
    if (!words.length) return;
    const results = await findMatchingSales(words, query ? 1 : 2);
    if (!results.length) return;

    const { host, panel } = createPanel(SUGGEST_ID, { left: '16px', bottom: '16px' });
    const label = query ? `“${query.slice(0, 30)}”` : 'this';
    panel.append(panelHead(`🏷️ On sale on other sites for ${label}`, () => host.remove()));

    for (const { store, matches } of results) {
      const best = matches[0].item;
      const maxOff = Math.max(...matches.map((m) => m.item.percentOff));
      const row = document.createElement('a');
      row.className = 'store';
      row.href = matches.length > 1 ? store.pageUrl : best.url;
      row.target = '_blank';
      row.rel = 'noopener noreferrer';

      const top = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = formatSite(store.site);
      const off = document.createElement('span');
      off.className = 'off';
      off.textContent = ` · ${matches.length} item${matches.length === 1 ? '' : 's'}, up to ${maxOff}% off`;
      top.append(name, off);

      const item = document.createElement('div');
      item.className = 'item';
      item.textContent = `${best.title} — ${formatPrice(best.price, best.currency || store.currency)} (was ${formatPrice(best.was, best.currency || store.currency)})`;
      row.append(top, item);
      panel.append(row);
    }

    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = 'From sales you visited before. Stored only in your browser.';
    panel.append(note);
  }

  // ---------------------------------------------------------------------------
  // Main loop: retry while the page renders, and re-run on SPA navigation.
  // ---------------------------------------------------------------------------

  let runToken = 0;

  async function processPage(token, isLastTry) {
    const product = extractProduct();
    const saleItems = scanSaleItems();
    if (!product && !saleItems.length && !isLastTry) return false;

    if (product) {
      const record = await saveSnapshot(product);
      if (token !== runToken) return true;
      showBadge(record, product.anchor);
      // The product's own crossed-out price may be picked up with a wrong link; replace it.
      if (product.originalPrice) {
        for (let i = saleItems.length - 1; i >= 0; i--) {
          if (saleItems[i].price === product.price && saleItems[i].was === product.originalPrice) saleItems.splice(i, 1);
        }
      }
      if (record.sale.onSale && record.sale.reason === 'store' && !saleItems.some((i) => i.url === record.url)) {
        saleItems.push({ title: record.title, url: record.url, price: record.price, was: record.sale.was,
          percentOff: record.sale.percentOff, currency: record.currency });
      }
    }

    if (saleItems.length) {
      await saveStoreSale(saleItems);
      // Only announce on listing pages; product pages already have the badge.
      if (!product && saleItems.length >= 3 && token === runToken) {
        showSaleToast(saleItems.length, Math.max(...saleItems.map((i) => i.percentOff)));
      }
    }

    if (token === runToken) await showSuggestions(product);
    return true;
  }

  function scheduleRuns() {
    const token = ++runToken;
    let done = false;
    RETRY_DELAYS_MS.forEach((delay, i) => {
      setTimeout(async () => {
        if (done || token !== runToken) return;
        try {
          done = await processPage(token, i === RETRY_DELAYS_MS.length - 1);
        } catch (err) {
          // Extension was reloaded or storage failed; stay quiet on the page.
          done = true;
          console.debug('[PriceDrop Hunter]', err);
        }
      }, delay);
    });
  }

  function clearPageUi() {
    removeBadge();
    document.getElementById(TOAST_ID)?.remove();
    document.getElementById(SUGGEST_ID)?.remove();
  }

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    clearPageUi();
    scheduleRuns();
  }, 1000);

  scheduleRuns();
})();
