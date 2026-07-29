/**
 * Hohmann transfer: the fuel-optimal way to move between two circular orbits,
 * and the one every real interplanetary mission is built around.
 *
 * Two burns. The first raises apoapsis from r1 to r2, putting the ship on an
 * ellipse tangent to both orbits. Half an orbit later the second burn
 * circularises at r2. The catch is that the destination has to *be* there when
 * you arrive, so the departure must wait for the right phase angle:
 *
 *     dv1 = sqrt(mu/r1) * (sqrt(2*r2/(r1+r2)) - 1)
 *     dv2 = sqrt(mu/r2) * (1 - sqrt(2*r1/(r1+r2)))
 *     TOF = pi * sqrt(a_t^3 / mu),   a_t = (r1 + r2) / 2
 *     phase = pi - n2 * TOF
 *
 * Earth to Mars comes out at 2.94 km/s, 2.65 km/s, 259 days, and a departure
 * window every 26 months. This mode exists to make that concrete — it is the
 * honest cost of the trip that the flip-and-burn autopilot papers over with
 * unlimited propellant.
 *
 * Real orbits are elliptical and inclined, so the textbook two-burn solution
 * misses. The transfer hands over to the direct autopilot for the last stretch
 * and reports how far off it was.
 */

import { getBody } from '../data/constants';
import { ephemeris } from './ephemeris';
import { stateToElements, wrapTwoPi } from './kepler';
import type { Vec3 } from '../math/vec3d';
import { add, cross, len, normalize, scale, set, sub, vec, dot } from '../math/vec3d';

export interface HohmannPlan {
  /** departure orbit radius, m */
  r1: number;
  /** arrival orbit radius, m */
  r2: number;
  /** transfer ellipse semi-major axis, m */
  aTransfer: number;
  /** departure burn, m/s */
  dv1: number;
  /** arrival burn, m/s */
  dv2: number;
  /** time of flight, s */
  tof: number;
  /** phase angle the target must lead by at departure, radians */
  phaseAngle: number;
  /** current phase angle of the target ahead of the ship, radians */
  currentPhase: number;
  /** wait until the window opens, s */
  waitTime: number;
  /** synodic period between the two orbits, s */
  synodicPeriod: number;
}

export type HohmannPhase = 'idle' | 'wait' | 'burn1' | 'coast' | 'burn2' | 'handover' | 'done';

const shipPos = vec();
const shipVel = vec();
const targetPos = vec();
const targetVel = vec();
const prograde = vec();
const normal = vec();
const tmp = vec();

/** Plan a transfer from radius r1 to radius r2 about a body of parameter mu. */
export const planHohmann = (
  mu: number,
  r1: number,
  r2: number,
  currentPhase: number,
): HohmannPlan => {
  const aTransfer = (r1 + r2) / 2;
  const v1 = Math.sqrt(mu / r1);
  const v2 = Math.sqrt(mu / r2);
  const dv1 = v1 * (Math.sqrt((2 * r2) / (r1 + r2)) - 1);
  const dv2 = v2 * (1 - Math.sqrt((2 * r1) / (r1 + r2)));
  const tof = Math.PI * Math.sqrt((aTransfer * aTransfer * aTransfer) / mu);

  const n1 = Math.sqrt(mu / (r1 * r1 * r1));
  const n2 = Math.sqrt(mu / (r2 * r2 * r2));
  // The target must be this far ahead at departure so that it arrives at the
  // transfer's far side at the same moment the ship does.
  const phaseAngle = Math.PI - n2 * tof;

  // Wait for the phase to drift to the required value. The relative angular
  // rate is n1 - n2, positive when the ship's orbit is the inner one.
  const relativeRate = n1 - n2;
  const delta = wrapTwoPi(currentPhase - phaseAngle);
  const waitTime = Math.abs(relativeRate) < 1e-12
    ? Infinity
    : (relativeRate > 0 ? delta / relativeRate : (2 * Math.PI - delta) / -relativeRate);

  return {
    r1, r2, aTransfer, dv1, dv2, tof,
    phaseAngle: wrapTwoPi(phaseAngle),
    currentPhase: wrapTwoPi(currentPhase),
    waitTime,
    synodicPeriod: Math.abs(relativeRate) < 1e-12 ? Infinity : (2 * Math.PI) / Math.abs(relativeRate),
  };
};

export class HohmannTransfer {
  active = false;
  phase: HohmannPhase = 'idle';
  plan: HohmannPlan | null = null;
  targetId: string | null = null;
  message = '';
  /** How far the textbook solution missed by, m. Filled in at handover. */
  missDistance = 0;
  /** Acceleration used to execute the burns, m/s^2. */
  burnAccel = 30;

  private departureTime = 0;

