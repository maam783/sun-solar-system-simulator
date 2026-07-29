/**
 * Pilot aids that sit between the stick and the drive: attitude holds and the
 * "stop relative to that thing" button.
 *
 * None of these bend physics. Killing relative velocity is a real burn that
 * costs real delta-v and takes real time; the aid is only that the computer
 * points the ship and modulates the throttle instead of the pilot doing it.
 */

import { ephemeris } from './ephemeris';
import type { Ship } from './ship';
import type { Vec3 } from '../math/vec3d';
import { len, normalize, scale, set, sub, vec, addScaled } from '../math/vec3d';

export type AttitudeHold = 'off' | 'prograde' | 'retrograde' | 'target' | 'antitarget' | 'nadir';

const refPos = vec();
const refVel = vec();
const relVel = vec();
const dir = vec();
const tmp = vec();

/** Velocity of the ship relative to a body. */
export const relativeVelocity = (ship: Ship, bodyId: string, t: number, out: Vec3): Vec3 => {
  ephemeris.state(bodyId, t, refPos, refVel);
  return sub(out, ship.vel, refVel);
};

/** Position of the ship relative to a body. */
export const relativePosition = (ship: Ship, bodyId: string, t: number, out: Vec3): Vec3 => {
  ephemeris.state(bodyId, t, refPos, refVel);
  return sub(out, ship.pos, refPos);
};

/**
 * Thrust that cancels the ship's velocity relative to `bodyId`.
 *
 * The magnitude tapers below `accel` as the relative speed approaches zero, so
 * the burn settles instead of chattering across the target each substep.
 */
export const killRelativeVelocityThrust = (
  ship: Ship,
  bodyId: string,
  t: number,
  accel: number,
  out: Vec3,
): Vec3 => {
  relativeVelocity(ship, bodyId, t, relVel);
  const speed = len(relVel);
  if (speed < 1e-3) return set(out, 0, 0, 0);
  normalize(dir, relVel);
  // Settle over a 5 s time constant once the speed is small enough that full
  // thrust would overshoot within one substep.
  const magnitude = Math.min(accel, speed / 5);
  return scale(out, dir, -magnitude);
};

/** Direction the ship should face for a given hold mode. */
export const holdDirection = (
  ship: Ship,
  hold: AttitudeHold,
  referenceId: string,
  targetId: string | null,
  t: number,
  out: Vec3,
): Vec3 | null => {
  switch (hold) {
    case 'prograde':
      relativeVelocity(ship, referenceId, t, relVel);
      if (len(relVel) < 1e-6) return null;
      return normalize(out, relVel);
    case 'retrograde':
      relativeVelocity(ship, referenceId, t, relVel);
      if (len(relVel) < 1e-6) return null;
      normalize(out, relVel);
      return scale(out, out, -1);
    case 'target': {
      if (!targetId) return null;
      ephemeris.state(targetId, t, refPos, refVel);
      sub(tmp, refPos, ship.pos);
      if (len(tmp) < 1e-6) return null;
      return normalize(out, tmp);
    }
    case 'antitarget': {
      if (!targetId) return null;
      ephemeris.state(targetId, t, refPos, refVel);
      sub(tmp, refPos, ship.pos);
      if (len(tmp) < 1e-6) return null;
      normalize(out, tmp);
      return scale(out, out, -1);
    }
    case 'nadir': {
      ephemeris.state(referenceId, t, refPos, refVel);
      sub(tmp, refPos, ship.pos);
      if (len(tmp) < 1e-6) return null;
      return normalize(out, tmp);
    }
    default:
      return null;
  }
};

/**
 * Suicide-burn altitude: the height at which a ship falling straight down must
 * start burning to arrive at the surface with zero speed. Shown as a warning
 * cue when the ship is on a collision course.
 */
export const stoppingDistance = (speed: number, accel: number): number =>
  accel > 0 ? (speed * speed) / (2 * accel) : Infinity;

/**
 * Seconds until impact if the current closing motion continues unchanged.
 * Returns Infinity when the ship is not closing on the surface.
 */
export const timeToImpact = (
  ship: Ship,
  bodyId: string,
  bodyRadius: number,
  t: number,
): number => {
  relativePosition(ship, bodyId, t, tmp);
  const distance = len(tmp);
  const altitude = distance - bodyRadius;
  if (altitude <= 0) return 0;
  relativeVelocity(ship, bodyId, t, relVel);
  normalize(dir, tmp);
  // Closing speed is the inward component of the relative velocity.
  const closing = -(relVel.x * dir.x + relVel.y * dir.y + relVel.z * dir.z);
  if (closing <= 0) return Infinity;
  return altitude / closing;
};

/** Nudge a position outward from a body, used when respawning clear of terrain. */
export const liftAbove = (pos: Vec3, bodyPos: Vec3, radius: number, margin: number): void => {
  sub(tmp, pos, bodyPos);
  const d = len(tmp);
  if (d >= radius + margin) return;
  normalize(dir, tmp);
  set(pos, bodyPos.x, bodyPos.y, bodyPos.z);
  addScaled(pos, pos, dir, radius + margin);
};
