/**
 * Scripted flights that check themselves.
 *
 * Loading `?scenario=mars-direct` puts the ship in a defined state, runs it on
 * a fixed time step so the result is reproducible, and prints machine-readable
 * lines to the console:
 *
 *   [SCEN] name=mars-direct status=PASS dist_err_pct=1.8 vrel=0.42 t_sim_h=57.3
 *
 * That is what makes it possible to verify the simulator end to end — angular
 * sizes, orbit stability, autopilot arrivals, gravity-assist physics — without
 * anyone sitting and watching it.
 */

import { AU, C_LIGHT, getBody } from '../data/constants';
import { AUTOPILOT, G0, SPEED } from '../config';
import type { World } from '../sim/world';
import type { SolarSystemRenderer } from '../render/scene';
import type { InputController } from '../ui/input';
import { planHohmann } from '../sim/hohmann';
import { stateToElements } from '../sim/kepler';
import {
  add, addScaled, cross, len, normalize, scale, set, sub, vec, angleBetween, dot,
} from '../math/vec3d';

const RAD = 180 / Math.PI;

interface Check {
  name: string;
  ok: boolean;
  value: string;
}

class Results {
  readonly checks: Check[] = [];

  expect(name: string, ok: boolean, value: number | string): void {
    this.checks.push({
      name,
      ok,
      value: typeof value === 'number' ? formatNumber(value) : value,
    });
  }

  between(name: string, value: number, low: number, high: number): void {
    this.expect(name, value >= low && value <= high, value);
  }

  below(name: string, value: number, limit: number): void {
    this.expect(name, value <= limit, value);
  }

  above(name: string, value: number, limit: number): void {
    this.expect(name, value >= limit, value);
  }

  get passed(): boolean {
    return this.checks.length > 0 && this.checks.every((c) => c.ok);
  }
}

const formatNumber = (v: number): string => {
  if (!Number.isFinite(v)) return String(v);
  if (v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6)) return v.toExponential(3);
  return String(Number(v.toFixed(4)));
};

export interface ScenarioContext {
  world: World;
  renderer: SolarSystemRenderer;
  input: InputController;
  results: Results;
  /** simulated seconds since the scenario started */
  simElapsed: number;
  /** frames rendered since the scenario started */
  frames: number;
  /** scratch space for a scenario's own bookkeeping */
  memory: Record<string, number>;
}

export interface Scenario {
  id: string;
  description: string;
  /** Fixed simulated step per frame, seconds. Defaults to 1/60. */
  setup(ctx: ScenarioContext): void;
  update?(ctx: ScenarioContext): void;
  isDone(ctx: ScenarioContext): boolean;
  finish(ctx: ScenarioContext): void;
  /** Give up after this many simulated seconds. */
  simTimeout: number;
  /** Give up after this many rendered frames. */
  frameTimeout?: number;
}

const scratchA = vec();
const scratchB = vec();
const scratchC = vec();

// ---------------------------------------------------------------------------
// Scenario definitions
// ---------------------------------------------------------------------------

const bootScenario: Scenario = {
  id: 'boot',
  description: 'renderer and simulation come up clean',
  simTimeout: 5,
  setup() { /* default state is the scenario */ },
  isDone: (ctx) => ctx.frames > 30,
  finish(ctx) {
    const { world, renderer } = ctx;
    ctx.results.expect('bodies', world.bodyStates.size >= 26, world.bodyStates.size);
    ctx.results.expect('ship_finite', Number.isFinite(world.ship.pos.x), 1);
    ctx.results.above('draw_calls', renderer.drawCalls, 1);
    ctx.results.expect('reference', world.referenceId === 'earth', world.referenceId);
  },
};

/**
 * The single most direct check that the scale is right: from low Earth orbit
 * the Sun must subtend half a degree, and so must the Moon. Any error in
 * distances, radii or units shows up here immediately.
 */
