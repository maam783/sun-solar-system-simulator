import { describe, expect, it } from 'vitest';
import {
  solveKeplerElliptic,
  solveKeplerHyperbolic,
  elementsToState,
  stateToElements,
  wrapPi,
  wrapTwoPi,
  circularSpeed,
  visViva,
} from '../../src/sim/kepler';
import { vec, len } from '../../src/math/vec3d';
import { AU, getBody } from '../../src/data/constants';

const MU_SUN = getBody('sun').mu;
const MU_EARTH = getBody('earth').mu;

describe('angle wrapping', () => {
  it('wraps into the expected ranges', () => {
    expect(wrapPi(0)).toBeCloseTo(0, 12);
    expect(wrapPi(3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(wrapPi(-3 * Math.PI)).toBeCloseTo(-Math.PI, 12);
    expect(wrapTwoPi(-0.5)).toBeCloseTo(2 * Math.PI - 0.5, 12);
    expect(wrapTwoPi(7)).toBeCloseTo(7 - 2 * Math.PI, 12);
  });
});

describe('elliptic Kepler solver', () => {
  const eccentricities = [0, 1e-9, 0.1, 0.3, 0.7, 0.95, 0.9999];

  it('converges for every eccentricity below 1', () => {
    for (const e of eccentricities) {
      for (let k = 0; k <= 64; k++) {
        const M = -Math.PI + (2 * Math.PI * k) / 64;
        const { E, iterations, residual } = solveKeplerElliptic(M, e);
        expect(Number.isFinite(E)).toBe(true);
        expect(residual).toBeLessThan(1e-10);
        expect(iterations).toBeLessThanOrEqual(25);
      }
    }
  });

  it('handles unwrapped mean anomalies', () => {
    const a = solveKeplerElliptic(0.7, 0.4);
    const b = solveKeplerElliptic(0.7 + 8 * Math.PI, 0.4);
    expect(b.E).toBeCloseTo(a.E, 10);
  });

  it('is exact for a circular orbit', () => {
    const { E } = solveKeplerElliptic(1.234, 0);
    expect(E).toBeCloseTo(1.234, 12);
  });
});

describe('hyperbolic Kepler solver', () => {
  it('converges across eccentricities and anomalies', () => {
    for (const e of [1.05, 1.5, 5]) {
      for (const M of [-20, -3, -0.4, 0.4, 3, 20]) {
        const { E, residual } = solveKeplerHyperbolic(M, e);
        expect(Number.isFinite(E)).toBe(true);
        expect(residual).toBeLessThan(1e-9);
      }
    }
  });
});

describe('elements <-> state round trip', () => {
  it('recovers the elements it was built from', () => {
    const cases = [
      { a: AU, e: 0.0167, i: 0.02, lonNode: 0.5, argPeri: 1.8, meanAnomaly: 0.9 },
      { a: 5.2 * AU, e: 0.0484, i: 0.0228, lonNode: 1.75, argPeri: 4.6, meanAnomaly: -2.1 },
      { a: 6.771e6, e: 1e-9, i: 0.9, lonNode: 2.2, argPeri: 0.1, meanAnomaly: 3.0 },
      { a: 3.9e11, e: 0.6, i: 0.3, lonNode: 5.5, argPeri: 2.2, meanAnomaly: 1.1 },
    ];
    for (const el of cases) {
      const mu = el.a > 1e10 ? MU_SUN : MU_EARTH;
      const pos = vec();
      const velocity = vec();
      elementsToState(el, mu, pos, velocity);
      const back = stateToElements(pos, velocity, mu);
      expect(Math.abs(back.a / el.a - 1)).toBeLessThan(1e-9);
      expect(Math.abs(back.e - el.e)).toBeLessThan(1e-9);
      expect(Math.abs(back.i - el.i)).toBeLessThan(1e-9);
      if (el.e > 1e-6) {
        expect(Math.abs(wrapPi(back.meanAnomaly - el.meanAnomaly))).toBeLessThan(1e-8);
      }
    }
  });

  it('gives circular speed for a circular orbit', () => {
    const r = 6.771e6;
    const pos = vec();
    const velocity = vec();
    elementsToState(
      { a: r, e: 0, i: 0.5, lonNode: 1, argPeri: 0, meanAnomaly: 2 },
      MU_EARTH, pos, velocity,
    );
    expect(len(pos)).toBeCloseTo(r, 3);
    // 400 km circular LEO: the canonical 7.67 km/s.
    expect(len(velocity)).toBeCloseTo(circularSpeed(MU_EARTH, r), 6);
    expect(len(velocity)).toBeGreaterThan(7672);
    expect(len(velocity)).toBeLessThan(7674);
  });

  it('matches vis-viva along an eccentric orbit', () => {
    const a = 2 * AU;
    const e = 0.5;
    const pos = vec();
    const velocity = vec();
    for (const M of [0, 1, 2.5, 4, 5.7]) {
      elementsToState({ a, e, i: 0.1, lonNode: 0.3, argPeri: 1.2, meanAnomaly: M },
        MU_SUN, pos, velocity);
      expect(len(velocity)).toBeCloseTo(visViva(MU_SUN, len(pos), a), 2);
    }
  });

  it('reports a hyperbolic orbit as such', () => {
    // Escape speed times 1.5 at 1 AU gives a clearly hyperbolic orbit.
    const pos = vec(AU, 0, 0);
    const vEsc = Math.sqrt((2 * MU_SUN) / AU);
    const velocity = vec(0, 1.5 * vEsc, 0);
    const el = stateToElements(pos, velocity, MU_SUN);
    expect(el.e).toBeGreaterThan(1);
    expect(el.a).toBeLessThan(0);
    expect(el.apoapsis).toBe(Infinity);
  });
});
