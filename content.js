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
 *   4. Visible page: one <h1> with a price next to it.
 *
 * It also records store-wide sales: product grids with discounts, sale
 * banners, and (optional) Chrome's on-device AI when the rules find nothing.
 * Needs shared.js loaded first. Nothing leaves the browser.
 */
(() => {
  'use strict';

  if (window.__priceDropHunterLoaded) return;
  window.__priceDropHunterLoaded = true;

  const {
    KEY_PREFIX, STORE_PREFIX, parsePrice, currencyFromText, formatPrice, keywords, wordMatch,
    categoryWords, parseSaleText, today, siteOf, activeSale, saveStoreSale, describeSummary, getSettings, SOURCE_LABEL,
  } = globalThis.PDH;

  const MAX_SNAPSHOTS = 365;
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

    // Product-page signals: a buy button, or a SKU / product code shown near the title.
    // (Some items are "in-store only" and have no buy button.)
    const hasBuyButton = [...document.querySelectorAll('button, input[type="submit"], a[role="button"]')]
      .some((b) => BUY_BUTTON_RE.test(b.textContent || b.value || ''));

    let scope = headings[0];
    for (let i = 0; i < 3 && scope.parentElement; i++) {
      scope = scope.parentElement;
      for (const el of scope.querySelectorAll('[class*="price" i], [itemprop="price"]')) {
        if (!isVisible(el) || el.closest('s, del, strike')) continue;
        const text = textWithoutStrike(el);
        if (!text || text.length > 60) continue;
        const price = parsePrice(text);
        if (price == null) continue;
        const originalPrice = findOriginalPriceNear(el, price);
        const hasSku = /\b(SKU|product code|style (no|code)|item code)\b/i.test(scope.textContent.slice(0, 3000));
        if (!hasBuyButton && !hasSku && !originalPrice) return null;
        const product = buildGeneric(title, price, currencyFromText(el.textContent), null, null);
        product.anchor = el;
        product.originalPrice = originalPrice;
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

  // Discount labels like "Save ৳ 973", "You save $20", "70% off", "-30%".
  const SAVE_AMOUNT_RE = /^(you )?save\s*:?\s*\D{0,4}\s*[\d][\d.,]*/i;
  const PERCENT_OFF_RE = /^(-\s*)?(\d{1,2})\s*%(\s*off)?$|^(save|up ?to|flat)?\s*(\d{1,2})\s*%\s*off$/i;

  /** A link text that is a product name, not a button, price or discount label. */
  // Prices and discount labels that some stores put inside the product link.
  const PRICE_IN_TEXT_RE = /(?:[$£€₹¥৳₩₱₺]|\b(?:tk|bdt|rs|inr|usd)\.?)\s*[\d][\d,.]*|[\d][\d,.]*\s*(?:৳|tk\b|bdt\b)/gi;
  const LABEL_IN_TEXT_RE = /\b(?:you )?save\b\s*:?|\b\d{1,2}\s*%\s*(?:off)?|\bnew\b(?=\s*$)|\b(?:sale|sold out)\b(?=\s*$)|^\s*(?:new|sale)\b/gi;

  /**
   * Product name from a link. Some stores (e.g. SaRa) wrap the prices and the
   * name in one link: "৳ 764৳2545denim fashion tops" -> "denim fashion tops".
   */
  function linkName(a) {
    const named = a.querySelector('[class*="name" i], [class*="title" i], h2, h3, h4, h5');
    const source = named && named.textContent.trim() ? named : a;
    const clone = source.cloneNode(true);
    clone.querySelectorAll('s, del, strike, [class*="price" i], [class*="amount" i], [class*="badge" i]')
      .forEach((n) => n.remove());
    return clone.textContent
      .replace(PRICE_IN_TEXT_RE, ' ')
      .replace(LABEL_IN_TEXT_RE, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—|·:,]+|[\s\-–—|·:,]+$/g, '')
      .trim();
  }

  /** A link that carries a product name, not a button, price or discount label. */
  function isNameLink(a) {
    if ((a.getAttribute('href') || '').startsWith('#')) return false;
    const text = linkName(a);
    if (text.length < 3 || text.length > 150 || !/\p{L}{2}/u.test(text)) return false;
    return !BUTTON_TEXT_RE.test(text);
  }

  /** Climbs from an element to the smallest product card with a named product link. */
  function findCard(start) {
    let card = start.parentElement;
    for (let i = 0; i < 8 && card && card !== document.body; i++, card = card.parentElement) {
      const link = [...card.querySelectorAll('a[href]')]
        .filter(isNameLink)
        .map((a) => ({ a, name: linkName(a) }))
        .sort((x, y) => y.name.length - x.name.length)[0];
      if (link) return { card, link: link.a, title: link.name };
    }
    return null;
  }

  /** Current price inside a card: first short visible price-looking text that isn't a label. */
  function findCardPrice(card, skip) {
    const candidates = card.querySelectorAll('[class*="price" i], [class*="amount" i], span, div, p, strong, b');
    for (const el of candidates) {
      if (el === skip || el.contains(skip) || skip.contains(el) || !isVisible(el) || el.closest('s, del, strike')) continue;
      if (el.children.length > 3) continue;
      const text = textWithoutStrike(el);
      if (!text || text.length > 30 || SAVE_AMOUNT_RE.test(text) || /%/.test(text)) continue;
      if (!/[$£€₹¥৳₩₱₺]|\b(tk|bdt|rs|inr|usd|eur|gbp)\b|price|amount/i.test(text + ' ' + el.className)) continue;
      const price = parsePrice(text);
      if (price != null) return { price, text };
    }
    return null;
  }

  /** Finds every product card on the page that shows a discount. */
  function scanSaleItems() {
    const items = new Map(); // url -> item
    const add = (found, price, was, currencyText) => {
      if (!found || price == null || was == null || price >= was || was > price * 10) return;
      if (items.has(found.link.href)) return;
      items.set(found.link.href, {
        title: found.title.slice(0, 200),
        url: found.link.href,
        price,
        was: Math.round(was * 100) / 100,
        percentOff: Math.round((1 - price / was) * 100),
        currency: currencyFromText(currencyText),
      });
    };

    // 1. Crossed-out "was" prices.
    for (const strike of document.querySelectorAll(ORIGINAL_PRICE_SELECTORS)) {
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
      add(findCard(strike), price, was, strikeText);
    }

    // 2. Discount labels ("Save ৳ 973", "70% off") when there's no crossed-out price.
    for (const label of document.querySelectorAll('span, div, p, strong, b, em, small, mark')) {
      if (items.size >= 100) break;
      if (label.children.length > 2) continue;
      const text = label.textContent.replace(/\s+/g, ' ').trim();
      if (!text || text.length > 25) continue;
      const saveMatch = SAVE_AMOUNT_RE.test(text);
      const pctMatch = text.match(PERCENT_OFF_RE);
      if (!saveMatch && !pctMatch) continue;
      if (!isVisible(label)) continue;

      const found = findCard(label);
      if (!found || items.has(found.link.href)) continue;
      const current = findCardPrice(found.card, label);
      if (!current) continue;
      if (saveMatch) {
        add(found, current.price, current.price + parsePrice(text), text + ' ' + current.text);
      } else {
        const pct = Number(pctMatch[2] || pctMatch[5]);
        if (pct > 0 && pct < 95) add(found, current.price, current.price / (1 - pct / 100), current.text);
      }
    }
    return [...items.values()];
  }

  // ---------------------------------------------------------------------------
  // Store-wide sale announcements: banners, hero text, announcement bars.
  // ---------------------------------------------------------------------------

  const BANNER_SELECTORS = [
    '[class*="banner" i]', '[class*="hero" i]', '[class*="promo" i]', '[class*="slider" i]', '[class*="carousel" i]',
    '[class*="announcement" i]', '[class*="marquee" i]', '[class*="topbar" i]', '[class*="notice" i]', '[id*="banner" i]',
    'h1', 'h2', 'marquee',
  ].join(',');

  /** Visible banner text and image alt text that announce a sale, e.g. "Upto 70% off". */
  function scanBanners() {
    const texts = [];
    for (const img of document.images) {
      if (img.alt && img.alt.length < 300 && isVisible(img) && (img.width || 0) >= 250) texts.push(img.alt);
    }
    for (const el of document.querySelectorAll(BANNER_SELECTORS)) {
      if (texts.length > 200) break;
      if (!isVisible(el) || el.closest('a[href*="/product"]')) continue;
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text && text.length < 200) texts.push(text);
    }
    let best = null;
    for (const text of texts) {
      const found = parseSaleText(text);
      // Banners must state a discount; a bare "Sale" link in a menu is not an ongoing sale.
      if (!found?.percentOff) continue;
      if (!best || found.percentOff > best.percentOff || (found.endDate && !best.endDate)) best = { ...found, note: text.slice(0, 140) };
    }
    return best;
  }

  // On-device AI (Chrome's built-in model), only when the rules found nothing.
  const AI_RECHECK_MS = 6 * 3600000;
  const PAGE_SALE_HINT_RE = /\b(sale|clearance)\b|\d{1,2}\s*%\s*off|\bdiscount|ছাড়|ছাড়|অফার|সেল/i;

  /** Largest visible image near the top, as a data: URL (for banners that are pictures). */
  async function topBannerImage() {
    const candidates = [...document.images]
      .filter((img) => isVisible(img) && img.complete && img.naturalWidth >= 600 && img.getBoundingClientRect().top < 1500)
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight);
    for (const img of candidates.slice(0, 2)) {
      try {
        const res = await fetch(img.currentSrc || img.src);
        const blob = await res.blob();
        if (!blob.type.startsWith('image/') || blob.size > 3_000_000) continue;
        return await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch { /* cross-origin image: skip */ }
    }
    return null;
  }

  async function aiReadPage() {
    const settings = await getSettings();
    if (!settings.aiEnabled) return null;
    const text = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').slice(0, 4000);
    if (!PAGE_SALE_HINT_RE.test(text + ' ' + [...document.images].map((i) => i.alt).join(' '))) return null;

    const site = siteOf(location.hostname);
    const checkKey = 'ai:' + site;
    const lastCheck = (await chrome.storage.local.get(checkKey))[checkKey] || 0;
    if (Date.now() - lastCheck < AI_RECHECK_MS) return null;
    await chrome.storage.local.set({ [checkKey]: Date.now() });

    const image = await topBannerImage();
    const result = await chrome.runtime.sendMessage({ type: 'pdh-ai-read', site, url: location.href, title: document.title, text, image });
    if (!result?.isSale) return null;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

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
  function showSaleToast(count, maxOff, summary) {
    const { host, panel } = createPanel(TOAST_ID, { top: '16px', right: '16px' });
    const what = count ? `${count} item${count === 1 ? '' : 's'}, up to ${maxOff}% off` : describeSummary(summary);
    panel.append(panelHead(`🏷️ Sale found: ${what}`, () => host.remove()));
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
    for (const [key, raw] of Object.entries(all)) {
      if (!key.startsWith(STORE_PREFIX)) continue;
      const store = activeSale(raw);
      if (!store || store.site === site || (store.website && siteOf(new URL(store.website).hostname) === site)) continue;
      const matches = store.items
        .map((item) => {
          const itemWords = keywords(item.title);
          const score = words.filter((w) => itemWords.some((iw) => wordMatch(w, iw))).length;
          return { item, score };
        })
        .filter((m) => m.score >= minMatches)
        .sort((a, b) => b.score - a.score || b.item.percentOff - a.item.percentOff);
      // Store-wide sale (banner / Facebook / AI): match against the store's product words.
      const storeWide = store.summary && words.some((w) => (store.keywords || []).some((k) => wordMatch(w, k)));
      if (matches.length || storeWide) results.push({ store, matches, storeWide });
    }
    return results.sort((a, b) => b.matches.length - a.matches.length || b.store.maxOff - a.store.maxOff).slice(0, 3);
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
      const best = matches[0]?.item;
      const row = document.createElement('a');
      row.className = 'store';
      row.href = best ? (matches.length > 1 ? store.pageUrl : best.url) : (store.summary.sourceUrl || store.pageUrl || store.website);
      row.target = '_blank';
      row.rel = 'noopener noreferrer';

      const top = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = store.name || formatSite(store.site);
      const off = document.createElement('span');
      off.className = 'off';
      off.textContent = best
        ? ` · ${matches.length} item${matches.length === 1 ? '' : 's'}, up to ${Math.max(...matches.map((m) => m.item.percentOff))}% off`
        : ` · ${describeSummary(store.summary)}`;
      top.append(name, off);

      const detail = document.createElement('div');
      detail.className = 'item';
      detail.textContent = best
        ? `${best.title} — ${formatPrice(best.price, best.currency || store.currency)} (was ${formatPrice(best.was, best.currency || store.currency)})`
        : `Seen on ${SOURCE_LABEL[store.summary.source] || 'the web'}${store.summary.note ? ': ' + store.summary.note : ''}`;
      row.append(top, detail);
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

  async function processPage(token, tryIndex) {
    const isLastTry = tryIndex === RETRY_DELAYS_MS.length - 1;
    const product = extractProduct();
    const saleItems = scanSaleItems();
    if (!product && !saleItems.length && !isLastTry) {
      // Search pages: suggest right away instead of waiting for the retries.
      if (tryIndex === 0 && currentSearchQuery()) await showSuggestions(null);
      return false;
    }

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

    const site = siteOf(location.hostname);
    const banner = scanBanners();
    if (saleItems.length || banner) {
      await saveStoreSale({
        site,
        pageUrl: location.href,
        items: saleItems,
        summary: banner ? { ...banner, source: 'page', sourceUrl: location.href } : null,
        // Store's product words, so store-wide sales can match searches ("Lifestyle"/"Fashion" -> clothing words).
        keywords: categoryWords(`${document.title} ${document.querySelector('meta[name="description"]')?.content || ''}`),
      });
      // Only announce on listing pages; product pages already have the badge.
      if (!product && (saleItems.length >= 3 || banner) && token === runToken) {
        const maxOff = Math.max(banner?.percentOff || 0, ...saleItems.map((i) => i.percentOff));
        showSaleToast(saleItems.length, maxOff, banner);
      }
    }

    if (token === runToken) await showSuggestions(product);

    // Rules found nothing, but the page talks about a sale: ask the on-device AI.
    if (!product && !saleItems.length && !banner && token === runToken) {
      aiReadPage().then(async (ai) => {
        if (!ai || token !== runToken) return;
        const summary = { percentOff: ai.maxPercentOff || 0, upTo: !!ai.upTo, endDate: ai.endDate || null,
          note: ai.summary || '', source: 'ai', sourceUrl: location.href };
        const types = (ai.productTypes || []).join(' ');
        await saveStoreSale({ site, pageUrl: location.href, summary,
          keywords: [...keywords(types), ...categoryWords(types)] });
        showSaleToast(0, summary.percentOff, summary);
      }).catch((err) => console.debug('[PriceDrop Hunter] AI', err));
    }
    return true;
  }

  function scheduleRuns() {
    const token = ++runToken;
    let done = false;
    RETRY_DELAYS_MS.forEach((delay, i) => {
      setTimeout(async () => {
        if (done || token !== runToken) return;
        try {
          done = await processPage(token, i);
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
