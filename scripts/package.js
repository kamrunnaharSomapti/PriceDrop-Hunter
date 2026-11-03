/*
 * Builds the Chrome Web Store zip with only the extension's files.
 *
 *   npm run package   ->   dist/pricedrop-hunter-<version>.zip
 *
 * Included: manifest.json and the extension's .js/.html/.css files at the
 * repo root (plus icons/ if it exists). Left out: web/, tests/, docs/,
 * node_modules/, package files and notes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NOT_EXTENSION = new Set(['package.json', 'package-lock.json']);

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// Root-level extension files.
const files = fs.readdirSync(ROOT)
  .filter((name) => fs.statSync(path.join(ROOT, name)).isFile())
  .filter((name) => /\.(js|html|css|json|png|svg)$/.test(name) && !NOT_EXTENSION.has(name));
if (fs.existsSync(path.join(ROOT, 'icons'))) files.push('icons');

// Every file the manifest or the extension's pages point to must be in the zip.
const referenced = new Set([
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...(manifest.content_scripts || []).flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
].filter(Boolean));
for (const page of files.filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  for (const [, src] of html.matchAll(/(?:src|href)="([^":]+\.(?:js|css|svg|png))"/g)) referenced.add(src);
}
const bg = manifest.background?.service_worker;
if (bg) {
  for (const [, src] of fs.readFileSync(path.join(ROOT, bg), 'utf8').matchAll(/importScripts\(['"]([^'"]+)['"]\)/g)) referenced.add(src);
}
const missing = [...referenced].filter((f) => !files.includes(f.split('/')[0]));
if (missing.length) {
  console.error('Missing from the package:', missing.join(', '));
  process.exit(1);
}

fs.mkdirSync(DIST, { recursive: true });
const zipPath = path.join(DIST, `pricedrop-hunter-${manifest.version}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync('zip', ['-r', '-q', '-X', zipPath, ...files], { cwd: ROOT });

const kb = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`Built ${path.relative(ROOT, zipPath)} (${kb} KB, ${files.length} entries):`);
console.log('  ' + files.join('\n  '));
