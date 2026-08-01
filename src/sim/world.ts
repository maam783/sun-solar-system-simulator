/**
 * The simulation as a whole: clock, ship, force model, warp and autopilot,
 * advanced together one frame at a time.
 *
 * Everything the renderer and the HUD read comes from here, and nothing here
 * knows that a renderer exists.
 */

import { INTEGRATOR, SHIP, SPEED, WARP, NAV_TARGETS } from '../config';
import { BODIES, getBody } from '../data/constants';
import { ROTATION_BY_ID } from '../data/rotation.iau';
import { SimClock, simTimeNow } from './time';
import { ephemeris } from './ephemeris';
import { Ship, emptyCommand, type ShipCommand } from './ship';
import { WarpController } from './warp';
import { Autopilot } from './autopilot';
import { HohmannTransfer } from './hohmann';
import { PilotDrive } from './pilot';
import { FlybyDirector, findLitTime, type FlybyRoute } from './flyby';
import {
  selectActiveBodies, dominantBody, nearestSurface, gravityAccel,
  type ActiveBody, type DominantBody,
} from './gravity';
import { integrate, substepBound, type CollisionEvent } from './integrator';
import {
  holdDirection, killRelativeVelocityThrust, timeToImpact, type AttitudeHold,
} from './flightassist';
import { iauOrientation, syncOrientation, bodyNorthPole } from './frames';
import { stateToElements, type OrbitElements } from './kepler';
import { mat3, type Mat3 } from '../math/mat3d';
import type { Vec3 } from '../math/vec3d';
import { addScaled, copy, cross, len, normalize, sub, vec } from '../math/vec3d';

export interface BodyRenderState {
  id: string;
  pos: Vec3;
  vel: Vec3;
  orientation: Mat3;
}

export interface OrbitInfo extends OrbitElements {
  periapsis: number;
  apoapsis: number;
  trueAnomaly: number;
  period: number;
  /** Body the elements are relative to. */
  primary: string;
  /** Altitude of periapsis above the primary's surface, m. */
  periapsisAltitude: number;
}

const thrustAccel = vec();
const holdDir = vec();
const relTmp = vec();
const posTmp = vec();
const velTmp = vec();
const flybyPos = vec();
const flybyVel = vec();
const flybyLook = vec();
const flybyUp = vec();
const refPos = vec();
const refVel = vec();
const gLocal = vec();
const noseDir = vec();
const orbitRadial = vec();
const orbitVel = vec();
const orbitNormal = vec();
const orbitTangent = vec();

export class World {
  readonly clock = new SimClock();
  readonly ship = new Ship();
  readonly warp = new WarpController();
  readonly autopilot = new Autopilot();
  readonly hohmann = new HohmannTransfer();
  readonly pilot = new PilotDrive();
  readonly flyby = new FlybyDirector();

  /**
   * How the ship handles.
   *
   * 'pilot' commands velocity: point and go, holding station against gravity.
   * 'orbital' is Newtonian - thrust changes velocity and the orbit is yours to
   * manage. The world is identical either way; only the drive differs.
   *
   * The default is Newtonian, because that is what the simulation *is*; the
   * interactive build opts into PILOT at startup. Leaving the default the
   * other way round would quietly turn every headless physics test into a test
   * of a hovering ship.
   */
  flightModel: 'pilot' | 'orbital' = 'orbital';
  readonly command: ShipCommand = emptyCommand();

  /** Body the HUD reports speed and orbit relative to. */
  referenceId = 'earth';
  /** Navigation target. */
  targetId = 'moon';
  hold: AttitudeHold = 'off';
  killRelVel = false;
  paused = false;

  /**
   * Where the pilot is looking, relative to the hull. Radians of pitch and yaw.
   *
   * The head is not the ship. Turning to look out of the side of the window
   * does not put the ship on a new course, which is both what a window is for
   * and what actually happens when you turn your head in a moving vehicle.
   */
  head = { pitch: 0, yaw: 0 };

