/**
 * Newtonian gravity from every body that matters at the ship's current
 * position.
 *
 * All 26 bodies are point masses and all of them are always available, but
 * evaluating a distant moon's Kepler orbit thousands of times per frame buys
 * nothing: from outside a planet's system, a moon and its parent are
 * indistinguishable. So moons far from the ship are dropped from the force
 * model and their mass is folded into the parent, which keeps the total mass
 * exactly right instead of quietly losing it.
 *
 * The consequence that matters for the simulator's honesty: slingshots,
 * three-body wandering and tidal effects all fall out of this sum. Nothing
 * scripts them.
 */

import { BODIES, getBody } from '../data/constants';
import { GRAVITY } from '../config';
import { MOON_ELEMENTS_BY_ID } from '../data/elements.moons';
import type { Ephemeris } from './ephemeris';
import type { Vec3 } from '../math/vec3d';
import { set, vec, distSq } from '../math/vec3d';

export interface ActiveBody {
  id: string;
  /** Gravitational parameter used this frame, m^3/s^2. */
  mu: number;
  /** Collision radius, m. */
  radius: number;
}

const bodyPos = vec();
const shipToBody = vec();

/** Orbital radius of each moon, used for the activation test. */
const MOON_ORBIT_RADIUS = new Map<string, number>(
  [...MOON_ELEMENTS_BY_ID.values()].map((el) => [el.id, el.a]),
);
MOON_ORBIT_RADIUS.set('moon', 3.844e8);

/**
 * Choose the force model for this frame.
 *
 * Returns the Sun and all planets unconditionally, plus any moon close enough
 * to pull measurably. Absorbed moons add their mu to their parent.
 */
export const selectActiveBodies = (
  ephem: Ephemeris,
  shipPos: Vec3,
  t: number,
  out: ActiveBody[],
): ActiveBody[] => {
  out.length = 0;
  const absorbed = new Map<string, number>();

  for (const body of BODIES) {
    if (body.kind === 'moon') {
      const orbitRadius = MOON_ORBIT_RADIUS.get(body.id) ?? 1e9;
      const parent = body.parent!;
      ephem.position(parent, t, bodyPos);
      const activationRange = orbitRadius * GRAVITY.moonActivationRadii;
      if (distSq(shipPos, bodyPos) > activationRange * activationRange) {
        absorbed.set(parent, (absorbed.get(parent) ?? 0) + body.mu);
        continue;
      }
    }
    out.push({ id: body.id, mu: body.mu, radius: body.radiusCollide });
  }

  for (const entry of out) {
    const extra = absorbed.get(entry.id);
    if (extra) entry.mu += extra;
  }
  return out;
};

/**
 * Gravitational acceleration at `pos` from the active bodies, m/s^2.
 * Uses the frame-interpolated ephemeris, which is what makes this cheap enough
 * to call four times per substep.
 */
export const gravityAccel = (
  out: Vec3,
  pos: Vec3,
  t: number,
  ephem: Ephemeris,
  active: readonly ActiveBody[],
): Vec3 => {
  let ax = 0;
  let ay = 0;
  let az = 0;

  for (const body of active) {
    ephem.framePosition(body.id, t, bodyPos);
    const dx = bodyPos.x - pos.x;
    const dy = bodyPos.y - pos.y;
    const dz = bodyPos.z - pos.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    // Inside the body the sum would blow up; the collision sweep ends the
    // flight before this matters, but clamp so a grazing frame stays finite.
    const rMin = body.radius * 0.5;
    const safe = Math.max(r2, rMin * rMin);
    const invR3 = body.mu / (safe * Math.sqrt(safe));
    ax += dx * invR3;
    ay += dy * invR3;
    az += dz * invR3;
  }
  return set(out, ax, ay, az);
};

export interface DominantBody {
  id: string;
  distance: number;
  /** Height above the collision radius, m. */
  altitude: number;
  /** Acceleration this body contributes at the ship, m/s^2. */
  accel: number;
}

/**
 * The body whose gravity dominates at `pos` — the ship's current primary. This
 * drives the HUD's reference frame, the orbital readouts and the autopilot's
 * idea of what it is orbiting.
 */
export const dominantBody = (
  pos: Vec3,
  t: number,
  ephem: Ephemeris,
  active: readonly ActiveBody[],
): DominantBody => {
  let best: DominantBody = { id: 'sun', distance: Infinity, altitude: Infinity, accel: 0 };
  for (const body of active) {
    ephem.framePosition(body.id, t, bodyPos);
    const d = Math.sqrt(distSq(pos, bodyPos));
    const accel = body.mu / (d * d);
    if (accel > best.accel) {
      best = { id: body.id, distance: d, altitude: d - body.radius, accel };
    }
  }
  return best;
};

/** Nearest body by surface distance, which is what a collision warning needs. */
export const nearestSurface = (
  pos: Vec3,
  t: number,
  ephem: Ephemeris,
  active: readonly ActiveBody[],
): DominantBody => {
  let best: DominantBody = { id: 'sun', distance: Infinity, altitude: Infinity, accel: 0 };
  for (const body of active) {
    ephem.framePosition(body.id, t, bodyPos);
    const d = Math.sqrt(distSq(pos, bodyPos));
    const altitude = d - body.radius;
    if (altitude < best.altitude) {
      best = { id: body.id, distance: d, altitude, accel: body.mu / (d * d) };
    }
  }
  return best;
};

/** Escape velocity from a body's surface, for the HUD's context readouts. */
export const surfaceEscapeSpeed = (bodyId: string): number => {
  const body = getBody(bodyId);
  return Math.sqrt((2 * body.mu) / body.radius);
};

export { shipToBody };
