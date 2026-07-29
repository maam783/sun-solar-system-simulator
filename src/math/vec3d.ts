/**
 * Allocation-free f64 vector math. All simulation state uses these plain
 * {x,y,z} objects (IEEE-754 doubles), never THREE.Vector3 (f32-backed math is
 * unusable at solar-system scale).
 *
 * Every operation writes into an explicit `out` so hot loops never allocate.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const vec = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const set = (out: Vec3, x: number, y: number, z: number): Vec3 => {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
};

export const copy = (out: Vec3, a: Vec3): Vec3 => set(out, a.x, a.y, a.z);
export const clone = (a: Vec3): Vec3 => vec(a.x, a.y, a.z);

export const add = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out, a.x + b.x, a.y + b.y, a.z + b.z);

export const sub = (out: Vec3, a: Vec3, b: Vec3): Vec3 =>
  set(out, a.x - b.x, a.y - b.y, a.z - b.z);

export const scale = (out: Vec3, a: Vec3, s: number): Vec3 =>
  set(out, a.x * s, a.y * s, a.z * s);

/** out = a + b*s */
export const addScaled = (out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 =>
  set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (out: Vec3, a: Vec3, b: Vec3): Vec3 => {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return set(out, x, y, z);
};

export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const lenSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;

export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export const distSq = (a: Vec3, b: Vec3): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
};

export const normalize = (out: Vec3, a: Vec3): Vec3 => {
  const l = len(a);
  return l > 0 ? scale(out, a, 1 / l) : set(out, 0, 0, 0);
};

export const negate = (out: Vec3, a: Vec3): Vec3 => set(out, -a.x, -a.y, -a.z);

/** Angle between two vectors in radians, numerically safe near 0 and pi. */
export const angleBetween = (a: Vec3, b: Vec3): number => {
  const la = len(a);
  const lb = len(b);
  if (la === 0 || lb === 0) return 0;
  const c = Math.min(1, Math.max(-1, dot(a, b) / (la * lb)));
  return Math.acos(c);
};

export const isFinite3 = (a: Vec3): boolean =>
  Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);

/**
 * Fixed pool of scratch vectors for hot loops. Callers take what they need at
 * module scope; the pool is never resized at runtime so no GC pressure builds.
 */
export const makeScratch = (n: number): Vec3[] => Array.from({ length: n }, () => vec());