  active: ActiveBody[] = [];
  readonly bodyStates = new Map<string, BodyRenderState>();

  dominant: DominantBody = { id: 'earth', distance: 0, altitude: 0, accel: 0 };
  nearest: DominantBody = { id: 'earth', distance: 0, altitude: 0, accel: 0 };
  lastCollision: CollisionEvent | null = null;
  lastSubsteps = 0;
  lastStepError = 0;
  /** Seconds of simulated time in the last frame. */
  lastDtSim = 0;

  private spawnTime = 0;

  constructor(t0: number = simTimeNow()) {
    this.clock.reset(t0);
    this.spawnTime = t0;
    for (const body of BODIES) {
      this.bodyStates.set(body.id, {
        id: body.id, pos: vec(), vel: vec(), orientation: mat3(),
      });
    }
    this.spawnAtEarth();
    this.updateBodyStates();
  }

  /** Standard start: 400 km circular orbit over Earth's day side. */
  spawnAtEarth(): void {
    this.clock.reset(this.spawnTime);
    this.ship.spawnInOrbit('earth', 400_000, this.clock.t, getBody('earth').radius);
    this.autopilot.disengage();
    this.hohmann.disengage();
    this.flyby.stop();
    this.pilot.reset();
    this.warp.reset();
    this.hold = 'off';
    this.killRelVel = false;
    this.referenceId = 'earth';
    this.lastCollision = null;
    this.paused = false;
    this.active.length = 0;
    this.updateReferences();
  }

  respawn(): void {
    this.spawnTime = simTimeNow();
    this.spawnAtEarth();
    this.updateBodyStates();
  }

  cycleTarget(delta: number): void {
    const list = NAV_TARGETS as readonly string[];
    const i = list.indexOf(this.targetId);
    const next = (i + delta + list.length) % list.length;
    this.targetId = list[next]!;
  }

  /** Advance the simulation by one rendered frame. */
  step(dtReal: number): void {
    if (this.ship.destroyed || this.paused) {
      this.updateBodyStates();
      return;
    }

    const dt = Math.min(dtReal, INTEGRATOR.maxFrameDt);
    const t = this.clock.t;

    // A sightseeing route flies the ship directly. It is a camera move, so it
    // owns the state outright rather than steering toward it.
    if (this.flyby.active) {
      this.stepFlyby(dt, t);
      return;
    }

    // --- Attitude, on wall-clock time: the pilot's hands are not time-warped.
    this.updateAttitude(dt, t);

    // --- Warp ceilings from what the ship is doing.
    if (this.ship.mode === 'override') {
      this.warp.constrain(1, 'override');
    }
    if (this.command.throttle > 0 && !this.autopilot.active) {
      this.warp.constrain(WARP.maxWithManualThrust, 'manual-thrust');
    }
    if (this.autopilot.active) {
      const ceiling = this.autopilot.warpCeiling();
      this.warp.constrain(
        ceiling,
        this.autopilot.phase === 'terminal' ? 'terminal-approach' : 'autopilot-burn',
      );
    }
    if (this.hohmann.active) {
      this.warp.constrain(this.hohmann.warpCeiling(), 'autopilot-burn');
    }

    this.active = selectActiveBodies(ephemeris, this.ship.pos, t, this.active);
    const activeIds = this.active.map((b) => b.id);

    // --- Resolve the time step, then clamp it to what the integrator can
    // carry accurately. Doing this before the step (rather than reacting to
    // the integrator afterwards) means every frame is integrated properly.
    let dtSim = dt * this.warp.resolve();
    const bound = substepBound(this.ship.pos, this.ship.vel, t, ephemeris, this.active);
    const maxDtSim = INTEGRATOR.maxSubsteps * bound;
    if (dtSim > maxDtSim) {
      dtSim = maxDtSim;
      this.warp.effective = Math.max(1e-3, maxDtSim / dt);
      this.warp.reason = 'gravity';
    }
    this.lastDtSim = dtSim;

    ephemeris.beginFrame(t, dtSim, activeIds);

    // --- Thrust for this frame.
    const recompute = this.buildThrustCallback(t);
    recompute(this.ship.pos, this.ship.vel, t, thrustAccel);

    const result = integrate(
      this.ship, dtSim, t, ephemeris, this.active, thrustAccel,
      this.ship.hullRadius, dt, recompute,
    );

    this.lastSubsteps = result.substeps;
    this.lastStepError = result.maxStepError;
    this.warp.applyIntegratorLimit(result.warpAllowed);

    // Delta-v and g-load bookkeeping, for the HUD and the reality check.
    const accelMag = len(thrustAccel);
    this.ship.currentAccel = accelMag;
    if (accelMag > this.ship.peakAccel) this.ship.peakAccel = accelMag;
    this.ship.deltaVUsed += accelMag * result.elapsed;

    this.clock.advance(result.elapsed);
    ephemeris.endFrame();

    if (result.collision) {
      this.lastCollision = result.collision;
      this.ship.markDestroyed(result.collision.bodyId, result.collision.speed);
      this.autopilot.disengage();
      this.hohmann.disengage();
      this.warp.reset();
    }

    this.warp.recover(dt);
    this.updateReferences();
    this.updateBodyStates();
  }

