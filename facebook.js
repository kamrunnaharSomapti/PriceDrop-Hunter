/*
 * PriceDrop Hunter - Facebook reader.
 *
 * Many shops announce sales only on Facebook, often as an image. Facebook adds
 * a text description to most images ("May be an image of text that says
 * 'MEGA SALE FLAT 50% OFF TILL 10th NOVEMBER'"), so we read:
 *   - brand pages (facebook.com/<brand>): posts, image descriptions, and the
 *     Intro box (website + category) to link the sale to the store
 *   - single photos / posts (facebook.com/photo/?fbid=..., /<brand>/posts/...):
 *     the image description plus the brand that posted it
 * If the image has no usable description and on-device AI is on, the image is
 * read by Chrome's built-in AI (on this computer).
 * Works logged in or out. Facebook's class names change constantly, so this
 * only uses visible text, alt text and a few stable attributes (role, dir, h1).
 * Needs shared.js loaded first. Nothing leaves the browser.
 */
(() => {
  'use strict';

  if (window.__priceDropHunterFbLoaded) return;
  window.__priceDropHunterFbLoaded = true;

  const {
    parseSaleText, keywords, categoryWords, saveStoreSale, siteOf, describeSummary, today, getSettings, STORE_PREFIX,
  } = globalThis.PDH;

  const SCAN_EVERY_MS = 3000;
  const MAX_SCANS_PER_URL = 10; // stop after ~30s on one URL; resumes on navigation
  const BRAND_KEY = 'fbpage:';  // fbpage:<slug> -> { site, name, website, keywords } learned from the brand page
  const AI_RECHECK_MS = 24 * 3600000;

  // First path segments that are Facebook features, not brand pages.
  const NOT_PAGES = new Set(['', 'home.php', 'watch', 'marketplace', 'groups', 'gaming', 'events', 'friends', 'login',
    'messages', 'notifications', 'settings', 'search', 'reel', 'reels', 'stories', 'hashtag', 'help', 'policies', 'privacy',
    'bookmarks', 'saved', 'memories', 'pages', 'business', 'ads', 'feeds', 'photo', 'photo.php', 'photos', 'permalink.php',
    'story.php', 'share', 'l.php', 'media', 'video.php', 'videos', 'people', 'public', 'recover', 'checkpoint', 'r.php']);

  const SOCIAL_HOST_RE = /(^|\.)(facebook|fb|instagram|whatsapp|wa|m|messenger|tiktok|youtube|youtu|twitter|x|linkedin|google|goo|bit|linktr)\.(com|me|be|ly|gl|ee)$/i;

  /** Brand slug from a facebook.com URL, or null for feature pages. */
  function slugFromUrl(href) {
    let url;
    try { url = new URL(href, location.href); } catch { return null; }
    if (!/(^|\.)facebook\.com$/.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'profile.php') return url.searchParams.get('id');
    if (parts[0] === 'p' && parts[1]) return parts[1];
    if (!parts[0] || NOT_PAGES.has(parts[0].toLowerCase())) return null;
    return parts[0];
  }

  const isPhotoOrPost = () =>
    /^\/(photo|photo\.php|permalink\.php|story\.php)\b/.test(location.pathname) ||
    /\/(posts|photos|videos)\/[^/]+/.test(location.pathname);

  /**
   * Which brand this page is about.
   *   Brand page: from the URL, name from <h1>.
   *   Photo/post: the URL may not say (photo/?fbid=...), so use the first link
   *   to a brand page that has a short name (the poster), e.g. "Artisan Outfitters".
   */
  function pageIdentity() {
    const urlSlug = slugFromUrl(location.href);
    if (urlSlug && !isPhotoOrPost()) {
      const name = [...document.querySelectorAll('h1')]
        .map((h) => h.textContent.replace(/\s+/g, ' ').trim())
        .find((t) => t && t.length < 100 && !/^facebook$/i.test(t)) || null;
      return { slug: urlSlug, name, kind: 'page' };
    }
    if (!isPhotoOrPost()) return null;

    const scope = document.querySelector('[role="dialog"]') || document.querySelector('[role="main"]') || document.body;
    for (const a of scope.querySelectorAll('a[href]')) {
      const slug = slugFromUrl(a.href);
      const name = a.textContent.replace(/\s+/g, ' ').trim();
      if (slug && name.length >= 2 && name.length <= 80 && !/^(facebook|log in|sign up|create new account)$/i.test(name)) {
        return { slug, name, kind: 'post' };
      }
    }
    return urlSlug ? { slug: urlSlug, name: null, kind: 'post' } : null;
  }

  const pageUrlFor = (slug) => `https://www.facebook.com/${slug}`;

  /** Website from the Intro box: a link whose text looks like a domain, or an l.facebook.com redirect. */
  function findWebsite() {
    for (const a of document.querySelectorAll('a[href]')) {
      const text = a.textContent.trim().toLowerCase();
      let target = null;
      if (/^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/.test(text)) {
        target = text.startsWith('http') ? text : `https://${text}`;
      } else if (a.hostname === 'l.facebook.com') {
        target = new URL(a.href).searchParams.get('u');
      }
      if (!target) continue;
      try {
        const url = new URL(target);
        if (!SOCIAL_HOST_RE.test(url.hostname.replace(/^www\./, ''))) return url.origin;
      } catch { /* not a URL */ }
    }
    return null;
  }

  /** "Page · Apparel & clothing · Shopping & retail" from the Intro box. */
  function findCategory() {
    for (const el of document.querySelectorAll('span, div')) {
      if (el.children.length > 4) continue;
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (/^Page\s*·\s*/i.test(text) && text.length < 120) return text.replace(/^Page\s*·\s*/i, '');
    }
    return '';
  }

  /** Every piece of text that could be a post: post bodies, image descriptions, articles. */
  function postTexts() {
    const texts = new Set();
    for (const img of document.images) {
      if (img.alt && img.alt.length > 8 && img.alt.length < 600) texts.add(img.alt);
    }
    for (const el of document.querySelectorAll('[role="article"], [role="dialog"], div[dir="auto"], span[dir="auto"]')) {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text.length > 8 && text.length < 1500) texts.add(text);
    }
    return [...texts];
  }

  /** Best sale announcement: biggest discount, then one with an end date. Ignores finished sales. */
  function bestSale(texts) {
    let best = null;
    for (const text of texts) {
      const found = parseSaleText(text);
      if (!found || (found.endDate && found.endDate < today())) continue;
      const better = !best
        || found.percentOff > best.percentOff
        || (found.percentOff === best.percentOff && found.endDate && !best.endDate);
      if (better) best = { ...found, note: cleanNote(text) };
    }
    return best;
  }

  /** Strips Facebook's "May be an image of ... text that says" wrapper. */
  function cleanNote(text) {
    const said = text.match(/text that says\s*['"“‘](.+)$/i);
    const body = said ? said[1].replace(/['"”’]\s*$/, '') : text;
    return body.replace(/\s+/g, ' ').trim().slice(0, 140);
  }

  /** Largest visible image (the photo being viewed / the cover), as a URL. */
  function mainImageUrl() {
    const img = [...document.images]
      .filter((i) => (i.naturalWidth || i.width) >= 400 && /^https:/.test(i.currentSrc || i.src))
      .sort((a, b) => (b.naturalWidth || b.width) * (b.naturalHeight || b.height) - (a.naturalWidth || a.width) * (a.naturalHeight || a.height))[0];
    return img ? img.currentSrc || img.src : null;
  }

  /** On-device AI reads the image itself when Facebook gave no usable description. */
  async function aiReadImage(identity) {
    if (!(await getSettings()).aiEnabled) return null;
    const imageUrl = mainImageUrl();
    if (!imageUrl) return null;
    const checkKey = 'ai:fb:' + (new URLSearchParams(location.search).get('fbid') || location.pathname);
    const last = (await chrome.storage.local.get(checkKey))[checkKey] || 0;
    if (Date.now() - last < AI_RECHECK_MS) return null;
    await chrome.storage.local.set({ [checkKey]: Date.now() });

    const text = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').slice(0, 2000);
    const result = await chrome.runtime.sendMessage({
      type: 'pdh-ai-read', site: 'facebook.com/' + identity.slug, url: location.href,
      title: `Facebook post by ${identity.name || identity.slug}`, text, imageUrl,
    });
    if (!result?.isSale || (result.endDate && result.endDate < today())) return null;
    return {
      percentOff: result.maxPercentOff, upTo: result.upTo, endDate: result.endDate, note: result.summary,
      productTypes: result.productTypes, source: 'ai',
    };
  }

  /**
   * Where to save: the brand's website if we know it (from this page's Intro or
   * from an earlier visit to the brand page), else "facebook.com/<slug>".
   */
  async function resolveStore(identity) {
    const mapKey = BRAND_KEY + identity.slug.toLowerCase();
    if (identity.kind === 'page') {
      const website = findWebsite();
      const category = findCategory();
      const brand = {
        site: website ? siteOf(new URL(website).hostname) : `facebook.com/${identity.slug.toLowerCase()}`,
        name: identity.name,
        website,
        keywords: [...categoryWords(`${category} ${identity.name || ''}`), ...keywords(category)],
      };
      await chrome.storage.local.set({ [mapKey]: brand });
      if (website) await mergeFacebookOnlyRecord(identity.slug, brand.site);
      return brand;
    }
    const known = (await chrome.storage.local.get(mapKey))[mapKey];
    return known || {
      site: `facebook.com/${identity.slug.toLowerCase()}`,
      name: identity.name,
      website: null,
      keywords: categoryWords(identity.name || ''), // "Outfitters", "Fashion" -> clothing words
    };
  }

  /** A sale first seen on a photo (saved as facebook.com/<slug>) moves to the website once we learn it. */
  async function mergeFacebookOnlyRecord(slug, site) {
    const oldKey = STORE_PREFIX + `facebook.com/${slug.toLowerCase()}`;
    const old = (await chrome.storage.local.get(oldKey))[oldKey];
    if (!old) return;
    await saveStoreSale({ site, name: old.name, summary: old.summary, keywords: old.keywords, items: old.items });
    await chrome.storage.local.remove(oldKey);
  }

  let lastUrl = '';
  let scans = 0;
  let lastSaved = '';
  let aiTried = false;

  async function scan() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scans = 0;
      lastSaved = '';
      aiTried = false;
    }
    if (scans++ >= MAX_SCANS_PER_URL || document.hidden) return;

    const identity = pageIdentity();
    if (!identity) return;

    let sale = bestSale(postTexts());
    if (sale && !sale.percentOff && !sale.endDate) sale = null; // need something concrete
    if (sale) sale.source = 'facebook';

    // No readable sale text after the page settled: let the on-device AI look at the photo.
    if (!sale && identity.kind === 'post' && scans >= 2 && !aiTried) {
      aiTried = true;
      sale = await aiReadImage(identity);
    }
    if (!sale) return;

    const brand = await resolveStore(identity);
    const fingerprint = `${brand.site}|${sale.percentOff}|${sale.endDate}`;
    if (fingerprint === lastSaved) return;
    lastSaved = fingerprint;

    const types = (sale.productTypes || []).join(' ');
    await saveStoreSale({
      site: brand.site,
      name: brand.name || identity.name,
      website: brand.website,
      pageUrl: brand.website || pageUrlFor(identity.slug),
      summary: { percentOff: sale.percentOff, upTo: sale.upTo, endDate: sale.endDate, note: sale.note,
        source: sale.source, sourceUrl: location.href },
      keywords: [...brand.keywords, ...keywords(types), ...categoryWords(types)],
    });
    console.debug('[PriceDrop Hunter] Facebook sale saved:', brand.name || identity.slug, describeSummary(sale));
  }

  setInterval(() => scan().catch((err) => console.debug('[PriceDrop Hunter]', err)), SCAN_EVERY_MS);
  setTimeout(() => scan().catch(() => {}), 1500);
})();
