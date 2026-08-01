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
import { Ambience } from './ui/audio';
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
    if (!route) return;
    // Face front for the opening frame; the shot is composed for that.
    input.recentreHead();
    world.head.pitch = 0;
    world.head.yaw = 0;
    world.startFlyby(route);
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

/**
 * Fullscreen, because the frame round the window is the one thing that keeps
 * insisting you are looking at a web page rather than out of a ship.
 */
const toggleFullscreen = (): void => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => {});
};

const ambience = new Ambience();

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
  toggleFullscreen: () => toggleFullscreen(),
  toggleMute: () => { ambience.toggleMute(); },
  toggleConsole: () => {
    hud.setSimple(!hud.simple);
    if (!hud.simple) world.flightModel = 'pilot';
  },
  toggleAutopilot: engageAutopilot,
  toggleOverride: () => {
    if (world.ship.mode === 'override') world.setNormalMode();
    else { world.setOverrideStage(world.ship.overrideStage); ambience.event('warp'); }
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

// Browsers will not make a sound until the user has touched something.
for (const event of ['pointerdown', 'keydown'] as const) {
  window.addEventListener(event, () => { void ambience.start(); }, { once: true });
}

// Registering one is what makes a browser offer to install the page at all,
// and it is what lets the installed app open without a network.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('./sw.js').then((registration) => {
      // Ask on every start, so an installed copy picks up a new build rather
      // than waiting for the browser to get round to checking.
      void registration.update();
    }).catch(() => {});
  });
  // When a new worker takes over, the page in front of it is still running the
  // old build. Reload it, once.
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}

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

/**
 * Attitude response. Torque over damping is the top rate — 0.16 / 0.6 is about
 * 15 deg/s — and one over the damping is how long it takes to get there, or to
 * settle again once the key is released.
 */
// It was 0.16 over 0.6 — a top rate of 15 deg/s reached in under two seconds,
// so a tap was already most of a turn. Real attitude thrusters on a ship this
// size are a rounding error against its moment of inertia; these are a quarter
// of the authority and take four seconds to reach 8 deg/s, which is slow
// enough that lining something up is a decision rather than a twitch.
const STEER_TORQUE = 0.04;
const HELD_DAMPING = 0.28;
const FREE_DAMPING = 0.22;
const steerRate = { pitch: 0, yaw: 0, roll: 0 };

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
    // The mouse turns the head; only the arrow keys and a click turn the ship.
    world.head.pitch = input.headPitch;
    world.head.yaw = input.headYaw;
    if (input.takeAim()) {
      world.ship.aim(input.headPitch, input.headYaw, 0);
      input.headPitch = 0;
      input.headYaw = 0;
    }
    // Steering has mass. The arrows ask for torque from the attitude
    // thrusters, and the rate builds and decays instead of switching — a ship
    // of this size cannot start and stop turning within one frame, and the
    // previous version, which simply added an angle per frame, read exactly as
    // digital as it was. The decay when nothing is held is the flight
    // assistant trimming the rate out, not friction; there is none.
    const steer = input.steerAxis();
    // Roll goes through the same mill. It was still adding an angle per frame,
    // which is the very thing the other two axes were taken off — a hull does
    // not start and stop rolling on a keystroke either. Its authority is a
    // little higher than pitch and yaw because there is less of the ship to
    // swing about the long axis, which is true of nearly every vehicle.
    const rollAxis = command.roll;
    const rate = (axis: number, current: number, torque: number): number => {
      const damping = axis === 0 ? FREE_DAMPING : HELD_DAMPING;
      const next = current + (axis * torque - current * damping) * dtReal;
      return Math.abs(next) < 1e-5 ? 0 : next;
    };
    steerRate.pitch = rate(steer.pitch, steerRate.pitch, STEER_TORQUE);
    steerRate.yaw = rate(steer.yaw, steerRate.yaw, STEER_TORQUE);
    steerRate.roll = rate(rollAxis, steerRate.roll, STEER_TORQUE * 1.4);

    const look = input.consumeLook();
    world.ship.aim(
      look.pitch + steerRate.pitch * dtReal,
      look.yaw + steerRate.yaw * dtReal,
      steerRate.roll * dtReal);
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
  // Attitude has exactly one owner, and in PILOT it is the block above, which
  // aims the ship directly through a torque model. Passing the same keys on
  // here as well drove every axis twice — the old path instantly and without
  // the inversion, the new one gently and with it, the two fighting each other.
  // It presented as "up/down is not inverted and something is pushing up",
  // which is precisely what two opposed controls on one axis feel like, and it
  // silently undid the roll inertia added a round earlier.
  const manual = world.flightModel !== 'pilot';
  world.command.pitch = manual ? command.pitch : 0;
  world.command.yaw = manual ? command.yaw : 0;
  world.command.roll = manual ? command.roll : 0;

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
  // The drive is the only thing with a voice, and it only has one while it is
  // actually burning — so coasting is silent, which is the physics said aloud.
  const burning = world.flightModel === 'pilot' && !world.flyby.active
    && (world.pilot.engaged || (world.pilot.stopping && world.referenceSpeed() > 5));
  // Nearness is one at a surface and nothing past a few radii out.
  const radius = getBody(world.nearest.id).radius;
  const nearness = Math.max(0, Math.min(1,
    1 - world.nearest.altitude / (radius * 2.5)));
  ambience.update(burning ? 1 : 0, dtReal, nearness);

  // Cold gas, on while the valve is open and off when it shuts.
  ambience.steering(input.isHeld('ArrowUp') || input.isHeld('ArrowDown')
    || input.isHeld('ArrowLeft') || input.isHeld('ArrowRight')
    || input.isHeld('KeyQ') || input.isHeld('KeyE'));

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
