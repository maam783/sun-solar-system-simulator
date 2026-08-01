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
  /**
   * Wait for a date when the subject is lit before starting.
   *
   * Earth's phase seen from the Moon depends only on where the Sun is, not on
   * where the ship sits — so no amount of repositioning rescues an Earthrise
   * during a new Earth. The clock moves instead. Which real date it is does not
   * matter to the shot, and the geometry is real on whatever date it lands.
   */
  needsLitSubject?: boolean;
  /**
   * Phase to wait for, as a lit fraction of the subject's disc. Defaults to
   * "as full as possible".
   *
   * Full is not always what a shot wants. The Apollo 8 photograph is a *half*
   * Earth, and that is not a limitation of it — a fully lit disc has no
   * terminator, no shape and no direction of light, and it puts the Sun
   * directly behind the observer, which is the flattest light there is.
   */
  litTarget?: number;
  /**
   * Camera pitch relative to the subject, degrees. Positive tilts up.
   *
   * A camera aimed straight at the subject is the obvious thing and, for a
   * shot where the subject starts *behind* something, the wrong one: it fills
   * the frame with featureless ground and gives the eye nothing to hold on to.
   * Tilting up puts the horizon in the lower third, so there is a hard edge
   * against black sky and somewhere for the subject to arrive from.
   */
  aimPitch?: number;
  stops: FlybyStop[];
}

/**
 * Waypoints taken from a real hyperbolic encounter.
 *
 * Hand-placed waypoints kept producing a straight run at the planet, and a
 * straight run at anything is a zoom: the line of sight does not turn, so the
 * stars behind it hold still, no new surface comes over the limb, and the only
 * thing that changes in the whole frame is the size of the disc. The eye reads
 * that as a picture being enlarged, not as flight — which is exactly what it
 * geometrically is.
 *
 * A real encounter cannot do that. The incoming asymptote misses the centre by
 * the impact parameter, so the body drifts across the star field the entire way
 * in and its surface streams underneath at closest approach. Deriving the
 * waypoints from the conic is both shorter than tuning them by hand and the
 * reason the shot reads as flying rather than zooming.
 *
 * Angles are the true anomaly; offsets come out in body radii, which is what
 * the scenic frame wants.
 */
function hyperbolaStops(opts: {
  /** Closest approach, in body radii. */
  periapsis: number;
  /** > 1. Higher is a faster, straighter, less wrapped pass. */
  eccentricity: number;
  /** Where periapsis sits relative to +X (the lit side), degrees. */
  argument: number;
  /** Tilt of the orbital plane out of the scenic XY plane, degrees. */
  inclination: number;
  /** Radius at both ends of the arc, in body radii. */
  entryRadius: number;
  /** Total length of the shot; the arc-length table redistributes it. */
  seconds: number;
  samples?: number;
}): FlybyStop[] {
  const { periapsis: q, eccentricity: e, entryRadius } = opts;
  const p = q * (1 + e);
  // r = p / (1 + e cos v), inverted at the end of the arc.
  const nuMax = Math.acos(Math.max(-1, Math.min(1, (p / entryRadius - 1) / e)));
  const n = opts.samples ?? 11;
  const arg = opts.argument * (Math.PI / 180);
  const inc = opts.inclination * (Math.PI / 180);
  const stops: FlybyStop[] = [];
  for (let i = 0; i < n; i++) {
    const nu = -nuMax + (2 * nuMax * i) / (n - 1);
    const r = p / (1 + e * Math.cos(nu));
    const phi = nu + arg;
    const inPlane = r * Math.sin(phi);
    stops.push({
      at: [r * Math.cos(phi), inPlane * Math.cos(inc), inPlane * Math.sin(inc)],
      seconds: i === 0 ? 0 : opts.seconds / (n - 1),
    });
  }
  return stops;
}

/**
 * Waypoints along a circular orbit in the scenic XY plane, by angle from the
 * -X axis. Used where a shot wants a steady rate rather than an encounter.
 */
function circularStops(opts: {
  radius: number; from: number; to: number; seconds: number; samples?: number;
}): FlybyStop[] {
  const n = opts.samples ?? 13;
  const stops: FlybyStop[] = [];
  for (let i = 0; i < n; i++) {
    const deg = opts.from + ((opts.to - opts.from) * i) / (n - 1);
    const a = (deg * Math.PI) / 180;
    stops.push({
      at: [-opts.radius * Math.cos(a), opts.radius * Math.sin(a), 0],
      seconds: i === 0 ? 0 : opts.seconds / (n - 1),
    });
  }
  return stops;
}

