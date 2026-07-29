/**
 * Fourth-order Runge-Kutta propagation of the ship, with an adaptive substep
 * policy and swept collision detection.
 *
 * Two independent bounds set the substep size:
 *
 *  1. Orbit curvature. A step may not let any body's local orbital angle
 *     advance by more than `eta` radians, i.e. h <= eta / omega_max where
 *     omega_max = max sqrt(mu/r^3). At eta = 0.02 that is ~314 steps per
 *     orbit, which keeps RK4's error far below anything measurable.
 *
 *  2. Proximity. A step may not carry the ship more than a quarter of its
 *     current altitude. Without this, one frame at 100c crosses three AU and
 *     would tunnel straight through a planet between samples.
 *
 * If honouring those bounds would need more substeps than the frame budget
 * allows, the integrator reports the largest time warp it *could* have
 * sustained. The warp controller reads that and throttles back, which is what
 * makes "time warp slows down near planets" fall out of the physics rather
 * than being a special case.
 */

import { INTEGRATOR } from '../config';
import type { Ephemeris } from './ephemeris';
import type { ActiveBody } from './gravity';
import { gravityAccel } from './gravity';
import type { Vec3 } from '../math/vec3d';
import { addScaled, copy, len, set, sub, vec, dot, distSq } from '../math/vec3d';

export interface IntegrationState {
  pos: Vec3;
  vel: Vec3;
}

export interface CollisionEvent {
  bodyId: string;
  /** Impact speed relative to the body, m/s. */
  speed: number;
  /** Fraction into the substep at which contact happened. */
  fraction: number;
}

export interface StepResult {
  substeps: number;
  /** Simulated seconds actually advanced (less than dt if a collision cut it short). */
  elapsed: number;
  /** Set when the hull touched a surface; the caller ends the flight. */
  collision: CollisionEvent | null;
  /**
   * Largest time-warp factor the substep budget could have sustained this
   * frame. Below the requested warp means the warp must come down.
   */
  warpAllowed: number;
  /** Worst step-doubling discrepancy seen, m. Diagnostic only. */
  maxStepError: number;
}

const k1v = vec(); const k1a = vec();
const k2v = vec(); const k2a = vec();
const k3v = vec(); const k3a = vec();
const k4v = vec(); const k4a = vec();
const tmpPos = vec(); const tmpVel = vec();
const bodyPos = vec(); const bodyVel = vec();
const relStart = vec(); const relEnd = vec(); const relDelta = vec();
const checkPos = vec(); const checkVel = vec();
const halfPos = vec(); const halfVel = vec();
const nextPos = vec(); const nextVel = vec();
const nextState: IntegrationState = { pos: nextPos, vel: nextVel };

/**
 * Largest substep allowed at this position and velocity, in seconds.
 * `Infinity` when nothing constrains the step (deep interstellar coasting).
 */
export const substepBound = (
  pos: Vec3,
  vel: Vec3,
  t: number,
  ephem: Ephemeris,
  active: readonly ActiveBody[],
): number => {
  let bound = Infinity;
  for (const body of active) {
    ephem.framePosition(body.id, t, bodyPos);
    const d2 = distSq(pos, bodyPos);
    const d = Math.sqrt(d2);
    if (d <= 0) return 1e-6;

    // Curvature: local orbital angular rate about this body.
    const omega = Math.sqrt(body.mu / (d2 * d));
    if (omega > 0) bound = Math.min(bound, INTEGRATOR.eta / omega);

    // Proximity: never cross more than a fraction of the gap to the surface.
    const altitude = Math.max(d - body.radius, body.radius * 0.02);
    const speed = len(vel);
    if (speed > 0) {
      bound = Math.min(bound, (INTEGRATOR.proximityFraction * altitude) / speed);
    }
  }
  return bound;
};

/** One RK4 step of length h, writing the new state into `out`. */
const rk4Step = (
  out: IntegrationState,
  state: IntegrationState,
  t: number,
  h: number,
  ephem: Ephemeris,
  active: readonly ActiveBody[],
  thrust: Vec3,
): void => {
  // k1
  copy(k1v, state.vel);
  gravityAccel(k1a, state.pos, t, ephem, active);
  k1a.x += thrust.x; k1a.y += thrust.y; k1a.z += thrust.z;

  // k2
  addScaled(tmpPos, state.pos, k1v, h / 2);
  addScaled(k2v, state.vel, k1a, h / 2);
  gravityAccel(k2a, tmpPos, t + h / 2, ephem, active);
  k2a.x += thrust.x; k2a.y += thrust.y; k2a.z += thrust.z;

  // k3
  addScaled(tmpPos, state.pos, k2v, h / 2);
  addScaled(k3v, state.vel, k2a, h / 2);
  gravityAccel(k3a, tmpPos, t + h / 2, ephem, active);
  k3a.x += thrust.x; k3a.y += thrust.y; k3a.z += thrust.z;

  // k4
  addScaled(tmpPos, state.pos, k3v, h);
  addScaled(k4v, state.vel, k3a, h);
  gravityAccel(k4a, tmpPos, t + h, ephem, active);
  k4a.x += thrust.x; k4a.y += thrust.y; k4a.z += thrust.z;

  const s = h / 6;
  set(out.pos,
    state.pos.x + s * (k1v.x + 2 * k2v.x + 2 * k3v.x + k4v.x),
    state.pos.y + s * (k1v.y + 2 * k2v.y + 2 * k3v.y + k4v.y),
    state.pos.z + s * (k1v.z + 2 * k2v.z + 2 * k3v.z + k4v.z));
  set(out.vel,
    state.vel.x + s * (k1a.x + 2 * k2a.x + 2 * k3a.x + k4a.x),
    state.vel.y + s * (k1a.y + 2 * k2a.y + 2 * k3a.y + k4a.y),
    state.vel.z + s * (k1a.z + 2 * k2a.z + 2 * k3a.z + k4a.z));
};