  /** Fly a sightseeing route: position, velocity and gaze all come from it. */
  private stepFlyby(dt: number, t: number): void {
    const running = this.flyby.update(dt, t, flybyPos, flybyVel, flybyLook, flybyUp);
    if (running) {
      copy(this.ship.pos, flybyPos);
      copy(this.ship.vel, flybyVel);
      this.ship.pointAlong(flybyLook, flybyUp);
    }
    this.clock.advance(dt);
    this.warp.reset();
    this.updateReferences();
    this.updateBodyStates();
  }

  /** Begin a sightseeing route, placing the ship at its opening frame. */
  startFlyby(route: FlybyRoute): void {
    this.autopilot.disengage();
    this.hohmann.disengage();
    this.killRelVel = false;
    this.pilot.allStop();
    this.warp.reset();
    this.paused = false;
    this.ship.destroyed = false;
    if (route.needsLitSubject && route.subject) {
      // Move to a date when the shot is actually lit, rather than showing a
      // new Earth and calling it an Earthrise.
      this.clock.t = findLitTime(
        route.body, route.subject, this.clock.t, route.litTarget ?? 0.98);
      this.updateBodyStates();
    }
    this.flyby.start(route);
    this.flyby.startPosition(this.clock.t, flybyPos, flybyVel);
    this.ship.setState(flybyPos, flybyVel);
    this.targetId = route.subject ?? route.body;
    this.updateReferences();
    this.updateBodyStates();
  }

  /**
   * Put the ship into a circular orbit around whatever it is closest to.
   *
   * This used to launch a full-thrust transfer to the *navigation target*,
   * which from low Earth orbit meant setting off for the Moon. What a pilot
   * means by "orbit" is here, now, around this.
   */
  enterOrbit(): boolean {
    const primary = this.dominant.id;
    const body = getBody(primary);
    const state = this.bodyState(primary);

    sub(orbitRadial, this.ship.pos, state.pos);
    const r = len(orbitRadial);
    if (!Number.isFinite(r) || r < body.radiusCollide * 1.01) return false;

    sub(orbitVel, this.ship.vel, state.vel);
    cross(orbitNormal, orbitRadial, orbitVel);
    if (len(orbitNormal) < r * 1e-3) {
      // Barely moving relative to the body, so there is no orbit plane to
      // preserve. Use the body's own equator, which is the natural choice.
      bodyNorthPole(orbitNormal, primary, this.clock.t);
    }
    normalize(orbitNormal, orbitNormal);

    cross(orbitTangent, orbitNormal, orbitRadial);
    if (len(orbitTangent) < 1e-9) return false;
    normalize(orbitTangent, orbitTangent);

    const speed = Math.sqrt(body.mu / r);
    copy(this.ship.vel, state.vel);
    addScaled(this.ship.vel, this.ship.vel, orbitTangent, speed);

    // An orbit is a coasting trajectory, so hand the ship back to Newton.
    this.flightModel = 'orbital';
    this.pilot.allStop();
    this.autopilot.disengage();
    this.hohmann.disengage();
    this.killRelVel = false;
    this.hold = 'prograde';
    this.updateReferences();
    return true;
  }

