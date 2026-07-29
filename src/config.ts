/**
 * Every tunable in one place. Physics constants live in data/constants.ts;
 * this file holds the choices — caps, gains, thresholds — that shape how the
 * simulator flies and renders.
 */

import { C_LIGHT } from './data/constants';

/** Standard gravity, the unit accelerations are quoted in. */
export const G0 = 9.80665;

export const SHIP = {
  /** Hull length in metres. Sets the collision margin and the scale reference. */
  length: 50,
  /** Dry mass, kg. Only used by the rocket-equation reality check. */
  mass: 1.0e5,
  /** Default main-drive acceleration, m/s^2. */
  defaultAccel: 3 * G0,
  /** Range the pilot can dial the main drive over, m/s^2. */
  minAccel: 0.1 * G0,
  maxAccel: 100 * G0,
  /** Translation thruster (RCS) acceleration, m/s^2. */
  rcsAccel: 2 * G0,
  /** Peak attitude rate under full stick, rad/s. */
  maxAngularRate: 1.2,
  /** Attitude thruster authority, rad/s^2. */
  angularAccel: 3.0,
  /** How hard flight assist damps residual rotation, 1/s. */
  angularDamping: 4.0,
} as const;

export const SPEED = {
  /**
   * NORMAL mode ceiling: 0.1 c.
   *
   * Below this the Lorentz factor is 1.005, so momentum is Newtonian to 0.5%
   * and kinetic energy to 0.75% — the point where the physics this simulator
   * actually integrates is still the physics that applies. Above it the model
   * would be quietly wrong, so the drive simply stops pushing.
   */
  normalCap: 0.1 * C_LIGHT,
  /** OVERRIDE stages as multiples of c. Explicitly not physical. */
  overrideStages: [1, 5, 20, 100],
  /** Seconds to slew between override speeds. */
  overrideSlew: 2.0,
} as const;

export const WARP = {
  /** Selectable time-warp factors. */
  stages: [1, 2, 5, 10, 50, 100, 1000, 10_000, 100_000, 1_000_000] as number[],
  /** How fast the effective warp climbs back after gravity forces it down. */
  recoverPerSecond: 2.0,
  /** Manual thrust is only meaningful while the pilot can react. */
  maxWithManualThrust: 50,
  /** Above this, attitude is set directly rather than integrated. */
  maxWithManualAttitude: 100,
} as const;

export const INTEGRATOR = {
  /**
   * Largest angle (radians) a body's orbit may sweep in one substep. 0.02 rad
   * puts about 314 steps in a full orbit, which keeps RK4 error negligible.
   */
  eta: 0.02,
  /** Hard ceiling on substeps per frame; overflow forces the warp down. */
  maxSubsteps: 2048,
  /** Fraction of the distance to the nearest surface a step may cross. */
  proximityFraction: 0.25,
  /** Real-time seconds of simulation advanced per frame, before warp. */
  maxFrameDt: 0.1,
  /** Substeps between step-doubling accuracy checks. */
  watchdogInterval: 16,
} as const;

export const GRAVITY = {
  /**
   * A moon joins the force model once the ship is within this many of its
   * orbital radii of its parent. Outside that its pull is indistinguishable
   * from the parent's, so its mass is folded into the parent instead — which
   * keeps the total mass right rather than quietly discarding it.
   */
  moonActivationRadii: 200,
} as const;

export const AUTOPILOT = {
  /** Arrival standoff, in target radii. */
  standoffRadii: 4,
  /** Selectable cruise accelerations, m/s^2. */
  accelPresets: [1 * G0, 3 * G0, 10 * G0],
  /** Fraction of available thrust the braking profile plans on using. */
  brakeMargin: 0.85,
  /** Velocity-tracking time constant, s. */
  tau: 20,
  /** Distance inside which the approach is treated as terminal, in radii. */
  terminalRadii: 100,
  /** Arrival test: relative speed, m/s. */
  arrivalSpeed: 1.0,
  /** Warp ceiling while the drive is lit. */
  maxWarpUnderThrust: 1000,
  /** Warp ceiling during terminal approach. */
  maxWarpTerminal: 100,
} as const;

export const RENDER = {
  /** Vertical field of view, degrees. */
  fov: 60,
  fovMin: 20,
  fovMax: 100,
  near: 1,
  far: 1e14,
  /** Distance the star sphere sits at, m. Far beyond Pluto, inside `far`. */
  starDistance: 1e13,
  /** Below this apparent size in pixels a body is drawn as a point of light. */
  impostorPixels: 2.0,
  /** Sphere tessellation steps, chosen by apparent size. */
  lodSegments: [16, 32, 64, 128, 256],
} as const;

export const PHOTOMETRY = {
  /** Faintest magnitude drawn. Naked-eye limit is about 6.5. */
  faintestMagnitude: 6.5,
  /** Magnitude at which a point source saturates and starts to bloom. */
  saturationMagnitude: -1.0,
  /** Display gamma applied to the brightness ramp. */
  gamma: 0.7,
} as const;

/** Bodies offered in the navigation target list, in flight order. */
export const NAV_TARGETS = [
  'sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'phobos', 'deimos',
  'jupiter', 'io', 'europa', 'ganymede', 'callisto',
  'saturn', 'mimas', 'enceladus', 'rhea', 'titan', 'iapetus',
  'uranus', 'titania', 'oberon', 'neptune', 'triton', 'pluto', 'charon',
] as const;
