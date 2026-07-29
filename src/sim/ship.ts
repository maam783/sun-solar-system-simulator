/**
 * The ship: state, attitude, drive and the two speed regimes.
 *
 * The vehicle is a 50 m hull with a human crew and, by explicit exception,
 * unlimited propellant. Everything else about how it moves is ordinary
 * Newtonian mechanics — it has no special relationship with gravity, it cannot
 * stop without turning around and burning, and it will hit a planet if aimed
 * at one.
 */

import { C_LIGHT, getBody } from '../data/constants';
import { SHIP, SPEED } from '../config';
import { ephemeris } from './ephemeris';
import { bodyNorthPole } from './frames';
import type { Vec3 } from '../math/vec3d';
import {
  add, addScaled, copy, cross, len, normalize, scale, set, sub, vec, dot,
} from '../math/vec3d';
import {
  quat, quatCopy, quatIntegrate, quatLookAlong, quatRotate, type Quat,
} from '../math/quat';

export type FlightMode = 'normal' | 'override';

export interface ShipCommand {
  /** Main drive, 0..1 along the nose. */
  throttle: number;
  /** Translation thrusters in the body frame, each -1..1 (x right, y up, z aft). */
  rcsX: number;
  rcsY: number;
  rcsZ: number;
  /** Attitude stick, each -1..1. */
  pitch: number;
  yaw: number;
  roll: number;
}

export const emptyCommand = (): ShipCommand => ({
  throttle: 0, rcsX: 0, rcsY: 0, rcsZ: 0, pitch: 0, yaw: 0, roll: 0,
});

const FORWARD: Vec3 = { x: 0, y: 0, z: -1 };
const RIGHT: Vec3 = { x: 1, y: 0, z: 0 };
const UP: Vec3 = { x: 0, y: 1, z: 0 };

const tmpA = vec();
const tmpB = vec();
const tmpC = vec();
const noseDir = vec();
const velDir = vec();

export class Ship {
  readonly pos = vec();
  readonly vel = vec();
  readonly attitude: Quat = quat();
  /** Body-frame angular velocity, rad/s. */
  readonly angularVel = vec();

  mode: FlightMode = 'normal';
  /** Index into SPEED.overrideStages; only meaningful in override mode. */
  overrideStage = 1;
  /** Main-drive acceleration at full throttle, m/s^2. */
  maxAccel: number = SHIP.defaultAccel;
  throttle = 0;
  flightAssist = true;
  destroyed = false;
  destroyedBy: string | null = null;
  impactSpeed = 0;

  /** Cumulative delta-v spent under thrust, m/s. Feeds the reality check. */
  deltaVUsed = 0;
  /** Peak acceleration felt by the crew this flight, m/s^2. */
  peakAccel = 0;
  /** Acceleration commanded on the last step, m/s^2 (for the g-load readout). */
  currentAccel = 0;

  /** Hull half-length, used as the collision margin. */
  readonly hullRadius = SHIP.length / 2;

  get speed(): number {
    return len(this.vel);
  }

  /** Direction the nose points, in world coordinates. */
  nose(out: Vec3): Vec3 {
    return quatRotate(out, this.attitude, FORWARD);
  }

  /** Lorentz factor at the current speed — shown so the pilot sees the cost. */
  get lorentzFactor(): number {
    const beta = this.speed / C_LIGHT;
    return beta >= 1 ? Infinity : 1 / Math.sqrt(1 - beta * beta);
  }

  get overrideSpeed(): number {
    const stage = SPEED.overrideStages[this.overrideStage] ?? SPEED.overrideStages[0]!;
    return stage * C_LIGHT;
  }