const angularSizes: Scenario = {
  id: 'angular-sizes',
  description: 'apparent sizes from low Earth orbit match the real sky',
  simTimeout: 10,
  setup(ctx) {
    ctx.world.respawn();
  },
  isDone: (ctx) => ctx.frames > 10,
  finish(ctx) {
    const { world, renderer, results } = ctx;
    const sun = renderer.apparentDiameterDeg(world, 'sun');
    const moon = renderer.apparentDiameterDeg(world, 'moon');
    const earth = renderer.apparentDiameterDeg(world, 'earth');

    // 0.533 deg is the textbook value, varying with Earth's distance.
    results.between('sun_deg', sun, 0.522, 0.544);
    // The Moon varies more, between perigee and apogee.
    results.between('moon_deg', moon, 0.45, 0.58);
    // From 400 km up, Earth's disc spans 140 deg — it fills the window.
    results.between('earth_deg', earth, 135, 145);

    const speed = world.referenceSpeed();
    results.between('leo_speed', speed, 7670, 7676);
  },
};

const leoOrbit: Scenario = {
  id: 'leo-orbit',
  description: 'a circular orbit comes back to where it started',
  simTimeout: 6200,
  setup(ctx) {
    ctx.world.respawn();
    ctx.world.warp.requested = 200;
    ctx.memory.startAltitude = ctx.world.altitudeAbove('earth');
    ctx.memory.period = ctx.world.orbitInfo()!.period;
  },
  isDone: (ctx) => ctx.simElapsed >= ctx.memory.period!,
  finish(ctx) {
    const { world, results, memory } = ctx;
    const altitude = world.altitudeAbove('earth');
    results.below('altitude_err_m', Math.abs(altitude - memory.startAltitude!), 500);
    results.between('period_s', memory.period!, 5540, 5580);
    const orbit = world.orbitInfo()!;
    results.below('eccentricity', orbit.e, 2e-3);
  },
};

/** Fly somewhere under autopilot and check where it parked. */
const directFlight = (
  id: string,
  targetId: string,
  accel: number,
  simTimeout: number,
  bounds: { minHours: number; maxHours: number },
): Scenario => ({
  id,
  description: `autopilot flight to ${getBody(targetId).name}`,
  simTimeout,
  setup(ctx) {
    ctx.world.respawn();
    ctx.world.targetId = targetId;
    ctx.world.autopilot.accel = accel;
    ctx.world.autopilot.engage(targetId, accel, SPEED.normalCap);
    ctx.world.warp.requested = 1_000_000;
  },
  isDone: (ctx) => {
    if (ctx.world.ship.destroyed) return true;
    if (ctx.world.autopilot.phase === 'arrived') {
      // Arriving is not the same as holding. Give it two minutes of station
      // keeping before measuring, so a controller that reaches the point and
      // then drifts away cannot pass.
      if (!ctx.memory.arrivedAt) ctx.memory.arrivedAt = ctx.simElapsed;
      return ctx.simElapsed - ctx.memory.arrivedAt > 120;
    }
    return !ctx.world.autopilot.active;
  },
  finish(ctx) {
    const { world, results } = ctx;
    const body = getBody(targetId);
    const standoff = body.radiusCollide * AUTOPILOT.standoffRadii;

    sub(scratchA, world.ship.pos, world.bodyState(targetId).pos);
    const distance = len(scratchA);
    // Arrival means station-keeping on the standoff point. That point circles
    // the planet once per planetary year as the sunward direction swings, so
    // holding it means a small steady speed relative to the planet itself -
    // 1.4 m/s at Mars. Both numbers are reported.
    sub(scratchB, world.ship.vel, world.autopilot.standoffVel);
    const stationKeeping = len(scratchB);
    world.relativeVelocity(targetId, scratchC);
    const relToBody = len(scratchC);

    results.expect('arrived', world.autopilot.phase === 'arrived', world.autopilot.phase);
    results.expect('survived', !world.ship.destroyed, world.ship.destroyed ? 'lost' : 'ok');
    results.below('dist_err_pct', Math.abs(distance / standoff - 1) * 100, 5);
    results.below('station_ms', stationKeeping, 1.0);
    results.below('vrel_body_ms', relToBody, 10);
    results.between('t_sim_h', (ctx.memory.arrivedAt ?? ctx.simElapsed) / 3600,
      bounds.minHours, bounds.maxHours);
    // A flight that never went fast enough to matter has not tested anything.
    results.above('peak_speed_kms', (ctx.memory.peakSpeed ?? 0) / 1000, 1);
  },
  update(ctx) {
    const speed = ctx.world.ship.speed;
    if (speed > (ctx.memory.peakSpeed ?? 0)) ctx.memory.peakSpeed = speed;
  },
});

