/**
 * Reference frames.
 *
 * The simulation frame is the mean ecliptic and equinox of J2000: +x toward
 * the vernal equinox, +z toward the ecliptic north pole. Two other frames
 * matter and both are converted into it here:
 *
 *  - ICRF equatorial J2000, in which IAU pole directions are published.
 *  - Each planet's equatorial plane, in which its moons' elements are given.
 */

import { DEG, OBLIQUITY_J2000 } from '../data/constants';
import { ROTATION_BY_ID, MOON_LIBRATION, type RotationModel } from '../data/rotation.iau';
import { centuriesSinceJ2000, daysSinceJ2000 } from './time';
import type { Vec3 } from '../math/vec3d';
import { set, cross, normalize, len, vec, scale, sub, dot } from '../math/vec3d';
import { mat3, rotX, rotZ, mul, apply, type Mat3 } from '../math/mat3d';

const COS_EPS = Math.cos(OBLIQUITY_J2000);
const SIN_EPS = Math.sin(OBLIQUITY_J2000);

/** ICRF equatorial J2000 -> ecliptic J2000 (a rotation of -epsilon about x). */
export const equatorialToEcliptic = (out: Vec3, v: Vec3): Vec3 =>
  set(out, v.x, COS_EPS * v.y + SIN_EPS * v.z, -SIN_EPS * v.y + COS_EPS * v.z);

/** Ecliptic J2000 -> ICRF equatorial J2000. */
export const eclipticToEquatorial = (out: Vec3, v: Vec3): Vec3 =>
  set(out, v.x, COS_EPS * v.y - SIN_EPS * v.z, SIN_EPS * v.y + COS_EPS * v.z);

const EQ_TO_ECL: Mat3 = (() => {
  const m = mat3();
  return rotX(m, -OBLIQUITY_J2000);
})();

/** Right ascension / declination (radians) -> unit vector in the ecliptic frame. */
export const raDecToEcliptic = (out: Vec3, ra: number, dec: number): Vec3 => {
  const cd = Math.cos(dec);
  set(out, cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec));
  return equatorialToEcliptic(out, out);
};

const mA: Mat3 = mat3();
const mB: Mat3 = mat3();
const mC: Mat3 = mat3();

/**
 * Rotation taking a body's equatorial frame (z along its north pole, x on the
 * ascending node of its equator on the ICRF equator) into the ecliptic frame.
 *
 * R = Rx(-eps) * Rz(alpha0 + 90deg) * Rx(90deg - delta0)
 */
export const poleToEclipticMatrix = (out: Mat3, raDeg: number, decDeg: number): Mat3 => {
  rotZ(mA, (raDeg + 90) * DEG);
  rotX(mB, (90 - decDeg) * DEG);
  mul(mC, mA, mB);
  return mul(out, EQ_TO_ECL, mC);
};

export interface PoleAngles {
  /** pole right ascension, degrees (ICRF) */
  ra: number;
  /** pole declination, degrees (ICRF) */
  dec: number;
  /** prime meridian angle, degrees */
  w: number;
}

/** Evaluate an IAU rotation model at simulation time t. */
export const poleAngles = (model: RotationModel, t: number): PoleAngles => {
  const T = centuriesSinceJ2000(t);
  const d = daysSinceJ2000(t);
  let ra = model.ra0 + model.raT * T;
  let dec = model.dec0 + model.decT * T;
  let w = model.w0 + model.wDot * d;

  if (model.id === 'moon') {
    // Libration: the Moon's pole and prime meridian wobble by a couple of
    // degrees, which is exactly the near-side rocking a pilot would notice.
    for (const term of [MOON_LIBRATION.e1, MOON_LIBRATION.e2, MOON_LIBRATION.e3]) {
      const arg = (term.c + term.rate * d) * DEG;
      ra += term.ra * Math.sin(arg);
      dec += term.dec * Math.cos(arg);
      w += term.w * Math.sin(arg);
    }
  } else if (model.id === 'neptune') {
    // Neptune's pole precesses with a 367-year period.
    const N = (357.85 + 52.316 * T) * DEG;
    ra += 0.70 * Math.sin(N);
    dec -= 0.51 * Math.cos(N);
    w -= 0.48 * Math.sin(N);
  }

  return { ra, dec, w };
};

const spinM: Mat3 = mat3();
const poleM: Mat3 = mat3();

/**
 * Body-fixed -> ecliptic rotation for a body with a tabulated IAU model.
 * Composing the pole matrix with the spin about the body's own z axis gives
 * the full orientation, so surface features and the terminator line up with
 * the real body's time of day.
 */
