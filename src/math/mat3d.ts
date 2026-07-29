/**
 * f64 3x3 matrices, row-major: m[row*3 + col].
 * Used for orbital plane rotations and IAU body orientation.
 */

import type { Vec3 } from './vec3d';
import { set } from './vec3d';

export type Mat3 = Float64Array;

export const mat3 = (): Mat3 => new Float64Array(9);

export const identity = (out: Mat3): Mat3 => {
  out.fill(0);
  out[0] = 1;
  out[4] = 1;
  out[8] = 1;
  return out;
};

export const rotX = (out: Mat3, a: number): Mat3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  out[0] = 1; out[1] = 0; out[2] = 0;
  out[3] = 0; out[4] = c; out[5] = -s;
  out[6] = 0; out[7] = s; out[8] = c;
  return out;
};

export const rotY = (out: Mat3, a: number): Mat3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  out[0] = c;  out[1] = 0; out[2] = s;
  out[3] = 0;  out[4] = 1; out[5] = 0;
  out[6] = -s; out[7] = 0; out[8] = c;
  return out;
};

export const rotZ = (out: Mat3, a: number): Mat3 => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  out[0] = c; out[1] = -s; out[2] = 0;
  out[3] = s; out[4] = c;  out[5] = 0;
  out[6] = 0; out[7] = 0;  out[8] = 1;
  return out;
};

/** out = a * b */
export const mul = (out: Mat3, a: Mat3, b: Mat3): Mat3 => {
  const a0 = a[0]!, a1 = a[1]!, a2 = a[2]!;
  const a3 = a[3]!, a4 = a[4]!, a5 = a[5]!;
  const a6 = a[6]!, a7 = a[7]!, a8 = a[8]!;
  const b0 = b[0]!, b1 = b[1]!, b2 = b[2]!;
  const b3 = b[3]!, b4 = b[4]!, b5 = b[5]!;
  const b6 = b[6]!, b7 = b[7]!, b8 = b[8]!;
  out[0] = a0 * b0 + a1 * b3 + a2 * b6;
  out[1] = a0 * b1 + a1 * b4 + a2 * b7;
  out[2] = a0 * b2 + a1 * b5 + a2 * b8;
  out[3] = a3 * b0 + a4 * b3 + a5 * b6;
  out[4] = a3 * b1 + a4 * b4 + a5 * b7;
  out[5] = a3 * b2 + a4 * b5 + a5 * b8;
  out[6] = a6 * b0 + a7 * b3 + a8 * b6;
  out[7] = a6 * b1 + a7 * b4 + a8 * b7;
  out[8] = a6 * b2 + a7 * b5 + a8 * b8;
  return out;
};

export const apply = (out: Vec3, m: Mat3, v: Vec3): Vec3 => {
  const x = m[0]! * v.x + m[1]! * v.y + m[2]! * v.z;
  const y = m[3]! * v.x + m[4]! * v.y + m[5]! * v.z;
  const z = m[6]! * v.x + m[7]! * v.y + m[8]! * v.z;
  return set(out, x, y, z);
};

/** Transpose == inverse for rotation matrices. */
export const transpose = (out: Mat3, a: Mat3): Mat3 => {
  const a1 = a[1]!, a2 = a[2]!, a5 = a[5]!;
  out[0] = a[0]!; out[4] = a[4]!; out[8] = a[8]!;
  out[1] = a[3]!; out[3] = a1;
  out[2] = a[6]!; out[6] = a2;
  out[5] = a[7]!; out[7] = a5;
  return out;
};

export const copyMat = (out: Mat3, a: Mat3): Mat3 => {
  out.set(a);
  return out;
};

/**
 * Rotation matrix -> quaternion [x,y,z,w], Shepperd's method (branch on the
 * largest diagonal term to stay conditioned for any rotation).
 */
export const toQuaternion = (m: Mat3, out: number[]): number[] => {
  const m00 = m[0]!, m01 = m[1]!, m02 = m[2]!;
  const m10 = m[3]!, m11 = m[4]!, m12 = m[5]!;
  const m20 = m[6]!, m21 = m[7]!, m22 = m[8]!;
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m21 - m12) * s;
    y = (m02 - m20) * s;
    z = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
  out[3] = w;
  return out;
};