/**
 * Gravity assist at Jupiter.
 *
 * The physics being checked is the thing that makes slingshots work and is
 * easy to get subtly wrong: in the planet's frame the encounter is elastic —
 * the ship leaves with exactly the speed it arrived with, only pointing
 * somewhere else — while in the Sun's frame it gains kinetic energy, borrowed
 * from Jupiter's orbital motion. Nothing in the simulator implements this; it
 * falls out of integrating Newtonian gravity.
 */
const jupiterSlingshot: Scenario = {
  id: 'jupiter-slingshot',
  description: 'gravity assist conserves speed in Jupiter frame, gains it in the Sun frame',
  simTimeout: 60 * 86400,
  setup(ctx) {
    const { world } = ctx;
    const jupiter = world.bodyState('jupiter');
    const mu = getBody('jupiter').mu;
    const rJ = getBody('jupiter').radius;

    const vInf = 15_000;
    const periapsis = 3 * rJ;
    const r = 100 * rJ;

    // Hyperbola through that periapsis with that excess speed.
    const e = 1 + (periapsis * vInf * vInf) / mu;
    const a = -mu / (vInf * vInf);
    const h = Math.sqrt(mu * Math.abs(a) * (e * e - 1));
    const speed = Math.sqrt(vInf * vInf + (2 * mu) / r);
    const sinGamma = Math.min(1, h / (r * speed));
    const gamma = Math.asin(sinGamma);

    // Frame: sunward direction and Jupiter's direction of travel. Approaching
    // from sunward and being turned toward Jupiter's prograde direction is the
    // geometry that steals orbital energy from the planet.
    normalize(scratchA, scale(scratchC, jupiter.pos, -1));  // toward the Sun
    normalize(scratchB, jupiter.vel);                        // Jupiter prograde

    const start = vec();
    addScaled(start, jupiter.pos, scratchA, r);

    // Velocity: mostly inward along -sunward, tilted by gamma. The sign of the
    // tilt picks which side of Jupiter the ship rounds, and that decides
    // whether the encounter steals orbital energy from the planet or gives it
    // away. Passing behind Jupiter is the one that gains.
    const velocity = vec();
    scale(velocity, scratchA, -Math.cos(gamma) * speed);
    addScaled(velocity, velocity, scratchB, -Math.sin(gamma) * speed);
    add(velocity, velocity, jupiter.vel);

    world.placeShip(start, velocity);
    world.warp.requested = 100_000;
    world.autopilot.disengage();

    ctx.memory.e = e;
    ctx.memory.rEntry = r;
    ctx.memory.periapsisTarget = periapsis;
    ctx.memory.minRadius = Infinity;

    // Record the incoming state in both frames.
    world.relativeVelocity('jupiter', scratchC);
    ctx.memory.vInfIn = len(scratchC);
    ctx.memory.vInfInX = scratchC.x;
    ctx.memory.vInfInY = scratchC.y;
    ctx.memory.vInfInZ = scratchC.z;
    ctx.memory.helioIn = world.ship.speed;
    ctx.memory.inbound = 1;
  },
  update(ctx) {
    const { world } = ctx;
    sub(scratchA, world.ship.pos, world.bodyState('jupiter').pos);
    const r = len(scratchA);
    if (r < ctx.memory.minRadius!) ctx.memory.minRadius = r;
    if (r < ctx.memory.rEntry! * 0.9) ctx.memory.inbound = 0;
  },
  isDone: (ctx) => {
    const { world } = ctx;
    sub(scratchA, world.ship.pos, world.bodyState('jupiter').pos);
    return (ctx.memory.inbound === 0 && len(scratchA) >= ctx.memory.rEntry!)
      || world.ship.destroyed;
  },
  finish(ctx) {
    const { world, results, memory } = ctx;
    results.expect('survived', !world.ship.destroyed, world.ship.destroyed ? 'lost' : 'ok');

    world.relativeVelocity('jupiter', scratchC);
    const vInfOut = len(scratchC);
    set(scratchB, memory.vInfInX!, memory.vInfInY!, memory.vInfInZ!);

    // Elastic in the planet's frame: same speed, different direction.
    results.below('vinf_ratio_err_pct',
      Math.abs(vInfOut / memory.vInfIn! - 1) * 100, 0.5);

    const turning = angleBetween(scratchB, scratchC) * RAD;
    const expected = 2 * Math.asin(1 / memory.e!) * RAD;
    results.below('turn_err_pct', Math.abs(turning / expected - 1) * 100, 3);
    results.expect('turn_deg', true, turning);

    // Energy in the Sun's frame is not conserved, and that is the whole point.
    const helioOut = world.ship.speed;
    const gain = helioOut - memory.helioIn!;
    results.above('helio_gain_kms', gain / 1000, 1);

    // The trajectory really did pass close to the planet.
    results.below('periapsis_err_pct',
      Math.abs(memory.minRadius! / memory.periapsisTarget! - 1) * 100, 5);
  },
};

