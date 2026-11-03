/*
 * PriceDrop Hunter tests: loads saved store pages into a simulated browser
 * (jsdom), runs the real content scripts on them, and checks what was saved.
 *
 *   npm install   (once)
 *   npm test
 *
 * To add a store: save its page into tests/fixtures/ and add a case below.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const fixture = (name) => read(`tests/fixtures/${name}`);

// jsdom has no layout, so "is this visible?" is approximated by "not inside .d-none / [hidden]".
const SHARED = read('shared.js');
const CONTENT = read('content.js').replace(
  /const isVisible = [^\n]+/,
  "const isVisible = (el) => !!el && !el.closest('.d-none, [hidden]');",
);
const FACEBOOK = read('facebook.js');

// ---------------------------------------------------------------------------
// Fake chrome.* with one shared storage, like a real browser profile.
// ---------------------------------------------------------------------------
const storage = {};
const chrome = {
  storage: {
    local: {
      get: async (key) => (key == null ? structuredClone(storage) : key in storage ? { [key]: structuredClone(storage[key]) } : {}),
      set: async (obj) => Object.assign(storage, structuredClone(obj)),
      remove: async (keys) => [].concat(keys).forEach((k) => delete storage[k]),
    },
  },
  runtime: { sendMessage: async () => null },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shadowText = (doc, id) => {
  const host = doc.getElementById(id);
  if (!host) return null;
  return [...host.shadowRoot.children]
    .filter((node) => node.tagName !== 'STYLE')
    .map((node) => node.textContent)
    .join(' ').replace(/\s+/g, ' ').trim();
};

async function visit(url, html, { facebook = false, wait = 600 } = {}) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  // Next.js streams content into <div hidden id="S:n"> and its own script reveals it; do that here.
  dom.window.document.querySelectorAll('div[hidden][id^="S:"]').forEach((el) => el.removeAttribute('hidden'));
  dom.window.chrome = chrome;
  dom.window.eval(SHARED);
  dom.window.eval(facebook ? FACEBOOK : CONTENT);
  await sleep(wait);
  const doc = dom.window.document;
  const ui = {
    badge: shadowText(doc, 'pricedrop-hunter-badge'),
    toast: shadowText(doc, 'pricedrop-hunter-toast'),
    suggest: shadowText(doc, 'pricedrop-hunter-suggest'),
  };
  dom.window.close();
  return ui;
}

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------
let failed = 0;
let passed = 0;
function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail !== undefined ? `\n      got: ${JSON.stringify(detail)}` : ''}`); }
}

async function main() {
  // ---- Text parsing (no page needed)
  console.log('\nparseSaleText');
  const { parseSaleText } = (() => { const w = new JSDOM('', { runScripts: 'outside-only' }).window; w.eval(SHARED); return w.PDH; })();
  const year = new Date().getFullYear();
  const p1 = parseSaleText('MEGA SALE FLAT 50% OFF TILL 10th NOVEMBER Excludes Selected Items');
  check('flat 50% off till 10th November', p1?.percentOff === 50 && p1?.endDate?.endsWith('-11-10'), p1);
  const p2 = parseSaleText('UPTO 70% OFF ONLINE & OUTLETS SHOP NOW');
  check('upto 70% off', p2?.percentOff === 70 && p2?.upTo === true, p2);
  const p3 = parseSaleText('শীতের অফার! ৩০% ছাড়');
  check('Bangla: ৩০% ছাড়', p3?.percentOff === 30, p3);
  const p4 = parseSaleText('Sale ends December 31, ' + year);
  check('ends December 31', p4?.endDate === `${year}-12-31`, p4);
  check('no sale in "100% cotton shirt"', parseSaleText('100% cotton shirt, 50% polyester') === null);
  check('no sale in "Free shipping over $50"', parseSaleText('Free shipping over $50') === null);

  // ---- Le Reve: sale grid with crossed-out prices
  console.log('\nLe Reve sale page');
  let ui = await visit('https://lerevecraze.com/product-category/sale/', fixture('lereve-sale.html'));
  const lereve = storage['s:lerevecraze.com'];
  check('20 sale items saved', lereve?.items.length === 20, lereve?.items.length);
  check('currency is BDT (not "VAT")', lereve?.currency === 'BDT', lereve?.currency);
  check('first item correct', lereve?.items[0]?.price === 5440 && lereve?.items[0]?.was === 10879, lereve?.items[0]);
  check('no button links saved as items', !lereve?.items.some((i) => /try on/i.test(i.title)));
  check('toast shown', /Sale found: 20 items, up to 50% off/.test(ui.toast || ''), ui.toast);

  console.log('\nLe Reve product page');
  ui = await visit('https://lerevecraze.com/product/skd16345/', fixture('lereve-product.html'));
  const product = storage['p:lerevecraze.com:/product/skd16345/'];
  check('product saved with price + original', product?.price === 5440 && product?.originalPrice === 10879, product);
  check('badge shows 50% off', /On sale: 50% off/.test(ui.badge || ''), ui.badge);

  console.log('\nLe Reve in-store-only product (no Add to cart)');
  delete storage['p:lerevecraze.com:/product/skd16345/'];
  ui = await visit('https://lerevecraze.com/product/skd16345/?ref=x', fixture('lereve-product-instore.html'));
  check('still detected as a product', /On sale: 50% off/.test(ui.badge || ''), ui.badge);
  check('no duplicate sale item from ?ref=', storage['s:lerevecraze.com'].items.length === 20, storage['s:lerevecraze.com'].items.length);

  // ---- Sara-style: "Save ৳ X" labels + banner
  console.log('\nSara-style sale page (mock)');
  ui = await visit('https://saralifestyle.com/sale', fixture('sara-sale-mock.html'));
  const sara = storage['s:saralifestyle.com'];
  check('3 items from "Save ৳"/"% OFF" labels', sara?.items.length === 3, sara?.items);
  check('jersey: 1505 was 2150', sara?.items.some((i) => i.title === 'Brazil Football Jersey' && i.price === 1505 && i.was === 2150));
  check('banner: up to 70% off', sara?.summary?.percentOff === 70 && sara?.summary?.upTo, sara?.summary);
  check('no false product badge on the sale page', ui.badge === null, ui.badge);

  // ---- Facebook brand page
  console.log('\nFacebook brand page (mock)');
  // Dates relative to today so the test doesn't expire: current sale ends in 7 days, old one ended 30 days ago.
  const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const shift = (days) => new Date(Date.now() + days * 86400000);
  const spoken = (d) => `${d.getDate()}th ${MONTH_NAMES[d.getMonth()]}`;
  const fbHtml = fixture('facebook-artisan-mock.html')
    .replace('TILL 10th NOVEMBER', `TILL ${spoken(shift(7))}`)
    .replace('TILL 1st OCTOBER', `TILL ${spoken(shift(-30))}`);
  await visit('https://www.facebook.com/artisanoutfittersltd/', fbHtml, { facebook: true, wait: 2000 });
  const artisan = storage['s:artisanclick.com'];
  check('saved under the website from Intro', !!artisan, Object.keys(storage));
  check('flat 50% off, ends in 7 days (old ended post ignored)',
    artisan?.summary?.percentOff === 50 && artisan?.summary?.endDate === shift(7).toLocaleDateString('en-CA'), artisan?.summary);
  check('page name kept', artisan?.name === 'Artisan Outfitters', artisan?.name);
  check('clothing words attached', artisan?.keywords.includes('panjabi'), artisan?.keywords);

  // ---- Suggestions on other sites
  console.log('\nSuggestions');
  ui = await visit('https://www.amazon.com/s?k=gown+with+dupatta', '<html><body></body></html>');
  check('"gown with dupatta" → Le Reve items', /lerevecraze · \d+ items?, up to 50% off/.test(ui.suggest || ''), ui.suggest);
  ui = await visit('https://www.daraz.com.bd/catalog/?q=panjabi', '<html><body></body></html>');
  check('"panjabi" → Artisan (Facebook sale)', /Artisan Outfitters · 50% off · until/.test(ui.suggest || ''), ui.suggest);
  check('"panjabi" → Sara (banner sale)', /saralifestyle/.test(ui.suggest || ''), ui.suggest);
  ui = await visit('https://www.google.com/search?q=iphone+charger', '<html><body></body></html>', { wait: 4500 });
  check('"iphone charger" → nothing', ui.suggest === null, ui.suggest);
  ui = await visit('https://artisanclick.com/search?q=panjabi', '<html><body></body></html>');
  check('no suggestion for a store on its own site', !/Artisan/.test(ui.suggest || ''), ui.suggest);

  // ---- Pages that must not create sales
  console.log('\nFalse positives');
  const before = Object.keys(storage).length;
  await visit('https://blog.example.com/trip', '<html><body><h1>My trip to the market</h1><p>Everything was 50% off at the bazaar.</p></body></html>', { wait: 4500 });
  check('blog post saves nothing', Object.keys(storage).length === before, Object.keys(storage));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err.name, err.message, err.stack); process.exit(1); });
