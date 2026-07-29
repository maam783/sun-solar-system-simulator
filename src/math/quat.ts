/**
 * Minimal quaternion helpers for the ship's attitude, stored as [x, y, z, w].
 *
 * The simulation keeps its own quaternion rather than borrowing THREE's so the
 * physics layer stays free of renderer types (and of f32 math). The renderer
 * copies the four numbers into a THREE.Quaternion once per frame.
 *
 * Ship body axes follow the camera convention: +X right, +Y up, forward is -Z.
 */

import type { Vec3 } from './vec3d';
import { set } from './vec3d';

export type Quat = [number, number, number, number];

export const quat = (): Quat => [0, 0, 0, 1];

export const quatCopy = (out: Quat, a: Quat): Quat => {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
  return out;
};

export const quatNormalize = (q: Quat): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (l === 0) { q[0] = 0; q[1] = 0; q[2] = 0; q[3] = 1; return q; }
  q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l;
  return q;
};

/** out = a * b (apply b first, then a). */
export const quatMul = (out: Quat, a: Quat, b: Quat): Quat => {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  const x = aw * bx + ax * bw + ay * bz - az * by;
  const y = aw * by - ax * bz + ay * bw + az * bx;
  const z = aw * bz + ax * by - ay * bx + az * bw;
  const w = aw * bw - ax * bx - ay * by - az * bz;
  out[0] = x; out[1] = y; out[2] = z; out[3] = w;
  return out;
};

/** Rotate a vector by a quaternion. */
export const quatRotate = (out: Vec3, q: Quat, v: Vec3): Vec3 => {
  const [x, y, z, w] = q;
  // t = 2 * (q_vec x v)
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);
  return set(out,
    v.x + w * tx + (y * tz - z * ty),
    v.y + w * ty + (z * tx - x * tz),
    v.z + w * tz + (x * ty - y * tx));
};

/** Quaternion for a rotation of `angle` radians about a unit axis. */
export const quatFromAxisAngle = (out: Quat, ax: number, ay: number, az: number, angle: number): Quat => {
  const h = angle / 2;
  const s = Math.sin(h);
  out[0] = ax * s; out[1] = ay * s; out[2] = az * s; out[3] = Math.cos(h);
  return out;
};

const tmpQ: Quat = [0, 0, 0, 1];

/**
 * Integrate an angular velocity (body frame, rad/s) over dt.
 * Uses the exact axis-angle form rather than the linearised update, so large
 * rates during a fast roll stay accurate and the quaternion stays unit-length.
 */
export const quatIntegrate = (q: Quat, wx: number, wy: number, wz: number, dt: number): Quat => {
  const speed = Math.hypot(wx, wy, wz);
  if (speed < 1e-12) return q;
  const angle = speed * dt;
  quatFromAxisAngle(tmpQ, wx / speed, wy / speed, wz / speed, angle);
  quatMul(q, q, tmpQ);
  return quatNormalize(q);
};

/** Conjugate (inverse for a unit quaternion). */
export const quatConjugate = (out: Quat, a: Quat): Quat => {
  out[0] = -a[0]; out[1] = -a[1]; out[2] = -a[2]; out[3] = a[3];
  return out;
};

/** Rotate a world vector into the body frame. */
export const quatRotateInverse = (out: Vec3, q: Quat, v: Vec3): Vec3 => {
  quatConjugate(tmpQ, q);
  return quatRotate(out, tmpQ, v);
};

/**
 * Shortest-arc rotation taking the ship's forward axis onto `dir`.
 * `up` breaks the roll degeneracy; it may be any vector not parallel to dir.
 */
export const quatLookAlong = (out: Quat, dir: Vec3, up: Vec3): Quat => {
  // Build an orthonormal basis with forward = -z.
  let zx = -dir.x, zy = -dir.y, zz = -dir.z;
  const zl = Math.hypot(zx, zy, zz);
  if (zl < 1e-12) return quatCopy(out, [0, 0, 0, 1]);
  zx /= zl; zy /= zl; zz /= zl;

  let xx = up.y * zz - up.z * zy;
  let xy = up.z * zx - up.x * zz;
  let xz = up.x * zy - up.y * zx;
  let xl = Math.hypot(xx, xy, xz);
  if (xl < 1e-9) {
    // `up` is parallel to the view direction, so it cannot fix the roll. Fall
    // back to whichever world axis is least aligned with the view.
    const fx = Math.abs(zx) < 0.9 ? 1 : 0;
    const fy = Math.abs(zx) < 0.9 ? 0 : 1;
    xx = fy * zz - 0 * zy;
    xy = 0 * zx - fx * zz;
    xz = fx * zy - fy * zx;
    xl = Math.hypot(xx, xy, xz) || 1;
  }
  xx /= xl; xy /= xl; xz /= xl;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  // Rotation matrix columns are (x, y, z); convert to a quaternion.
  const trace = xx + yy + zz;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out[3] = 0.25 / s;
    out[0] = (yz - zy) * s;
    out[1] = (zx - xz) * s;
    out[2] = (xy - yx) * s;
  } else if (xx > yy && xx > zz) {
    const s = 2 * Math.sqrt(1 + xx - yy - zz);
    out[3] = (yz - zy) / s;
    out[0] = 0.25 * s;
    out[1] = (yx + xy) / s;
    out[2] = (zx + xz) / s;
  } else if (yy > zz) {
    const s = 2 * Math.sqrt(1 + yy - xx - zz);
    out[3] = (zx - xz) / s;
    out[0] = (yx + xy) / s;
    out[1] = 0.25 * s;
    out[2] = (zy + yz) / s;
  } else {
    const s = 2 * Math.sqrt(1 + zz - xx - yy);
    out[3] = (xy - yx) / s;
    out[0] = (zx + xz) / s;
    out[1] = (zy + yz) / s;
    out[2] = 0.25 * s;
  }
  return quatNormalize(out);
};

/** Spherically interpolate toward a target attitude by fraction t. */
export const quatSlerp = (out: Quat, a: Quat, b: Quat, t: number): Quat => {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) {
    out[0] = a[0] + (bx - a[0]) * t;
    out[1] = a[1] + (by - a[1]) * t;
    out[2] = a[2] + (bz - a[2]) * t;
    out[3] = a[3] + (bw - a[3]) * t;
    return quatNormalize(out);
  }
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  out[0] = a[0] * wa + bx * wb;
  out[1] = a[1] * wa + by * wb;
  out[2] = a[2] * wa + bz * wb;
  out[3] = a[3] * wa + bw * wb;
  return out;
};
