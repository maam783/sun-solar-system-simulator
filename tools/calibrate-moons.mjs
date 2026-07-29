#!/usr/bin/env node
/**
 * Derive mean orbital elements for the simulated moons directly from JPL
 * Horizons, and write src/data/elements.moons.ts.
 *
 * Hand-copied satellite elements are referred to a variety of reference
 * directions and epochs, which is how a moon ends up 90 degrees around its
 * orbit from where it really is. Instead of transcribing them, this samples
 * one full orbital period of real ephemeris per moon, converts each state into
 * osculating elements in the parent's equatorial frame, and averages: short
 * period wobbles cancel and what is left are mean elements in exactly the
 * frame the simulator propagates them in.
 *
 * Run with:  npx vite-node tools/calibrate-moons.mjs
 */

import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentEquatorMatrix } from '../src/sim/frames.ts';
import { stateToElements } from '../src/sim/kepler.ts';
import { getBody, RAD, DEG } from '../src/data/constants.ts';
import { vec } from '../src/math/vec3d.ts';
import { transpose, mat3, apply } from '../src/math/mat3d.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'src', 'data', 'elements.moons.ts');

/** Reference epoch for the generated elements: close to when flights start. */
const REF_ISO = '2026-07-29';
const REF_JD = Date.parse(`${REF_ISO}T00:00:00Z`) / 86400000 + 2440587.5;
const REF_T = (REF_JD - 2451545.0) * 86400;

const MOONS = [
  { id: 'phobos', parent: 'mars', command: '401', center: '500@499', periodDays: 0.31891023 },
  { id: 'deimos', parent: 'mars', command: '402', center: '500@499', periodDays: 1.2624407 },
  { id: 'io', parent: 'jupiter', command: '501', center: '500@599', periodDays: 1.7691378 },
  { id: 'europa', parent: 'jupiter', command: '502', center: '500@599', periodDays: 3.5511810 },
  { id: 'ganymede', parent: 'jupiter', command: '503', center: '500@599', periodDays: 7.1545530 },
  { id: 'callisto', parent: 'jupiter', command: '504', center: '500@599', periodDays: 16.6890180 },
  { id: 'mimas', parent: 'saturn', command: '601', center: '500@699', periodDays: 0.9424218 },
  { id: 'enceladus', parent: 'saturn', command: '602', center: '500@699', periodDays: 1.3702180 },
  { id: 'rhea', parent: 'saturn', command: '605', center: '500@699', periodDays: 4.5175000 },
  { id: 'titan', parent: 'saturn', command: '606', center: '500@699', periodDays: 15.9454210 },
  { id: 'iapetus', parent: 'saturn', command: '608', center: '500@699', periodDays: 79.3301830 },
  { id: 'titania', parent: 'uranus', command: '703', center: '500@799', periodDays: 8.7058717 },
  { id: 'oberon', parent: 'uranus', command: '704', center: '500@799', periodDays: 13.4632389 },
  { id: 'triton', parent: 'neptune', command: '801', center: '500@899', periodDays: 5.8768540 },
  { id: 'charon', parent: 'pluto', command: '901', center: '500@999', periodDays: 6.3872304 },
];

const SAMPLES = 24;

const fetchArc = async (moon) => {
  const half = moon.periodDays / 2;
  const params = new URLSearchParams({
    format: 'json',
    COMMAND: `'${moon.command}'`,
    OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER: `'${moon.center}'`,
    REF_PLANE: 'ECLIPTIC',
    REF_SYSTEM: 'ICRF',
    START_TIME: `'JD${(REF_JD - half).toFixed(6)}'`,
    STOP_TIME: `'JD${(REF_JD + half).toFixed(6)}'`,
    STEP_SIZE: `'${SAMPLES}'`,
    OUT_UNITS: 'KM-S',
    VEC_TABLE: '2',
    CSV_FORMAT: 'YES',
  });
  const res = await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${params}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = (await res.json()).result ?? '';
  const s = text.indexOf('$$SOE');
  const e = text.indexOf('$$EOE');
  if (s < 0 || e < 0) throw new Error(text.slice(0, 400));
  return text.slice(s + 5, e).split('\n')
    .map((l) => l.trim()).filter(Boolean)
    .map((line) => {
      const c = line.split(',').map((x) => x.trim());
      return {
        t: (Number(c[0]) - 2451545.0) * 86400,
        pos: vec(Number(c[2]) * 1000, Number(c[3]) * 1000, Number(c[4]) * 1000),
        vel: vec(Number(c[5]) * 1000, Number(c[6]) * 1000, Number(c[7]) * 1000),
      };
    });
};

const circularMean = (angles) => {
  let s = 0;
  let c = 0;
  for (const a of angles) { s += Math.sin(a); c += Math.cos(a); }
  const m = Math.atan2(s / angles.length, c / angles.length);
  return m < 0 ? m + 2 * Math.PI : m;
};

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const invEq = mat3();
const tmp = vec();
const tmp2 = vec();