const collisionScenario: Scenario = {
  id: 'collision',
  description: 'flying into a planet ends the flight at its surface',
  simTimeout: 3000,
  setup(ctx) {
    const { world } = ctx;
    world.respawn();
    // Kill the orbital motion and drop straight down.
    const earth = world.bodyState('earth');
    sub(scratchA, world.ship.pos, earth.pos);
    normalize(scratchA, scratchA);
    const vel = vec();
    scale(vel, scratchA, -3000);
    add(vel, vel, earth.vel);
    world.placeShip(world.ship.pos, vel);
    world.warp.requested = 50;
  },
  isDone: (ctx) => ctx.world.ship.destroyed,
  finish(ctx) {
    const { world, results } = ctx;
    results.expect('destroyed', world.ship.destroyed, world.ship.destroyed ? 1 : 0);
    results.expect('by_earth', world.ship.destroyedBy === 'earth', String(world.ship.destroyedBy));
    sub(scratchA, world.ship.pos, world.bodyState('earth').pos);
    const surface = getBody('earth').radiusCollide;
    results.below('surface_err_pct', Math.abs(len(scratchA) / surface - 1) * 100, 2);

    // And respawning must restore a clean orbit.
    world.respawn();
    results.expect('respawn_ok', !world.ship.destroyed, world.ship.destroyed ? 0 : 1);
    results.below('respawn_ecc', world.orbitInfo()!.e, 1e-3);
  },
};

