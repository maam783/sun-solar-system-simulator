/**
 * Sightseeing routes — the flypasts worth having a ship for.
 *
 * Each route is a handful of waypoints given in a *scenic frame* anchored to
 * the body: one axis points at whatever the shot is about (the Sun, or another
 * body), one along the body's own rotation axis, one across. Offsets are in
 * body radii. That makes a route a description of a shot rather than a list of
 * coordinates — "pass two radii out, just under the ring plane, and climb
 * through it" — and it comes out right whatever the date, because the frame is
 * rebuilt from the real positions every frame.
 *
 * The ship is flown along the path directly rather than steered onto it. These
 * are camera moves; the point is the view, and a guidance loop that mostly
 * gets there would only make the framing worse.
 */

import { getBody } from '../data/constants';
import { ephemeris } from './ephemeris';
import type { Vec3 } from '../math/vec3d';
import {
  addScaled, copy, cross, len, normalize, scale, set, sub, vec, dot,
} from '../math/vec3d';
import { bodyNorthPole } from './frames';

export interface FlybyStop {
  /** Position in body radii: [toward subject, across, along the pole]. */
  at: [number, number, number];
  /** Seconds spent flying from the previous stop to this one. */
  seconds: number;
}

export interface FlybyRoute {
  id: string;
  name: string;
  blurb: string;
  /** Body the offsets are measured from. */
  body: string;
  /** Body the camera looks at. Defaults to `body`. */
  subject?: string;
  stops: FlybyStop[];
}

export const FLYBY_ROUTES: readonly FlybyRoute[] = [
  {
    id: 'saturn-rings',
    name: 'Saturn — through the rings',
    blurb: 'Approach from below, cross the ring plane at two radii, climb away.',
    body: 'saturn',
    stops: [
      { at: [7.5, -7.5, -2.6], seconds: 0 },
      { at: [3.4, -3.0, -0.9], seconds: 13 },
      { at: [2.05, -0.9, -0.10], seconds: 11 },
      { at: [1.95, 0.9, 0.07], seconds: 7 },
      { at: [3.4, 3.4, 1.1], seconds: 11 },
      { at: [7.0, 6.5, 2.6], seconds: 12 },
    ],
  },
  {
    id: 'jupiter-skim',
    name: 'Jupiter — over the cloud tops',
    blurb: 'A low pass across the belts, close enough to lose the horizon.',
    body: 'jupiter',
    stops: [
      { at: [8, -8, 2.2], seconds: 0 },
      { at: [2.4, -2.4, 0.6], seconds: 13 },
      { at: [1.13, -0.55, 0.07], seconds: 11 },
      { at: [1.11, 0.65, 0.03], seconds: 8 },
      { at: [2.6, 2.9, 0.5], seconds: 11 },
      { at: [7.5, 7.5, 1.8], seconds: 12 },
    ],
  },
  {
    id: 'earthrise',
    name: 'Earthrise from the Moon',
    blurb: 'Hold behind the lunar limb and let Earth climb over it.',
    body: 'moon',
    subject: 'earth',
    stops: [
      { at: [-2.3, -0.5, 0.35], seconds: 0 },
      { at: [-1.65, 0.15, 0.16], seconds: 12 },
      { at: [-1.45, 0.95, 0.07], seconds: 12 },
      { at: [-1.5, 1.7, 0.03], seconds: 10 },
      { at: [-2.0, 2.8, 0.06], seconds: 12 },
    ],
  },
  {
    id: 'io-jupiter',
    name: 'Io, with Jupiter behind',
    blurb: 'Round the volcanic moon with Jupiter filling twenty degrees of sky.',
    body: 'io',
    subject: 'jupiter',
    stops: [
      { at: [-4.5, -3.2, 1.1], seconds: 0 },
      { at: [-2.3, -1.3, 0.45], seconds: 12 },
      { at: [-1.7, 0.5, 0.12], seconds: 11 },
      { at: [-2.1, 1.9, 0.4], seconds: 10 },
      { at: [-4.0, 3.6, 1.0], seconds: 12 },
    ],
  },
  {
    id: 'sun-pass',
    name: 'Solar close pass',
    blurb: 'Three and a half radii off the photosphere. It fills the window.',
    body: 'sun',
    stops: [
      { at: [15, -15, 3.5], seconds: 0 },
      { at: [5.5, -5.5, 1.2], seconds: 13 },
      { at: [3.5, -0.4, 0.25], seconds: 11 },
      { at: [3.6, 1.6, 0.25], seconds: 7 },
      { at: [6.0, 6.0, 1.2], seconds: 11 },
      { at: [15, 14, 3.5], seconds: 12 },
    ],
  },
  {
    id: 'mars-lowpass',
    name: 'Mars — low pass',
    blurb: 'Down to the deck and across the terminator into the night side.',
    body: 'mars',
    stops: [
      { at: [5, -5, 1.3], seconds: 0 },
      { at: [1.9, -1.7, 0.35], seconds: 12 },
      { at: [1.07, -0.35, 0.05], seconds: 11 },
      { at: [1.06, 0.55, 0.02], seconds: 8 },
      { at: [2.3, 2.1, 0.35], seconds: 11 },
      { at: [5, 5, 1.3], seconds: 11 },
    ],
  },
];