export const iauOrientation = (out: Mat3, model: RotationModel, t: number): Mat3 => {
  const { ra, dec, w } = poleAngles(model, t);
  poleToEclipticMatrix(poleM, ra, dec);
  rotZ(spinM, w * DEG);
  return mul(out, poleM, spinM);
};

const zAxis = vec();
const xAxis = vec();
const yAxis = vec();

/**
 * Orientation of a tidally locked moon, derived from its own orbit: the spin
 * axis is the orbit normal and the prime meridian points at the parent. Exact
 * for a synchronous rotator, and it produces Triton's retrograde spin without
 * any special case, because its orbit normal points the other way.
 *
 * `relPos` and `relVel` are the moon's state relative to its parent.
 */
export const syncOrientation = (out: Mat3, relPos: Vec3, relVel: Vec3): Mat3 => {
  cross(zAxis, relPos, relVel);
  if (len(zAxis) < 1e-9) set(zAxis, 0, 0, 1);
  normalize(zAxis, zAxis);

  // Prime meridian faces the parent, i.e. along -relPos.
  scale(xAxis, relPos, -1);
  // Remove any component along the spin axis so the frame stays orthonormal.
  const proj = dot(xAxis, zAxis);
  xAxis.x -= zAxis.x * proj;
  xAxis.y -= zAxis.y * proj;
  xAxis.z -= zAxis.z * proj;
  if (len(xAxis) < 1e-9) set(xAxis, 1, 0, 0);
  normalize(xAxis, xAxis);
  cross(yAxis, zAxis, xAxis);

  // Columns are the body axes expressed in the ecliptic frame.
  out[0] = xAxis.x; out[1] = yAxis.x; out[2] = zAxis.x;
  out[3] = xAxis.y; out[4] = yAxis.y; out[5] = zAxis.y;
  out[6] = xAxis.z; out[7] = yAxis.z; out[8] = zAxis.z;
  return out;
};

/** Cached equator->ecliptic matrices for the planets that host moons. */
const equatorMatrices = new Map<string, { t: number; m: Mat3 }>();

/**
 * Rotation from a planet's equatorial frame into the ecliptic frame. Moon
 * elements are referred to this plane. The pole drifts only over centuries, so
 * the matrix is recomputed at most once per simulated day.
 */
export const parentEquatorMatrix = (parentId: string, t: number): Mat3 => {
  const cached = equatorMatrices.get(parentId);
  if (cached && Math.abs(cached.t - t) < 86400) return cached.m;

  const model = ROTATION_BY_ID.get(parentId);
  const m = cached?.m ?? mat3();
  if (!model) {
    rotZ(m, 0);
  } else {
    const { ra, dec } = poleAngles(model, t);
    poleToEclipticMatrix(m, ra, dec);
  }
  equatorMatrices.set(parentId, { t, m });
  return m;
};

/** Convenience: transform a vector from a parent's equatorial frame to ecliptic. */
export const fromParentEquator = (out: Vec3, parentId: string, t: number, v: Vec3): Vec3 =>
  apply(out, parentEquatorMatrix(parentId, t), v);

/** North pole direction of a body, as a unit vector in the ecliptic frame. */
export const bodyNorthPole = (out: Vec3, bodyId: string, t: number): Vec3 => {
  const model = ROTATION_BY_ID.get(bodyId);
  if (!model || model.sync) return set(out, 0, 0, 1);
  const { ra, dec } = poleAngles(model, t);
  return raDecToEcliptic(out, ra * DEG, dec * DEG);
};

const subSolarTmp = vec();

/**
 * Sub-solar longitude on a body, in degrees east of its prime meridian. Used
 * by the frame tests: on Earth this must track local noon.
 */
export const subSolarLongitude = (bodyId: string, bodyPos: Vec3, sunPos: Vec3, t: number): number => {
  const model = ROTATION_BY_ID.get(bodyId);
  if (!model) return 0;
  const orient = mat3();
  iauOrientation(orient, model, t);
  sub(subSolarTmp, sunPos, bodyPos);
  // Transpose of a rotation is its inverse: ecliptic -> body-fixed.
  const x = orient[0]! * subSolarTmp.x + orient[3]! * subSolarTmp.y + orient[6]! * subSolarTmp.z;
  const y = orient[1]! * subSolarTmp.x + orient[4]! * subSolarTmp.y + orient[7]! * subSolarTmp.z;
  let lon = Math.atan2(y, x) / DEG;
  if (lon < 0) lon += 360;
  return lon;
};