const sunApproach: Scenario = {
  id: 'sun-approach',
  description: 'the Sun stays a lit disc up close, and the photosphere is solid',
  simTimeout: 40 * 86400,
  setup(ctx) {
    const { world } = ctx;
    const sunRadius = getBody('sun').radius;
    // Fall in from 5 solar radii with no orbital motion at all.
    world.placeShip(vec(5 * sunRadius, 0, 0), vec(0, 0, 0));
    world.autopilot.disengage();
    world.warp.requested = 100;
    ctx.memory.startRadius = 5 * sunRadius;
  },
  update(ctx) {
    ctx.memory.lastRadius = len(ctx.world.ship.pos);
  },
  isDone: (ctx) => ctx.world.ship.destroyed,
  finish(ctx) {
    const { world, results } = ctx;
    const sunRadius = getBody('sun').radius;
    results.expect('destroyed', world.ship.destroyed, world.ship.destroyed ? 1 : 0);
    results.expect('by_sun', world.ship.destroyedBy === 'sun', String(world.ship.destroyedBy));
    results.below('photosphere_err_pct',
      Math.abs(len(world.ship.pos) / sunRadius - 1) * 100, 2);
    // Free fall from 5 radii reaches a serious speed.
    results.above('impact_kms', world.ship.impactSpeed / 1000, 300);
  },
};

const hohmannMars: Scenario = {
  id: 'hohmann-mars',
  description: 'the textbook Earth-to-Mars transfer reproduces its own numbers',
  simTimeout: 10,
  setup(ctx) {
    ctx.world.respawn();
  },
  isDone: (ctx) => ctx.frames > 5,
  finish(ctx) {
    const { results } = ctx;
    const mu = getBody('sun').mu;
    const r1 = AU;
    const r2 = 1.523679 * AU;
    const plan = planHohmann(mu, r1, r2, 0);

    // The classical Earth-to-Mars numbers, to the metre per second.
    results.between('dv1_ms', plan.dv1, 2938, 2948);
    results.between('dv2_ms', plan.dv2, 2644, 2654);
    results.between('tof_days', plan.tof / 86400, 258.4, 259.4);
    results.between('phase_deg', plan.phaseAngle * RAD, 43.8, 44.8);
    // Departure windows repeat with the synodic period, about 26 months.
    results.between('synodic_days', plan.synodicPeriod / 86400, 770, 790);

    // And the transfer ellipse really does reach Mars' orbit.
    const vDeparture = Math.sqrt(mu / r1) + plan.dv1;
    const el = stateToElements(vec(r1, 0, 0), vec(0, vDeparture, 0), mu);
    results.below('aphelion_err_pct', Math.abs(el.apoapsis / r2 - 1) * 100, 3);
  },
};

const overrideFlight: Scenario = {
  id: 'override',
  description: 'the override drive crosses the solar system and stays collision-safe',
  simTimeout: 4000,
  setup(ctx) {
    const { world } = ctx;
    world.respawn();
    // Point away from Earth so the first move is not into the planet.
    const earth = world.bodyState('earth');
    sub(scratchA, world.ship.pos, earth.pos);
    normalize(scratchA, scratchA);
    world.ship.pointAt(scratchA);
    world.setOverrideStage(1);       // 5 c
    world.command.throttle = 1;
    ctx.memory.startDistance = len(world.ship.pos);
  },
  update(ctx) {
    ctx.memory.maxSpeed = Math.max(ctx.memory.maxSpeed ?? 0, ctx.world.ship.speed);
  },
  isDone: (ctx) => ctx.simElapsed > 400 || ctx.world.ship.destroyed,
  finish(ctx) {
    const { world, results, memory } = ctx;
    results.expect('mode', world.ship.mode === 'override', world.ship.mode);
    // 5 c means 5 c: the drive is explicitly not bound by light speed here.
    results.above('peak_c', (memory.maxSpeed ?? 0) / C_LIGHT, 4.5);
    results.below('peak_c_max', (memory.maxSpeed ?? 0) / C_LIGHT, 5.2);
    const travelled = Math.abs(len(world.ship.pos) - memory.startDistance!);
    results.above('travelled_au', travelled / AU, 1);

    // Dropping back to NORMAL must shed the illegal speed.
    world.command.throttle = 0;
    world.setNormalMode();
    results.below('after_normal_c', world.ship.speed / C_LIGHT, 0.1001);
  },
};

