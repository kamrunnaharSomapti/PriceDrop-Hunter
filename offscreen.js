/* Runs AI requests forwarded by background.js. */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'pdh-ai-offscreen') return false;
  PDH_AI.readPage(message.request)
    .then((result) => sendResponse(result || null))
    .catch((err) => {
      console.warn('[PriceDrop Hunter] AI read failed:', err);
      sendResponse(null);
    });
  return true;
});
