/**
 * Propagation accuracy, the speed ceiling and collision detection.
 *
 * These run the real World loop rather than a stripped-down copy, so they
 * exercise the substep policy, the warp controller and the force model exactly
 * as the browser does.
 */

import { describe, expect, it } from 'vitest';
import { World } from '../../src/sim/world';
import { simTimeFromISO } from '../../src/sim/time';
import { substepBound, integrate } from '../../src/sim/integrator';
import { selectActiveBodies } from '../../src/sim/gravity';
import { ephemeris } from '../../src/sim/ephemeris';
import { stateToElements, elementsToState } from '../../src/sim/kepler';
import { AU, C_LIGHT, getBody } from '../../src/data/constants';
import { SPEED, G0 } from '../../src/config';
import { vec, len, sub, addScaled, normalize, scale } from '../../src/math/vec3d';

const T0 = simTimeFromISO('2026-07-29T00:00:00Z');

/** Run the world forward until `simSeconds` have elapsed or the ship is lost. */
const runFor = (world: World, simSeconds: number, warp: number, dtReal = 0.1): number => {
  world.warp.requested = warp;
  const target = world.clock.t + simSeconds;
  let frames = 0;
  while (world.clock.t < target && !world.ship.destroyed && frames < 400_000) {
    world.step(dtReal);
    frames++;
  }
  return frames;
};

describe('orbit propagation holds its energy', () => {
  it('keeps a 400 km LEO stable for 24 hours', () => {
    const world = new World(T0);
    const before = world.orbitInfo()!;
    expect(before.primary).toBe('earth');
    // The canonical circular speed at 400 km altitude.
    const relVel = vec();
    world.relativeVelocity('earth', relVel);
    expect(len(relVel)).toBeGreaterThan(7670);
    expect(len(relVel)).toBeLessThan(7676);
    expect(before.e).toBeLessThan(1e-3);

    runFor(world, 24 * 3600, 1000);

    const after = world.orbitInfo()!;
    expect(after.primary).toBe('earth');
    expect(Math.abs(after.a / before.a - 1)).toBeLessThan(1e-5);
    expect(after.e).toBeLessThan(2e-3);
  });

  it('propagates a heliocentric orbit independently of step size', () => {
    // A ship on a 1 AU orbit really is perturbed by the planets over a year,
    // so its elements are supposed to change. What must not change is the
    // answer as a function of how finely the year was integrated: running the
    // same year at 1e4x and at 1e6x differs by a hundredfold in step size, so
    // agreement between them measures the integrator rather than the physics.
    const mu = getBody('sun').mu;
    const run = (warp: number) => {
      const world = new World(T0);
      const pos = vec(AU, 0, 0.2 * AU);
      const speed = Math.sqrt(mu / len(pos));
      world.placeShip(pos, vec(0, speed, 0));
      runFor(world, 365.25 * 86400, warp);
      return stateToElements(world.ship.pos, world.ship.vel, mu);
    };

    const coarse = run(1_000_000);
    const fine = run(10_000);
    expect(Math.abs(coarse.a / fine.a - 1)).toBeLessThan(1e-6);
    expect(Math.abs(coarse.e - fine.e)).toBeLessThan(1e-6);
    // And the orbit is still recognisably the one it started on.
    expect(Math.abs(fine.a / len(vec(AU, 0, 0.2 * AU)) - 1)).toBeLessThan(1e-3);
  });

  it('matches the analytic two-body solution over a full year', () => {
    // There is nowhere in a real solar system where planetary perturbations
    // vanish, so isolating the integrator means removing the other planets
    // from the force model rather than flying somewhere quiet. The Sun sits at
    // the origin by construction, which makes this an exact Kepler problem
    // with a closed-form answer to check against.
    const mu = getBody('sun').mu;
    const sunOnly = [{ id: 'sun', mu, radius: getBody('sun').radius }];

    const state = {
      pos: vec(1.6 * AU, 0, 0),
      // 1.15x circular gives a clearly eccentric orbit, which stresses the
      // step-size policy far more than a circle does.
      vel: vec(0, 1.15 * Math.sqrt(mu / (1.6 * AU)), 0.05 * Math.sqrt(mu / (1.6 * AU))),
    };
    const initial = stateToElements(state.pos, state.vel, mu);

    const duration = 365.25 * 86400;
    const noThrust = vec();
    let elapsed = 0;
    while (elapsed < duration) {
      const dt = Math.min(20_000, duration - elapsed);
      integrate(state, dt, T0 + elapsed, ephemeris, sunOnly, noThrust, 25, 0.1);
      elapsed += dt;
    }

    // Analytic reference: same ellipse, mean anomaly advanced by n * duration.
    const n = Math.sqrt(mu / Math.pow(initial.a, 3));
    const refPos = vec();
    const refVel = vec();
    elementsToState(
      { ...initial, meanAnomaly: initial.meanAnomaly + n * duration },
      mu, refPos, refVel,
    );

    const err = vec();
    sub(err, state.pos, refPos);
    // Position error after a full revolution, relative to the orbit size.
    expect(len(err) / initial.a).toBeLessThan(1e-9);

    const final = stateToElements(state.pos, state.vel, mu);
    expect(Math.abs(final.a / initial.a - 1)).toBeLessThan(1e-11);
    expect(Math.abs(final.e - initial.e)).toBeLessThan(1e-11);
  });
});

