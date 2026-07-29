/**
 * Kepler's equation and the conversion between orbital elements and state
 * vectors. Everything here is pure f64 arithmetic with no allocation in the
 * inner loops — the integrator calls these thousands of times per frame.
 */

import type { Vec3 } from '../math/vec3d';
import { set, cross, dot, len, lenSq, sub, scale, vec } from '../math/vec3d';
import { mat3, rotX, rotZ, mul, apply, type Mat3 } from '../math/mat3d';

const TWO_PI = Math.PI * 2;

/** Wrap an angle into [-pi, pi). */
export const wrapPi = (a: number): number => {
  let x = (a + Math.PI) % TWO_PI;
  if (x < 0) x += TWO_PI;
  return x - Math.PI;
};

/** Wrap an angle into [0, 2pi). */
export const wrapTwoPi = (a: number): number => {
  const x = a % TWO_PI;
  return x < 0 ? x + TWO_PI : x;
};

export interface KeplerResult {
  /** eccentric anomaly, radians */
  E: number;
  /** Newton iterations actually used */
  iterations: number;
  /** |E - e sinE - M| at the returned E */
  residual: number;
}

/**
 * Solve M = E - e*sinE for the eccentric anomaly.
 *
 * Newton-Raphson from a starting guess that stays in the basin of attraction
 * for every eccentricity below 1: the classic `M + e sinM` for mild orbits,
 * Danby's `M + 0.85 e sign(sinM)` once e passes 0.3, where the naive guess can
 * land on the wrong side of the steep part of the curve. If Newton somehow
 * fails to converge (only reachable at e extremely close to 1) the solver
 * falls back to bisection, which cannot fail because f is monotone in E.
 */
export const solveKeplerElliptic = (M: number, e: number, tol = 1e-12): KeplerResult => {
  const Mw = wrapPi(M);
  if (e < 1e-9) return { E: Mw, iterations: 0, residual: 0 };

  let E = e < 0.3 ? Mw + e * Math.sin(Mw) : Mw + 0.85 * e * Math.sign(Math.sin(Mw) || 1);

  for (let i = 1; i <= 25; i++) {
    const sinE = Math.sin(E);
    const f = E - e * sinE - Mw;
    const fp = 1 - e * Math.cos(E);
    // fp only vanishes as e -> 1 with E -> 0; clamp so the step stays finite.
    const step = f / (Math.abs(fp) < 1e-12 ? Math.sign(fp || 1) * 1e-12 : fp);
    E -= step;
    if (Math.abs(step) < tol) {
      return { E, iterations: i, residual: Math.abs(E - e * Math.sin(E) - Mw) };
    }
  }

  // Bisection fallback: E is bracketed by M-e and M+e for any e < 1.
  let lo = Mw - e;
  let hi = Mw + e;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (mid - e * Math.sin(mid) - Mw > 0) hi = mid;
    else lo = mid;
  }
  E = 0.5 * (lo + hi);
  return { E, iterations: 105, residual: Math.abs(E - e * Math.sin(E) - Mw) };
};

/**
 * Solve M = e*sinh(H) - H for hyperbolic orbits. Used for the osculating
 * readouts on escape trajectories and gravity assists, where e > 1.
 */
export const solveKeplerHyperbolic = (M: number, e: number, tol = 1e-12): KeplerResult => {
  if (M === 0) return { E: 0, iterations: 0, residual: 0 };
  const s = Math.sign(M);
  let H = s * Math.log((2 * Math.abs(M)) / e + 1.8);

  for (let i = 1; i <= 60; i++) {
    const f = e * Math.sinh(H) - H - M;
    const fp = e * Math.cosh(H) - 1;
    const step = f / (Math.abs(fp) < 1e-12 ? 1e-12 : fp);
    H -= step;
    if (Math.abs(step) < tol) {
      return { E: H, iterations: i, residual: Math.abs(e * Math.sinh(H) - H - M) };
    }
  }
  return { E: H, iterations: 60, residual: Math.abs(e * Math.sinh(H) - H - M) };
};

export interface OrbitElements {
  /** semi-major axis, m (negative for hyperbolic orbits) */
  a: number;
  e: number;
  /** inclination, radians */
  i: number;
  /** longitude of ascending node, radians */
  lonNode: number;
  /** argument of periapsis, radians */
  argPeri: number;
  /** mean anomaly at the requested epoch, radians */
  meanAnomaly: number;
}

const rotNode: Mat3 = mat3();
const rotInc: Mat3 = mat3();
const rotPeri: Mat3 = mat3();
const rotTmp: Mat3 = mat3();
const perifocalToFrame: Mat3 = mat3();
const scratchP = vec();

/**
 * Build the perifocal -> reference-frame rotation R = Rz(node) Rx(i) Rz(argPeri).
 * Exposed because moon orbits need it composed with the parent's equator.
 */
export const orbitRotation = (out: Mat3, i: number, lonNode: number, argPeri: number): Mat3 => {
  rotZ(rotNode, lonNode);
  rotX(rotInc, i);
  rotZ(rotPeri, argPeri);
  mul(rotTmp, rotNode, rotInc);
  return mul(out, rotTmp, rotPeri);
};