  /**
   * Attitude update. Runs on real elapsed time rather than simulated time:
   * the pilot's hands move at wall-clock speed regardless of time warp.
   */
  updateAttitude(cmd: ShipCommand, dtReal: number, allowManual: boolean): void {
    const target = tmpA;
    if (allowManual) {
      set(target,
        cmd.pitch * SHIP.maxAngularRate,
        cmd.yaw * SHIP.maxAngularRate,
        cmd.roll * SHIP.maxAngularRate);
    } else {
      set(target, 0, 0, 0);
    }

    if (this.flightAssist) {
      // Thrusters drive the rate toward the commanded one; releasing the stick
      // damps back to zero, which is what makes the ship easy to aim.
      const maxDelta = SHIP.angularAccel * dtReal;
      sub(tmpB, target, this.angularVel);
      const need = len(tmpB);
      if (need > maxDelta) scale(tmpB, tmpB, maxDelta / need);
      add(this.angularVel, this.angularVel, tmpB);
      if (len(target) < 1e-6) {
        const damp = Math.exp(-SHIP.angularDamping * dtReal);
        scale(this.angularVel, this.angularVel, damp);
      }
    } else {
      // Assist off: the stick applies torque and rotation persists, the way a
      // real reaction-control system behaves.
      addScaled(this.angularVel, this.angularVel, target, SHIP.angularAccel * dtReal);
    }

    quatIntegrate(this.attitude, this.angularVel.x, this.angularVel.y, this.angularVel.z, dtReal);
  }

  /**
   * Rotate the nose by an exact amount, in radians about the body axes.
   * Used by PILOT mode, where the mouse points the ship rather than spinning
   * it, so releasing the mouse leaves the view exactly where it was left.
   */
  aim(pitch: number, yaw: number, roll: number): void {
    if (pitch === 0 && yaw === 0 && roll === 0) return;
    quatIntegrate(this.attitude, pitch, yaw, roll, 1);
    set(this.angularVel, 0, 0, 0);
  }

  /** Zero the rotation rate outright (the pilot's "stop tumbling" button). */
  killRotation(): void {
    set(this.angularVel, 0, 0, 0);
  }

  /**
   * World-frame acceleration commanded by the drive and thrusters, before
   * gravity. In NORMAL mode the prograde component is tapered to zero at the
   * 0.1 c ceiling; lateral and retrograde thrust stay fully available, so the
   * ship can always turn and always slow down.
   */
  thrustAccel(cmd: ShipCommand, out: Vec3): Vec3 {
    if (this.destroyed) return set(out, 0, 0, 0);

    if (this.mode === 'override') {
      // Override is kinematic by construction: the drive drags the velocity
      // toward a commanded superluminal value. Gravity is still integrated on
      // top, which keeps one code path for everything.
      this.nose(noseDir);
      scale(tmpC, noseDir, this.overrideSpeed * cmd.throttle);
      sub(out, tmpC, this.vel);
      scale(out, out, 1 / SPEED.overrideSlew);
      return out;
    }

    // Body-frame command -> world frame.
    set(tmpB,
      cmd.rcsX * SHIP.rcsAccel,
      cmd.rcsY * SHIP.rcsAccel,
      cmd.rcsZ * SHIP.rcsAccel);
    quatRotate(out, this.attitude, tmpB);
    this.nose(noseDir);
    addScaled(out, out, noseDir, cmd.throttle * this.maxAccel);

    return this.applySpeedCap(out);
  }

  /**
   * Remove any thrust that would push the ship past the NORMAL-mode ceiling.
   *
   * This caps the *drive*, not the velocity: no energy is quietly discarded,
   * so a gravity assist can still add speed and the orbit stays honest. In
   * practice gravity cannot get anywhere near 0.1 c anyway — falling into the
   * Sun's surface only reaches 617 km/s, which is 0.002 c.
   */
  applySpeedCap(accel: Vec3): Vec3 {
    const speed = this.speed;
    const cap = SPEED.normalCap;
    if (speed < cap * 0.99) return accel;

    normalize(velDir, this.vel);
    const prograde = dot(accel, velDir);
    if (prograde <= 0) return accel;

    // Taper over the last 1% so the ceiling is approached smoothly.
    const headroom = Math.max(0, Math.min(1, (cap - speed) / (0.01 * cap)));
    const removed = prograde * (1 - headroom);
    return addScaled(accel, accel, velDir, -removed);
  }