describe('substep policy', () => {
  it('shrinks steps near a planet and relaxes far away', () => {
    const world = new World(T0);
    const active = selectActiveBodies(ephemeris, world.ship.pos, T0, []);

    const nearBound = substepBound(world.ship.pos, world.ship.vel, T0, ephemeris, active);
    // In LEO the orbit turns fast, so steps must stay short.
    expect(nearBound).toBeLessThan(30);
    expect(nearBound).toBeGreaterThan(1);

    const far = vec(30 * AU, 0, 0);
    const slow = vec(0, 5000, 0);
    const farActive = selectActiveBodies(ephemeris, far, T0, []);
    const farBound = substepBound(far, slow, T0, ephemeris, farActive);
    expect(farBound).toBeGreaterThan(nearBound * 100);
  });

  it('forces the warp down near a planet instead of losing accuracy', () => {
    const world = new World(T0);
    world.warp.requested = 1_000_000;
    for (let i = 0; i < 60; i++) world.step(0.1);
    // 1e6x in low orbit would need far more substeps than the budget allows,
    // so the controller must have throttled itself back.
    expect(world.warp.effective).toBeLessThan(1_000_000);
    expect(world.warp.reason).toBe('gravity');
    expect(Number.isFinite(world.ship.pos.x)).toBe(true);

    const orbit = world.orbitInfo()!;
    expect(Math.abs(orbit.a - (getBody('earth').radius + 400_000))).toBeLessThan(5000);
  });

  it('runs unthrottled in deep space', () => {
    const world = new World(T0);
    world.placeShip(vec(30 * AU, 5 * AU, 0), vec(0, 5000, 0));
    world.warp.requested = 1_000_000;
    // The warp ramps back up rather than jumping, so give it a few seconds.
    for (let i = 0; i < 200; i++) world.step(0.1);
    expect(world.warp.effective).toBeGreaterThan(100_000);
    expect(world.warp.reason).toBe('none');
  });
});

describe('speed regimes', () => {
  it('never lets the drive push past 0.1 c in NORMAL mode', () => {
    const world = new World(T0);
    // Out in open space at 0.09 c, then burn prograde at 10 g and keep burning
    // long past the point where an uncapped drive would have blown through.
    world.placeShip(vec(40 * AU, 0, 0), vec(0, 0.09 * C_LIGHT, 0));
    world.ship.maxAccel = 10 * G0;
    world.ship.pointAt(vec(0, 1, 0));
    world.command.throttle = 1;
    // Manual thrust holds the warp at 50, so this is 5 s of sim time a frame.
    world.warp.requested = 50;

    let maxSpeed = 0;
    let reachedCap = false;
    for (let i = 0; i < 12_000; i++) {
      world.step(0.1);
      maxSpeed = Math.max(maxSpeed, world.ship.speed);
      if (world.ship.speed > SPEED.normalCap * 0.9999) reachedCap = true;
    }
    expect(reachedCap).toBe(true);
    expect(maxSpeed).toBeLessThanOrEqual(SPEED.normalCap + 1);
  });

  it('leaves retrograde and lateral thrust available at the ceiling', () => {
    const world = new World(T0);
    world.placeShip(vec(40 * AU, 0, 0), vec(0, SPEED.normalCap, 0));
    const accel = vec();
    // Pointing retrograde: braking must still work at the cap.
    world.ship.pointAt(vec(0, -1, 0));
    world.ship.thrustAccel({ ...world.command, throttle: 1 }, accel);
    expect(accel.y).toBeLessThan(-1);

    // Pointing prograde: the drive is cut.
    world.ship.pointAt(vec(0, 1, 0));
    world.ship.thrustAccel({ ...world.command, throttle: 1 }, accel);
    expect(len(accel)).toBeLessThan(0.01);
  });

  it('reports the Lorentz factor the ceiling was chosen for', () => {
    const world = new World(T0);
    world.placeShip(vec(40 * AU, 0, 0), vec(0, SPEED.normalCap, 0));
    // 0.1 c: gamma - 1 is 0.5%, which is why Newtonian mechanics still holds.
    expect(world.ship.lorentzFactor - 1).toBeGreaterThan(0.004);
    expect(world.ship.lorentzFactor - 1).toBeLessThan(0.006);
  });

  it('sheds the excess when dropping out of OVERRIDE', () => {
    const world = new World(T0);
    world.placeShip(vec(40 * AU, 0, 0), vec(0, 5 * C_LIGHT, 0));
    world.ship.mode = 'override';
    world.setNormalMode();
    expect(world.ship.speed).toBeLessThanOrEqual(SPEED.normalCap + 1);
  });
});

