/**
 * How bright things look.
 *
 * At true scale most of the solar system is a point of light, so "how big is
 * it on screen" is usually the wrong question and "how bright is it" is the
 * right one. Bodies smaller than a couple of pixels are drawn as point sources
 * whose brightness comes from their actual apparent magnitude, which is what
 * makes Venus a hard white spark and Pluto essentially invisible.
 */

import { AU, absoluteMagnitude, getBody, type BodyPhysical } from '../data/constants';
import { PHOTOMETRY } from '../config';
import type { Vec3 } from '../math/vec3d';
import { len, sub, vec, angleBetween, scale } from '../math/vec3d';

const toSun = vec();
const toObserver = vec();
const tmp = vec();

/**
 * Apparent visual magnitude of a body seen from `observer`.
 *
 *   m = H + 5 log10(r_sun * r_obs) - 2.5 log10(phase)
 *
 * with distances in AU. The phase function is the Lambert half-illumination
 * term, which is why an inner planet near conjunction dims sharply — the same
 * reason Venus is brightest as a crescent rather than when full.
 */
export const apparentMagnitude = (
  body: BodyPhysical,
  bodyPos: Vec3,
  observerPos: Vec3,
): number => {
  if (body.id === 'sun') {
    // The Sun's own magnitude follows the inverse-square law from -26.74 at 1 AU.
    const d = Math.max(len(observerPos), body.radius) / AU;
    return -26.74 + 5 * Math.log10(d);
  }

  // The Sun sits at the origin of the simulation frame.
  scale(toSun, bodyPos, -1);
  const rSun = len(toSun) / AU;
  sub(toObserver, observerPos, bodyPos);
  const rObs = len(toObserver) / AU;
  if (rSun <= 0 || rObs <= 0) return -30;

  const phaseAngle = angleBetween(toSun, toObserver);
  const phase = Math.max(1e-4, (1 + Math.cos(phaseAngle)) / 2);

  return absoluteMagnitude(body) + 5 * Math.log10(rSun * rObs) - 2.5 * Math.log10(phase);
};

/** Fraction of the disc that is lit, 0 (new) to 1 (full). */
export const illuminatedFraction = (bodyPos: Vec3, observerPos: Vec3): number => {
  scale(toSun, bodyPos, -1);
  sub(toObserver, observerPos, bodyPos);
  const phaseAngle = angleBetween(toSun, toObserver);
  return (1 + Math.cos(phaseAngle)) / 2;
};

/**
 * Map a magnitude onto a 0..1 display brightness. The ramp runs from the
 * naked-eye limit down to the saturation point; anything brighter than that
 * clips to 1 and grows in size instead.
 */
export const magnitudeToBrightness = (m: number): number => {
  const { faintestMagnitude: faint, saturationMagnitude: sat, gamma } = PHOTOMETRY;
  const x = (faint - m) / (faint - sat);
  return Math.pow(Math.max(0, Math.min(1, x)), gamma);
};

/** Relative flux, used to size the halo on saturated point sources. */
export const magnitudeToFlux = (m: number): number => Math.pow(10, -0.4 * m);

/** Angular diameter of a body in radians. */
export const angularDiameter = (radius: number, distance: number): number =>
  distance <= radius ? Math.PI : 2 * Math.asin(radius / distance);

/** Angular diameter in degrees, the form the HUD and tests use. */
export const angularDiameterDeg = (radius: number, distance: number): number =>
  (angularDiameter(radius, distance) * 180) / Math.PI;

/**
 * Apparent size in pixels, given the vertical field of view and viewport
 * height. This is what decides whether a body gets a mesh or a sprite.
 */
export const apparentPixels = (
  radius: number,
  distance: number,
  fovRadians: number,
  viewportHeight: number,
): number => (angularDiameter(radius, distance) / fovRadians) * viewportHeight;

/**
 * Solar irradiance at a distance, W/m^2. 1361 at Earth; this is what drives
 * how harshly lit a surface looks out at Saturn versus at Mercury.
 */
export const solarIrradiance = (distance: number): number => {
  const d = Math.max(distance, getBody('sun').radius);
  return 1361 * (AU / d) * (AU / d);
};

/**
 * Star colour from B-V colour index, as a linear RGB triple.
 * A rough but recognisable mapping: blue-white O/B stars, white A/F, yellow G,
 * orange K, red M.
 */
export const colorIndexToRGB = (bv: number): [number, number, number] => {
  const t = Math.max(-0.4, Math.min(2.0, bv));
  let r: number;
  let g: number;
  let b: number;
  if (t < 0.0) {
    r = 0.61 + 0.11 * t + 0.1 * t * t;
    g = 0.70 + 0.07 * t + 0.1 * t * t;
    b = 1.0;
  } else if (t < 0.4) {
    r = 0.83 + (0.17 / 0.4) * t;
    g = 0.87 + (0.11 / 0.4) * t;
    b = 1.0;
  } else if (t < 1.6) {
    r = 1.0;
    g = 0.98 - 0.16 * ((t - 0.4) / 1.2);
    b = 1.0 - 0.47 * ((t - 0.4) / 1.2) - 0.35 * Math.pow((t - 0.4) / 1.2, 2);
  } else {
    r = 1.0;
    g = 0.82 - 0.5 * ((t - 1.6) / 0.4);
    b = 0.18;
  }
  return [
    Math.max(0, Math.min(1, r)),
    Math.max(0, Math.min(1, g)),
    Math.max(0, Math.min(1, b)),
  ];
};

export { tmp as photometryScratch };
