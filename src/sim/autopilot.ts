/**
 * The navigation computer: fly to a body, arrive stopped alongside it.
 *
 * The profile is the classic constant-acceleration "flip and burn": accelerate
 * toward the target for the first half of the trip, turn around, decelerate
 * for the second. Rather than precomputing a schedule (which any gravity well
 * along the way would invalidate), the autopilot follows a desired-velocity
 * field, recomputed every substep:
 *
 *     v_desired = v_target + d_hat * min(cap, sqrt(2 * a_brake * distance))
 *
 * The square-root term is exactly the speed from which the ship can still stop
 * in the distance remaining, so the profile can never build a speed it cannot
 * shed. Braking from the 0.1 c ceiling would need 306 AU at 1 g and 31 AU at
 * 10 g — the field simply never asks for that unless the target is far enough
 * away to allow it.
 *
 * The command then compensates gravity explicitly:
 *
 *     a_command = (v_desired - v) / tau - g_local
 *
 * so falling through a planet's well on the way does not push the ship off
 * profile. Thrust is planned at 85% of what the drive can do, leaving the
 * other 15% as control authority for the feedback term.
 */

import { AUTOPILOT, SPEED } from '../config';
import { getBody } from '../data/constants';
import { ephemeris } from './ephemeris';
import { gravityAccel, type ActiveBody } from './gravity';
import { circularSpeed } from './kepler';
import type { Ship } from './ship';
import type { Vec3 } from '../math/vec3d';
import {
  add, addScaled, cross, dot, len, normalize, scale, set, sub, vec,
} from '../math/vec3d';

export type AutopilotPhase =
  | 'idle'
  | 'accelerate'
  | 'coast'
  | 'brake'
  | 'terminal'
  | 'circularize'
  | 'arrived'
  | 'abort';

export interface AutopilotStatus {
  active: boolean;
  phase: AutopilotPhase;
  targetId: string | null;
  /** Distance to the standoff point, m. */
  distance: number;
  /** Speed relative to the target body, m/s. */
  relSpeed: number;
  /** Estimated time to arrival in simulated seconds. */
  eta: number;
  /** Acceleration currently commanded, m/s^2. */
  commandedAccel: number;
  message: string;
}

const targetPos = vec();
const targetVel = vec();
const sunDir = vec();
const standoff = vec();
const toTarget = vec();
const desiredVel = vec();
const relVel = vec();
const gLocal = vec();
const tmp = vec();
const orbitNormal = vec();
const dirHat = vec();

export class Autopilot {
  active = false;
  phase: AutopilotPhase = 'idle';
  targetId: string | null = null;
  /** Planned acceleration, m/s^2. */
  accel: number = AUTOPILOT.accelPresets[1]!;
  /** Speed ceiling the pilot allows, m/s. */
  speedCap: number = SPEED.normalCap;
  /** Circularise into orbit on arrival instead of holding station. */
  circularizeOnArrival = false;

  private arrivalHoldSubsteps = 0;
  private lastDistance = Infinity;
  private lastRelSpeed = 0;
  private lastCommanded = 0;
  message = '';

  engage(targetId: string, accel: number, speedCap: number): void {
    this.targetId = targetId;
    this.accel = accel;
    this.speedCap = Math.min(speedCap, SPEED.normalCap * 0.99);
    this.active = true;
    this.phase = 'accelerate';
    this.arrivalHoldSubsteps = 0;
    this.message = '';
  }

  disengage(): void {
    this.active = false;
    this.phase = 'idle';
    this.arrivalHoldSubsteps = 0;
  }

