/**
 * Entry point: build the world, the view and the console, then run the loop.
 *
 * The loop is deliberately simple — read input, step the simulation by the
 * real elapsed time, render, update the console. All the difficulty lives in
 * the simulation, where it belongs.
 */

import { SolarSystemRenderer } from './render/scene';
import { Hud } from './ui/hud';
import { InputController } from './ui/input';
import { World } from './sim/world';
import { AUTOPILOT, RENDER, SHIP, SPEED, WARP } from './config';
import { getBody } from './data/constants';
import { installDebugApi } from './debug/simApi';
import { runScenarioFromUrl } from './scenarios/runner';
import type { AttitudeHold } from './sim/flightassist';
import { vec, sub } from './math/vec3d';

const HOLD_CYCLE: AttitudeHold[] = ['off', 'prograde', 'retrograde', 'target', 'nadir'];

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const world = new World();
const renderer = new SolarSystemRenderer(canvas);
let fov = RENDER.fov;

const engageAutopilot = (): void => {
  if (world.autopilot.active || world.hohmann.active) {
    world.autopilot.disengage();
    world.hohmann.disengage();
    return;
  }
  world.autopilot.circularizeOnArrival = false;
  world.autopilot.engage(world.targetId, world.autopilot.accel, SPEED.normalCap);
};

const hud = new Hud({
  onEngageAutopilot: engageAutopilot,
  onDisengageAutopilot: () => {
    world.autopilot.disengage();
    world.hohmann.disengage();
  },
  onCircularize: () => {
    world.autopilot.circularizeOnArrival = true;
    if (!world.autopilot.active) {
      world.autopilot.engage(world.targetId, world.autopilot.accel, SPEED.normalCap);
    }
  },
  onHohmann: () => {
    world.autopilot.disengage();
    const ok = world.hohmann.engage(
      world.ship.pos, world.targetId, world.clock.t, world.autopilot.accel);
    hud.setStatus(ok
      ? formatHohmannPlan()
      : 'Hohmann transfer needs a heliocentric orbit and a planetary target.');
  },
  onSetAccel: (accel) => { world.autopilot.accel = accel; },
  onSetTarget: (id) => { world.targetId = id; },
  onSetWarpStage: (index) => world.warp.setStage(index),
  onSetMode: (mode) => {
    if (mode === 'override') world.setOverrideStage(world.ship.overrideStage);
    else world.setNormalMode();
  },
  onSetOverrideStage: (index) => world.setOverrideStage(index),
  onToggleHelp: () => toggleHelp(),
  onRespawn: () => { world.respawn(); hud.hideOverlay(); },
  onSetHold: (hold) => { world.hold = hold; },
  onToggleAssist: () => { world.ship.flightAssist = !world.ship.flightAssist; },
});

const formatHohmannPlan = (): string => {
  const plan = world.hohmann.plan;
  if (!plan) return '';
  return `Hohmann to ${getBody(world.targetId).name}: `
    + `Δv1 ${(plan.dv1 / 1000).toFixed(3)} km/s, Δv2 ${(plan.dv2 / 1000).toFixed(3)} km/s, `
    + `flight ${(plan.tof / 86400).toFixed(1)} d, `
    + `phase ${(plan.phaseAngle * 180 / Math.PI).toFixed(1)}°, `
    + `window in ${(plan.waitTime / 86400).toFixed(1)} d `
    + `(every ${(plan.synodicPeriod / 86400).toFixed(0)} d)`;
};

const toggleHelp = (): void => {
  if (hud.helpVisible) hud.hideOverlay();
  else hud.showHelp();
};

