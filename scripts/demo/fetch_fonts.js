// Build-time only. Pulls woff2 subsets of the Noto Sans families from Google
// Fonts and self-hosts them so a surface renders OFFLINE (clinic wifi, network
// disconnected). NOT shipped runtime code — run once, commit the woff2 + css.
//
//   node scripts/demo/fetch_fonts.js
//     → public/demo/fonts/, Telugu + Devanagari. Exactly the DEMO-01 behaviour;
//       the default path is unchanged so an argument-less run is a no-op rerun.
//
//   node scripts/demo/fetch_fonts.js public/portal/fonts latin telugu devanagari
//     → the portal, which needs Latin as well: spec §2.2 puts all three scripts
//       in ONE family so a trilingual card sets on one baseline grid.
//
// Latin is fetched as the `latin` subset only, not `latin-ext`. Google serves
// those as separate files; latin-ext would double the face count for codepoints
// this product does not currently set.
//
// The `rupee` family is the exception to "one entry, one subset" — see F-V001
// and the CATALOGUE comment below.
'use strict';

const fs = require('fs');
const path = require('path');

const DEMO_DIR = path.join(__dirname, '..', '..', 'public', 'demo', 'fonts');
const OUT_DIR = process.argv[2] ? path.resolve(process.argv[2]) : DEMO_DIR;
// A modern Chrome UA makes Google Fonts serve woff2 (vs ttf for old UAs).
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CATALOGUE = {
  // Four weights for Latin (spec §2.2): no 300 — unreadable at 13px on a cheap
  // Android panel — and no 800, which has no job in this system.
  latin: { css: 'Noto+Sans:wght@400;500;600;700', subset: 'latin', file: 'noto-latin' },
  telugu: { css: 'Noto+Sans+Telugu:wght@400;600;700', subset: 'telugu', file: 'noto-telugu' },
  devanagari: { css: 'Noto+Sans+Devanagari:wght@400;600;700', subset: 'devanagari', file: 'noto-devanagari' },
  // F-V001 — the rupee sign. U+20B9 is absent from Google's `latin` subset but
  // present in Noto Sans's `devanagari` one, so every ₹ in the product otherwise
  // renders from system-ui: Roboto on Android, SF on iOS, Segoe on Windows, each
  // at a different weight and baseline from the Noto digits beside it. Most
  // visible on the Verbatim panel, which sets prices at 19px/600 on an ink ground.
  //
  // Shipping Noto Sans's whole 120 KB devanagari subset for one glyph would also
  // shadow the Devanagari family for Hindi. So we take the glyph ALONE through
  // Google's `text=` subsetter — same family, weight-matched, ~830 bytes a face.
  // `subset: null` marks the text= path; Google emits no `/* subset */` comment
  // for those responses and declares `unicode-range: U+20b9` itself.
  rupee: { css: 'Noto+Sans:wght@400;500;600;700', text: '₹', subset: null, file: 'noto-rupee' },
};

const wanted = process.argv.slice(3);
const keys = wanted.length ? wanted : ['telugu', 'devanagari'];
for (const k of keys) {
  if (!CATALOGUE[k]) {
    console.error(`unknown family '${k}' — known: ${Object.keys(CATALOGUE).join(', ')}`);
    process.exit(1);
  }
}
const FAMILIES = keys.map((k) => CATALOGUE[k]);

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return res.text();
}

async function fetchBinary(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Google's CSS2 output is a run of `/* subset */\n@font-face { ... }` blocks.
// Parse each into { subset, weight, url, unicodeRange }.
function parseBlocks(css) {
  const blocks = [];
  const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*{([^}]*)}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const subset = m[1];
    const body = m[2];
    const weight = (body.match(/font-weight:\s*(\d+)/) || [])[1];
    const url = (body.match(/url\(([^)]+)\)/) || [])[1];
    const unicodeRange = (body.match(/unicode-range:\s*([^;]+);/) || [])[1];
    blocks.push({ subset, weight, url, unicodeRange });
  }
  return blocks;
}

// The `text=` path. One request PER WEIGHT on purpose: asking for all four at
// once makes Google serve a single VARIABLE file referenced by four @font-face
// rules, which is exactly the duplication F-V002 exists to remove. Per-weight
// requests return distinct static instances, matching the one-file-per-weight
// shape the other faces already have — so F-V002 can collapse them uniformly.
async function fetchTextBlocks(fam) {
  const weights = (fam.css.split('wght@')[1] || '400').split(';');
  const blocks = [];
  for (const weight of weights) {
    const family = fam.css.split(':')[0];
    const css = await fetchText(
      `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}` +
      `&text=${encodeURIComponent(fam.text)}&display=swap`
    );
    const url = (css.match(/url\(([^)]+)\)/) || [])[1];
    const unicodeRange = (css.match(/unicode-range:\s*([^;]+);/) || [])[1];
    if (!url) throw new Error(`no face for ${family} @${weight} text='${fam.text}'`);
    blocks.push({ subset: null, weight, url, unicodeRange });
  }
  return blocks;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const faces = [];

  for (const fam of FAMILIES) {
    let blocks;
    if (fam.text) {
      blocks = await fetchTextBlocks(fam);
    } else {
      const css = await fetchText(
        `https://fonts.googleapis.com/css2?family=${fam.css}&display=swap`
      );
      blocks = parseBlocks(css).filter((b) => b.subset === fam.subset);
    }
    if (blocks.length === 0) throw new Error(`no ${fam.subset} blocks for ${fam.css}`);

    for (const b of blocks) {
      const family = fam.css.split(':')[0].replace(/\+/g, ' ');
      const fileName = `${fam.file}-${b.weight}.woff2`;
      const bin = await fetchBinary(b.url);
      fs.writeFileSync(path.join(OUT_DIR, fileName), bin);
      console.log(`  ${fileName}  ${(bin.length / 1024).toFixed(1)} KB  (${b.unicodeRange ? 'ranged' : 'no-range'})`);
      faces.push({ family, weight: b.weight, fileName, unicodeRange: b.unicodeRange });
    }
  }

  const cssOut = faces
    .map(
      (f) =>
        `@font-face {\n` +
        `  font-family: '${f.family}';\n` +
        `  font-style: normal;\n` +
        `  font-weight: ${f.weight};\n` +
        `  font-display: swap;\n` +
        `  src: url('./${f.fileName}') format('woff2');\n` +
        (f.unicodeRange ? `  unicode-range: ${f.unicodeRange};\n` : '') +
        `}`
    )
    .join('\n');

  const header =
    `/* Self-hosted Noto Sans — ${keys.join(' + ')} subsets, ${faces.length} faces.\n` +
    ' * Generated by scripts/demo/fetch_fonts.js — self-hosted so the surface\n' +
    ' * renders offline; no CDN and no Google Fonts link at runtime.\n' +
    ' * Do not edit by hand; re-run the script to regenerate. */\n';

  fs.writeFileSync(path.join(OUT_DIR, 'fonts.css'), header + cssOut + '\n');
  console.log(`\nWrote ${faces.length} @font-face rules → ${path.join(OUT_DIR, 'fonts.css')}`);
}

main().catch((e) => {
  console.error('fetch_fonts failed:', e.message);
  process.exit(1);
});
