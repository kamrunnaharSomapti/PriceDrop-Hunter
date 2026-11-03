/*
 * PriceDrop Hunter - Chrome built-in AI (Gemini Nano, runs on this computer).
 * Used only as a fallback when the normal rules can't find a sale on a page.
 * Loaded by background.js, offscreen.html and popup.html.
 * Docs: https://developer.chrome.com/docs/ai/prompt-api
 */
// Global on purpose: shared with background.js, offscreen.js and popup.js.
var PDH_AI = (() => { // eslint-disable-line no-var, no-unused-vars
  'use strict';

  const TEXT_OPTIONS = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };
  const IMAGE_OPTIONS = {
    expectedInputs: [{ type: 'text', languages: ['en'] }, { type: 'image' }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };

  const SYSTEM_PROMPT = [
    'You read text (and sometimes a banner image) from an online store page or a brand\'s social media page.',
    'Decide whether a sale or discount is advertised as happening now.',
    'Use only what the text or image says. Do not guess numbers.',
    'maxPercentOff: the biggest percentage discount stated, or 0 if none is stated.',
    'upTo: true if the discount is "up to" a percentage.',
    'endDate: the last day of the sale as YYYY-MM-DD if stated, otherwise an empty string.',
    'productTypes: up to 8 short English product words on sale (e.g. "panjabi", "saree", "shoes").',
    'summary: one short line describing the offer.',
  ].join('\n');

  const SCHEMA = {
    type: 'object',
    properties: {
      isSale: { type: 'boolean' },
      maxPercentOff: { type: 'integer', minimum: 0, maximum: 95 },
      upTo: { type: 'boolean' },
      endDate: { type: 'string' },
      productTypes: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      summary: { type: 'string' },
    },
    required: ['isSale', 'maxPercentOff', 'upTo', 'endDate', 'productTypes', 'summary'],
  };

  const supported = () => typeof LanguageModel !== 'undefined';

  /** 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available' */
  async function status() {
    if (!supported()) return 'unsupported';
    try { return await LanguageModel.availability(TEXT_OPTIONS); } catch { return 'unavailable'; }
  }

  /** Starts the model download. Must be called from a click (user activation). */
  async function enable(onProgress) {
    const session = await LanguageModel.create({
      ...TEXT_OPTIONS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded));
      },
    });
    session.destroy();
  }

  function clean(result) {
    const pct = Math.max(0, Math.min(95, Math.round(Number(result.maxPercentOff) || 0)));
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(result.endDate || '') ? result.endDate : null;
    return {
      isSale: !!result.isSale,
      maxPercentOff: pct,
      upTo: !!result.upTo,
      endDate,
      productTypes: (Array.isArray(result.productTypes) ? result.productTypes : [])
        .filter((t) => typeof t === 'string').map((t) => t.slice(0, 30)).slice(0, 8),
      summary: String(result.summary || '').slice(0, 140),
    };
  }

  /** { title, url, text, image? (data: URL) } -> sale facts, or null if the model isn't ready. */
  async function readPage({ title, url, text, image }) {
    if (await status() !== 'available') return null;

    let options = TEXT_OPTIONS;
    let imageBlob = null;
    if (image) {
      try {
        if (await LanguageModel.availability(IMAGE_OPTIONS) === 'available') {
          imageBlob = await (await fetch(image)).blob();
          options = IMAGE_OPTIONS;
        }
      } catch { /* image input not supported here: text only */ }
    }

    const session = await LanguageModel.create({
      ...options,
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
    });
    try {
      const content = [{
        type: 'text',
        value: `Today is ${new Date().toLocaleDateString('en-CA')}.\nPage title: ${title}\nURL: ${url}\nPage text:\n${String(text).slice(0, 4000)}`,
      }];
      if (imageBlob) content.push({ type: 'image', value: imageBlob });
      const raw = await session.prompt([{ role: 'user', content }], { responseConstraint: SCHEMA });
      return clean(JSON.parse(raw));
    } finally {
      session.destroy();
    }
  }

  return { supported, status, enable, readPage };
})();