  /**
   * Work out the transfer from where the ship is now. Both orbits are treated
   * as circular and coplanar, which is the classical assumption and part of
   * what the mode is meant to show.
   */
  compute(shipPosition: Vec3, targetId: string, t: number): HohmannPlan | null {
    const mu = getBody('sun').mu;
    ephemeris.state(targetId, t, targetPos, targetVel);
    const r1 = len(shipPosition);
    const r2 = len(targetPos);
    if (r1 < 1e6 || r2 < 1e6) return null;

    // Phase angle of the target ahead of the ship, measured in the ecliptic.
    const shipLon = Math.atan2(shipPosition.y, shipPosition.x);
    const targetLon = Math.atan2(targetPos.y, targetPos.x);
    const currentPhase = wrapTwoPi(targetLon - shipLon);

    return planHohmann(mu, r1, r2, currentPhase);
  }

  engage(shipPosition: Vec3, targetId: string, t: number, burnAccel: number): boolean {
    const plan = this.compute(shipPosition, targetId, t);
    if (!plan) return false;
    this.plan = plan;
    this.targetId = targetId;
    this.active = true;
    this.burnAccel = burnAccel;
    this.phase = 'wait';
    this.departureTime = t + plan.waitTime;
    this.message = `WINDOW IN ${(plan.waitTime / 86400).toFixed(1)} d`;
    return true;
  }

  disengage(): void {
    this.active = false;
    this.phase = 'idle';
  }

  /**
   * Thrust for the current phase. Burns are executed as finite burns through
   * the same velocity-tracking law the direct autopilot uses, rather than as
   * instantaneous impulses, so the delta-v costs what it should.
   */
  command(pos: Vec3, vel: Vec3, t: number, out: Vec3): void {
    set(out, 0, 0, 0);
    if (!this.active || !this.plan || !this.targetId) return;

    const mu = getBody('sun').mu;
    const r = len(pos);

    // Prograde direction in the heliocentric orbit plane.
    cross(normal, pos, vel);
    if (len(normal) < 1e-6) set(normal, 0, 0, 1);
    normalize(normal, normal);
    cross(prograde, normal, pos);
    normalize(prograde, prograde);

    const elements = stateToElements(pos, vel, mu);

    switch (this.phase) {
      case 'wait': {
        if (t >= this.departureTime) {
          this.phase = 'burn1';
          this.message = `DEPARTURE BURN ${(this.plan.dv1 / 1000).toFixed(3)} km/s`;
        } else {
          this.message = `WINDOW IN ${((this.departureTime - t) / 86400).toFixed(2)} d`;
        }
        return;
      }

      case 'burn1': {
        // Burn prograde until apoapsis reaches the destination radius.
        const targetSpeed = Math.sqrt(mu * (2 / r - 1 / this.plan.aTransfer));
        const speed = len(vel);
        if (elements.apoapsis >= this.plan.r2 * 0.999 || speed >= targetSpeed) {
          this.phase = 'coast';
          this.message = `COAST ${(this.plan.tof / 86400).toFixed(1)} d`;
          return;
        }
        this.thrustToward(vel, prograde, targetSpeed, out);
        return;
      }

      case 'coast': {
        // Coast to apoapsis; the true anomaly passing pi marks arrival.
        const nearApoapsis = Math.abs(r - elements.apoapsis) < elements.apoapsis * 0.002
          || (elements.trueAnomaly > Math.PI * 0.98 && elements.trueAnomaly < Math.PI * 1.02);
        if (nearApoapsis) {
          this.phase = 'burn2';
          this.message = `CIRCULARISE ${(this.plan.dv2 / 1000).toFixed(3)} km/s`;
        }
        return;
      }

      case 'burn2': {
        const circular = Math.sqrt(mu / r);
        const speed = len(vel);
        if (speed >= circular * 0.999) {
          this.phase = 'handover';
          ephemeris.state(this.targetId, t, targetPos, targetVel);
          sub(tmp, targetPos, pos);
          this.missDistance = len(tmp);
          this.message =
            `TRANSFER COMPLETE · MISS ${(this.missDistance / 1.495978707e11).toFixed(3)} AU`;
          return;
        }
        this.thrustToward(vel, prograde, circular, out);
        return;
      }

      default:
        return;
    }
  }

  /** Accelerate along `direction` until the speed reaches `targetSpeed`. */
  private thrustToward(vel: Vec3, direction: Vec3, targetSpeed: number, out: Vec3): void {
    const speed = len(vel);
    const deficit = targetSpeed - speed;
    if (Math.abs(deficit) < 1e-6) return;
    // Taper the final metres per second so the burn settles instead of ringing.
    const magnitude = Math.min(this.burnAccel, Math.abs(deficit) / 2);
    scale(out, direction, Math.sign(deficit) * magnitude);
    void dot;
    void add;
  }

  /** Warp ceiling for the current phase: high while waiting, low while burning. */
  warpCeiling(): number {
    if (!this.active) return Infinity;
    switch (this.phase) {
      case 'wait': return 1_000_000;
      case 'coast': return 100_000;
      case 'burn1':
      case 'burn2': return 100;
      default: return 1000;
    }
  }

  get readyForHandover(): boolean {
    return this.phase === 'handover';
  }
}

export { shipPos, shipVel };