const perfScenario: Scenario = {
  id: 'perf',
  description: 'frame rate from low Earth orbit',
  simTimeout: 1e9,
  frameTimeout: 100_000,
  setup(ctx) {
    ctx.world.respawn();
    ctx.world.warp.requested = 1;
    ctx.memory.startReal = performance.now();
    ctx.memory.frameCount = 0;
    ctx.memory.worst = 0;
    ctx.memory.lastFrame = performance.now();
  },
  update(ctx) {
    const now = performance.now();
    const dt = now - (ctx.memory.lastFrame ?? now);
    ctx.memory.lastFrame = now;
    // Ignore the first few frames: shader compilation lands there.
    if ((ctx.memory.frameCount ?? 0) > 20) {
      ctx.memory.worst = Math.max(ctx.memory.worst ?? 0, dt);
    }
    ctx.memory.frameCount = (ctx.memory.frameCount ?? 0) + 1;
  },
  isDone: (ctx) => performance.now() - (ctx.memory.startReal ?? 0) > 10_000,
  finish(ctx) {
    const { results, memory } = ctx;
    const seconds = (performance.now() - memory.startReal!) / 1000;
    const fps = memory.frameCount! / seconds;
    if (document.visibilityState !== 'visible') {
      results.expect('skipped_hidden', true, 'tab not visible; rAF is throttled');
      return;
    }
    results.above('avg_fps', fps, 55);
    results.below('worst_frame_ms', memory.worst!, 60);
  },
};

const noAssets: Scenario = {
  id: 'no-assets',
  description: 'the procedural fallback carries the view when textures are missing',
  simTimeout: 5,
  setup(ctx) { ctx.world.respawn(); },
  isDone: (ctx) => ctx.frames > 40,
  finish(ctx) {
    const { renderer, results } = ctx;
    // Whether the textures arrived or not, the frame must still be rendering.
    results.above('draw_calls', renderer.drawCalls, 1);
    results.expect('textures', true,
      `${renderer.texturesLoaded} loaded / ${renderer.texturesFailed} missing`);
  },
};

export const SCENARIOS: Scenario[] = [
  bootScenario,
  angularSizes,
  leoOrbit,
  directFlight('moon-direct', 'moon', 1 * G0, 30 * 3600, { minHours: 0.5, maxHours: 12 }),
  directFlight('mars-direct', 'mars', 3 * G0, 400 * 3600, { minHours: 20, maxHours: 200 }),
  directFlight('saturn-direct', 'saturn', 3 * G0, 900 * 3600, { minHours: 60, maxHours: 400 }),
  jupiterSlingshot,
  collisionScenario,
  sunApproach,
  hohmannMars,
  overrideFlight,
  perfScenario,
  noAssets,
];

