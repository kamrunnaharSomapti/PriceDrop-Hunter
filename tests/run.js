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
  runtime: {
    // Stand-in for the on-device AI in background.js; tests can swap the answer.
    aiCalls: [],
    aiAnswer: null,
    sendMessage: async (msg) => { chrome.runtime.aiCalls.push(msg); return chrome.runtime.aiAnswer; },
  },
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

  // ---- Le Reve-style (mock): sale grid with crossed-out prices
  console.log('\nLe Reve-style sale page (mock)');
  let ui = await visit('https://lerevecraze.com/product-category/sale/', fixture('lereve-sale-mock.html'));
  const lereve = storage['s:lerevecraze.com'];
  check('5 sale items saved', lereve?.items.length === 5, lereve?.items.map((i) => i.title));
  check('short names like "Kameez" and "Gown" kept', ['Kameez', 'Gown'].every((n) => lereve?.items.some((i) => i.title === n)));
  check('currency is BDT (not "VAT")', lereve?.currency === 'BDT', lereve?.currency);
  check('first item correct', lereve?.items[0]?.price === 5440 && lereve?.items[0]?.was === 10879, lereve?.items[0]);
  check('toast shown', /Sale found: 5 items, up to 50% off/.test(ui.toast || ''), ui.toast);

  console.log('\nLe Reve-style product page (mock)');
  ui = await visit('https://lerevecraze.com/product/skd16345/', fixture('lereve-product-mock.html'));
  const product = storage['p:lerevecraze.com:/product/skd16345/'];
  check('product saved with price + original', product?.price === 5440 && product?.originalPrice === 10879, product);
  check('badge shows 50% off', /On sale: 50% off/.test(ui.badge || ''), ui.badge);
  check('"Try On" button not saved as a product name', !storage['s:lerevecraze.com'].items.some((i) => /try on/i.test(i.title)),
    storage['s:lerevecraze.com'].items.map((i) => i.title));
  check('related sale item added', storage['s:lerevecraze.com'].items.some((i) => i.title === 'Golden Brown Joom A-line Kameez'));

  console.log('\nLe Reve-style in-store-only product (no Add to cart)');
  delete storage['p:lerevecraze.com:/product/skd16345/'];
  const itemCount = storage['s:lerevecraze.com'].items.length;
  ui = await visit('https://lerevecraze.com/product/skd16345/?ref=x',
    fixture('lereve-product-mock.html').replace('Add to cart', 'Check store availability'));
  check('still detected as a product', /On sale: 50% off/.test(ui.badge || ''), ui.badge);
  check('no duplicate sale item from ?ref=', storage['s:lerevecraze.com'].items.length === itemCount, storage['s:lerevecraze.com'].items.length);

  // ---- Sara-style: "Save ৳ X" labels + banner
  console.log('\nSara-style sale page (mock)');
  ui = await visit('https://saralifestyle.com/sale', fixture('sara-sale-mock.html'));
  const sara = storage['s:saralifestyle.com'];
  check('4 items (crossed-out + "Save ৳"/"% OFF" labels)', sara?.items.length === 4, sara?.items.map((i) => i.title));
  check('prices stripped from wrapped link name', sara?.items.some((i) => i.title === 'denim fashion tops' && i.price === 764 && i.was === 2545),
    sara?.items.map((i) => i.title));
  check('no item name contains a price', !sara?.items.some((i) => /৳|\d{3}/.test(i.title)), sara?.items.map((i) => i.title));
  check('jersey: 1505 was 2150', sara?.items.some((i) => i.title === 'Brazil Football Jersey' && i.price === 1505 && i.was === 2150));
  check('banner: up to 70% off', sara?.summary?.percentOff === 70 && sara?.summary?.upTo, sara?.summary);
  check('no false product badge on the sale page', ui.badge === null, ui.badge);

  // ---- Facebook brand page
  console.log('\nFacebook photo page, before the brand page was ever visited');
  // Dates relative to today so the test doesn't expire: current sale ends in 7 days, old one ended 30 days ago.
  const MONTH_NAMES = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
  const shift = (days) => new Date(Date.now() + days * 86400000);
  const spoken = (d) => `${d.getDate()}th ${MONTH_NAMES[d.getMonth()]}`;
  const fbHtml = fixture('facebook-artisan-mock.html')
    .replace('TILL 10th NOVEMBER', `TILL ${spoken(shift(7))}`)
    .replace('TILL 1st OCTOBER', `TILL ${spoken(shift(-30))}`);
  const photoHtml = fixture('facebook-photo-mock.html').replace('TILL 10th NOVEMBER', `TILL ${spoken(shift(7))}`);
  const PHOTO_URL = 'https://www.facebook.com/photo/?fbid=1107338685547628&set=a.113922921555881';
  await visit(PHOTO_URL, photoHtml, { facebook: true, wait: 2000 });
  const fbOnly = storage['s:facebook.com/artisanoutfittersltd'];
  check('poster found from the photo page', fbOnly?.name === 'Artisan Outfitters', Object.keys(storage));
  check('photo: 50% off, ends in 7 days', fbOnly?.summary?.percentOff === 50 && fbOnly?.summary?.endDate === shift(7).toLocaleDateString('en-CA'), fbOnly?.summary);
  check('"Outfitters" in the name → clothing words', fbOnly?.keywords.includes('panjabi'), fbOnly?.keywords);

  console.log('\nFacebook brand page (mock)');
  await visit('https://www.facebook.com/artisanoutfittersltd/', fbHtml, { facebook: true, wait: 2000 });
  const artisan = storage['s:artisanclick.com'];
  check('photo-only record merged into the website record', !storage['s:facebook.com/artisanoutfittersltd'], Object.keys(storage));
  check('saved under the website from Intro', !!artisan, Object.keys(storage));
  check('flat 50% off, ends in 7 days (old ended post ignored)',
    artisan?.summary?.percentOff === 50 && artisan?.summary?.endDate === shift(7).toLocaleDateString('en-CA'), artisan?.summary);
  check('page name kept', artisan?.name === 'Artisan Outfitters', artisan?.name);
  check('clothing words attached', artisan?.keywords.includes('panjabi'), artisan?.keywords);

  console.log('\nFacebook photo page, after the brand page was visited');
  await visit(PHOTO_URL + '&x=2', photoHtml, { facebook: true, wait: 2000 });
  check('saved straight to the website record', !storage['s:facebook.com/artisanoutfittersltd'] && storage['s:artisanclick.com']?.summary?.source === 'facebook',
    Object.keys(storage).filter((k) => k.startsWith('s:')));
  const storesBefore = Object.keys(storage).filter((k) => k.startsWith('s:')).length;
  await visit('https://www.facebook.com/', '<html><body><div role="article"><img alt="May be an image of text that says \'FLAT 30% OFF\'"></div></body></html>', { facebook: true, wait: 2000 });
  check('home feed post without a poster saves nothing', Object.keys(storage).filter((k) => k.startsWith('s:')).length === storesBefore);

  console.log('\nFacebook photo with no readable text → on-device AI');
  storage.settings = { aiEnabled: true };
  chrome.runtime.aiAnswer = { isSale: true, maxPercentOff: 40, upTo: true, endDate: null, productTypes: ['saree', 'kurti'], summary: 'Up to 40% off sarees' };
  await visit('https://www.facebook.com/photo/?fbid=999&set=a.1',
    `<html><body><div role="dialog">
      <img src="https://scontent.xx.fbcdn.net/v/sale.jpg" width="1200" height="1200" alt="May be an image of 1 person and saree">
      <a href="https://www.facebook.com/yellowbd" role="link"><span>Yellow</span></a></div></body></html>`,
    { facebook: true, wait: 4500 });
  const call = chrome.runtime.aiCalls.find((c) => c.type === 'pdh-ai-read');
  check('AI asked with the fbcdn image URL', call?.imageUrl === 'https://scontent.xx.fbcdn.net/v/sale.jpg', call);
  const yellow = storage['s:facebook.com/yellowbd'];
  check('AI answer saved: up to 40% off, from AI', yellow?.summary?.percentOff === 40 && yellow?.summary?.source === 'ai', yellow?.summary);
  check('AI product words kept for matching', yellow?.keywords.includes('saree'), yellow?.keywords);
  storage.settings = { aiEnabled: false };
  chrome.runtime.aiAnswer = null;

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

  // ---- Amazon-style search results: the review link sits next to the price, the title further up
  console.log('\nAmazon-style search results (mock)');
  // `discount` is either a crossed-out price or a "-50%" label, to cover both ways items are found.
  const amazonCard = (asin, title, price, discount) => `
    <div class="s-result-item" data-asin="${asin}">
      <div class="title-recipe"><a class="a-link-normal" href="/x/dp/${asin}/"><h2 aria-label="${title}"><span>${title}</span></h2></a></div>
      <div class="a-section">
        <span class="a-declarative"><a href="javascript:void(0)" role="button" aria-label="4.5 out of 5 stars, rating details"><i class="a-icon-star"><span class="a-icon-alt">4.5 out of 5 stars</span></i></a></span>
        <a aria-label="See customer reviews" href="/x/dp/${asin}/#customerReviews"><span>See customer reviews</span></a>
        <div class="price-recipe">
          <span class="a-price"><span>$${price}</span></span>
          ${discount}
        </div>
      </div>
    </div>`;
  await visit('https://www.amazon.com/s?k=headphones', `<html><body><a href="/cart">Cart</a>
    ${amazonCard('B001', 'Wireless Noise Cancelling Headphones', '99.99', '<span class="a-text-price"><s>$199.99</s></span>')}
    ${amazonCard('B002', 'Bluetooth Speaker Waterproof', '19.99', '<span class="savings">-50%</span>')}</body></html>`, { wait: 2000 });
  const amazon = storage['s:amazon.com'];
  check('Amazon items named after the product, not "See customer reviews"',
    amazon?.items.length === 2 && amazon.items.every((i) => !/review|stars/i.test(i.title)), amazon?.items.map((i) => i.title));
  check('Amazon item: headphones $99.99 was $199.99',
    amazon?.items.some((i) => i.title === 'Wireless Noise Cancelling Headphones' && i.price === 99.99 && i.was === 199.99), amazon?.items);
  const pdh = (() => { const w = new JSDOM('', { runScripts: 'outside-only' }).window; w.eval(SHARED); return w.PDH; })();
  check('old items saved as "See customer reviews" are hidden', pdh.activeSale({ site: 'amazon.com', items: [
    { title: 'See customer reviews', url: 'https://www.amazon.com/dp/1#customerReviews', price: 10, was: 20, percentOff: 50, seen: new Date().toISOString() }] }) === null);
  delete storage['s:amazon.com'];

  // ---- Word matching: "today" is not "day"
  console.log('\nWord matching');
  const { wordMatch, isNonShopSite, activeSale } = (() => { const w = new JSDOM('', { runScripts: 'outside-only' }).window; w.eval(SHARED); return w.PDH; })();
  check('"handbag" matches "bag"', wordMatch('handbag', 'bag'));
  check('"today" does not match "day"', !wordMatch('today', 'day'));
  check('"market" does not match "ket"', !wordMatch('market', 'ket'));
  const now = new Date().toISOString();
  storage['s:arogga.com'] = { site: 'arogga.com', keywords: [], items: [
    { title: 'Skin Cafe All Day Moisturizer With Niacinamide 50ml', url: 'https://www.arogga.com/p/1', price: 700, was: 1000, percentOff: 30, seen: now }] };
  ui = await visit('https://www.google.com/search?q=is+today+new+market+open', '<html><body></body></html>', { wait: 4500 });
  check('Google "is today new market open" → nothing', ui.suggest === null, ui.suggest);
  ui = await visit('https://www.google.com/search?q=niacinamide+moisturizer', '<html><body></body></html>');
  check('Google "niacinamide moisturizer" → arogga', /arogga/.test(ui.suggest || ''), ui.suggest);

  // ---- Sites that are not shops never get a store sale
  console.log('\nNot shops');
  check('google / youtube / 127.0.0.1 / localhost / intranet are not shops',
    ['google.com', 'www.google.com.bd', 'youtube.com', '127.0.0.1', 'localhost', 'erp', 'erp.local'].every(isNonShopSite));
  check('stores and Facebook pages are shops',
    !['lerevecraze.com', 'arogga.com', 'facebook.com/yellowbd', 'shop.google-free.com'].some(isNonShopSite));
  check('old youtube.com sale record is hidden',
    activeSale({ site: 'youtube.com', items: [], summary: { source: 'ai', percentOff: 50, seen: now } }) === null);
  check('a sale added by hand on such a site is kept',
    !!activeSale({ site: '127.0.0.1', items: [], summary: { source: 'manual', percentOff: 0, seen: now } }));

  storage.settings = { aiEnabled: true };
  chrome.runtime.aiAnswer = { isSale: true, maxPercentOff: 20, upTo: false, endDate: null, productTypes: [], summary: 'Sales order' };
  chrome.runtime.aiCalls.length = 0;
  const erpHtml = '<html><body><h1>Sales Order SAL-ORD-0042</h1><h2>Discount 20% off on grand total</h2><button>Save</button></body></html>';
  const storesNow = () => Object.keys(storage).filter((k) => k.startsWith('s:')).sort().join();
  const storesBeforeErp = storesNow();
  await visit('http://127.0.0.1:8000/app/sales-order/SAL-ORD-0042', erpHtml, { wait: 4500 });
  await visit('https://erp.example.com/app/sales-order/SAL-ORD-0042', erpHtml, { wait: 4500 });
  await visit('https://www.youtube.com/watch?v=1', '<html><body><h1>Diwali Dhamaka Sale: Flat 50% off</h1></body></html>', { wait: 4500 });
  check('ERPNext sales order (local + own domain) and YouTube save nothing', storesNow() === storesBeforeErp, storesNow());
  check('AI not asked on those pages', chrome.runtime.aiCalls.length === 0, chrome.runtime.aiCalls.map((c) => c.url));
  await visit('https://shop.example.com/', '<html><body><h2>Winter sale: flat 30% off</h2><button>Add to cart</button></body></html>', { wait: 4500 });
  check('a real shop banner still counts', storage['s:shop.example.com']?.summary?.percentOff === 30, storage['s:shop.example.com']);
  storage.settings = { aiEnabled: false };
  chrome.runtime.aiAnswer = null;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err.name, err.message, err.stack); process.exit(1); });