/**
 * Swept test of the segment travelled during a substep against every active
 * body's collision sphere, in the body's own moving frame.
 *
 * Testing endpoints alone would miss a pass straight through a planet, which
 * at override speeds is the normal case rather than a corner case.
 */
const sweepCollision = (
  startPos: Vec3,
  endPos: Vec3,
  startVel: Vec3,
  t0: number,
  t1: number,
  ephem: Ephemeris,
  active: readonly ActiveBody[],
  hullRadius: number,
): CollisionEvent | null => {
  let earliest: CollisionEvent | null = null;

  for (const body of active) {
    ephem.framePosition(body.id, t0, bodyPos);
    sub(relStart, startPos, bodyPos);
    ephem.frameState(body.id, t1, bodyPos, bodyVel);
    sub(relEnd, endPos, bodyPos);
    sub(relDelta, relEnd, relStart);

    const radius = body.radius + hullRadius;
    const r2 = radius * radius;

    const startInside = dot(relStart, relStart) <= r2;
    if (startInside) {
      // Already touching at the start of the step.
      sub(tmpVel, startVel, bodyVel);
      const event = { bodyId: body.id, speed: len(tmpVel), fraction: 0 };
      if (!earliest || event.fraction < earliest.fraction) earliest = event;
      continue;
    }

    // Solve |relStart + s*relDelta|^2 = r2 for the smallest s in [0,1].
    const a = dot(relDelta, relDelta);
    if (a < 1e-9) continue;
    const b = 2 * dot(relStart, relDelta);
    const c = dot(relStart, relStart) - r2;
    const disc = b * b - 4 * a * c;
    if (disc < 0) continue;
    const sqrtDisc = Math.sqrt(disc);
    const s1 = (-b - sqrtDisc) / (2 * a);
    const s2 = (-b + sqrtDisc) / (2 * a);
    const s = s1 >= 0 && s1 <= 1 ? s1 : (s2 >= 0 && s2 <= 1 ? s2 : -1);
    if (s < 0) continue;

    sub(tmpVel, startVel, bodyVel);
    const event = { bodyId: body.id, speed: len(tmpVel), fraction: s };
    if (!earliest || event.fraction < earliest.fraction) earliest = event;
  }

  return earliest;
};

/**
 * Advance the ship by `dt` seconds of simulation time.
 *
 * `thrust` is a world-frame acceleration held constant across each substep.
 * `recompute` lets the autopilot re-derive its command every substep, which is
 * what keeps guidance stable under heavy time warp.
 */
export const integrate = (
  state: IntegrationState,
  dt: number,
  t: number,
  ephem: Ephemeris,
  active: readonly ActiveBody[],
  thrust: Vec3,
  hullRadius: number,
  frameDt: number,
  recompute?: (pos: Vec3, vel: Vec3, t: number, out: Vec3) => void,
): StepResult => {
  const result: StepResult = {
    substeps: 0,
    elapsed: dt,
    collision: null,
    warpAllowed: Infinity,
    maxStepError: 0,
  };
  if (dt === 0) return result;

  const bound = substepBound(state.pos, state.vel, t, ephem, active);
  const needed = Number.isFinite(bound) ? Math.ceil(Math.abs(dt) / bound) : 1;
  const substeps = Math.max(1, Math.min(needed, INTEGRATOR.maxSubsteps));

  if (needed > INTEGRATOR.maxSubsteps && frameDt > 0) {
    // Report the warp that would have fitted the budget so the controller can
    // drop to it. This is the whole mechanism behind automatic warp-down.
    result.warpAllowed = (INTEGRATOR.maxSubsteps * bound) / frameDt;
  }

  const h = dt / substeps;
  // Reused across frames: allocating here would put garbage collection in the
  // middle of the hot loop.
  const next = nextState;
  let time = t;

  for (let i = 0; i < substeps; i++) {
    if (recompute) recompute(state.pos, state.vel, time, thrust);

    rk4Step(next, state, time, h, ephem, active, thrust);

    // Step-doubling accuracy watchdog: occasionally compare one step of h with
    // two of h/2. A large gap means the substep policy is mistuned, which is
    // worth knowing about even though it should never fire.
    if (i % INTEGRATOR.watchdogInterval === 0 && substeps > 1) {
      const half: IntegrationState = { pos: halfPos, vel: halfVel };
      rk4Step(half, state, time, h / 2, ephem, active, thrust);
      const half2: IntegrationState = { pos: checkPos, vel: checkVel };
      rk4Step(half2, half, time + h / 2, h / 2, ephem, active, thrust);
      const err = Math.hypot(
        half2.pos.x - next.pos.x, half2.pos.y - next.pos.y, half2.pos.z - next.pos.z);
      if (err > result.maxStepError) result.maxStepError = err;
    }

    const collision = sweepCollision(
      state.pos, next.pos, state.vel, time, time + h, ephem, active, hullRadius);
    if (collision) {
      // Stop at the contact point rather than inside the planet.
      const f = collision.fraction;
      set(state.pos,
        state.pos.x + (next.pos.x - state.pos.x) * f,
        state.pos.y + (next.pos.y - state.pos.y) * f,
        state.pos.z + (next.pos.z - state.pos.z) * f);
      copy(state.vel, next.vel);
      result.collision = collision;
      result.substeps = i + 1;
      result.elapsed = h * (i + collision.fraction);
      return result;
    }

    copy(state.pos, next.pos);
    copy(state.vel, next.vel);
    time += h;
  }

  result.substeps = substeps;
  return result;
};