  setMode(mode: FlightMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'normal') {
      // Leaving override: shed anything above the lawful ceiling. The fiction
      // is that the inertia dampers absorb it; the honest description is that
      // this is the one place the simulation discards energy on purpose.
      const speed = this.speed;
      if (speed > SPEED.normalCap) {
        scale(this.vel, this.vel, SPEED.normalCap / speed);
      }
    }
  }

  /** Aim the nose along a direction with an explicit roll reference. */
  pointAlong(dir: Vec3, up: Vec3): void {
    normalize(tmpA, dir);
    copy(tmpB, up);
    if (Math.abs(dot(tmpA, tmpB)) > 0.999) set(tmpB, 0, 0, 1);
    if (Math.abs(dot(tmpA, tmpB)) > 0.999) set(tmpB, 0, 1, 0);
    quatLookAlong(this.attitude, tmpA, tmpB);
  }

  /** Aim the nose along a world direction, keeping roll sane. */
  pointAt(dir: Vec3): void {
    normalize(tmpA, dir);
    // Prefer the ecliptic north pole as the roll reference; fall back to any
    // perpendicular when the ship is looking straight up or down.
    set(tmpB, 0, 0, 1);
    if (Math.abs(dot(tmpA, tmpB)) > 0.999) set(tmpB, 0, 1, 0);
    quatLookAlong(this.attitude, tmpA, tmpB);
  }

  /**
   * Place the ship in a circular orbit at `altitude` above `bodyId`, on the
   * sunlit side, prograde in the body's equatorial plane.
   */
  spawnInOrbit(bodyId: string, altitude: number, t: number, radius: number): void {
    const bodyPos = vec();
    const bodyVel = vec();
    ephemeris.state(bodyId, t, bodyPos, bodyVel);

    // Radial direction: toward the Sun, so the ship starts over the day side.
    normalize(tmpA, scale(tmpC, bodyPos, -1));
    const r = radius + altitude;
    addScaled(this.pos, bodyPos, tmpA, r);

    // Prograde direction in the body's equatorial plane.
    const pole = vec();
    bodyNorthPole(pole, bodyId, t);
    cross(tmpB, pole, tmpA);
    if (len(tmpB) < 1e-6) cross(tmpB, UP, tmpA);
    normalize(tmpB, tmpB);

    const orbitalSpeed = Math.sqrt(getBody(bodyId).mu / r);
    copy(this.vel, bodyVel);
    addScaled(this.vel, this.vel, tmpB, orbitalSpeed);

    // Look along the direction of travel, with the planet below.
    quatLookAlong(this.attitude, tmpB, tmpA);
    set(this.angularVel, 0, 0, 0);
    this.throttle = 0;
    this.destroyed = false;
    this.destroyedBy = null;
    this.impactSpeed = 0;
    this.mode = 'normal';
    this.deltaVUsed = 0;
    this.peakAccel = 0;
  }

  /** Free-fall state placement, used by the scenario runner. */
  setState(pos: Vec3, vel: Vec3): void {
    copy(this.pos, pos);
    copy(this.vel, vel);
    set(this.angularVel, 0, 0, 0);
    this.destroyed = false;
    this.destroyedBy = null;
  }

  markDestroyed(bodyId: string, speed: number): void {
    this.destroyed = true;
    this.destroyedBy = bodyId;
    this.impactSpeed = speed;
    this.throttle = 0;
    set(this.angularVel, 0, 0, 0);
  }

  cloneAttitude(out: Quat): Quat {
    return quatCopy(out, this.attitude);
  }
}

export { FORWARD, RIGHT, UP };
