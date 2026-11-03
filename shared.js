/*
 * PriceDrop Hunter - shared helpers.
 * Loaded before content.js / facebook.js (same isolated world) and by the popup.
 * Everything is exposed on globalThis.PDH.
 */
(() => {
  'use strict';
  if (globalThis.PDH) return;

  const KEY_PREFIX = 'p:';      // one tracked product
  const STORE_PREFIX = 's:';    // one store's ongoing sale
  const SETTINGS_KEY = 'settings';
  const SALE_TTL_DAYS = 14;     // forget sale info not seen again for this long
  const MAX_SALE_ITEMS = 60;
  const DAY_MS = 86400000;

  // ---------------------------------------------------------------------------
  // Prices
  // ---------------------------------------------------------------------------

  /** Bangla/Devanagari digits -> ASCII, so "৫০%" reads as "50%". */
  function asciiDigits(text) {
    return String(text)
      .replace(/[০-৯]/g, (d) => String(d.charCodeAt(0) - 0x09E6))
      .replace(/[०-९]/g, (d) => String(d.charCodeAt(0) - 0x0966));
  }

  /** Turns "$1,299.99", "1.299,99 €", "Rs. 1,299" into a float, or null. */
  function parsePrice(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return raw > 0 ? raw : null;
    const match = asciiDigits(raw).replace(/[\s'’]/g, '').match(/\d[\d.,]*/);
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

  // Multi-character symbols first so "R$" wins over "$".
  const SYMBOL_TO_ISO = [['R$', 'BRL'], ['C$', 'CAD'], ['A$', 'AUD'], ['£', 'GBP'], ['€', 'EUR'], ['₹', 'INR'],
    ['¥', 'JPY'], ['৳', 'BDT'], ['₩', 'KRW'], ['₱', 'PHP'], ['₺', 'TRY'], ['$', 'USD']];
  const KNOWN_CURRENCIES = new Set(Intl.supportedValuesOf ? Intl.supportedValuesOf('currency') : []);

  /** Best guess of currency from price text, e.g. "£12.00" -> GBP. Ignores words like "VAT". */
  function currencyFromText(text) {
    if (!text) return null;
    for (const [symbol, code] of SYMBOL_TO_ISO) {
      if (String(text).includes(symbol)) return code;
    }
    for (const [, code] of String(text).matchAll(/\b([A-Z]{3})\b/g)) {
      if (KNOWN_CURRENCIES.has(code)) return code;
    }
    return null;
  }

  function formatPrice(value, currency) {
    try {
      if (currency) return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
    } catch { /* unknown currency code */ }
    return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ---------------------------------------------------------------------------
  // Words (for matching searches to sales)
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
    return [...new Set(String(text || '').toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
      .map(stem))];
  }

  // "handbag" matches "bag", "kameez" matches "kameez".
  const wordMatch = (a, b) => a === b || (b.length >= 3 && a.endsWith(b)) || (a.length >= 3 && b.endsWith(a));

  /**
   * Store categories -> product words. Used when a sale has no item list
   * (Facebook posts, banners): "Apparel & clothing" makes "panjabi" match.
   */
  const CATEGORIES = {
    clothing: {
      triggers: ['apparel', 'clothing', 'clothes', 'fashion', 'garment', 'boutique', 'outfitter', 'wear', 'lifestyle'],
      words: ['shirt', 'tshirt', 'polo', 'panjabi', 'punjabi', 'kurta', 'kurti', 'fatua', 'saree', 'sari', 'kameez', 'salwar',
        'three', 'piece', 'dress', 'gown', 'top', 'tunic', 'pant', 'jean', 'trouser', 'chino', 'jogger', 'short', 'skirt',
        'jacket', 'hoodie', 'sweater', 'sweatshirt', 'cardigan', 'blazer', 'suit', 'coat', 'lehenga', 'abaya', 'hijab',
        'dupatta', 'scarf', 'shawl', 'jersey', 'lungi', 'pajama', 'nightwear', 'innerwear', 'clothing', 'apparel', 'wear'],
    },
    shoes: {
      triggers: ['shoe', 'footwear', 'sneaker'],
      words: ['shoe', 'sneaker', 'sandal', 'slipper', 'boot', 'loafer', 'heel', 'flat', 'footwear', 'moccasin'],
    },
    bags: {
      triggers: ['bag', 'luggage', 'leather'],
      words: ['bag', 'handbag', 'backpack', 'purse', 'wallet', 'tote', 'clutch', 'luggage', 'belt'],
    },
    beauty: {
      triggers: ['beauty', 'cosmetic', 'skincare', 'personal care', 'makeup'],
      words: ['cream', 'serum', 'lotion', 'lipstick', 'makeup', 'perfume', 'shampoo', 'skincare', 'sunscreen', 'cleanser'],
    },
    electronics: {
      triggers: ['electronic', 'gadget', 'mobile', 'computer'],
      words: ['phone', 'mobile', 'laptop', 'headphone', 'earbud', 'charger', 'watch', 'speaker', 'tablet', 'camera'],
    },
    home: {
      triggers: ['home decor', 'furniture', 'home & garden', 'kitchen'],
      words: ['bedsheet', 'cushion', 'curtain', 'lamp', 'sofa', 'table', 'chair', 'decor', 'kitchen', 'towel'],
    },
  };

  /** Product words for a store, from its category text (e.g. "Apparel & clothing"). */
  function categoryWords(text) {
    const lower = String(text || '').toLowerCase();
    const words = new Set();
    for (const cat of Object.values(CATEGORIES)) {
      if (cat.triggers.some((t) => lower.includes(t))) cat.words.forEach((w) => words.add(w));
    }
    return [...words];
  }

  // ---------------------------------------------------------------------------
  // Reading sale announcements from free text (banners, posts, image text)
  // ---------------------------------------------------------------------------

  const SALE_WORD_RE = /\b(sale|discount|off|offer|deal|clearance|flat|upto|up to)\b|ছাড়|ছাড়|অফার|সেল|ডিসকাউন্ট/i;
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  const END_WORDS = '(?:till|until|untill|upto|up to|to|through|thru|ends?|ending|valid till|last date|last day|deadline)';

  const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

  function toIsoDate(day, monthName, year) {
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    const d = Number(day);
    if (month < 0 || d < 1 || d > 31) return null;
    const now = new Date();
    let y = year ? Number(year) : now.getFullYear();
    let date = new Date(y, month, d);
    // "till 10 January" seen in December means next year.
    if (!year && date.getTime() < now.getTime() - 60 * DAY_MS) date = new Date(++y, month, d);
    return date.toLocaleDateString('en-CA');
  }

  /**
   * Finds a sale in text like "MEGA SALE FLAT 50% OFF TILL 10th NOVEMBER" or
   * "Upto 70% off". Returns { percentOff, upTo, endDate } or null.
   */
  function parseSaleText(raw) {
    const text = asciiDigits(raw || '').replace(/\s+/g, ' ');
    if (!SALE_WORD_RE.test(text)) return null;

    let percentOff = 0;
    let upTo = false;
    const pctRe = /(up ?to|upto|flat|save|get)?\s*(\d{1,2})\s*%\s*(off|discount|ছাড়|ছাড়|ডিসকাউন্ট)?/gi;
    for (const m of text.matchAll(pctRe)) {
      const pct = Number(m[2]);
      // A bare "50%" needs a sale word nearby; "50% off" / "flat 50%" stand on their own.
      const context = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
      if (!m[1] && !m[3] && !/sale|discount|offer|ছাড়|ছাড়|অফার|সেল/i.test(context)) continue;
      if (pct > percentOff && pct < 96) {
        percentOff = pct;
        upTo = /up ?to|upto/i.test(m[1] || '');
      }
    }

    let endDate = null;
    const dayFirst = text.match(new RegExp(`${END_WORDS}\\s*:?\\s*(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH_RE}(?:\\s*,?\\s*(\\d{4}))?`, 'i'));
    const monthFirst = text.match(new RegExp(`${END_WORDS}\\s*:?\\s*${MONTH_RE}\\s*(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(\\d{4}))?`, 'i'));
    if (dayFirst) endDate = toIsoDate(dayFirst[1], dayFirst[2], dayFirst[3]);
    else if (monthFirst) endDate = toIsoDate(monthFirst[2], monthFirst[1], monthFirst[3]);

    const saleWord = /\b(sale|clearance)\b|সেল/i.test(text);
    if (!percentOff && !saleWord) return null;
    return { percentOff, upTo, endDate };
  }

  // ---------------------------------------------------------------------------
  // Store sale records  (key "s:<site>")
  //   items:   discounted products seen on the store's pages
  //   summary: store-wide announcement (banner, Facebook post, AI, manual)
  // ---------------------------------------------------------------------------

  const siteOf = (host) => String(host || '').replace(/^www\./, '').toLowerCase();
  const urlKey = (u) => { try { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, ''); } catch { return u; } };

  function summaryActive(summary) {
    if (!summary) return false;
    if (summary.endDate) return summary.endDate >= today();
    return Date.now() - new Date(summary.seen).getTime() < SALE_TTL_DAYS * DAY_MS;
  }

  /** Items still fresh, summary still running. Returns null if nothing is left. */
  function activeSale(store) {
    if (!store) return null;
    const cutoff = Date.now() - SALE_TTL_DAYS * DAY_MS;
    const items = (store.items || []).filter((it) => new Date(it.seen).getTime() > cutoff);
    const summary = summaryActive(store.summary) ? store.summary : null;
    if (!items.length && !summary) return null;
    const maxOff = Math.max(summary?.percentOff || 0, ...items.map((it) => it.percentOff || 0));
    return { ...store, items, summary, maxOff };
  }

  /**
   * Merges new sale info into a store's record.
   * update: { site, name?, pageUrl?, website?, items?, summary?, keywords?, currency? }
   */
  async function saveStoreSale(update) {
    const site = siteOf(update.site);
    if (!site) return null;
    const key = STORE_PREFIX + site;
    const stored = (await chrome.storage.local.get(key))[key];
    const now = new Date().toISOString();
    const cutoff = Date.now() - SALE_TTL_DAYS * DAY_MS;
    const items = update.items || [];

    const byUrl = new Map((stored?.items || [])
      .filter((it) => new Date(it.seen).getTime() > cutoff)
      .map((it) => [urlKey(it.url), it]));
    for (const it of items) byUrl.set(urlKey(it.url), { ...it, seen: now });
    const mergedItems = [...byUrl.values()]
      .sort((a, b) => new Date(b.seen) - new Date(a.seen) || b.percentOff - a.percentOff)
      .slice(0, MAX_SALE_ITEMS);

    // Newer announcement wins, unless the old one is still running with a bigger discount.
    let summary = stored?.summary && summaryActive(stored.summary) ? stored.summary : null;
    if (update.summary) {
      const next = { ...update.summary, seen: now };
      if (!summary || next.source === 'manual' || (next.percentOff || 0) >= (summary.percentOff || 0) || !summaryActive(summary)) {
        summary = next;
      }
    }

    // Remember the page that showed the most sale items (usually the store's sale page).
    let pageUrl = stored?.pageUrl || update.pageUrl || null;
    let bestPageCount = stored?.bestPageCount || 0;
    if (update.pageUrl && (items.length >= bestPageCount || !stored?.pageUrl)) {
      pageUrl = update.pageUrl;
      bestPageCount = Math.max(items.length, bestPageCount);
    }

    const record = {
      site,
      name: update.name || stored?.name || null,
      website: update.website || stored?.website || null,
      pageUrl,
      bestPageCount,
      currency: update.currency || items.find((it) => it.currency)?.currency || stored?.currency || null,
      keywords: [...new Set([...(stored?.keywords || []), ...(update.keywords || [])])].slice(0, 80),
      items: mergedItems,
      summary,
      firstSeen: stored?.firstSeen || now,
      lastSeen: now,
    };
    await chrome.storage.local.set({ [key]: record });
    return record;
  }

  /** "Flat 50% off · until 10 Nov" */
  function describeSummary(summary) {
    if (!summary) return '';
    const parts = [];
    if (summary.percentOff) parts.push(`${summary.upTo ? 'up to ' : ''}${summary.percentOff}% off`);
    else parts.push('sale on');
    if (summary.endDate) {
      const d = new Date(summary.endDate + 'T00:00:00');
      parts.push(`until ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`);
    }
    return parts.join(' · ');
  }

  const SOURCE_LABEL = { page: 'store banner', facebook: 'Facebook', ai: 'on-device AI', manual: 'added by you' };

  async function getSettings() {
    const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
    return { aiEnabled: false, ...stored };
  }

  globalThis.PDH = {
    KEY_PREFIX, STORE_PREFIX, SETTINGS_KEY, SALE_TTL_DAYS, SOURCE_LABEL,
    asciiDigits, parsePrice, currencyFromText, formatPrice,
    stem, keywords, wordMatch, categoryWords,
    parseSaleText, today, siteOf,
    activeSale, saveStoreSale, describeSummary, getSettings,
  };
})();
