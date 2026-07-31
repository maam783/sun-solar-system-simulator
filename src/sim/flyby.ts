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
   * Body to place in shot, to scale, as a size reference.
   *
   * The reason Saturn always read as huge and the Sun never did is that Saturn
   * has the rings in frame and the Sun has nothing: an unmarked sphere carries
   * no cue to read size from. This puts something of known size *in the world*
   * beside the subject rather than in a panel — the ratio has to be seen, not
   * stated. It is the one thing in the scene that is not really there, and the
   * console says so while it is on screen.
   */
  scaleReference?: string;
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

export const FLYBY_ROUTES: readonly FlybyRoute[] = [
  {
    id: 'saturn-rings',
    scaleReference: 'earth',
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
    scaleReference: 'earth',
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
    blurb: 'Hold behind the lunar limb and let Earth climb over it.',
    body: 'moon',
    subject: 'earth',
    needsLitSubject: true,
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
    // Periapsis on the far side of Io from Jupiter, so the moon crosses the
    // planet's face through the middle of the shot and drifts clear at the ends.
    stops: hyperbolaStops({
      periapsis: 1.8, eccentricity: 6, argument: 180,
      inclination: 12, entryRadius: 5.0, seconds: 45,
    }),
  },
  {
    id: 'sun-pass',
    scaleReference: 'earth',
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
    // The Moon, not Earth: a reference only works if it is smaller than the
    // subject, and Earth is nearly twice Mars. At closest approach here the
    // camera would be inside it. "About twice the Moon" is also the more
    // surprising fact.
    scaleReference: 'moon',
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
export const findLitTime = (bodyId: string, subjectId: string, t0: number): number => {
  const STEP = 2 * 3600;
  const SPAN = 60 * 86400;
  let best = t0;
  let bestLit = litFraction(bodyId, subjectId, t0);
  if (bestLit > 0.75) return t0;
  for (let dt = STEP; dt <= SPAN; dt += STEP) {
    const lit = litFraction(bodyId, subjectId, t0 + dt);
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

  /**
   * Where the size reference is, in the world. Null when a route has none.
   *
   * It has to be a place, not a screen position. Holding it a fixed angle off
   * to the camera's right made the angular comparison exact, but it was a prop
   * carried along beside the window rather than a body: it slid into the
   * ship's path during the wrap, and because it was moved every frame its
   * phase jumped around instead of evolving, so it read as lit from within
   * while the planet next to it showed a terminator. A point in the world
   * fixes both at once — the light is simply computed where it stands.
   */
  referencePos: Vec3 | null = null;

  private reference = vec();
  private refRadius = 0;
  private refPhase = 0;
  private refInclination = 0;
  private refRate = 0;

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
    this.planReference(route);
  }

  /**
   * Choose an orbit for the size reference.
   *
   * A moon in the body's equatorial plane, which is where regular moons are,
   * leaves only two numbers to pick: how far out and where round. They are
   * chosen by trying them — for each candidate the whole shot is walked and the
   * placement scored on how much of it the reference spends outside the
   * subject's limb but still inside the frame, with a penalty for sitting at a
   * different range from the subject, since a nearer body looks bigger for
   * reasons that have nothing to do with its size. Anything the ship would fly
   * within a few reference radii of is rejected outright.
   *
   * A radius near the route's own periapsis tends to win, and the reason is
   * worth knowing: it keeps the reference about one closest-approach off to
   * the side throughout, so its range and the subject's stay within a few per
   * cent of each other and the comparison survives without being staged.
   */
  private planReference(route: FlybyRoute): void {
    this.refRadius = 0;
    this.referencePos = null;
    const refId = route.scaleReference;
    if (!refId) return;

    const body = getBody(route.body);
    // Everything here is in body radii, which is what the scenic frame uses.
    const refRadii = getBody(refId).radius / body.radius;
    const halfFov = (((route.fov ?? 60) * Math.PI) / 180) / 2;

    const SAMPLES = 72;
    const track: number[][] = [];
    let periapsis = Infinity;
    for (let i = 0; i <= SAMPLES; i++) {
      splineAt(route.stops, this.segmentAt((i / SAMPLES) * this.total), lengthB);
      const p = [lengthB[0]!, lengthB[1]!, lengthB[2]!];
      periapsis = Math.min(periapsis, Math.hypot(p[0]!, p[1]!, p[2]!));
      track.push(p);
    }

    let best = -Infinity;
    for (const multiple of [0.6, 0.8, 1, 1.25, 1.6, 2, 2.6]) {
      const r = periapsis * multiple;
      if (r < 1 + refRadii * 1.2) continue;   // it would be inside the body
      for (const incDeg of [0, 30, 55, 75, 90]) {
      const inc = (incDeg * Math.PI) / 180;
      for (let k = 0; k < 72; k++) {
        const theta = (k / 72) * Math.PI * 2;
        const rx = r * Math.cos(theta);
        const ry = r * Math.sin(theta) * Math.cos(inc);
        const rz = r * Math.sin(theta) * Math.sin(inc);
        let clearance = Infinity;
        let framed = 0;
        let mismatch = 0;
        for (const p of track) {
          const dx = rx - p[0]!;
          const dy = ry - p[1]!;
          const dz = rz - p[2]!;
          const toRef = Math.hypot(dx, dy, dz);
          const toSubject = Math.hypot(p[0]!, p[1]!, p[2]!);
          clearance = Math.min(clearance, toRef);
          const cos = -(p[0]! * dx + p[1]! * dy + p[2]! * dz) / (toSubject * toRef);
          const apart = Math.acos(Math.max(-1, Math.min(1, cos)));
          const subjectAngle = Math.asin(Math.min(1, 1 / toSubject));
          const refAngle = Math.asin(Math.min(1, refRadii / toRef));
          // Visible either clear of the limb, or crossing the face in front of
          // it — a transit is not a failure of the shot, it is the best version
          // of it. Only being genuinely behind the subject loses the reference.
          const visible = apart > subjectAngle + refAngle * 1.2 || toRef < toSubject - 1;
          if (visible && apart < halfFov * 0.82) framed++;
          mismatch += Math.abs(Math.log(toRef / toSubject));
        }
        // A clean miss is all that is wanted; the ship is fifty metres long.
        // Demanding more than this rules out the close orbits, and those are
        // the ones that keep the reference at the subject's own range.
        if (clearance < refRadii * 3) continue;
        const score = framed / track.length - 0.5 * (mismatch / track.length);
        if (score > best) {
          best = score;
          this.refRadius = r;
          this.refPhase = theta;
          this.refInclination = inc;
        }
      }
      }
    }

    if (this.refRadius > 0) {
      const a = this.refRadius * body.radius;
      this.refRate = Math.sqrt(body.mu / (a * a * a));
      this.referencePos = this.reference;
    }
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

    // The reference is on a real circular orbit, so it moves while the shot
    // runs. Over a hundred seconds that is a fraction of a degree — but it is
    // the difference between a body that is somewhere and a body that is held
    // there, and the shot is only worth anything if it is the first.
    if (this.refRadius > 0) {
      const theta = this.refPhase + this.refRate * this.elapsed;
      const inPlane = this.refRadius * Math.sin(theta);
      scratchAt[0] = this.refRadius * Math.cos(theta);
      scratchAt[1] = inPlane * Math.cos(this.refInclination);
      scratchAt[2] = inPlane * Math.sin(this.refInclination);
      toWorld(this.route, scratchAt, this.reference);
      this.referencePos = this.reference;
    }

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
