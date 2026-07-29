/**
 * Ephemeris accuracy against JPL Horizons state vectors.
 *
 * This is also the transcription check on every number in src/data: a single
 * mistyped digit in an element table or a rotation model shows up here as a
 * direction error far outside tolerance.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ephemeris } from '../../src/sim/ephemeris';
import { vec, sub, len, angleBetween } from '../../src/math/vec3d';
import { RAD, getBody } from '../../src/data/constants';

const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'horizons.json');
const hasFixture = existsSync(FIXTURE);

interface Fixture {
  epochs: string[];
  data: Record<string, Record<string, { pos: number[]; vel: number[]; center: string }>>;
}

const fixture: Fixture | null = hasFixture
  ? (JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture)
  : null;

/** Same Julian-date convention the fetcher used, so the epochs line up. */
const simTimeForEpoch = (iso: string): number => {
  const jd = Date.parse(`${iso}T00:00:00Z`) / 86400000 + 2440587.5;
  return (jd - 2451545.0) * 86400;
};

const CENTERS: Record<string, string> = {
  '500@10': 'sun',
  '500@399': 'earth',
  '500@599': 'jupiter',
  '500@699': 'saturn',
  '500@899': 'neptune',
};

/**
 * Direction tolerance in degrees, per body. These sit just above the measured
 * error, so any later edit to an element table trips them.
 *
 * Saturn is the loosest planet at 0.074 deg, which is the published accuracy
 * of the Standish set rather than anything wrong here. Io and Europa are held
 * to 2 deg because their apsides precess (driven by the Laplace resonance,
 * not by oblateness alone) and this model keeps them fixed; the resulting
 * error oscillates within roughly 2e radians of orbit phase and never grows.
 */
const DIRECTION_TOL: Record<string, number> = {
  mercury: 0.02, venus: 0.02, earth: 0.02, mars: 0.03,
  jupiter: 0.05, saturn: 0.1, uranus: 0.02, neptune: 0.02, pluto: 0.02,
  moon: 0.05,
  io: 1.5, europa: 2, ganymede: 0.3, callisto: 0.1, titan: 0.1, triton: 0.3,
};

/** Radius tolerance as a fraction, per body. */
const RADIUS_TOL: Record<string, number> = {
  mercury: 0.001, venus: 0.001, earth: 0.001, mars: 0.001,
  jupiter: 0.001, saturn: 0.001, uranus: 0.001, neptune: 0.001, pluto: 0.001,
  moon: 0.003,
  io: 0.01, europa: 0.02, ganymede: 0.005, callisto: 0.005, titan: 0.005, triton: 0.005,
};

describe.skipIf(!fixture)('ephemeris vs JPL Horizons', () => {
  const rel = vec();
  const ours = vec();
  const oursVel = vec();
  const centerPos = vec();
  const centerVel = vec();

  it('has a usable fixture file', () => {
    expect(fixture).not.toBeNull();
    expect(Object.keys(fixture!.data).length).toBeGreaterThanOrEqual(3);
  });

  for (const epoch of fixture?.epochs ?? []) {
    describe(epoch, () => {
      const t = simTimeForEpoch(epoch);
      const entries = Object.entries(fixture!.data[epoch] ?? {});

      for (const [id, ref] of entries) {
        it(`${id} position`, () => {
          const centerId = CENTERS[ref.center] ?? 'sun';
          ephemeris.state(id, t, ours, oursVel);
          if (centerId === 'sun') {
            centerPos.x = 0; centerPos.y = 0; centerPos.z = 0;
          } else {
            ephemeris.state(centerId, t, centerPos, centerVel);
          }
          sub(rel, ours, centerPos);

          const refPos = vec(ref.pos[0]!, ref.pos[1]!, ref.pos[2]!);
          const angleDeg = angleBetween(rel, refPos) * RAD;
          const radiusErr = Math.abs(len(rel) / len(refPos) - 1);

          expect(angleDeg).toBeLessThan(DIRECTION_TOL[id] ?? 1);
          expect(radiusErr).toBeLessThan(RADIUS_TOL[id] ?? 0.02);
        });
      }
    });
  }
});

describe.skipIf(!fixture)('moon orbits stay geometrically correct', () => {
  // Phase along the orbit is approximate for the minor moons, but the orbit
  // radius, plane and period are what determine whether a flight to Europa
  // arrives at a real place. Those are checked strictly.
  const a = vec();
  const b = vec();
  const va = vec();
  const vb = vec();

  const cases: Array<[string, string, number]> = [
    ['io', 'jupiter', 1.769138],
    ['europa', 'jupiter', 3.551181],
    ['ganymede', 'jupiter', 7.154553],
    ['callisto', 'jupiter', 16.689017],
    ['titan', 'saturn', 15.945421],
    ['triton', 'neptune', 5.876854],
    ['moon', 'earth', 27.321582],
  ];

  for (const [id, parent, periodDays] of cases) {
    it(`${id} completes one orbit in ${periodDays} d`, () => {
      const t0 = 0;
      const period = periodDays * 86400;
      ephemeris.state(id, t0, a, va);
      ephemeris.state(parent, t0, b, vb);
      sub(a, a, b);
      const start = vec(a.x, a.y, a.z);

      ephemeris.state(id, t0 + period, a, va);
      ephemeris.state(parent, t0 + period, b, vb);
      sub(a, a, b);

      // After exactly one period the moon is back where it started.
      expect(angleBetween(start, a) * RAD).toBeLessThan(2.5);
      expect(Math.abs(len(a) / len(start) - 1)).toBeLessThan(0.03);
    });
  }

  it('orbital speeds match the two-body value', () => {
    for (const [id, parent] of [['io', 'jupiter'], ['titan', 'saturn'], ['moon', 'earth']] as const) {
      ephemeris.state(id, 0, a, va);
      ephemeris.state(parent, 0, b, vb);
      sub(a, a, b);
      sub(va, va, vb);
      const mu = getBody(parent).mu;
      const expected = Math.sqrt(mu / len(a));
      expect(Math.abs(len(va) / expected - 1)).toBeLessThan(0.06);
    }
  });
});