const calibrate = async (moon) => {
  const arc = await fetchArc(moon);
  if (arc.length < 4) throw new Error(`only ${arc.length} samples`);
  // A relative two-body orbit is governed by the sum of the masses. It only
  // matters for Charon, which is 12 percent of Pluto - ignoring it there put
  // the semi-major axis out by 3000 km.
  const mu = getBody(moon.parent).mu + getBody(moon.id).mu;
  const n = (2 * Math.PI) / (moon.periodDays * 86400);

  const as = []; const es = []; const is = [];
  const nodes = []; const lonPeris = []; const meanLons = [];

  for (const s of arc) {
    // Ecliptic -> parent equatorial frame (transpose of a rotation inverts it).
    transpose(invEq, parentEquatorMatrix(moon.parent, s.t));
    apply(tmp, invEq, s.pos);
    apply(tmp2, invEq, s.vel);
    const el = stateToElements(tmp, tmp2, mu);
    as.push(el.a);
    es.push(el.e);
    is.push(el.i);
    nodes.push(el.lonNode);
    lonPeris.push(el.lonNode + el.argPeri);
    // Reduce every sample's mean longitude to the reference epoch.
    meanLons.push(el.lonNode + el.argPeri + el.meanAnomaly - n * (s.t - REF_T));
  }

  return {
    id: moon.id,
    parent: moon.parent,
    a: mean(as),
    e: mean(es),
    i: mean(is) * RAD,
    periodDays: moon.periodDays,
    L: circularMean(meanLons) * RAD,
    lonPeri: circularMean(lonPeris) * RAD,
    lonNode: circularMean(nodes) * RAD,
    spread: {
      a: (Math.max(...as) - Math.min(...as)) / mean(as),
      e: Math.max(...es) - Math.min(...es),
      i: (Math.max(...is) - Math.min(...is)) * RAD,
    },
  };
};

const num = (x, digits) => {
  const s = x.toFixed(digits);
  return s.replace(/\.?0+$/, '') || '0';
};

const main = async () => {
  const results = [];
  for (const moon of MOONS) {
    try {
      const el = await calibrate(moon);
      results.push(el);
      console.log(
        `${el.id.padEnd(10)} a=${(el.a / 1000).toFixed(1).padStart(10)} km  e=${el.e.toFixed(5)}  ` +
        `i=${el.i.toFixed(3).padStart(8)}  L=${el.L.toFixed(3).padStart(8)}  ` +
        `spread a=${(el.spread.a * 100).toFixed(2)}% i=${el.spread.i.toFixed(3)}deg`,
      );
    } catch (err) {
      console.error(`FAIL ${moon.id}: ${err.message}`);
      process.exitCode = 1;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (results.length !== MOONS.length) {
    console.error('\nnot all moons calibrated; file not written');
    return;
  }

  const rows = results.map((el) => `  {
    id: '${el.id}', parent: '${el.parent}',
    a: ${num(el.a, 1)}, e: ${num(el.e, 7)}, i: ${num(el.i, 5)}, periodDays: ${el.periodDays},
    L: ${num(el.L, 4)}, lonPeri: ${num(el.lonPeri, 4)}, lonNode: ${num(el.lonNode, 4)},
  },`).join('\n');

  const file = `/**
 * Mean Keplerian elements for the simulated moons, referred to each parent
 * planet's equatorial plane at the epoch below.
 *
 * GENERATED by tools/calibrate-moons.mjs — do not edit by hand. Each row is
 * the average of osculating elements over one full orbital period of JPL
 * Horizons ephemeris, so the short-period wobbles cancel and the phase along
 * the orbit matches the real sky at the epoch.
 *
 * Earth's Moon is not in this table: solar perturbations are far too large for
 * a fixed ellipse, so ephemeris.ts propagates it with a truncated lunar series
 * instead.
 *
 * Deliberate approximations, all invisible at flight scale:
 *  - Node and apsidal precession from planetary oblateness are ignored, so the
 *    orbit's orientation slowly drifts away from reality over decades. The
 *    orbit's size, plane and period stay right.
 *  - Inner satellites' Laplace planes are treated as the parent's equator.
 *  - Mean motion comes from the tabulated sidereal period rather than mu/a^3.
 *
 * Reference epoch: ${REF_ISO}T00:00:00 TDB (t = ${REF_T.toFixed(0)} s past J2000).
 */

/** Seconds past J2000 at which the elements below are given. */
export const MOON_ELEMENTS_EPOCH = ${REF_T.toFixed(0)};

export interface MoonElements {
  id: string;
  parent: string;
  /** semi-major axis, m */
  a: number;
  /** eccentricity */
  e: number;
  /** inclination to the parent's equator, degrees (>90 means retrograde) */
  i: number;
  /** sidereal orbital period, days */
  periodDays: number;
  /** mean longitude at the epoch, degrees (= node + argPeri + meanAnomaly) */
  L: number;
  /** longitude of periapsis at the epoch, degrees (= node + argPeri) */
  lonPeri: number;
  /** longitude of the ascending node on the parent's equator, degrees */
  lonNode: number;
}

export const MOON_ELEMENTS: readonly MoonElements[] = [
${rows}
];

export const MOON_ELEMENTS_BY_ID: ReadonlyMap<string, MoonElements> = new Map(
  MOON_ELEMENTS.map((el) => [el.id, el]),
);
`;

  await writeFile(OUT, file);
  console.log(`\nwrote ${OUT}`);
  // DEG is imported for symmetry with the runtime code; reference it so the
  // linter in strict mode does not flag the import.
  void DEG;
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
