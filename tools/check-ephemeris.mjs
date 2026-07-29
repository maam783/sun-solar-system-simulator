#!/usr/bin/env node
/**
 * Diagnostic: print the ephemeris error against every Horizons fixture.
 * Not part of the test suite; useful when tuning element tables.
 *
 * Run with: npx vite-node tools/check-ephemeris.mjs
 */
import { readFileSync } from 'node:fs';
import { ephemeris } from '../src/sim/ephemeris.ts';
import { vec, sub, len, angleBetween } from '../src/math/vec3d.ts';
import { RAD } from '../src/data/constants.ts';

const fixture = JSON.parse(readFileSync('tests/fixtures/horizons.json', 'utf8'));
const CENTERS = {
  '500@10': 'sun', '500@399': 'earth', '500@599': 'jupiter',
  '500@699': 'saturn', '500@899': 'neptune',
};
const simTime = (iso) => (Date.parse(`${iso}T00:00:00Z`) / 86400000 + 2440587.5 - 2451545.0) * 86400;

const ours = vec(), oursVel = vec(), cp = vec(), cv = vec(), rel = vec();
for (const epoch of fixture.epochs) {
  console.log(`\n=== ${epoch} ===`);
  for (const [id, ref] of Object.entries(fixture.data[epoch])) {
    const centerId = CENTERS[ref.center] ?? 'sun';
    ephemeris.state(id, simTime(epoch), ours, oursVel);
    if (centerId === 'sun') { cp.x = 0; cp.y = 0; cp.z = 0; }
    else ephemeris.state(centerId, simTime(epoch), cp, cv);
    sub(rel, ours, cp);
    const refPos = vec(ref.pos[0], ref.pos[1], ref.pos[2]);
    const ang = angleBetween(rel, refPos) * RAD;
    const rerr = (len(rel) / len(refPos) - 1) * 100;
    console.log(`${id.padEnd(10)} dir ${ang.toFixed(4).padStart(9)} deg   r ${rerr.toFixed(4).padStart(9)} %`);
  }
}
