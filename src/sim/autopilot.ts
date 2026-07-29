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
  add, addScaled, copy, cross, dot, len, normalize, scale, set, sub, vec,
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
const standoffVel = vec();
const sunDirRate = vec();
const obstaclePos = vec();
const toObstacle = vec();
const perp = vec();
const avoidAim = vec();

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

  /** Where the autopilot is flying to, and how fast that point itself moves. */
  readonly standoffPos = vec();
  readonly standoffVel = vec();
  /** Speed relative to the target body itself, m/s (for the HUD). */
  relSpeedToBody = 0;

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

  /**
   * Standoff point: `standoffRadii` planet radii out, on the sunlit side — so
   * the ship arrives looking at a lit face rather than a black disc.
   *
   * Its velocity is not simply the planet's. The sunward direction swings round
   * as the planet orbits, so the point itself circles the planet once a year
   * (1.4 m/s at Mars). Feeding that in is what lets the controller actually
   * null its error instead of settling at a permanent metre-per-second offset.
   */
  private computeStandoff(t: number, out: Vec3, outVel: Vec3): void {
    const body = getBody(this.targetId!);
    ephemeris.frameState(this.targetId!, t, targetPos, targetVel);
    const distance = Math.max(body.radiusCollide * AUTOPILOT.standoffRadii,
                              body.radiusCollide + 1000);

    if (this.targetId === 'sun') {
      // There is no sunlit side of the Sun; stand off along the ecliptic +x
      // axis instead, which keeps the approach out of any planet's way.
      set(sunDir, 1, 0, 0);
      addScaled(out, targetPos, sunDir, distance);
      copy(outVel, targetVel);
      return;
    }

    // Unit vector from the body toward the Sun (the Sun is at the origin).
    const r = len(targetPos);
    normalize(sunDir, scale(tmp, targetPos, -1));
    addScaled(out, targetPos, sunDir, distance);

    // d/dt of -r/|r| is -(v/|r| - r (r.v)/|r|^3).
    const rv = dot(targetPos, targetVel);
    set(sunDirRate,
      -(targetVel.x / r - (targetPos.x * rv) / (r * r * r)),
      -(targetVel.y / r - (targetPos.y * rv) / (r * r * r)),
      -(targetVel.z / r - (targetPos.z * rv) / (r * r * r)));
    copy(outVel, targetVel);
    addScaled(outVel, outVel, sunDirRate, distance);
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

    this.computeStandoff(t, standoff, standoffVel);
    copy(this.standoffPos, standoff);
    copy(this.standoffVel, standoffVel);
    sub(toTarget, standoff, pos);
    const distance = len(toTarget);
    // Motion relative to the standoff point is what the controller nulls;
    // motion relative to the planet is what the HUD reports.
    sub(relVel, vel, standoffVel);
    const relSpeed = len(relVel);
    sub(tmp, vel, targetVel);
    this.relSpeedToBody = len(tmp);
    this.lastDistance = distance;
    this.lastRelSpeed = relSpeed;

    const body = getBody(this.targetId);

    if (this.phase === 'circularize') {
      this.commandCircularize(pos, vel, body.radiusCollide * AUTOPILOT.standoffRadii, out);
      return;
    }

    if (this.phase === 'arrived') {
      // Parking four radii off a planet is not a stable place to be: let go and
      // the ship simply falls in. So arrival means holding station under
      // continuous thrust, which is exactly what the unlimited-propellant
      // exception buys. The alternative is to circularise into a real orbit.
      this.commandStationKeeping(pos, vel, t, active, out);
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
          return;
        }
        this.phase = 'arrived';
        this.message = 'ARRIVED - STATION KEEPING';
        // Must return: the phase classification at the end of this function
        // would otherwise put it straight back to 'terminal'.
        this.commandStationKeeping(pos, vel, t, active, out);
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

    // Gravity compensation has first call on the drive. A ship leaving low
    // orbit that spends its whole thrust budget steering toward the Moon
    // simply falls out of the sky, because the 8.7 m/s^2 pulling it down never
    // got cancelled. So: cancel the local field first, steer with the rest.
    gravityAccel(gLocal, pos, t, ephemeris, active);
    const gMag = len(gLocal);
    if (gMag >= this.accel) {
      // Too deep in the well to even hover. Push straight up; the situation
      // improves as soon as any altitude is gained.
      scale(out, gLocal, -this.accel / gMag);
      this.lastCommanded = this.accel;
      this.phase = 'abort';
      this.message = 'INSUFFICIENT THRUST TO CLIMB';
      return;
    }
    const steerBudget = this.accel - gMag;

    // Desired velocity: straight at the standoff point, at the fastest speed
    // that still leaves room to stop — steering round anything in the way.
    normalize(dirHat, toTarget);
    this.avoidObstacles(pos, t, active, distance, dirHat);

    const brakeSpeed = Math.sqrt(2 * brakeAccel * Math.max(distance - 100, 0));
    const capped = brakeSpeed > this.speedCap;
    const speed = Math.min(this.speedCap, brakeSpeed);
    scale(desiredVel, dirHat, speed);
    add(desiredVel, desiredVel, standoffVel);

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

    // Clamp the steering to what is left after holding station against
    // gravity, then add the compensation back. The total can never exceed the
    // drive's rating, because the two parts were budgeted against it.
    const steerMag = len(out);
    if (steerMag > steerBudget) scale(out, out, steerBudget / steerMag);
    sub(out, out, gLocal);
    this.lastCommanded = len(out);

    // Phase is descriptive only; the control law is the same throughout.
    if (distance < body.radiusCollide * AUTOPILOT.terminalRadii) this.phase = 'terminal';
    else if (speed >= this.speedCap - 1) this.phase = 'coast';
    else if (brakeSpeed < relSpeed) this.phase = 'brake';
    else this.phase = 'accelerate';
  }

  /**
   * Hold position on the standoff point: close any drift gently, match the
   * point's own motion, and cancel the local gravity that would otherwise pull
   * the ship down.
   */
  private commandStationKeeping(
    pos: Vec3,
    vel: Vec3,
    t: number,
    active: readonly ActiveBody[],
    out: Vec3,
  ): void {
    sub(toTarget, standoff, pos);
    // Close the remaining gap over about a minute, without ever exceeding a
    // sedate station-keeping speed.
    scale(desiredVel, toTarget, 1 / 60);
    const closing = len(desiredVel);
    if (closing > 50) scale(desiredVel, desiredVel, 50 / closing);
    add(desiredVel, desiredVel, standoffVel);

    sub(out, desiredVel, vel);
    scale(out, out, 1 / AUTOPILOT.tau);

    gravityAccel(gLocal, pos, t, ephemeris, active);
    const gMag = len(gLocal);
    const budget = Math.max(0, this.accel - gMag);
    const steerMag = len(out);
    if (steerMag > budget) scale(out, out, budget / steerMag);
    sub(out, out, gLocal);

    const total = len(out);
    if (total > this.accel) scale(out, out, this.accel / total);
    this.lastCommanded = len(out);
  }

  /**
   * Bend the aim point around anything sitting between the ship and the
   * target.
   *
   * The guidance law flies a straight line, and a straight line to Saturn from
   * low Earth orbit goes through the Earth about half the time. Rather than
   * plan a path, this nudges the aim point to graze the obstacle's limb at a
   * safe margin: the smallest deviation that clears it, applied continuously,
   * which straightens itself out again as soon as the body is no longer in the
   * way.
   */
  private avoidObstacles(
    pos: Vec3,
    t: number,
    active: readonly ActiveBody[],
    targetDistance: number,
    dir: Vec3,
  ): void {
    const SAFETY = 1.6;
    let worstIntrusion = 0;
    let chosen: ActiveBody | null = null;
    let chosenAlong = 0;

    for (const body of active) {
      if (body.id === this.targetId) continue;
      ephemeris.framePosition(body.id, t, obstaclePos);
      sub(toObstacle, obstaclePos, pos);
      const along = dot(toObstacle, dir);
      // Only things ahead of the ship and nearer than the target can block it.
      if (along <= 0 || along >= targetDistance) continue;

      // Perpendicular offset of the body from the line of flight.
      scale(tmp, dir, along);
      sub(perp, toObstacle, tmp);
      const miss = len(perp);
      const safe = body.radius * SAFETY;
      if (miss >= safe) continue;

      const intrusion = safe - miss;
      if (intrusion > worstIntrusion) {
        worstIntrusion = intrusion;
        chosen = body;
        chosenAlong = along;
      }
    }

    if (!chosen) return;

    ephemeris.framePosition(chosen.id, t, obstaclePos);
    sub(toObstacle, obstaclePos, pos);
    scale(tmp, dir, chosenAlong);
    sub(perp, toObstacle, tmp);

    if (len(perp) < chosen.radius * 1e-3) {
      // Dead ahead: any sideways direction will do, so pick one perpendicular
      // to the flight path rather than leaving it undefined.
      set(tmp, 0, 0, 1);
      if (Math.abs(dot(tmp, dir)) > 0.9) set(tmp, 1, 0, 0);
      cross(perp, dir, tmp);
    }
    normalize(perp, perp);

    // Aim at a point one safe radius off the body, on the side the ship is
    // already passing. That is the least deviation that clears it.
    scale(avoidAim, perp, -chosen.radius * SAFETY);
    add(avoidAim, avoidAim, obstaclePos);
    sub(dirHat, avoidAim, pos);
    normalize(dir, dirHat);
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
    if (this.phase === 'terminal' || this.phase === 'circularize'
        || this.phase === 'arrived') {
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
