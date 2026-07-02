'use strict';

/**
 * Generates a valid MSFS `layout.json` for the IFR Trainer add-on package and
 * updates `total_package_size` in `manifest.json`.
 *
 * MSFS reads layout.json to build the package's virtual filesystem — every
 * shipped file (except manifest.json and layout.json themselves) must be
 * listed with its byte size and a Windows FILETIME date. This script does the
 * bookkeeping the SDK's fspackagetool would otherwise do, so the package can
 * be dropped straight into the Community folder without the full SDK.
 *
 *   node msfs-addon/build-layout.js
 */

const fs = require('fs');
const path = require('path');

const PKG_DIR = path.join(__dirname, 'joybuy-ifr-trainer');
const LAYOUT_PATH = path.join(PKG_DIR, 'layout.json');
const MANIFEST_PATH = path.join(PKG_DIR, 'manifest.json');
const EXCLUDE = new Set(['layout.json', 'manifest.json']);

/** Convert JS epoch ms to Windows FILETIME (100 ns ticks since 1601-01-01). */
function toFileTime(ms) {
  // 11644473600 seconds between 1601-01-01 and 1970-01-01.
  return (BigInt(Math.round(ms)) + 11644473600000n) * 10000n;
}

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.posix.join(base, entry.name);
    if (entry.isDirectory()) {
      walk(abs, rel, out);
    } else if (entry.isFile() && !EXCLUDE.has(rel)) {
      const stat = fs.statSync(abs);
      out.push({
        path: rel,
        size: stat.size,
        date: Number(toFileTime(stat.mtimeMs)),
      });
    }
  }
}

function main() {
  if (!fs.existsSync(PKG_DIR)) {
    console.error(`Package directory not found: ${PKG_DIR}`);
    process.exit(1);
  }

  const content = [];
  walk(PKG_DIR, '', content);
  content.sort((a, b) => a.path.localeCompare(b.path));

  fs.writeFileSync(LAYOUT_PATH, JSON.stringify({ content }, null, 2) + '\n');

  // Update total_package_size (sum of listed file sizes), 20-digit zero-padded.
  const total = content.reduce((sum, f) => sum + f.size, 0);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  manifest.total_package_size = String(total).padStart(20, '0');
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 4) + '\n');

  console.log(`layout.json written: ${content.length} files, ${total} bytes total`);
  for (const f of content) console.log(`  ${f.path} (${f.size} B)`);
}

main();
