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
  /**
   * Field of view for this shot, degrees. A cinematographer changes lenses;
   * so does this. Earth is only 1.8 degrees wide from the Moon, so the famous
   * Earthrise frame needs a long lens or it is a speck.
   */
  fov?: number;
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
    blurb: 'Down to one and a half radii, where the belts fill the window.',
    body: 'jupiter',
    stops: [
      { at: [9, -9, 2.4], seconds: 0 },
      { at: [3.0, -3.0, 0.7], seconds: 13 },
      { at: [1.55, -0.8, 0.10], seconds: 11 },
      { at: [1.52, 0.9, 0.05], seconds: 8 },
      { at: [3.0, 3.2, 0.6], seconds: 11 },
      { at: [8, 8, 2.0], seconds: 12 },
    ],
  },
  {
    id: 'earthrise',
    name: 'Earthrise from the Moon',
    blurb: 'Hold behind the lunar limb and let Earth climb over it.',
    body: 'moon',
    subject: 'earth',
    // Long lens: Earth spans 1.8 degrees from here, so a normal field of view
    // makes it a speck above an enormous grey horizon.
    //
    // The track has to stay close to the line where Earth grazes the limb.
    // Climbing further out does clear Earth of the Moon, but it also swings
    // the limb outside a long lens, and an Earthrise without the horizon it
    // rises over is just a small blue dot. Earth is hidden while the sideways
    // offset is under one radius and clear past it, so the shot lives in the
    // narrow band either side of that.
    fov: 24,
    stops: [
      { at: [-1.46, -0.30, 0.10], seconds: 0 },
      { at: [-1.45, 0.25, 0.06], seconds: 12 },
      { at: [-1.45, 0.80, 0.03], seconds: 12 },
      { at: [-1.45, 1.08, 0.02], seconds: 10 },
      { at: [-1.46, 1.32, 0.02], seconds: 12 },
    ],
  },
  {
    id: 'io-jupiter',
    name: 'Io, with Jupiter behind',
    blurb: 'Round the volcanic moon with Jupiter filling twenty degrees of sky.',
    body: 'io',
    subject: 'jupiter',
    fov: 42,
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
    blurb: 'Low across the terminator and out into the night side.',
    body: 'mars',
    stops: [
      { at: [5, -5, 1.3], seconds: 0 },
      { at: [2.1, -1.9, 0.4], seconds: 12 },
      { at: [1.30, -0.5, 0.07], seconds: 11 },
      { at: [1.28, 0.7, 0.03], seconds: 8 },
      { at: [2.5, 2.3, 0.4], seconds: 11 },
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
const lengthA = [0, 0, 0];
const lengthB = [0, 0, 0];

export class FlybyDirector {
  active = false;
  route: FlybyRoute | null = null;
  /** Seconds into the route. */
  elapsed = 0;
  message = '';

  private total = 0;
  /**
   * Arc-length lookup: `distance[i]` is how far along the path `param[i]` is.
   *
   * A Catmull-Rom spline does not travel at a constant rate in its own
   * parameter — it slows through tight corners and races down straight legs.
   * Driving it by parameter therefore surges and stalls, which is exactly what
   * a flypast must not do. Walking this table instead means equal time buys
   * equal distance, so the only speed changes left are the ones the shot asks
   * for.
   */
  private param: number[] = [];
  private distance: number[] = [];
  private totalLength = 0;

  start(route: FlybyRoute): void {
    this.route = route;
    this.active = true;
    this.elapsed = 0;
    this.message = route.name;

    // Authored times set how long the shot lasts; the arc-length table decides
    // where the ship is at each moment within it.
    let authored = 0;
    for (let i = 1; i < route.stops.length; i++) authored += route.stops[i]!.seconds;
    this.total = authored;

    const SAMPLES = 600;
    const span = route.stops.length - 1;
    this.param = [0];
    this.distance = [0];
    let acc = 0;
    splineAt(route.stops, 0, lengthA);
    for (let k = 1; k <= SAMPLES; k++) {
      const u = (k / SAMPLES) * span;
      splineAt(route.stops, u, lengthB);
      acc += Math.hypot(
        lengthB[0]! - lengthA[0]!,
        lengthB[1]! - lengthA[1]!,
        lengthB[2]! - lengthA[2]!);
      lengthA[0] = lengthB[0]!;
      lengthA[1] = lengthB[1]!;
      lengthA[2] = lengthB[2]!;
      this.param.push(u);
      this.distance.push(acc);
    }
    this.totalLength = acc;
  }

  stop(): void {
    this.active = false;
    this.route = null;
    this.message = '';
  }

  get progress(): number {
    return this.total > 0 ? Math.min(1, this.elapsed / this.total) : 0;
  }

  /**
   * Segment coordinate for a time in seconds.
   *
   * The easing is applied once, across the whole route — accelerate away at
   * the start, coast, settle at the end. Easing each leg separately (which is
   * the obvious thing to write) brings the ship to a standstill at every
   * waypoint, so the flypast surges and stalls its way past the planet instead
   * of sweeping.
   */
  private segmentAt(seconds: number): number {
    if (this.total <= 0 || this.totalLength <= 0) return 0;

    const u = Math.max(0, Math.min(1, seconds / this.total));

    // Speed profile: ramp up over the first fifth, hold, ramp down over the
    // last. `eased` is its integral, so the ship accelerates away, sweeps past
    // at a steady rate, and settles at the end.
    const edge = 0.2;
    const rampDistance = edge / 2;
    const cruiseDistance = 1 - 2 * edge;
    let eased: number;
    if (u < edge) {
      eased = (u * u) / (2 * edge);
    } else if (u > 1 - edge) {
      const remaining = 1 - u;
      eased = rampDistance + cruiseDistance + rampDistance
        - (remaining * remaining) / (2 * edge);
    } else {
      eased = rampDistance + (u - edge);
    }
    // The two ramps together cover one `edge` less ground than a constant run,
    // so normalise to keep the route ending exactly at its last waypoint.
    eased /= 1 - edge;

    // Eased progress is a fraction of the *distance*, looked up in the table.
    const target = Math.max(0, Math.min(1, eased)) * this.totalLength;
    const d = this.distance;
    let lo = 0;
    let hi = d.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid]! <= target) lo = mid;
      else hi = mid;
    }
    const legSpan = d[hi]! - d[lo]!;
    const f = legSpan > 0 ? (target - d[lo]!) / legSpan : 0;
    return this.param[lo]! + f * (this.param[hi]! - this.param[lo]!);
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