export const FLYBY_ROUTES: readonly FlybyRoute[] = [
  {
    id: 'saturn-rings',
    name: 'Saturn — through the rings',
    blurb: 'Approach from below, cross the ring plane at two radii, climb away.',
    body: 'saturn',
    // Steeply inclined, with periapsis on the sunward axis — which is where the
    // plane of the orbit cuts the plane of the rings, so closest approach and
    // the ring crossing are the same instant.
    stops: hyperbolaStops({
      periapsis: 2.05, eccentricity: 4, argument: 0,
      inclination: 38, entryRadius: 10, seconds: 88,
    }),
  },
  {
    id: 'jupiter-skim',
    name: 'Jupiter — slingshot',
    blurb: 'In over the night side, round the limb at 1.5 radii, out into the light.',
    body: 'jupiter',
    // A wrap rather than a tangent: the ship comes in on the dark side, swings
    // right round the planet close in, and leaves in a different direction with
    // the full lit face behind it. The camera holds the planet throughout, so
    // it turns to look back on its own as the ship departs.
    stops: hyperbolaStops({
      periapsis: 1.5, eccentricity: 5, argument: -55,
      inclination: 10, entryRadius: 9.5, seconds: 102,
    }),
  },
  {
    id: 'earthrise',
    name: 'Earthrise from the Moon',
    blurb: 'Low over the far side at dawn, until Earth comes up over the edge.',
    body: 'moon',
    subject: 'earth',
    needsLitSubject: true,
    // A half Earth, as in the photograph. It also puts the Sun far enough round
    // to rake the ground the ship is crossing, which is where the shot gets its
    // shadows.
    litTarget: 0.55,
    // Horizon in the lower third. Earth then arrives from the bottom of the
    // frame rather than being sat on from the start.
    aimPitch: 9,
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
    // A circular orbit at 1.09 radii — 156 km up, near enough to Apollo 8's 110
    // that the ground moves at the same sort of rate, and low enough that the
    // horizon is close and the surface streams. Constant radius matters: it is
    // what makes the line of sight turn at a constant rate, which is what makes
    // Earth come up steadily instead of jumping.
    //
    // The window is narrow and has to be found rather than guessed. At 1.09
    // radii the Moon's limb sits 66.5 degrees off the direction to Earth
    // (asin(1/1.09)), and Earth's disc is 1.9 degrees across — so the whole
    // rise happens inside 1.9 degrees of orbital angle, from 65.55 to 67.45.
    // The first attempt swept 108 degrees and put all of that in under a
    // second, which is precisely what was reported.
    //
    // So the arc is 6.5 degrees, straddling the window: 28 seconds of ground
    // going by with the sky still empty, 27 seconds of Earth coming up, and
    // half a minute of it hanging there. Apollo 8 took 37 seconds over the
    // same rise, at 0.051 deg/s; this runs at 0.072.
    stops: circularStops({ radius: 1.09, from: 63.5, to: 70, seconds: 90 }),
  },
  {
    id: 'io-jupiter',
    name: 'Io, with Jupiter behind',
    blurb: 'Round the volcanic moon with Jupiter filling twenty degrees of sky.',
    body: 'io',
    subject: 'jupiter',
    fov: 42,
    // Periapsis on the far side of Io from Jupiter, so the moon crosses the
    // planet's face through the middle of the shot and drifts clear at the ends.
    stops: hyperbolaStops({
      periapsis: 1.8, eccentricity: 6, argument: 180,
      inclination: 12, entryRadius: 5.0, seconds: 45,
    }),
  },
  {
    id: 'sun-pass',
    name: 'Solar slingshot',
    blurb: 'Round the Sun at half a radius above the surface. It is the sky.',
    body: 'sun',
    // The Sun was being flown at three radii while the planets were flown at
    // one and a half — so the largest object in the solar system got the
    // smallest framing of any shot in the list, about 36 degrees. At 1.45
    // radii it spans 87 degrees and stops being an object at all.
    stops: hyperbolaStops({
      periapsis: 1.28, eccentricity: 5, argument: -55,
      inclination: 10, entryRadius: 9.5, seconds: 112,
    }),
  },
  {
    id: 'mars-lowpass',
    name: 'Mars — slingshot',
    blurb: 'Round the back of the planet and away with the day side astern.',
    body: 'mars',
    stops: hyperbolaStops({
      periapsis: 1.45, eccentricity: 5, argument: -55,
      inclination: 10, entryRadius: 7.0, seconds: 92,
    }),
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
const aimUp = vec();

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

const litA = vec();
const litB = vec();

/**
 * Fraction of the subject's disc that is lit, seen from the body.
 * 1 is full, 0 is new.
 */
export const litFraction = (bodyId: string, subjectId: string, t: number): number => {
  ephemeris.position(bodyId, t, litA);
  ephemeris.position(subjectId, t, litB);
  // From the subject: one vector to the Sun (at the origin), one to the viewer.
  const toSunX = -litB.x;
  const toSunY = -litB.y;
  const toSunZ = -litB.z;
  const toViewX = litA.x - litB.x;
  const toViewY = litA.y - litB.y;
  const toViewZ = litA.z - litB.z;
  const ls = Math.hypot(toSunX, toSunY, toSunZ);
  const lv = Math.hypot(toViewX, toViewY, toViewZ);
  if (ls === 0 || lv === 0) return 1;
  const cos = (toSunX * toViewX + toSunY * toViewY + toSunZ * toViewZ) / (ls * lv);
  return (1 + Math.max(-1, Math.min(1, cos))) / 2;
};

/**
 * Search forward for a time when the subject is well lit from the body.
 * Steps two hours at a time over two months — long enough to cover a lunar
 * cycle several times over. Returns the original time if nothing better exists.
 */
export const findLitTime = (
  bodyId: string, subjectId: string, t0: number, target = 0.98,
): number => {
  const STEP = 2 * 3600;
  const SPAN = 60 * 86400;
  let best = t0;
  let bestLit = -Math.abs(litFraction(bodyId, subjectId, t0) - target);
  if (bestLit > -0.03) return t0;
  for (let dt = STEP; dt <= SPAN; dt += STEP) {
    const lit = -Math.abs(litFraction(bodyId, subjectId, t0 + dt) - target);
    if (lit > bestLit) {
      bestLit = lit;
      best = t0 + dt;
      if (bestLit > 0.9) break;
    }
  }
  return best;
};

export class FlybyDirector {
  active = false;
  route: FlybyRoute | null = null;
  /** Seconds into the route. */
  elapsed = 0;
  message = '';

  private total = 0;
  /**
   * Swept-angle lookup: `distance[i]` is how much *angle*, seen from the body,
   * the path has covered by `param[i]`.
   *
   * Two things had to be got right here in turn. First, a Catmull-Rom spline
   * does not travel at a constant rate in its own parameter — it slows through
   * corners and races down straight legs — so driving it by parameter surges
   * and stalls. Reparameterising by arc length fixed that.
   *
   * But equal *distance* per second is still the wrong thing for a flypast.
   * What a viewer reads size from is how fast the surface slides across the
   * field of view, not how many metres are covered: the same metres per second
   * is a crawl at nine radii and a blur at one. Budgeting equal *angle* per
   * second instead makes the ship rush in from far out and then sweep slowly
   * round at closest approach, which is what the shot is for.
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
      // Budget the time by how far the body's *limb* travels across the sky,
      // which is what the eye actually measures the motion by. That is the
      // rotation of the line of sight — how fast the stars behind it stream —
      // plus the change in the body's angular radius.
      //
      // The obvious metric, distance flown over distance from the centre,
      // counts a straight dive at the planet as though it were a sweep past
      // it, and so hands a third of the shot to the one stretch where nothing
      // in the frame moves. Splitting the two apart is what stops the approach
      // reading as a zoom.
      const rA = Math.max(1, Math.hypot(lengthA[0]!, lengthA[1]!, lengthA[2]!));
      const rB = Math.max(1, Math.hypot(lengthB[0]!, lengthB[1]!, lengthB[2]!));
      const cos = (lengthA[0]! * lengthB[0]! + lengthA[1]! * lengthB[1]!
        + lengthA[2]! * lengthB[2]!) / (rA * rB);
      const swept = Math.acos(Math.max(-1, Math.min(1, cos)));
      // Offsets are in body radii, so 1/r is the sine of the angular radius.
      const growth = Math.abs(Math.asin(1 / rB) - Math.asin(1 / rA));
      acc += swept + growth;
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

    // Eased progress is a fraction of the swept *angle*, looked up in the table.
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

    // Tilt the aim off the subject, in the camera's own vertical plane.
    if (this.route.aimPitch) {
      const angle = (this.route.aimPitch * Math.PI) / 180;
      cross(tmp, outLook, axisZ);          // camera right
      if (len(tmp) > 1e-9) {
        normalize(tmp, tmp);
        cross(aimUp, tmp, outLook);        // camera up
        normalize(aimUp, aimUp);
        scale(outLook, outLook, Math.cos(angle));
        addScaled(outLook, outLook, aimUp, Math.sin(angle));
        normalize(outLook, outLook);
      }
    }
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
