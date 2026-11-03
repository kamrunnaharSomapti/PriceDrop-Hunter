/*
 * PriceDrop Hunter - background service worker.
 * Only job: run the on-device AI for content scripts (they can't use it directly).
 * If the AI isn't exposed in the service worker, it runs in an offscreen page instead.
 */
importScripts('ai.js');

const OFFSCREEN_URL = 'offscreen.html';

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_PARSER'],
    justification: 'Runs Chrome\'s built-in on-device AI to read sale banners. No data leaves the device.',
  });
}

async function readWithAi(request) {
  if (PDH_AI.supported()) return PDH_AI.readPage(request);
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ type: 'pdh-ai-offscreen', request });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'pdh-ai-read') return false;
  readWithAi(message)
    .then((result) => sendResponse(result || null))
    .catch((err) => {
      console.warn('[PriceDrop Hunter] AI read failed:', err);
      sendResponse(null);
    });
  return true; // async response
});
