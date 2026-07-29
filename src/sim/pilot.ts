/**
 * The pilot's drive — how the ship flies when you are just flying it.
 *
 * A real spacecraft is a projectile with a small engine, which is why flying
 * one is a chore: every nudge rewrites your orbit and you spend the trip
 * managing consequences rather than looking out of the window. That is a fine
 * simulator and a poor spaceship.
 *
 * So this mode commands *velocity* instead of acceleration. You point the nose,
 * you pick a speed, and the ship goes there — holding station against local
 * gravity on its own. Set the speed to zero next to Saturn and you hang there
 * looking at it, instead of falling.
 *
 * This is the one part of the simulation that is not Newtonian, and it is a
 * deliberate trade. Everything the ship is *looking at* — where the planets
 * are, how they turn, how they are lit, how big they are — stays exactly as
 * accurate as it was. ORBITAL mode is still there for anyone who wants to fly
 * the orbit itself.
 */

import { C_LIGHT } from '../data/constants';
import { SPEED } from '../config';
import type { Vec3 } from '../math/vec3d';
import { addScaled, copy, len, scale, set, sub, vec } from '../math/vec3d';

/** How quickly the ship converges on the commanded velocity, seconds. */
const RESPONSE_TAU = 1.2;

/**
 * Speed changes exponentially so one throttle key spans metres per second to
 * light speed without feeling coarse at either end.
 */
const RAMP_PER_SECOND = 2.4;

/** Slowest non-zero cruise setting, m/s. Below this the throttle snaps shut. */
const MIN_CRUISE = 2;

/**
 * Ceiling on the drive's acceleration, m/s^2. Five thousand g is nonsense for
 * anything with a crew, which is what the inertia dampers are for; the number
 * that matters is that it is *finite*, so the throttle produces a ramp the
 * pilot can watch and react to rather than an instant jump to light speed.
 */
const MAX_ACCEL = 5000 * 9.80665;

/**
 * The ship will not offer a cruise speed it could not stop from before hitting
 * whatever is nearest, and never crosses the remaining clearance in less than
 * this many seconds. Near a planet that keeps things slow and controllable; in
 * open space the limit lifts on its own. It is the same idea as the autopilot's
 * braking profile, applied to the throttle instead of to a trajectory.
 */
const CLEARANCE_SECONDS = 8;

const desired = vec();
const tmp = vec();

/** Clamp an acceleration to what the drive can actually deliver. */
const limit = (a: Vec3): void => {
  const mag = len(a);
  if (mag > MAX_ACCEL) scale(a, a, MAX_ACCEL / mag);
};

export class PilotDrive {
  /** Commanded speed relative to the reference body, m/s. */
  cruiseSpeed = 0;

  /**
   * Move the throttle. `input` is -1 (slower) to +1 (faster), `dt` real
   * seconds. The setting ramps; the ship then chases the setting.
   */
  throttle(input: number, dt: number, ceiling: number): void {
    if (input === 0) return;

    if (input > 0) {
      this.cruiseSpeed = this.cruiseSpeed < MIN_CRUISE
        ? MIN_CRUISE
        : this.cruiseSpeed * Math.exp(RAMP_PER_SECOND * input * dt);
      this.cruiseSpeed = Math.min(this.cruiseSpeed, ceiling);
    } else {
      this.cruiseSpeed *= Math.exp(RAMP_PER_SECOND * input * dt);
      if (this.cruiseSpeed < MIN_CRUISE) this.cruiseSpeed = 0;
    }
  }

  /** Cut to a dead stop relative to the reference body. */
  allStop(): void {
    this.cruiseSpeed = 0;
  }

  setCruise(speed: number, ceiling: number): void {
    this.cruiseSpeed = Math.max(0, Math.min(speed, ceiling));
  }

  /** Ceiling for the current flight mode. */
  static modeCeiling(mode: 'normal' | 'override', overrideStage: number): number {
    if (mode === 'override') {
      const stage = SPEED.overrideStages[overrideStage] ?? SPEED.overrideStages[0]!;
      return stage * C_LIGHT;
    }
    return SPEED.normalCap;
  }

  /**
   * How fast the ship is willing to go right now, given how much room it has.
   * `clearance` is the distance to the nearest surface, metres.
   */
  static ceiling(
    mode: 'normal' | 'override',
    overrideStage: number,
    clearance: number,
  ): number {
    const room = Math.max(clearance, 1000);
    return Math.min(
      PilotDrive.modeCeiling(mode, overrideStage),
      // sqrt(a * room) rather than sqrt(2 * a * room): stopping uses half the
      // clearance, so there is somewhere to go wrong.
      Math.sqrt(MAX_ACCEL * room),
      room / CLEARANCE_SECONDS,
    );
  }

  /**
   * Acceleration to apply this substep.
   *
   * The commanded velocity is the reference body's own motion plus the cruise
   * speed along the nose — so "stationary" means stationary *relative to the
   * planet you are looking at*, which is what a pilot means by it. Gravity is
   * cancelled explicitly rather than fought.
   */
  command(
    vel: Vec3,
    noseDir: Vec3,
    referenceVel: Vec3,
    gravity: Vec3,
    out: Vec3,
  ): void {
    copy(desired, referenceVel);
    addScaled(desired, desired, noseDir, this.cruiseSpeed);

    sub(out, desired, vel);
    scale(out, out, 1 / RESPONSE_TAU);
    limit(out);
    sub(out, out, gravity);
  }

  /**
   * Station-keeping only: hold position relative to the reference body without
   * being asked to move. Used when the throttle is closed, so the ship parks
   * rather than drifting.
   */
  hold(vel: Vec3, referenceVel: Vec3, gravity: Vec3, out: Vec3): void {
    sub(out, referenceVel, vel);
    scale(out, out, 1 / RESPONSE_TAU);
    limit(out);
    sub(out, out, gravity);
  }

  /** Peak acceleration the drive will deliver, m/s^2. */
  static get maxAccel(): number {
    return MAX_ACCEL;
  }

  /** Human-readable throttle position, 0..1 on a log scale. */
  throttleFraction(ceiling: number): number {
    if (this.cruiseSpeed < MIN_CRUISE) return 0;
    return Math.log(this.cruiseSpeed / MIN_CRUISE) / Math.log(ceiling / MIN_CRUISE);
  }

  reset(): void {
    this.cruiseSpeed = 0;
    set(tmp, 0, 0, 0);
    void len(tmp);
  }
}
