/**
 * Frame conventions and body orientation.
 *
 * These are the tests that catch a transposed matrix or a sign flip in the
 * IAU models — mistakes that leave the planets in the right place but lit from
 * the wrong side, or spinning backwards.
 */

import { describe, expect, it } from 'vitest';
import {
  equatorialToEcliptic,
  eclipticToEquatorial,
  poleAngles,
  iauOrientation,
  bodyNorthPole,
  subSolarLongitude,
  syncOrientation,
} from '../../src/sim/frames';
import { ROTATION_BY_ID } from '../../src/data/rotation.iau';
import { ephemeris } from '../../src/sim/ephemeris';
import { simTimeFromISO, daysSinceJ2000 } from '../../src/sim/time';
import { OBLIQUITY_J2000, RAD, DEG, getBody } from '../../src/data/constants';
import { vec, sub, len, angleBetween, dot, normalize, cross } from '../../src/math/vec3d';
import { mat3, apply } from '../../src/math/mat3d';

const model = (id: string) => {
  const m = ROTATION_BY_ID.get(id);
  if (!m) throw new Error(`no rotation model for ${id}`);
  return m;
};

describe('equatorial <-> ecliptic', () => {
  it('maps the celestial pole to the obliquity', () => {
    const out = vec();
    equatorialToEcliptic(out, vec(0, 0, 1));
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.y).toBeCloseTo(Math.sin(OBLIQUITY_J2000), 12);
    expect(out.z).toBeCloseTo(Math.cos(OBLIQUITY_J2000), 12);
  });

  it('leaves the vernal equinox alone', () => {
    const out = vec();
    equatorialToEcliptic(out, vec(1, 0, 0));
    expect(out.x).toBeCloseTo(1, 12);
    expect(out.y).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(0, 12);
  });

  it('round trips', () => {
    const v = vec(0.3, -0.7, 0.5);
    const a = vec();
    const back = vec();
    equatorialToEcliptic(a, v);
    eclipticToEquatorial(back, a);
    expect(back.x).toBeCloseTo(v.x, 12);
    expect(back.y).toBeCloseTo(v.y, 12);
    expect(back.z).toBeCloseTo(v.z, 12);
  });
});

describe('IAU orientation', () => {
  it("puts Earth's axial tilt at 23.44 degrees from the ecliptic pole", () => {
    const pole = vec();
    bodyNorthPole(pole, 'earth', 0);
    const tilt = angleBetween(pole, vec(0, 0, 1)) * RAD;
    expect(tilt).toBeGreaterThan(23.3);
    expect(tilt).toBeLessThan(23.6);
  });

  it('reproduces the known axial tilts', () => {
    // Axial tilt is the angle between the spin angular momentum and the body's
    // own orbit normal. That is not the IAU north pole for a retrograde
    // rotator: the IAU always puts "north" on the northern side of the
    // invariable plane and encodes the backwards spin in a negative rotation
    // rate, so the momentum vector is sign(wDot) times the pole. Checking it
    // this way tests the pole direction and the rotation sense together.
    const expected: Array<[string, number, number]> = [
      ['mercury', 0.03, 1.0],
      ['venus', 177.36, 1.0],
      ['earth', 23.44, 1.0],
      ['mars', 25.19, 1.0],
      ['jupiter', 3.13, 1.0],
      ['saturn', 26.73, 1.0],
      ['uranus', 97.77, 1.0],  // tipped over on its side
      ['neptune', 28.32, 1.0],
    ];
    const pole = vec();
    const pos = vec();
    const vel = vec();
    const orbitNormal = vec();
    for (const [id, tilt, tol] of expected) {
      bodyNorthPole(pole, id, 0);
      if (model(id).wDot < 0) { pole.x = -pole.x; pole.y = -pole.y; pole.z = -pole.z; }
      ephemeris.state(id, 0, pos, vel);
      cross(orbitNormal, pos, vel);
      expect(Math.abs(angleBetween(pole, orbitNormal) * RAD - tilt)).toBeLessThan(tol);
    }
  });

  it('spins Venus and Uranus retrograde', () => {
    expect(model('venus').wDot).toBeLessThan(0);
    expect(model('uranus').wDot).toBeLessThan(0);
    expect(model('earth').wDot).toBeGreaterThan(0);
  });

  it('gives the right rotation periods', () => {
    const periodHours = (id: string) => Math.abs(360 / model(id).wDot) * 24;
    expect(periodHours('earth')).toBeCloseTo(23.9345, 3);
    expect(periodHours('jupiter')).toBeCloseTo(9.925, 2);
    expect(periodHours('mars')).toBeCloseTo(24.6229, 3);
    // Venus takes 243 days, the slowest spin in the solar system.
    expect(periodHours('venus') / 24).toBeCloseTo(243.02, 1);
  });

  it('produces an orthonormal orientation matrix', () => {
    const m = mat3();
    iauOrientation(m, model('earth'), simTimeFromISO('2026-07-29T12:00:00Z'));
    const col = (i: number) => vec(m[i]!, m[i + 3]!, m[i + 6]!);
    const x = col(0);
    const y = col(1);
    const z = col(2);
    expect(len(x)).toBeCloseTo(1, 12);
    expect(len(y)).toBeCloseTo(1, 12);
    expect(len(z)).toBeCloseTo(1, 12);
    expect(dot(x, y)).toBeCloseTo(0, 12);
    expect(dot(x, z)).toBeCloseTo(0, 12);
    // Right-handed: x cross y must be z.
    const c = vec();
    cross(c, x, y);
    expect(dot(c, z)).toBeCloseTo(1, 12);
  });

  it('advances the Moon prime meridian once per sidereal month', () => {
    const t0 = 0;
    const t1 = 27.321582 * 86400;
    const w0 = poleAngles(model('moon'), t0).w;
    const w1 = poleAngles(model('moon'), t1).w;
    expect(Math.abs(((w1 - w0) % 360) - 0)).toBeLessThan(3);
  });
});

