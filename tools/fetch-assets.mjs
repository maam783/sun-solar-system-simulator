#!/usr/bin/env node
/**
 * Download surface textures and build the star catalogue.
 *
 * Nothing here is required to run the simulator: every body has a procedural
 * fallback surface, and a failed download is a warning, not an error. Run it
 * once after cloning to get the photographic maps.
 *
 *   node tools/fetch-assets.mjs
 *
 * Textures: Solar System Scope (CC BY 4.0), derived from NASA imagery.
 * Stars: the HYG database (astronexus), itself derived from Hipparcos,
 * Yale Bright Star and Gliese. Both are credited in public/assets/ATTRIBUTION.md.
 */

import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TEXTURE_DIR = join(ROOT, 'public', 'assets', 'textures');
const STARS_OUT = join(ROOT, 'src', 'data', 'stars.ts');

const SSS = 'https://www.solarsystemscope.com/textures/download';

/** local name -> candidate URLs, tried in order */
const TEXTURES = {
  'sun.jpg': [`${SSS}/2k_sun.jpg`],
  'mercury.jpg': [`${SSS}/2k_mercury.jpg`],
  'venus.jpg': [`${SSS}/2k_venus_atmosphere.jpg`],
  'earth.jpg': [`${SSS}/2k_earth_daymap.jpg`],
  'earth_night.jpg': [`${SSS}/2k_earth_nightmap.jpg`],
  'moon.jpg': [`${SSS}/2k_moon.jpg`],
  // Close-approach maps: four times the linear detail, loaded after the small
  // ones so a first frame never waits on twenty-four megabytes.
  'moon_hi.jpg': [`${SSS}/8k_moon.jpg`],
  'earth_hi.jpg': [`${SSS}/8k_earth_daymap.jpg`],
  'mars_hi.jpg': [`${SSS}/8k_mars.jpg`],
  'earth_night_hi.jpg': [`${SSS}/8k_earth_nightmap.jpg`],
  'jupiter_hi.jpg': [`${SSS}/8k_jupiter.jpg`, `${SSS}/4k_jupiter.jpg`],
  'mars.jpg': [`${SSS}/2k_mars.jpg`],
  'jupiter.jpg': [`${SSS}/2k_jupiter.jpg`],
  'saturn.jpg': [`${SSS}/2k_saturn.jpg`],
  'saturn_ring.png': [`${SSS}/2k_saturn_ring_alpha.png`],
  'uranus.jpg': [`${SSS}/2k_uranus.jpg`],
  'neptune.jpg': [`${SSS}/2k_neptune.jpg`],
};

const HYG_URLS = [
  'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv',
  'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v40.csv.gz',
  'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/v3/hyg_v38.csv.gz',
];

/** Faintest star to include. 6.5 is roughly the naked-eye limit. */
const MAG_LIMIT = 6.5;

const downloadTextures = async () => {
  await mkdir(TEXTURE_DIR, { recursive: true });
  let ok = 0;
  let failed = 0;

  for (const [name, urls] of Object.entries(TEXTURES)) {
    const target = join(TEXTURE_DIR, name);
    try {
      const existing = await stat(target);
      if (existing.size > 1000) {
        console.log(`skip ${name} (already present)`);
        ok++;
        continue;
      }
    } catch {
      // not present yet
    }

    let saved = false;
    for (const url of urls) {
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'sun-sim/1.0' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length < 1000) throw new Error('suspiciously small');
        await writeFile(target, buffer);
        console.log(`ok   ${name} (${(buffer.length / 1024).toFixed(0)} KB)`);
        saved = true;
        ok++;
        break;
      } catch (err) {
        console.warn(`      ${url} -> ${err.message}`);
      }
    }
    if (!saved) {
      failed++;
      console.warn(`WARN ${name}: no source worked; the procedural surface will be used`);
    }
  }
  return { ok, failed };
};

