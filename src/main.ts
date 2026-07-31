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
import { PilotDrive } from './sim/pilot';
import { AUTOPILOT, RENDER, SHIP, SPEED } from './config';
import { getBody } from './data/constants';
import { installDebugApi } from './debug/simApi';
import { runScenarioFromUrl } from './scenarios/runner';
import { FLYBY_BY_ID } from './sim/flyby';
import type { AttitudeHold } from './sim/flightassist';
import { vec, sub } from './math/vec3d';

const HOLD_CYCLE: AttitudeHold[] = ['off', 'prograde', 'retrograde', 'target', 'nadir'];

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const world = new World();
const renderer = new SolarSystemRenderer(canvas);
// Flying, not orbital mechanics, is the default for a person at the controls.
world.flightModel = 'pilot';
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
    // "Orbit" means orbit *here*, around whatever the ship is closest to.
    const ok = world.enterOrbit();
    hud.setStatus(ok
      ? `Circular orbit around ${getBody(world.referenceId).name} established.`
      : 'Too close to a surface to establish an orbit.');
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
  onStartFlyby: (routeId) => {
    const route = FLYBY_BY_ID.get(routeId);
    if (route) world.startFlyby(route);
  },
  onCancelFlyby: () => world.flyby.stop(),
  onSetFlightModel: (model) => {
    world.flightModel = model;
    world.pilot.allStop();
    if (model === 'pilot') {
      world.autopilot.disengage();
      world.hohmann.disengage();
      world.killRelVel = false;
      world.hold = 'off';
    }
  },
  onAllStop: () => {
    world.pilot.allStop();
    world.autopilot.disengage();
    world.hohmann.disengage();
    world.flyby.stop();
    if (world.flightModel === 'orbital') world.killRelVel = true;
  },
  onFlyToTarget: engageAutopilot,
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
    if (world.flightModel === 'pilot') {
      world.pilot.allStop();
      hud.setStatus('All stop — holding station.');
      return;
    }
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
    if (world.flyby.active) { world.flyby.stop(); return; }
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

  if (world.flightModel === 'pilot' && !world.flyby.active && !world.autopilot.active
      && !world.hohmann.active && !world.ship.destroyed && !world.paused) {
    // Point the nose directly, then set the speed we are asking for. Nothing
    // integrates here, which is exactly why it feels like flying rather than
    // like nudging a projectile.
    const look = input.consumeLook();
    world.ship.aim(look.pitch, look.yaw, command.roll * 1.6 * dtReal);
    const ceiling = PilotDrive.ceiling(
      world.ship.mode, world.ship.overrideStage, world.nearest.altitude);
    world.pilot.throttle(input.throttleAxis(), dtReal, ceiling);
    // Coasting: the throttle reading follows the speed actually being flown, so
    // that pushing it again carries on from there instead of snapping back to
    // the last commanded figure.
    if (!world.pilot.engaged && !world.pilot.stopping) {
      world.pilot.syncTo(world.referenceSpeed());
    }
  }
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

  // A route may ask for a different lens; hand the normal one back when it ends.
  const routeFov = world.flyby.active ? world.flyby.route?.fov : undefined;
  renderer.setFov(routeFov ?? fov);

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

hud.setSimple(true);

document.getElementById('loading')?.classList.add('hide');

hud.setStatus('Pick a flypast, or fly it yourself: mouse to look, W and S for speed, '
  + 'SPACE to stop. Press H for the full list.');

requestAnimationFrame(frame);
