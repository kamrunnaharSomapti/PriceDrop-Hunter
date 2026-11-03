You are an expert Chrome Extension engineer building a privacy-first, local-storage price tracking extension called "PriceDrop Hunter" using Chrome Manifest V3, vanilla JavaScript, HTML, and CSS (no heavy frameworks).

Key Constraints:
1. Strict Manifest V3 compliance (no remote scripts, no eval, service workers where needed).
2. Privacy-first: Zero external tracking or analytics servers. All data MUST reside exclusively in chrome.storage.local.
3. Supported initial platform: Amazon (with clean modular selector pattern so other stores like Daraz or eBay can be added via simple config).
4. Code organization: Keep files clean, modular, and well-commented:
   - manifest.json
   - content.js (DOM parsing + inline UI badge injection)
   - popup.html & popup.js (dashboard viewing tracked products + mini sparkline)
   - styles.css (clean, modern, lightweight UI)

Please confirm you understand this architecture and wait for my instruction for Step 2.

Now complete `content.js`:

1. DOM Extraction & Normalization:
   - Cleanly extract the product title and parse the price into a pure float (handling currency symbols and commas).
   - Ignore if price or product ID is missing (e.g. out of stock or wrong page).
2. Local Storage Logic:
   - Read from chrome.storage.local using the product ID as key.
   - Record an array of snapshots: [{ date: "YYYY-MM-DD", price: 29.99 }].
   - If a snapshot for today already exists, don't duplicate it.
3. Inline UI Badge:
   - Inject a neat, non-intrusive badge directly below the main price element on the live webpage.
   - Logic:
     - If current price == all-time low -> Green badge: "🔥 Lowest Price Recorded Locally"
     - If current price == all-time high -> Red badge: "⚠️ Highest Price Recorded Locally"
     - Otherwise -> Neutral badge: "ℹ️ Normal Price (Range: $min - $max)"
   - Badge must have clean styles scoped so it does not conflict with Amazon's native CSS.

   Now build `popup.html`, `popup.js`, and `styles.css`.

Requirements:
1. UI Layout:
   - Popup width: 340px, clean modern look (dark mode friendly or clean clean neutral).
   - Header with title and total items tracked.
   - Scrollable list of tracked products showing: product title (truncated), current price, lowest price seen, and date last checked.
   - Clear/Reset button with a confirmation check.
2. Visual Sparkline (No external chart libraries):
   - For each item card, render a tiny, crisp HTML5 `<canvas>` or inline SVG sparkline showing the price trajectory over time.
   - Handle edge cases: 1 single data point (show dot), 2+ data points (show connected line with gradient fill).
3. Clicking an item opens the product URL in a new browser tab.