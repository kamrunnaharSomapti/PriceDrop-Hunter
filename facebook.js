/*
 * PriceDrop Hunter - Facebook page reader.
 *
 * Many shops announce sales only on their Facebook page, often as an image.
 * Facebook adds a text description to most images ("May be an image of text
 * that says 'MEGA SALE FLAT 50% OFF TILL 10th NOVEMBER'"), so we read:
 *   - post text and image descriptions on a brand's page
 *   - the page's Intro (website + category) to link the sale to the store
 * Facebook's class names change constantly, so this only uses visible text,
 * alt text, and a few stable attributes (role, dir, h1).
 * Needs shared.js loaded first. Nothing leaves the browser.
 */
(() => {
  'use strict';

  if (window.__priceDropHunterFbLoaded) return;
  window.__priceDropHunterFbLoaded = true;

  const { parseSaleText, keywords, categoryWords, saveStoreSale, siteOf, describeSummary, today } = globalThis.PDH;

  const SCAN_EVERY_MS = 4000;
  const MAX_SCANS_PER_URL = 8; // stop after ~30s on one page; resumes on navigation

  // facebook.com/<page>, /<page>/posts, /<page>/photos, /p/<Name-123>, /profile.php?id=...
  const NOT_PAGES = new Set(['', 'home.php', 'watch', 'marketplace', 'groups', 'gaming', 'events', 'friends', 'login',
    'messages', 'notifications', 'settings', 'search', 'reel', 'reels', 'stories', 'hashtag', 'help', 'policies', 'privacy',
    'bookmarks', 'saved', 'memories', 'pages', 'business', 'ads', 'feeds', 'photo', 'photo.php', 'permalink.php', 'story.php']);

  const SOCIAL_HOST_RE = /(^|\.)(facebook|fb|instagram|whatsapp|wa|m|messenger|tiktok|youtube|youtu|twitter|x|linkedin|google|goo|bit|linktr)\.(com|me|be|ly|gl|ee)$/i;

  /** Identifies the brand page we're on, or null on feed/other pages. */
  function pageIdentity() {
    const parts = location.pathname.split('/').filter(Boolean);
    let slug = parts[0] || '';
    if (slug === 'p' && parts[1]) slug = parts[1];
    if (slug === 'profile.php') slug = new URLSearchParams(location.search).get('id') || '';
    if (!slug || NOT_PAGES.has(slug.toLowerCase())) return null;

    const name = [...document.querySelectorAll('h1')]
      .map((h) => h.textContent.replace(/\s+/g, ' ').trim())
      .find((t) => t && t.length < 100 && !/^facebook$/i.test(t)) || null;
    return { slug, name, pageUrl: `https://www.facebook.com/${parts[0] === 'p' ? 'p/' : ''}${slug}` };
  }

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
    for (const el of document.querySelectorAll('[role="article"], div[dir="auto"], span[dir="auto"]')) {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      if (text.length > 8 && text.length < 1500) texts.add(text);
    }
    return [...texts];
  }

  /** Best sale announcement on the page: biggest discount, then one with an end date. */
  function bestSale(texts) {
    let best = null;
    for (const text of texts) {
      const found = parseSaleText(text);
      if (!found || (found.endDate && found.endDate < today())) continue; // old, finished sale post
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

  let lastUrl = '';
  let scans = 0;
  let lastSaved = '';

  async function scan() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      scans = 0;
      lastSaved = '';
    }
    if (scans++ >= MAX_SCANS_PER_URL || document.hidden) return;

    const page = pageIdentity();
    if (!page) return;
    const sale = bestSale(postTexts());
    if (!sale || (!sale.percentOff && !sale.endDate)) return; // need something concrete

    const website = findWebsite();
    const category = findCategory();
    const site = website ? siteOf(new URL(website).hostname) : `facebook.com/${page.slug.toLowerCase()}`;

    const fingerprint = `${site}|${sale.percentOff}|${sale.endDate}`;
    if (fingerprint === lastSaved) return;
    lastSaved = fingerprint;

    await saveStoreSale({
      site,
      name: page.name,
      website,
      pageUrl: website || page.pageUrl,
      summary: { percentOff: sale.percentOff, upTo: sale.upTo, endDate: sale.endDate, note: sale.note,
        source: 'facebook', sourceUrl: page.pageUrl },
      keywords: [...categoryWords(`${category} ${page.name}`), ...keywords(category)],
    });
    console.debug('[PriceDrop Hunter] Facebook sale saved:', page.name, describeSummary(sale));
  }

  setInterval(() => scan().catch((err) => console.debug('[PriceDrop Hunter]', err)), SCAN_EVERY_MS);
  setTimeout(() => scan().catch(() => {}), 1500);
})();