export const FLYBY_BY_ID: ReadonlyMap<string, FlybyRoute> = new Map(
  FLYBY_ROUTES.map((r) => [r.id, r]),
);

// --- scenic frame -----------------------------------------------------------

const axisX = vec();
const axisY = vec();
const axisZ = vec();
const bodyPos = vec();
const bodyVel = vec();
const subjectPos = vec();
const subjectVel = vec();
const tmp = vec();
const posA = vec();
const posB = vec();

/**
 * Build the frame a route's offsets are measured in.
 *
 * X points at the subject (or at the Sun when the subject is the body itself,
 * so the shot is of a lit face rather than a silhouette). Z follows the body's
 * rotation axis, which is what puts Saturn's rings in the Z = 0 plane and makes
 * "cross the ring plane" expressible as a sign change.
 */
const scenicFrame = (route: FlybyRoute, t: number): void => {
  ephemeris.state(route.body, t, bodyPos, bodyVel);
  const subject = route.subject ?? route.body;

  if (route.body === 'sun') {
    // The Sun has no sunward direction; use the ecliptic frame instead.
    set(axisX, 1, 0, 0);
    set(axisZ, 0, 0, 1);
  } else {
    if (subject === route.body) {
      normalize(axisX, scale(tmp, bodyPos, -1));
    } else {
      ephemeris.state(subject, t, subjectPos, subjectVel);
      sub(tmp, subjectPos, bodyPos);
      normalize(axisX, tmp);
    }
    bodyNorthPole(axisZ, route.body, t);
  }

  // Orthogonalise Z against X so the frame stays square even when a pole
  // happens to lie close to the subject direction.
  const along = dot(axisZ, axisX);
  addScaled(axisZ, axisZ, axisX, -along);
  if (len(axisZ) < 1e-6) set(axisZ, 0, 0, 1);
  normalize(axisZ, axisZ);
  cross(axisY, axisZ, axisX);
  normalize(axisY, axisY);
};

/** Scenic-frame offset (in radii) to a world position. */
const toWorld = (route: FlybyRoute, at: readonly number[], out: Vec3): Vec3 => {
  const radius = getBody(route.body).radius;
  copy(out, bodyPos);
  addScaled(out, out, axisX, at[0]! * radius);
  addScaled(out, out, axisY, at[1]! * radius);
  addScaled(out, out, axisZ, at[2]! * radius);
  return out;
};