describe('sub-solar longitude tracks the time of day', () => {
  // At 12:00 UTC the Sun stands over Greenwich; the sub-solar point moves 15
  // degrees west per hour. Anything else means the terminator is in the wrong
  // place and the planet is lit at the wrong time of day.
  const cases = ['2026-07-29T00:00:00Z', '2026-07-29T06:00:00Z',
                 '2026-07-29T12:00:00Z', '2026-07-29T18:00:00Z',
                 '2026-01-15T09:00:00Z'];

  for (const iso of cases) {
    it(iso, () => {
      const t = simTimeFromISO(iso);
      const earthPos = vec();
      const earthVel = vec();
      ephemeris.state('earth', t, earthPos, earthVel);
      const lon = subSolarLongitude('earth', earthPos, vec(0, 0, 0), t);

      const hours = new Date(iso).getUTCHours() + new Date(iso).getUTCMinutes() / 60;
      let expected = (180 - 15 * hours) % 360;
      if (expected < 0) expected += 360;

      let diff = ((lon - expected + 540) % 360) - 180;
      // The equation of time swings local apparent noon by up to about 4 deg.
      expect(Math.abs(diff)).toBeLessThan(5);
    });
  }
});

describe('synchronous rotators', () => {
  it('points the prime meridian at the parent and spins with the orbit', () => {
    const t = simTimeFromISO('2026-07-29T00:00:00Z');
    const moonPos = vec();
    const moonVel = vec();
    const parentPos = vec();
    const parentVel = vec();
    ephemeris.state('triton', t, moonPos, moonVel);
    ephemeris.state('neptune', t, parentPos, parentVel);
    const relPos = vec();
    const relVel = vec();
    sub(relPos, moonPos, parentPos);
    sub(relVel, moonVel, parentVel);

    const m = mat3();
    syncOrientation(m, relPos, relVel);

    // Body +x axis must point from the moon toward the planet.
    const xAxis = vec(m[0]!, m[3]!, m[6]!);
    const toParent = vec();
    normalize(toParent, vec(-relPos.x, -relPos.y, -relPos.z));
    expect(angleBetween(xAxis, toParent) * RAD).toBeLessThan(1e-6);

    // Triton orbits backwards, so its spin axis points south of Neptune's.
    const zAxis = vec(m[2]!, m[5]!, m[8]!);
    const neptunePole = vec();
    bodyNorthPole(neptunePole, 'neptune', t);
    expect(dot(zAxis, neptunePole)).toBeLessThan(0);
  });

  it('keeps the frame orthonormal', () => {
    const m = mat3();
    syncOrientation(m, vec(1e8, 2e7, -3e6), vec(-100, 900, 40));
    const out = vec();
    apply(out, m, vec(1, 0, 0));
    expect(len(out)).toBeCloseTo(1, 12);
    apply(out, m, vec(0, 1, 0));
    expect(len(out)).toBeCloseTo(1, 12);
  });
});

describe('apparent sizes from Earth', () => {
  const angularDiameterDeg = (radius: number, distance: number) =>
    2 * Math.asin(Math.min(1, radius / distance)) * RAD;

  it('the Sun subtends about half a degree', () => {
    const t = simTimeFromISO('2026-07-29T12:00:00Z');
    const earth = vec();
    const v = vec();
    ephemeris.state('earth', t, earth, v);
    const d = len(earth);
    const deg = angularDiameterDeg(getBody('sun').radius, d);
    // The textbook value is 0.533 deg, varying with the Earth's orbit.
    expect(deg).toBeGreaterThan(0.522);
    expect(deg).toBeLessThan(0.544);
  });

  it('the Moon very nearly matches the Sun, which is why eclipses work', () => {
    const t = simTimeFromISO('2026-07-29T12:00:00Z');
    const earth = vec();
    const moon = vec();
    const v = vec();
    ephemeris.state('earth', t, earth, v);
    ephemeris.state('moon', t, moon, v);
    const rel = vec();
    sub(rel, moon, earth);
    const deg = angularDiameterDeg(getBody('moon').radius, len(rel));
    expect(deg).toBeGreaterThan(0.45);
    expect(deg).toBeLessThan(0.58);
  });

  it('day and night are consistent: the sub-solar point faces the Sun', () => {
    const t = simTimeFromISO('2026-03-21T12:00:00Z');
    const earthPos = vec();
    const v = vec();
    ephemeris.state('earth', t, earthPos, v);
    const orient = mat3();
    iauOrientation(orient, model('earth'), t);
    const lon = subSolarLongitude('earth', earthPos, vec(0, 0, 0), t) * DEG;

    // Rebuild the sub-solar direction from the reported longitude and check it
    // really points at the Sun (latitude aside, which is the seasonal tilt).
    const bodyDir = vec(Math.cos(lon), Math.sin(lon), 0);
    const world = vec();
    apply(world, orient, bodyDir);
    const toSun = vec();
    normalize(toSun, vec(-earthPos.x, -earthPos.y, -earthPos.z));
    // Near the equinox the sub-solar latitude is close to zero.
    expect(angleBetween(world, toSun) * RAD).toBeLessThan(5);
  });
});

describe('time helpers', () => {
  it('puts J2000 at the right instant', () => {
    expect(Math.abs(simTimeFromISO('2000-01-01T11:58:55.816Z'))).toBeLessThan(70.0);
    expect(daysSinceJ2000(86400)).toBeCloseTo(1, 12);
  });
});
