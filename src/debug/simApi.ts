/**
 * `window.SIM` — a scriptable handle on the running simulation.
 *
 * This exists so the simulator can be checked without a human watching it:
 * angular sizes, orbital elements, autopilot state and frame timing are all
 * readable from the console, and the ship can be placed anywhere to set up a
 * test. The scenario runner is built on it.
 */

import { AU, getBody, BODIES } from '../data/constants';
import { angularDiameterDeg, apparentMagnitude } from '../sim/photometry';
import type { World } from '../sim/world';
import type { SolarSystemRenderer } from '../render/scene';
import type { Hud } from '../ui/hud';
import type { InputController } from '../ui/input';
import { len, sub, vec } from '../math/vec3d';

const tmp = vec();

export interface DebugContext {
  world: World;
  renderer: SolarSystemRenderer;
  hud: Hud;
  input: InputController;
  getFps: () => number;
}

export interface SimApi {
  version: string;
  world: World;
  renderer: SolarSystemRenderer;
  hud: Hud;
  input: InputController;
  /** Advance and redraw one frame without waiting for the animation loop. */
  frame(dt?: number): void;
  getShip(): Record<string, unknown>;
  getBody(id: string): Record<string, unknown>;
  angularDiameterDeg(id: string): number;
  apparentMagnitude(id: string): number;
  distanceTo(id: string): number;
  altitudeAbove(id: string): number;
  relativeSpeed(id: string): number;
  orbit(): unknown;
  autopilot(): unknown;
  setTarget(id: string): void;
  setWarp(factor: number): void;
  setMode(mode: 'normal' | 'override'): void;
  setOverrideStage(index: number): void;
  engage(targetId?: string, accel?: number): void;
  disengage(): void;
  hohmann(targetId?: string): unknown;
  placeShip(pos: [number, number, number], vel: [number, number, number]): void;
  placeInOrbit(bodyId: string, altitude: number): void;
  pointAt(id: string): void;
  respawn(): void;
  step(seconds: number): void;
  perf(): Record<string, number>;
  bodies(): string[];
  texturesLoaded(): { loaded: number; failed: number };
  AU: number;
}

export const installDebugApi = (ctx: DebugContext): SimApi => {
  const { world, renderer } = ctx;

  const api: SimApi = {
    version: '1.0.0',
    world,
    renderer,
    hud: ctx.hud,
    input: ctx.input,

    // A browser suspends requestAnimationFrame entirely in a hidden tab, so a
    // scripted check cannot rely on the animation loop having run. This drives
    // one complete frame - simulation, render and console - on demand.
    frame: (dt = 1 / 60) => {
      world.step(dt);
      renderer.render(world);
      ctx.hud.update(world, renderer, ctx.getFps(), ctx.input.pointerLocked);
    },

    getShip: () => ({
      pos: [world.ship.pos.x, world.ship.pos.y, world.ship.pos.z],
      vel: [world.ship.vel.x, world.ship.vel.y, world.ship.vel.z],
      speed: world.ship.speed,
      speedRelReference: world.referenceSpeed(),
      lorentz: world.ship.lorentzFactor,
      mode: world.ship.mode,
      overrideStage: world.ship.overrideStage,
      maxAccel: world.ship.maxAccel,
      currentAccel: world.ship.currentAccel,
      deltaVUsed: world.ship.deltaVUsed,
      destroyed: world.ship.destroyed,
      destroyedBy: world.ship.destroyedBy,
      impactSpeed: world.ship.impactSpeed,
      reference: world.referenceId,
      target: world.targetId,
      simTime: world.clock.t,
      elapsed: world.clock.elapsed,
      warp: world.warp.effective,
      warpRequested: world.warp.requested,
      warpReason: world.warp.reason,
      substeps: world.lastSubsteps,
    }),

    getBody: (id: string) => {
      const state = world.bodyState(id);
      const def = getBody(id);
      return {
        id,
        name: def.name,
        radius: def.radius,
        mu: def.mu,
        pos: [state.pos.x, state.pos.y, state.pos.z],
        vel: [state.vel.x, state.vel.y, state.vel.z],
        distance: api.distanceTo(id),
        angularDiameterDeg: api.angularDiameterDeg(id),
      };
    },

    angularDiameterDeg: (id: string) =>
      angularDiameterDeg(getBody(id).radius, api.distanceTo(id)),

    apparentMagnitude: (id: string) =>
      apparentMagnitude(getBody(id), world.bodyState(id).pos, world.ship.pos),

    distanceTo: (id: string) => {
      sub(tmp, world.bodyState(id).pos, world.ship.pos);
      return len(tmp);
    },

    altitudeAbove: (id: string) => api.distanceTo(id) - getBody(id).radiusCollide,

    relativeSpeed: (id: string) => {
      world.relativeVelocity(id, tmp);
      return len(tmp);
    },

    orbit: () => world.orbitInfo(),
    autopilot: () => ({
      ...world.autopilot.status(world.ship),
      hohmannPhase: world.hohmann.phase,
      hohmannPlan: world.hohmann.plan,
      hohmannMiss: world.hohmann.missDistance,
    }),

    setTarget: (id: string) => { world.targetId = id; },
    setWarp: (factor: number) => {
      world.warp.requested = factor;
      world.warp.effective = Math.min(world.warp.effective, factor);
    },
    setMode: (mode) => {
      if (mode === 'override') world.setOverrideStage(world.ship.overrideStage);
      else world.setNormalMode();
    },
    setOverrideStage: (index: number) => world.setOverrideStage(index),

    engage: (targetId?: string, accel?: number) => {
      if (targetId) world.targetId = targetId;
      if (accel) world.autopilot.accel = accel;
      world.autopilot.engage(world.targetId, world.autopilot.accel, world.autopilot.speedCap);
    },
    disengage: () => {
      world.autopilot.disengage();
      world.hohmann.disengage();
    },
    hohmann: (targetId?: string) => {
      if (targetId) world.targetId = targetId;
      world.hohmann.engage(world.ship.pos, world.targetId, world.clock.t, world.autopilot.accel);
      return world.hohmann.plan;
    },

    placeShip: (pos, vel) => {
      world.placeShip(
        { x: pos[0], y: pos[1], z: pos[2] },
        { x: vel[0], y: vel[1], z: vel[2] });
    },
    placeInOrbit: (bodyId: string, altitude: number) => {
      world.ship.spawnInOrbit(bodyId, altitude, world.clock.t, getBody(bodyId).radius);
      world.updateBodyStates();
    },
    pointAt: (id: string) => {
      sub(tmp, world.bodyState(id).pos, world.ship.pos);
      world.ship.pointAt(tmp);
    },
    respawn: () => world.respawn(),
    step: (seconds: number) => world.step(seconds),

    perf: () => ({
      fps: ctx.getFps(),
      drawCalls: renderer.drawCalls,
      substeps: world.lastSubsteps,
      warp: world.warp.effective,
      dtSim: world.lastDtSim,
      stepError: world.lastStepError,
    }),

    bodies: () => BODIES.map((b) => b.id),
    texturesLoaded: () => ({
      loaded: renderer.texturesLoaded,
      failed: renderer.texturesFailed,
    }),

    AU,
  };

  (window as unknown as { SIM: SimApi }).SIM = api;
  return api;
};