  private updateAttitude(dt: number, t: number): void {
    const manualAllowed = this.warp.effective <= WARP.maxWithManualAttitude;

    if (this.hohmann.active) {
      this.hohmann.command(this.ship.pos, this.ship.vel, t, holdDir);
      if (len(holdDir) > 1e-6) this.ship.pointAt(holdDir);
      return;
    }

    if (this.autopilot.active && this.autopilot.phase !== 'arrived') {
      // Face the way the drive is pushing — this is what makes the mid-course
      // flip visible from the cockpit.
      this.autopilot.command(this.ship.pos, this.ship.vel, t, this.active, holdDir);
      if (len(holdDir) > 1e-6) this.ship.pointAt(holdDir);
      return;
    }

    if (this.killRelVel) {
      killRelativeVelocityThrust(this.ship, this.referenceId, t, this.ship.maxAccel, holdDir);
      if (len(holdDir) > 1e-6) this.ship.pointAt(holdDir);
      return;
    }

    if (this.hold !== 'off') {
      const dir = holdDirection(
        this.ship, this.hold, this.referenceId, this.targetId, t, holdDir);
      if (dir) {
        this.ship.pointAt(dir);
        return;
      }
    }

    this.ship.updateAttitude(this.command, dt, manualAllowed);
  }

  /**
   * Build the per-substep thrust function. Recomputing inside the integrator
   * is what lets the autopilot stay stable at high warp: the control law sees
   * every substep, not just the frame boundary.
   */
  private buildThrustCallback(_t0: number) {
    return (pos: Vec3, vel: Vec3, time: number, out: Vec3): void => {
      if (this.hohmann.active) {
        this.hohmann.command(pos, vel, time, out);
        if (this.hohmann.readyForHandover) {
          // The textbook solution lands the ship in the right orbit but not
          // next to the planet, because the real orbits are neither circular
          // nor coplanar. The direct autopilot closes the remaining gap.
          const target = this.hohmann.targetId ?? this.targetId;
          this.hohmann.disengage();
          this.autopilot.engage(target, this.autopilot.accel, this.autopilot.speedCap);
        }
        return;
      }
      if (this.autopilot.active) {
        this.autopilot.command(pos, vel, time, this.active, out);
        return;
      }
      if (this.flightModel === 'pilot') {
        ephemeris.frameState(this.referenceId, time, refPos, refVel);
        gravityAccel(gLocal, pos, time, ephemeris, this.active);
        if (this.pilot.stopping) {
          this.pilot.hold(vel, refVel, gLocal, out);
        } else if (this.pilot.engaged && this.pilot.cruiseSpeed > 0) {
          this.ship.nose(noseDir);
          this.pilot.command(vel, noseDir, refVel, gLocal, out);
        } else {
          this.pilot.coast(gLocal, out);
        }
        return;
      }
      if (this.killRelVel) {
        // Uses the ship's live state rather than the substep state; the
        // difference over one substep is negligible and it keeps this cheap.
        copy(posTmp, this.ship.pos);
        copy(velTmp, this.ship.vel);
        copy(this.ship.pos, pos);
        copy(this.ship.vel, vel);
        killRelativeVelocityThrust(this.ship, this.referenceId, time, this.ship.maxAccel, out);
        copy(this.ship.pos, posTmp);
        copy(this.ship.vel, velTmp);
        if (len(out) < 1e-3) this.killRelVel = false;
        return;
      }
      this.ship.thrustAccel(this.command, out);
    };
  }