describe('collision detection', () => {
  it('catches a pass straight through a planet at override speed', () => {
    const world = new World(T0);
    const earth = world.bodyState('earth');
    // Start well clear of Earth, aimed straight at its centre at 100 c.
    const dir = vec();
    normalize(dir, vec(1, 0.3, 0.1));
    const start = vec();
    addScaled(start, earth.pos, dir, 1.5e9);
    const vel = vec();
    scale(vel, dir, -100 * C_LIGHT);
    world.placeShip(start, vel);

    for (let i = 0; i < 200 && !world.ship.destroyed; i++) world.step(1 / 60);

    expect(world.ship.destroyed).toBe(true);
    expect(world.ship.destroyedBy).toBe('earth');
    // Contact must be recorded at the surface, not somewhere inside.
    const rel = vec();
    sub(rel, world.ship.pos, world.bodyState('earth').pos);
    const surface = getBody('earth').radiusCollide;
    expect(len(rel)).toBeGreaterThan(surface * 0.98);
    expect(len(rel)).toBeLessThan(surface * 1.05);
  });

  it('lets a grazing pass through untouched', () => {
    const world = new World(T0);
    const earth = world.bodyState('earth');
    const radius = getBody('earth').radiusCollide;
    // Offset the track by 1.2 radii: close, but a clean miss.
    const start = vec(earth.pos.x + 1.2 * radius, earth.pos.y - 5e8, earth.pos.z);
    const vel = vec(earth.vel.x, earth.vel.y + 3e7, earth.vel.z);
    world.placeShip(start, vel);

    for (let i = 0; i < 400 && !world.ship.destroyed; i++) world.step(1 / 60);
    expect(world.ship.destroyed).toBe(false);
  });

  it('ends the flight at the Sun photosphere', () => {
    const world = new World(T0);
    const sunRadius = getBody('sun').radius;
    world.placeShip(vec(3 * sunRadius, 0, 0), vec(-2e6, 0, 0));
    world.warp.requested = 10;
    for (let i = 0; i < 20_000 && !world.ship.destroyed; i++) world.step(0.1);
    expect(world.ship.destroyed).toBe(true);
    expect(world.ship.destroyedBy).toBe('sun');
    expect(len(world.ship.pos)).toBeLessThan(sunRadius * 1.05);
  });

  it('respawns into a clean orbit after a loss', () => {
    const world = new World(T0);
    world.ship.markDestroyed('earth', 8000);
    expect(world.ship.destroyed).toBe(true);
    world.respawn();
    expect(world.ship.destroyed).toBe(false);
    const orbit = world.orbitInfo()!;
    expect(orbit.primary).toBe('earth');
    expect(orbit.e).toBeLessThan(1e-3);
  });
});

describe('gravity model', () => {
  it('folds distant moons into their parent instead of dropping them', () => {
    const world = new World(T0);
    const farFromEarth = vec(AU * 5, 0, 0);
    const active = selectActiveBodies(ephemeris, farFromEarth, T0, []);
    const ids = active.map((b) => b.id);
    expect(ids).not.toContain('io');

    const jupiter = active.find((b) => b.id === 'jupiter')!;
    const jupiterAlone = getBody('jupiter').mu;
    // Jupiter must now carry the Galilean moons' mass.
    expect(jupiter.mu).toBeGreaterThan(jupiterAlone);
    const galilean = ['io', 'europa', 'ganymede', 'callisto']
      .reduce((sum, id) => sum + getBody(id).mu, 0);
    expect(jupiter.mu).toBeCloseTo(jupiterAlone + galilean, -6);
    void world;
  });

  it('activates moons once the ship is in their system', () => {
    const world = new World(T0);
    const jupiter = world.bodyState('jupiter');
    const near = vec(jupiter.pos.x + 1e9, jupiter.pos.y, jupiter.pos.z);
    const active = selectActiveBodies(ephemeris, near, T0, []);
    const ids = active.map((b) => b.id);
    expect(ids).toContain('io');
    expect(ids).toContain('europa');
    expect(ids).toContain('ganymede');
    expect(ids).toContain('callisto');
  });
});