const buildStars = async () => {
  let csv = null;
  for (const url of HYG_URLS) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'sun-sim/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (url.endsWith('.gz')) {
        const raw = Buffer.from(await res.arrayBuffer());
        csv = gunzipSync(raw).toString('utf8');
      } else {
        csv = await res.text();
      }
      console.log(`ok   star catalogue from ${url} (${(csv.length / 1e6).toFixed(1)} MB)`);
      break;
    } catch (err) {
      console.warn(`      ${url} -> ${err.message}`);
    }
  }
  if (!csv) {
    console.warn('WARN star catalogue unavailable; leaving src/data/stars.ts as it is');
    return 0;
  }

  // Minimal quote-aware CSV splitter: star names and spectral types contain
  // commas, so a plain split would shift every column after them.
  const splitRow = (line) => {
    const out = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === '"') {
          if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { out.push(field); field = ''; }
      else field += c;
    }
    out.push(field);
    return out;
  };

  const lines = csv.split('\n');
  const header = splitRow(lines[0]).map((h) => h.trim());
  const iRa = header.indexOf('rarad');
  const iDec = header.indexOf('decrad');
  const iMag = header.indexOf('mag');
  const iCi = header.indexOf('ci');
  if (iRa < 0 || iDec < 0 || iMag < 0) {
    throw new Error(`unexpected HYG columns: ${header.slice(0, 8).join(',')}`);
  }

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = splitRow(line);
    const mag = Number(cols[iMag]);
    if (!Number.isFinite(mag) || mag > MAG_LIMIT) continue;
    // The catalogue carries radians directly, which avoids a unit mistake.
    const ra = Number(cols[iRa]);
    const dec = Number(cols[iDec]);
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;
    // Row 0 of HYG is the Sun itself. Skip it: it is already a simulated body.
    if (ra === 0 && dec === 0 && mag < -20) continue;
    const ci = Number(cols[iCi]);

    out.push(
      ra.toFixed(5),
      dec.toFixed(5),
      mag.toFixed(2),
      (Number.isFinite(ci) ? ci : 0.6).toFixed(2),
    );
  }

  const count = out.length / 4;
  // Wrap to keep the generated file readable in a diff.
  const rows = [];
  for (let i = 0; i < out.length; i += 24) rows.push(`  ${out.slice(i, i + 24).join(',')},`);

  const file = `/**
 * Real stars, from the HYG database (astronexus), cut at magnitude ${MAG_LIMIT}.
 *
 * GENERATED by tools/fetch-assets.mjs — do not edit by hand.
 *
 * Flat array, four numbers per star: right ascension (radians), declination
 * (radians), visual magnitude, B-V colour index. Equatorial J2000; the
 * renderer rotates them into the ecliptic frame at load.
 *
 * ${count} stars — the naked-eye sky, so the constellations out of the window
 * are the real ones seen from the real position.
 */

export const STARS: readonly number[] = [
${rows.join('\n')}
];

export const STAR_COUNT = ${count};
`;

  await writeFile(STARS_OUT, file);
  console.log(`ok   wrote ${STARS_OUT} (${count} stars)`);
  return count;
};

const writeAttribution = async () => {
  const text = `# Asset attribution

## Planet and moon textures
Solar System Scope — https://www.solarsystemscope.com/textures/
Licensed CC BY 4.0. Derived from NASA imagery (public domain).

## Star catalogue
HYG Database — https://github.com/astronexus/HYG-Database
Compiled from the Hipparcos catalogue, the Yale Bright Star Catalogue and the
Gliese Catalogue of Nearby Stars. Licensed CC BY-SA 4.0.

## Ephemeris reference data
JPL Horizons — https://ssd.jpl.nasa.gov/horizons/
Used to validate the orbital elements. Public domain (NASA/JPL-Caltech).
`;
  await mkdir(join(ROOT, 'public', 'assets'), { recursive: true });
  await writeFile(join(ROOT, 'public', 'assets', 'ATTRIBUTION.md'), text);
};

const main = async () => {
  console.log('--- textures ---');
  const textures = await downloadTextures();
  console.log('\n--- stars ---');
  const stars = await buildStars();
  await writeAttribution();
  console.log(`\ntextures: ${textures.ok} ok, ${textures.failed} missing (procedural fallback)`);
  console.log(`stars: ${stars}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
