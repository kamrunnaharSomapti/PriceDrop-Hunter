/*
 * PriceDrop Hunter - background service worker.
 * Only job: run the on-device AI for content scripts (they can't use it directly).
 * If the AI isn't exposed in the service worker, it runs in an offscreen page instead.
 */
importScripts('ai.js');

const OFFSCREEN_URL = 'offscreen.html';
const MAX_IMAGE_BYTES = 4_000_000;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['DOM_PARSER'],
    justification: 'Runs Chrome\'s built-in on-device AI to read sale banners. No data leaves the device.',
  });
}

/**
 * Facebook photos live on fbcdn.net, which the page's content script can't
 * download (cross-origin). The service worker can, thanks to host_permissions.
 */
async function downloadImage(imageUrl) {
  try {
    const url = new URL(imageUrl);
    if (url.protocol !== 'https:' || !/(^|\.)fbcdn\.net$/.test(url.hostname)) return null;
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return blob.type.startsWith('image/') && blob.size <= MAX_IMAGE_BYTES ? blob : null;
  } catch {
    return null;
  }
}

/** Blob -> data: URL (messages to the offscreen page can't carry Blobs). */
async function toDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function readWithAi(message) {
  const request = { title: message.title, url: message.url, text: message.text, image: message.image || null };
  if (!request.image && message.imageUrl) request.image = await downloadImage(message.imageUrl);

  if (PDH_AI.supported()) return PDH_AI.readPage(request);

  if (request.image instanceof Blob) request.image = await toDataUrl(request.image);
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
