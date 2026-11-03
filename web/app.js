/*
 * Landing page animations.
 * The demo is a small "movie" per step: a pointer moves around a mock browser
 * and the extension's UI appears the way it does in real use.
 * Without JavaScript (or with reduced motion) every step shows its final state.
 */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STEP_MS = 9000;

  const browser = document.querySelector('.browser');
  const tabs = [...document.querySelectorAll('.step')];
  const panes = [...document.querySelectorAll('.pane')];
  const urlEl = document.getElementById('demo-url');
  const cursor = document.getElementById('cursor');
  const extCount = document.getElementById('ext-count');
  const progressBar = document.getElementById('progress-bar');

  let current = 1;
  let runId = 0;          // bumps on every step change; older scripts stop themselves
  let savedCount = 0;     // number on the extension icon
  let inView = false;
  let nextTimer = null;

  // ---------------------------------------------------------------------------
  // Small animation helpers (each throws 'stop' when a newer run started)
  // ---------------------------------------------------------------------------

  const wait = (ms, id) => new Promise((resolve, reject) => {
    setTimeout(() => (id === runId ? resolve() : reject(new Error('stop'))), ms);
  });

  async function moveTo(el, id, { dx = 0.5, dy = 0.5 } = {}) {
    if (!el) return;
    const box = browser.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const x = r.left - box.left + r.width * dx;
    const y = r.top - box.top + r.height * dy;
    cursor.classList.add('on');
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    await wait(950, id);
  }

  async function click(id) {
    cursor.classList.remove('click');
    void cursor.getBoundingClientRect(); // restart the animation
    cursor.classList.add('click');
    await wait(300, id);
  }

  async function type(el, text, id, speed = 90) {
    el.textContent = '';
    for (const ch of text) {
      el.textContent += ch;
      await wait(speed, id);
    }
  }

  async function countUp(el, to, id, ms = 900) {
    const steps = 18;
    for (let i = 1; i <= steps; i++) {
      el.textContent = Math.round((to * i) / steps);
      await wait(ms / steps, id);
    }
  }

  function show(el) { el?.classList.add('show'); }

  function bumpExtension(n = 1) {
    savedCount += n;
    extCount.hidden = false;
    extCount.textContent = savedCount;
    extCount.classList.remove('bump');
    void extCount.offsetWidth;
    extCount.classList.add('bump');
  }

  // ---------------------------------------------------------------------------
  // One script per step
  // ---------------------------------------------------------------------------

  const scripts = {
    // 1. Product page: badge + price chart appear, extension saves the price.
    async 1(pane, id) {
      await moveTo(urlEl, id, { dx: 0.3 });
      await click(id);
      await moveTo(pane.querySelector('h3'), id, { dx: 0.2 });
      await wait(300, id);
      show(pane.querySelector('.badge-low'));
      bumpExtension();
      await wait(500, id);
      pane.querySelector('.spark').classList.add('draw');
      await moveTo(pane.querySelector('.badge-low'), id, { dx: 0.8 });
    },

    // 2. Sale page: each discounted card gets "✓ saved", then the toast counts up.
    async 2(pane, id) {
      await moveTo(pane.querySelector('.banner'), id, { dx: 0.7 });
      for (const card of pane.querySelectorAll('.card')) {
        await moveTo(card.querySelector('.tag'), id, { dx: 0.9, dy: 0.9 });
        card.classList.add('found');
        bumpExtension();
        await wait(150, id);
      }
      const toast = pane.querySelector('.toast');
      show(toast);
      await countUp(document.getElementById('sale-count'), 24, id);
    },

    // 3. Facebook post: a scan beam reads the poster, the text types out, sale saved.
    async 3(pane, id) {
      await moveTo(pane.querySelector('.poster'), id, { dx: 0.5, dy: 0.4 });
      pane.querySelector('.scan-beam').classList.add('run');
      await wait(1400, id);
      const reader = pane.querySelector('.reader');
      show(reader);
      const code = document.getElementById('fb-read');
      await type(code, code.dataset.text, id, 32);
      show(reader.querySelector('.saved'));
      bumpExtension();
      await moveTo(reader.querySelector('.saved'), id, { dx: 0.2 });
    },

    // 4. Another site: type a search, results load, suggestion card slides in.
    async 4(pane, id) {
      const typed = document.getElementById('typed');
      typed.textContent = '';
      await moveTo(pane.querySelector('.searchbox'), id, { dx: 0.3 });
      await click(id);
      await type(typed, 'panjabi', id, 120);
      await wait(300, id);
      show(pane.querySelector('.results'));
      await wait(600, id);
      const card = pane.querySelector('.pdh-card');
      show(card);
      await wait(700, id);
      const firstStore = card.querySelector('.pdh-store');
      await moveTo(firstStore, id, { dx: 0.3 });
      firstStore.classList.add('hover');
    },
  };

  // ---------------------------------------------------------------------------
  // Step switching + autoplay
  // ---------------------------------------------------------------------------

  /** Puts a pane back to its "before" state so the animation can replay. */
  function resetPane(pane) {
    pane.querySelectorAll('.show, .found, .draw, .run, .hover').forEach((el) => {
      el.classList.remove('show', 'found', 'draw', 'run', 'hover');
    });
  }

  function startProgress() {
    progressBar.style.transition = 'none';
    progressBar.style.width = '0';
    void progressBar.offsetWidth;
    progressBar.style.transition = `width ${STEP_MS}ms linear`;
    progressBar.style.width = '100%';
  }

  function goTo(step) {
    current = step;
    const id = ++runId;
    clearTimeout(nextTimer);

    tabs.forEach((t) => {
      const on = Number(t.dataset.step) === step;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on);
    });
    panes.forEach((p, i) => { p.hidden = i + 1 !== step; });
    const pane = panes[step - 1];
    urlEl.textContent = pane.dataset.url;

    if (step === 1) {
      savedCount = 0;
      extCount.hidden = true;
    }

    if (reduceMotion) return; // final states are the default look

    resetPane(pane);
    browser.classList.add('playing');
    cursor.classList.remove('on');
    startProgress();
    scripts[step](pane, id).catch(() => { /* a newer step took over */ });

    nextTimer = setTimeout(() => {
      if (id === runId && inView) goTo(step === panes.length ? 1 : step + 1);
    }, STEP_MS);
  }

  tabs.forEach((tab) => tab.addEventListener('click', () => goTo(Number(tab.dataset.step))));

  // Arrow keys between tabs (tablist pattern).
  document.querySelector('.steps').addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) return;
    e.preventDefault();
    const delta = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1;
    const next = ((current - 1 + delta + tabs.length) % tabs.length) + 1;
    goTo(next);
    tabs[next - 1].focus();
  });

  // Only play while the demo is on screen.
  new IntersectionObserver(([entry]) => {
    const wasInView = inView;
    inView = entry.isIntersecting;
    if (inView && !wasInView) goTo(current);
    if (!inView) { runId++; clearTimeout(nextTimer); }
  }, { threshold: 0.35 }).observe(browser);

  // ---------------------------------------------------------------------------
  // Fade sections in as they scroll into view
  // ---------------------------------------------------------------------------
  if (!reduceMotion) {
    const items = document.querySelectorAll('.section h2, .feature, .flow li, .checks li, .faq details');
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      });
    }, { threshold: 0.15 });
    items.forEach((el, i) => {
      el.classList.add('reveal');
      el.style.transitionDelay = `${(i % 3) * 80}ms`;
      io.observe(el);
    });
  }
})();
