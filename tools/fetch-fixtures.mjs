#!/usr/bin/env node
/**
 * Pull reference state vectors from the public JPL Horizons API and write them
 * to tests/fixtures/horizons.json.
 *
 * These are the ground truth the ephemeris tests measure against: any typo in
 * an element table shows up immediately as a direction error. The result is
 * committed so the test suite runs offline; rerun this only to add epochs.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'tests', 'fixtures', 'horizons.json');

const EPOCHS = ['2026-01-01', '2026-07-29', '2027-06-01'];

/** Horizons target id + the centre its vectors should be measured from. */
const TARGETS = [
  { id: 'mercury', command: '199', center: '500@10' },
  { id: 'venus', command: '299', center: '500@10' },
  { id: 'earth', command: '399', center: '500@10' },
  { id: 'mars', command: '499', center: '500@10' },
  { id: 'jupiter', command: '599', center: '500@10' },
  { id: 'saturn', command: '699', center: '500@10' },
  { id: 'uranus', command: '799', center: '500@10' },
  { id: 'neptune', command: '899', center: '500@10' },
  { id: 'pluto', command: '999', center: '500@10' },
  { id: 'moon', command: '301', center: '500@399' },
  { id: 'io', command: '501', center: '500@599' },
  { id: 'europa', command: '502', center: '500@599' },
  { id: 'ganymede', command: '503', center: '500@599' },
  { id: 'callisto', command: '504', center: '500@599' },
  { id: 'titan', command: '606', center: '500@699' },
  { id: 'triton', command: '801', center: '500@899' },
];

const julianDate = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000 + 2440587.5;

const fetchVector = async (target, epoch) => {
  const jd = julianDate(epoch).toFixed(1);
  const params = new URLSearchParams({
    format: 'json',
    COMMAND: `'${target.command}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: `'${target.center}'`,
    REF_PLANE: 'ECLIPTIC',
    REF_SYSTEM: 'ICRF',
    TLIST: jd,
    TLIST_TYPE: 'JD',
    TIME_TYPE: 'TDB',
    OUT_UNITS: 'KM-S',
    VEC_TABLE: '2',
    CSV_FORMAT: 'YES',
  });
  const url = `https://ssd.jpl.nasa.gov/api/horizons.api?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${target.id} @ ${epoch}`);
  const body = await res.json();
  const text = body.result ?? '';
  const start = text.indexOf('$$SOE');
  const end = text.indexOf('$$EOE');
  if (start < 0 || end < 0) {
    throw new Error(`no ephemeris block for ${target.id} @ ${epoch}: ${text.slice(0, 300)}`);
  }
  const line = text
    .slice(start + 5, end)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) throw new Error(`empty ephemeris block for ${target.id} @ ${epoch}`);
  // CSV: JDTDB, calendar date, X, Y, Z, VX, VY, VZ
  const cols = line.split(',').map((c) => c.trim());
  const num = (i) => Number(cols[i]);
  return {
    // Convert km and km/s to metres and m/s.
    pos: [num(2) * 1000, num(3) * 1000, num(4) * 1000],
    vel: [num(5) * 1000, num(6) * 1000, num(7) * 1000],
  };
};

const main = async () => {
  const out = { generated: new Date().toISOString(), epochs: EPOCHS, data: {} };
  for (const epoch of EPOCHS) {
    out.data[epoch] = {};
    for (const target of TARGETS) {
      try {
        const vec = await fetchVector(target, epoch);
        out.data[epoch][target.id] = { ...vec, center: target.center };
        console.log(`ok   ${epoch} ${target.id}`);
      } catch (err) {
        console.error(`FAIL ${epoch} ${target.id}: ${err.message}`);
      }
      // Horizons asks for courtesy between requests.
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(out, null, 2)}\n`);
  const count = Object.values(out.data).reduce((n, e) => n + Object.keys(e).length, 0);
  console.log(`\nwrote ${OUT} (${count} vectors)`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