  /** Standoff point: `standoffRadii` planet radii out, on the sunlit side. */
  private computeStandoff(t: number, out: Vec3): void {
    const body = getBody(this.targetId!);
    ephemeris.frameState(this.targetId!, t, targetPos, targetVel);
    if (this.targetId === 'sun') {
      // There is no sunlit side of the Sun; stand off along the ecliptic +x
      // axis instead, which keeps the approach out of any planet's way.
      set(sunDir, 1, 0, 0);
    } else {
      // Unit vector from the body toward the Sun (the Sun is at the origin).
      normalize(sunDir, scale(tmp, targetPos, -1));
    }
    const distance = Math.max(body.radiusCollide * AUTOPILOT.standoffRadii,
                              body.radiusCollide + 1000);
    addScaled(out, targetPos, sunDir, distance);
  }

  /**
   * Compute the world-frame thrust the autopilot wants right now. Called from
   * inside the integrator once per substep, which is what keeps the loop
   * stable no matter how large the frame's time step is.
   */
  command(
    pos: Vec3,
    vel: Vec3,
    t: number,
    active: readonly ActiveBody[],
    out: Vec3,
  ): void {
    set(out, 0, 0, 0);
    if (!this.active || !this.targetId) return;

    this.computeStandoff(t, standoff);
    sub(toTarget, standoff, pos);
    const distance = len(toTarget);
    sub(relVel, vel, targetVel);
    const relSpeed = len(relVel);
    this.lastDistance = distance;
    this.lastRelSpeed = relSpeed;

    const body = getBody(this.targetId);

    if (this.phase === 'circularize') {
      this.commandCircularize(pos, vel, body.radiusCollide * AUTOPILOT.standoffRadii, out);
      return;
    }

    // Arrival: parked at the standoff point with the relative motion killed.
    // The tolerance scales with the body so it is a fixed fraction of the
    // standoff distance rather than an absolute number that is generous at
    // Jupiter and impossible at Phobos.
    const standoffDistance = body.radiusCollide * AUTOPILOT.standoffRadii;
    const arrivalRadius = Math.max(10_000, standoffDistance * 0.001);
    if (distance < arrivalRadius && relSpeed < AUTOPILOT.arrivalSpeed) {
      this.arrivalHoldSubsteps++;
      if (this.arrivalHoldSubsteps > 5) {
        if (this.circularizeOnArrival && this.targetId !== 'sun') {
          this.phase = 'circularize';
        } else {
          this.phase = 'arrived';
          this.active = false;
          this.message = 'ARRIVED';
        }
        return;
      }
    } else {
      this.arrivalHoldSubsteps = 0;
    }

    const brakeAccel = this.accel * AUTOPILOT.brakeMargin;

    // Commit check: if the ship is already too fast to stop in the distance
    // left (the pilot dialled the acceleration down mid-flight, say), give up
    // on the profile and brake with everything available.
    if (relSpeed * relSpeed > 2 * this.accel * Math.max(distance, 1) * 1.05 && distance > 1e6) {
      this.phase = 'abort';
      this.message = 'OVERSPEED - EMERGENCY BRAKING';
      normalize(tmp, relVel);
      scale(out, tmp, -this.accel);
      this.lastCommanded = this.accel;
      return;
    }

    // Desired velocity: straight at the standoff point, at the fastest speed
    // that still leaves room to stop.
    normalize(dirHat, toTarget);
    const brakeSpeed = Math.sqrt(2 * brakeAccel * Math.max(distance - 100, 0));
    const capped = brakeSpeed > this.speedCap;
    const speed = Math.min(this.speedCap, brakeSpeed);
    scale(desiredVel, dirHat, speed);
    add(desiredVel, desiredVel, targetVel);

    // Feedback toward that velocity.
    sub(out, desiredVel, vel);
    scale(out, out, 1 / AUTOPILOT.tau);

    // Feedforward: the profile is itself decelerating, and pure proportional
    // control would need a standing velocity error of a*tau (hundreds of m/s)
    // to produce that braking - the ship would arrive still moving fast. So
    // command the profile's own rate of change directly, leaving the feedback
    // term to correct the residual rather than to do the work.
    //
    //   d(v_des)/dt = -(a_brake / v_des) * closing_speed
    //
    // which reduces to exactly -a_brake when the ship is tracking the profile.
    if (!capped && speed > 1e-6) {
      const closing = dot(relVel, dirHat);
      addScaled(out, out, dirHat, -(brakeAccel / speed) * closing);
    }

    // Gravity cancelled explicitly, so falling through a well on the way does
    // not push the ship off profile.
    gravityAccel(gLocal, pos, t, ephemeris, active);
    sub(out, out, gLocal);

    const mag = len(out);
    if (mag > this.accel) scale(out, out, this.accel / mag);
    this.lastCommanded = Math.min(mag, this.accel);

    // Phase is descriptive only; the control law is the same throughout.
    if (distance < body.radiusCollide * AUTOPILOT.terminalRadii) this.phase = 'terminal';
    else if (speed >= this.speedCap - 1) this.phase = 'coast';
    else if (brakeSpeed < relSpeed) this.phase = 'brake';
    else this.phase = 'accelerate';
  }