/** The acceptance tour: one flight through everything that matters. */
export const TOUR = [
  'angular-sizes', 'leo-orbit', 'moon-direct', 'mars-direct',
  'jupiter-slingshot', 'saturn-direct', 'sun-approach', 'collision',
  'hohmann-mars', 'override', 'no-assets',
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const FIXED_STEP = 1 / 60;

export class ScenarioRunner {
  private queue: Scenario[] = [];
  private current: Scenario | null = null;
  private ctx: ScenarioContext;
  private summary: Array<{ id: string; passed: boolean }> = [];
  private started = false;
  finished = false;

  constructor(
    private readonly world: World,
    private readonly renderer: SolarSystemRenderer,
    input: InputController,
    ids: string[],
  ) {
    this.ctx = {
      world, renderer, input,
      results: new Results(),
      simElapsed: 0,
      frames: 0,
      memory: {},
    };
    for (const id of ids) {
      const scenario = SCENARIOS.find((s) => s.id === id);
      if (scenario) this.queue.push(scenario);
      else console.warn(`[SCEN] unknown scenario ${id}`);
    }
  }

  /**
   * Run every queued scenario to completion without waiting for frames.
   *
   * Browsers throttle requestAnimationFrame in a hidden tab, which would make
   * a scripted flight take hours of wall time for no reason. This drives the
   * same code path synchronously instead, rendering periodically so the
   * scenarios that inspect the renderer still see a live frame.
   */
  runSync(maxFrames = 2_000_000): number {
    let frames = 0;
    if (!this.started) { this.started = true; this.advance(); }
    while (!this.finished && frames < maxFrames) {
      this.world.step(FIXED_STEP);
      if (frames % 30 === 0) this.renderer.render(this.world);
      this.afterFrame();
      frames++;
    }
    return frames;
  }

  /** Fixed simulated step so results do not depend on frame timing. */
  step(_dtReal: number): number {
    if (!this.started) {
      this.started = true;
      this.advance();
    }
    return this.current ? FIXED_STEP : _dtReal;
  }

  afterFrame(): void {
    const scenario = this.current;
    if (!scenario) return;

    this.ctx.frames++;
    this.ctx.simElapsed += FIXED_STEP * this.world.warp.effective;
    scenario.update?.(this.ctx);

    const timedOut = this.ctx.simElapsed > scenario.simTimeout
      || this.ctx.frames > (scenario.frameTimeout ?? 200_000);

    if (scenario.isDone(this.ctx) || timedOut) {
      if (timedOut) {
        this.ctx.results.expect('timeout', false,
          `sim=${(this.ctx.simElapsed / 3600).toFixed(1)}h frames=${this.ctx.frames}`);
      }
      try {
        scenario.finish(this.ctx);
      } catch (error) {
        this.ctx.results.expect('exception', false, String(error));
      }
      this.report(scenario);
      this.advance();
    }
  }

  private report(scenario: Scenario): void {
    const results = this.ctx.results;
    const passed = results.passed;
    const parts = results.checks
      .map((c) => `${c.name}=${c.value}${c.ok ? '' : '(FAIL)'}`)
      .join(' ');
    console.log(`[SCEN] name=${scenario.id} status=${passed ? 'PASS' : 'FAIL'} ${parts}`);
    this.summary.push({ id: scenario.id, passed });
  }

  private advance(): void {
    this.current = this.queue.shift() ?? null;
    this.ctx.results = new Results();
    this.ctx.simElapsed = 0;
    this.ctx.frames = 0;
    this.ctx.memory = {};

    if (!this.current) {
      this.finished = true;
      const failed = this.summary.filter((s) => !s.passed);
      console.log(
        `[SCEN] name=SUMMARY status=${failed.length === 0 ? 'PASS' : 'FAIL'} `
        + `ran=${this.summary.length} failed=${failed.length}`
        + (failed.length ? ` failing=${failed.map((f) => f.id).join(',')}` : ''),
      );
      (window as unknown as { SCENARIO_DONE: boolean }).SCENARIO_DONE = true;
      (window as unknown as { SCENARIO_RESULTS: unknown }).SCENARIO_RESULTS = this.summary;
      return;
    }

    this.world.respawn();
    this.ctx.input.clear();
    try {
      this.current.setup(this.ctx);
    } catch (error) {
      this.ctx.results.expect('setup', false, String(error));
    }
  }
}

/** Read `?scenario=` and build a runner, or return null for free flight. */
export const runScenarioFromUrl = (
  world: World,
  renderer: SolarSystemRenderer,
  input: InputController,
): ScenarioRunner | null => {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('scenario');
  if (!requested) return null;

  const ids = requested === 'tour'
    ? TOUR
    : requested === 'all'
      ? SCENARIOS.map((s) => s.id)
      : requested.split(',').map((s) => s.trim()).filter(Boolean);

  console.log(`[SCEN] name=START status=INFO scenarios=${ids.join(',')}`);
  return new ScenarioRunner(world, renderer, input, ids);
};

export { cross, dot, addScaled };