/**
 * Elements -> position and velocity, for an elliptic orbit about a body of
 * gravitational parameter mu.
 */
export const elementsToState = (
  el: OrbitElements,
  mu: number,
  outPos: Vec3,
  outVel: Vec3,
  /** optional mean motion override, rad/s (used when the period is tabulated) */
  meanMotion?: number,
): void => {
  const { a, e } = el;
  const { E } = solveKeplerElliptic(el.meanAnomaly, e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const sqrtOneMinusE2 = Math.sqrt(Math.max(0, 1 - e * e));
  const n = meanMotion ?? Math.sqrt(mu / (a * a * a));
  const oneMinusECosE = 1 - e * cosE;

  // Perifocal frame: periapsis on +x, motion toward +y.
  const px = a * (cosE - e);
  const py = a * sqrtOneMinusE2 * sinE;
  const vx = (-a * n * sinE) / oneMinusECosE;
  const vy = (a * n * sqrtOneMinusE2 * cosE) / oneMinusECosE;

  orbitRotation(perifocalToFrame, el.i, el.lonNode, el.argPeri);
  apply(outPos, perifocalToFrame, set(scratchP, px, py, 0));
  apply(outVel, perifocalToFrame, set(scratchP, vx, vy, 0));
};

const hVec = vec();
const nVec = vec();
const eVec = vec();
const tmpA = vec();
const tmpB = vec();

/**
 * State vector -> osculating elements. Used for HUD readouts (apoapsis,
 * periapsis, inclination) and for the gravity-assist test, which compares the
 * flown trajectory against the analytic hyperbola.
 */
export const stateToElements = (pos: Vec3, vel: Vec3, mu: number): OrbitElements & {
  periapsis: number;
  apoapsis: number;
  trueAnomaly: number;
  period: number;
} => {
  const r = len(pos);
  const v2 = lenSq(vel);
  cross(hVec, pos, vel);
  const h = len(hVec);

  // Node vector = z_hat x h
  set(nVec, -hVec.y, hVec.x, 0);
  const nLen = len(nVec);

  // Eccentricity vector e = ((v^2 - mu/r) r - (r.v) v) / mu
  const rv = dot(pos, vel);
  scale(tmpA, pos, v2 - mu / r);
  scale(tmpB, vel, rv);
  sub(eVec, tmpA, tmpB);
  scale(eVec, eVec, 1 / mu);
  const e = len(eVec);

  const energy = v2 / 2 - mu / r;
  const a = Math.abs(energy) < 1e-30 ? Infinity : -mu / (2 * energy);

  const i = Math.acos(Math.min(1, Math.max(-1, hVec.z / (h || 1))));

  let lonNode = 0;
  if (nLen > 1e-12) {
    lonNode = Math.acos(Math.min(1, Math.max(-1, nVec.x / nLen)));
    if (nVec.y < 0) lonNode = TWO_PI - lonNode;
  }

  let argPeri = 0;
  if (nLen > 1e-12 && e > 1e-12) {
    argPeri = Math.acos(Math.min(1, Math.max(-1, dot(nVec, eVec) / (nLen * e))));
    if (eVec.z < 0) argPeri = TWO_PI - argPeri;
  }

  let trueAnomaly = 0;
  if (e > 1e-12) {
    trueAnomaly = Math.acos(Math.min(1, Math.max(-1, dot(eVec, pos) / (e * r))));
    if (rv < 0) trueAnomaly = TWO_PI - trueAnomaly;
  }

  // Mean anomaly from true anomaly, branching on orbit type.
  let meanAnomaly: number;
  if (e < 1) {
    const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(trueAnomaly / 2),
                             Math.sqrt(1 + e) * Math.cos(trueAnomaly / 2));
    meanAnomaly = wrapTwoPi(E - e * Math.sin(E));
  } else {
    const H = 2 * Math.atanh(
      Math.min(0.999999999999, Math.sqrt((e - 1) / (e + 1)) * Math.tan(trueAnomaly / 2)),
    );
    meanAnomaly = e * Math.sinh(H) - H;
  }

  const periapsis = e < 1 ? a * (1 - e) : a * (1 - e);
  const apoapsis = e < 1 ? a * (1 + e) : Infinity;
  const period = e < 1 && a > 0 ? TWO_PI * Math.sqrt((a * a * a) / mu) : Infinity;

  return { a, e, i, lonNode, argPeri, meanAnomaly, periapsis, apoapsis, trueAnomaly, period };
};

/** Circular orbital speed at radius r about a body of parameter mu. */
export const circularSpeed = (mu: number, r: number): number => Math.sqrt(mu / r);

/** Escape speed at radius r. */
export const escapeSpeed = (mu: number, r: number): number => Math.sqrt((2 * mu) / r);

/** Vis-viva: speed on an orbit of semi-major axis a at radius r. */
export const visViva = (mu: number, r: number, a: number): number =>
  Math.sqrt(Math.max(0, mu * (2 / r - 1 / a)));