  private updateReferences(): void {
    const t = this.clock.t;
    // The force model is normally refreshed by step(), but references are also
    // read straight after a respawn or a scripted placement, before any frame
    // has run. An empty list would report the Sun as the dominant body no
    // matter where the ship actually is.
    if (this.active.length === 0) {
      this.active = selectActiveBodies(ephemeris, this.ship.pos, t, this.active);
    }
    this.dominant = dominantBody(this.ship.pos, t, ephemeris, this.active);
    this.nearest = nearestSurface(this.ship.pos, t, ephemeris, this.active);
    // The HUD follows whatever is pulling hardest, unless the pilot pinned it.
    this.referenceId = this.dominant.id;
  }

  /** Refresh positions and orientations for rendering. */
  updateBodyStates(): void {
    const t = this.clock.t;
    for (const body of BODIES) {
      const state = this.bodyStates.get(body.id)!;
      ephemeris.state(body.id, t, state.pos, state.vel);

      const model = ROTATION_BY_ID.get(body.id);
      if (!model) continue;
      if (model.sync && body.parent) {
        const parent = this.bodyStates.get(body.parent);
        if (parent) {
          sub(relTmp, state.pos, parent.pos);
          sub(velTmp, state.vel, parent.vel);
          syncOrientation(state.orientation, relTmp, velTmp);
        }
      } else {
        iauOrientation(state.orientation, model, t);
      }
    }
  }

  bodyState(id: string): BodyRenderState {
    const s = this.bodyStates.get(id);
    if (!s) throw new Error(`no render state for ${id}`);
    return s;
  }

  /** Ship velocity relative to a body. */
  relativeVelocity(bodyId: string, out: Vec3): Vec3 {
    const state = this.bodyState(bodyId);
    return sub(out, this.ship.vel, state.vel);
  }

  /** Ship position relative to a body. */
  relativePosition(bodyId: string, out: Vec3): Vec3 {
    const state = this.bodyState(bodyId);
    return sub(out, this.ship.pos, state.pos);
  }

  /** Osculating orbit about the dominant body, for the HUD. */
  orbitInfo(): OrbitInfo | null {
    const primary = this.dominant.id;
    const body = getBody(primary);
    this.relativePosition(primary, posTmp);
    this.relativeVelocity(primary, velTmp);
    const r = len(posTmp);
    if (r <= 0) return null;
    const el = stateToElements(posTmp, velTmp, body.mu);
    return {
      ...el,
      primary,
      periapsisAltitude: el.periapsis - body.radius,
    };
  }

  /** Seconds until the ship hits whatever it is closing on, or Infinity. */
  timeToImpact(): number {
    const body = getBody(this.nearest.id);
    return timeToImpact(this.ship, this.nearest.id, body.radiusCollide, this.clock.t);
  }

  /** Speed relative to the reference body, m/s. */
  referenceSpeed(): number {
    this.relativeVelocity(this.referenceId, relTmp);
    return len(relTmp);
  }

  setOverrideStage(index: number): void {
    const clamped = Math.max(0, Math.min(SPEED.overrideStages.length - 1, index));
    this.ship.overrideStage = clamped;
    this.ship.setMode('override');
  }

  setNormalMode(): void {
    this.ship.setMode('normal');
  }

  /** Distance to a body's surface, m. */
  altitudeAbove(bodyId: string): number {
    this.relativePosition(bodyId, relTmp);
    return len(relTmp) - getBody(bodyId).radiusCollide;
  }

  /** Place the ship directly, used by scenarios and tests. */
  placeShip(pos: Vec3, vel: Vec3): void {
    this.ship.setState(pos, vel);
    this.updateReferences();
    this.updateBodyStates();
  }

  setTime(t: number): void {
    this.clock.reset(t);
    this.spawnTime = t;
    this.updateBodyStates();
  }
}

export { SHIP };