const input = new InputController(canvas, {
  killRelativeVelocity: () => {
    world.killRelVel = !world.killRelVel;
    if (world.killRelVel) {
      world.autopilot.disengage();
      world.hohmann.disengage();
    }
  },
  cycleTarget: (delta) => world.cycleTarget(delta),
  toggleHelp,
  toggleAutopilot: engageAutopilot,
  toggleOverride: () => {
    if (world.ship.mode === 'override') world.setNormalMode();
    else world.setOverrideStage(world.ship.overrideStage);
  },
  setAccelPreset: (index) => {
    const value = AUTOPILOT.accelPresets[index];
    if (value !== undefined) world.autopilot.accel = value;
  },
  stepWarp: (delta) => world.warp.stepStage(delta),
  togglePause: () => { world.paused = !world.paused; },
  toggleFlightAssist: () => { world.ship.flightAssist = !world.ship.flightAssist; },
  respawn: () => { world.respawn(); hud.hideOverlay(); },
  pointAtTarget: () => {
    const target = world.bodyState(world.targetId);
    const dir = vec();
    sub(dir, target.pos, world.ship.pos);
    world.ship.pointAt(dir);
  },
  adjustFov: (delta) => {
    fov = Math.max(RENDER.fovMin, Math.min(RENDER.fovMax, fov + delta));
    renderer.setFov(fov);
  },
  adjustMaxAccel: (factor) => {
    world.ship.maxAccel = Math.max(SHIP.minAccel,
      Math.min(SHIP.maxAccel, world.ship.maxAccel * factor));
  },
  cycleHold: () => {
    const i = HOLD_CYCLE.indexOf(world.hold);
    world.hold = HOLD_CYCLE[(i + 1) % HOLD_CYCLE.length]!;
  },
  releaseMouse: () => {
    // An overlay is the more urgent thing to dismiss; otherwise hand the
    // cursor back so the console can be clicked.
    if (hud.overlayShown) hud.hideOverlay();
    else if (document.pointerLockElement) document.exitPointerLock();
  },
});

renderer.loadTextures();
renderer.onContextLost = () => hud.setStatus('Graphics context lost — restoring…');
renderer.onContextRestored = () => hud.setStatus('Graphics context restored.');

window.addEventListener('resize', () => renderer.resize());

// --- Frame loop -------------------------------------------------------------

let lastTime = performance.now();
let fpsAccumulator = 0;
let fpsFrames = 0;
let fps = 60;
let wasDestroyed = false;

const scenario = installScenario();

const frame = (now: number): void => {
  const dtReal = Math.min((now - lastTime) / 1000, 0.25);
  lastTime = now;

  fpsAccumulator += dtReal;
  fpsFrames++;
  if (fpsAccumulator >= 0.5) {
    fps = fpsFrames / fpsAccumulator;
    fpsAccumulator = 0;
    fpsFrames = 0;
  }

  // A scenario drives the clock itself so its results are reproducible.
  const step = scenario?.step(dtReal) ?? dtReal;

  const command = input.update(dtReal);
  world.command.throttle = command.throttle;
  world.command.rcsX = command.rcsX;
  world.command.rcsY = command.rcsY;
  world.command.rcsZ = command.rcsZ;
  world.command.pitch = command.pitch;
  world.command.yaw = command.yaw;
  world.command.roll = command.roll;

  world.step(step);

  if (world.ship.destroyed && !wasDestroyed) {
    hud.showDestroyed(
      getBody(world.ship.destroyedBy ?? 'earth').name, world.ship.impactSpeed);
  } else if (!world.ship.destroyed && wasDestroyed) {
    hud.hideOverlay();
  }
  wasDestroyed = world.ship.destroyed;

  renderer.render(world);
  hud.update(world, renderer, fps, input.pointerLocked);
  scenario?.afterFrame();

  requestAnimationFrame(frame);
};

function installScenario() {
  const runner = runScenarioFromUrl(world, renderer, input);
  (window as unknown as { SCENARIO_RUNNER: unknown }).SCENARIO_RUNNER = runner;
  return runner;
}

installDebugApi({ world, renderer, hud, input, getFps: () => fps });

document.getElementById('loading')?.classList.add('hide');

hud.setStatus(
  `Ready. ${WARP.stages.length} warp steps, drive ${(world.ship.maxAccel / 9.80665).toFixed(0)} g. `
  + 'Press H for controls.');

requestAnimationFrame(frame);