  /**
   * Burn into a circular orbit at the standoff radius. The target velocity is
   * the local circular speed, in the plane the ship is already moving in.
   */
  private commandCircularize(pos: Vec3, vel: Vec3, radius: number, out: Vec3): void {
    sub(toTarget, pos, targetPos);
    const r = len(toTarget);
    sub(relVel, vel, targetVel);

    cross(orbitNormal, toTarget, relVel);
    if (len(orbitNormal) < 1e-3 * r) set(orbitNormal, 0, 0, 1);
    normalize(orbitNormal, orbitNormal);

    // Circular velocity direction: perpendicular to the radius, in-plane.
    cross(tmp, orbitNormal, toTarget);
    normalize(tmp, tmp);
    const speed = circularSpeed(getBody(this.targetId!).mu, r);
    scale(desiredVel, tmp, speed);
    add(desiredVel, desiredVel, targetVel);

    sub(out, desiredVel, vel);
    scale(out, out, 1 / AUTOPILOT.tau);
    const mag = len(out);
    if (mag > this.accel) scale(out, out, this.accel / mag);
    this.lastCommanded = Math.min(mag, this.accel);

    sub(tmp, vel, desiredVel);
    if (len(tmp) < 1.0 && Math.abs(r - radius) < radius * 0.2) {
      this.phase = 'arrived';
      this.active = false;
      this.message = 'ORBIT ESTABLISHED';
    }
  }

  /** Warp ceiling this phase can tolerate. */
  warpCeiling(): number {
    if (!this.active) return Infinity;
    if (this.phase === 'terminal' || this.phase === 'circularize') {
      return AUTOPILOT.maxWarpTerminal;
    }
    return AUTOPILOT.maxWarpUnderThrust;
  }

  status(ship: Ship): AutopilotStatus {
    // Time to arrival for a flip-and-burn profile: the ship spends half the
    // remaining distance speeding up and half slowing down, unless it is
    // already cruising at the cap.
    let eta = Infinity;
    const d = this.lastDistance;
    if (this.active && Number.isFinite(d)) {
      const a = this.accel * AUTOPILOT.brakeMargin;
      const peak = Math.sqrt(a * d);
      if (peak <= this.speedCap) {
        eta = 2 * Math.sqrt(d / a);
      } else {
        // Accelerate to the cap, cruise, then brake.
        const rampDistance = (this.speedCap * this.speedCap) / a;
        const cruise = Math.max(0, d - rampDistance);
        eta = (2 * this.speedCap) / a + cruise / this.speedCap;
      }
      // Already moving: subtract the ramp-up the ship has behind it.
      if (this.lastRelSpeed > 1) eta = Math.max(0, eta - this.lastRelSpeed / a);
    }

    return {
      active: this.active,
      phase: this.phase,
      targetId: this.targetId,
      distance: this.lastDistance,
      relSpeed: this.lastRelSpeed,
      eta,
      commandedAccel: this.active ? this.lastCommanded : 0,
      message: this.message || (ship.destroyed ? 'SHIP LOST' : ''),
    };
  }
}