/** Catmull-Rom, clamped at the ends by repeating the outer control points. */
const splineAt = (stops: readonly FlybyStop[], u: number, out: number[]): void => {
  const n = stops.length;
  const i = Math.max(0, Math.min(n - 2, Math.floor(u)));
  const s = Math.max(0, Math.min(1, u - i));
  const p = (k: number) => stops[Math.max(0, Math.min(n - 1, k))]!.at;
  const p0 = p(i - 1);
  const p1 = p(i);
  const p2 = p(i + 1);
  const p3 = p(i + 2);
  const s2 = s * s;
  const s3 = s2 * s;
  for (let c = 0; c < 3; c++) {
    out[c] = 0.5 * (
      2 * p1[c]! +
      (-p0[c]! + p2[c]!) * s +
      (2 * p0[c]! - 5 * p1[c]! + 4 * p2[c]! - p3[c]!) * s2 +
      (-p0[c]! + 3 * p1[c]! - 3 * p2[c]! + p3[c]!) * s3
    );
  }
};

const scratchAt = [0, 0, 0];

export class FlybyDirector {
  active = false;
  route: FlybyRoute | null = null;
  /** Seconds into the route. */
  elapsed = 0;
  message = '';

  private cumulative: number[] = [];
  private total = 0;

  start(route: FlybyRoute): void {
    this.route = route;
    this.active = true;
    this.elapsed = 0;
    this.message = route.name;

    this.cumulative = [0];
    let sum = 0;
    for (let i = 1; i < route.stops.length; i++) {
      sum += route.stops[i]!.seconds;
      this.cumulative.push(sum);
    }
    this.total = sum;
  }

  stop(): void {
    this.active = false;
    this.route = null;
    this.message = '';
  }

  get progress(): number {
    return this.total > 0 ? Math.min(1, this.elapsed / this.total) : 0;
  }

  /** Segment coordinate for a time in seconds. */
  private segmentAt(seconds: number): number {
    const c = this.cumulative;
    if (seconds <= 0) return 0;
    for (let i = 1; i < c.length; i++) {
      if (seconds <= c[i]!) {
        const span = c[i]! - c[i - 1]!;
        const f = span > 0 ? (seconds - c[i - 1]!) / span : 0;
        // Ease each leg so the ship arrives and leaves smoothly rather than
        // snapping direction at every waypoint.
        const eased = f * f * (3 - 2 * f);
        return i - 1 + eased;
      }
    }
    return c.length - 1;
  }

  /** World position along the route at a given time offset. */
  private sample(seconds: number, t: number, out: Vec3): void {
    const route = this.route!;
    scenicFrame(route, t);
    splineAt(route.stops, this.segmentAt(seconds), scratchAt);
    toWorld(route, scratchAt, out);

    // The spline can bulge inward between waypoints; never let it inside the
    // body it is flying around.
    sub(tmp, out, bodyPos);
    const radius = getBody(route.body).radius;
    const distance = len(tmp);
    const floor = radius * 1.04;
    if (distance < floor && distance > 0) {
      normalize(tmp, tmp);
      copy(out, bodyPos);
      addScaled(out, out, tmp, floor);
    }
  }

  /**
   * Advance the route and place the ship. Velocity comes from differencing the
   * path, so the HUD still reads a real speed and the stars streak correctly.
   */
  update(dt: number, t: number, outPos: Vec3, outVel: Vec3, outLook: Vec3, outUp: Vec3): boolean {
    if (!this.active || !this.route) return false;
    this.elapsed += dt;

    const h = 0.08;
    this.sample(this.elapsed, t, posA);
    this.sample(this.elapsed + h, t + h, posB);
    copy(outPos, posA);
    sub(outVel, posB, posA);
    scale(outVel, outVel, 1 / h);

    const subject = this.route.subject ?? this.route.body;
    ephemeris.state(subject, t, subjectPos, subjectVel);
    sub(outLook, subjectPos, outPos);
    normalize(outLook, outLook);
    // Keep the body's own axis up, so a ring plane reads as horizontal.
    copy(outUp, axisZ);

    if (this.elapsed >= this.total) {
      this.active = false;
      this.message = `${this.route.name} — complete`;
      return true;
    }
    return true;
  }

  /** Where the route begins, for placing the ship before it starts. */
  startPosition(t: number, outPos: Vec3, outVel: Vec3): void {
    this.sample(0, t, outPos);
    copy(outVel, bodyVel);
  }
}
