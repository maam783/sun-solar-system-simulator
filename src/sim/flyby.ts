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
  /**
   * A journey rather than a pass: legs between bodies, each with its own
   * standoff and its own share of the running time.
   *
   * Present instead of `stops`, not as well as. Where a pass is one camera move
   * around one thing, this is several strung together — and the interesting
   * problem is the middle of each leg rather than its ends.
   */
  legs?: TourLeg[];
}

/** One hop of a journey. */
export interface TourLeg {
  /** Body to arrive at. */
  body: string;
  /** How close to come, in that body's radii. */
  radii: number;
  /**
   * This leg's share of the running time.
   *
   * A share, not a schedule: where the ship is at each moment comes from the
   * timing table, which spends time where something is happening. All these
   * add up to how long the journey lasts, and nothing else.
   */
  seconds: number;
  /**
   * Where closest approach sits, in the body's scenic frame: [sunward, across,
   * polar], normalised. Picks which side of the body the pass happens on, and
   * so what the light does.
   *
   * It decides the whole shape at the two ends of the journey, where there is
   * only one direction to satisfy. In the middle it only chooses the plane,
   * and only when the pass turns the ship right around — anywhere else the
   * geometry has already fixed the plane, because a flypast's plane is the one
   * containing where you came from and where you are going.
   */
  approach: [number, number, number];
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

/**
 * The grand tour: Earth to the Moon to Mars and home.
 *
 * The whole difficulty of a journey at this scale is that most of it is
 * nothing. Earth to Mars is a hundred million kilometres of unchanging black,
 * and the two honest ways to present that are both wrong for a demonstration:
 * fly it at a survivable speed and it takes months, or cut, and lose the only
 * thing the distance had to say.
 *
 * So neither. The ship runs each leg on a raised-cosine speed profile — still
 * at both ends, enormous through the middle — which is what a director does
 * with a long dissolve and what an eye reads as *far* rather than as *slow*.
 * The departure body shrinks to a point behind you while the destination is
 * still a point ahead, and for a few seconds there is nothing else, which is
 * the truthful part. The camera looks back on the way out and forward on the
 * way in, crossfading in the middle of the leg, so leaving and arriving are
 * both seen rather than assumed.
 *
 * Speeds through the cruise are frankly impossible — around ten c on the Mars
 * legs. These are camera moves on rails, as the flypasts are, and the README
 * says so.
 */
const GRAND_TOUR: TourLeg[] = [
  // Away from Earth, out of the daylight side, with home filling the window.
  { body: 'earth', radii: 2.4, seconds: 8, approach: [1, 0.35, 0.25] },
  // The Moon: near enough that it is a place, and lit from the side.
  { body: 'moon', radii: 3.2, seconds: 40, approach: [0.55, 0.8, 0.2] },
  // The long one. Tens of millions of kilometres of nothing, in half a minute.
  // The far end of the round trip, and the reason for it: right round the
  // planet, from the night side into the light.
  { body: 'mars', radii: 2.3, seconds: 70, approach: [-0.55, 0.75, 0.25] },
  // And home, arriving on the night side so the terminator comes round.
  { body: 'earth', radii: 3.0, seconds: 56, approach: [-0.3, 0.9, 0.3] },
];

export const FLYBY_ROUTES: readonly FlybyRoute[] = [
  {
    id: 'grand-tour',
    name: 'The long way round',
    blurb: 'Earth, the Moon, Mars, and home — with the empty parts crossed at speed.',
    body: 'earth',
    legs: GRAND_TOUR,
    stops: [],
  },
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
    id: 'moon-dawn',
    name: 'Dawn on the far side',
    blurb: 'Low over the Moon, into the sunrise, with every crater throwing its shadow.',
    body: 'moon',
    // The light is the shot. Anywhere else on a body the Sun is high and the
    // ground is flat and grey; along the terminator it comes in at nothing
    // degrees and every rim, ridge and crater wall throws a shadow the length
    // of itself. That is the whole difference between a photograph of the Moon
    // and standing on it.
    //
    // In this frame +X points at the Sun, so the terminator is the great circle
    // at x = 0. The arc runs from 82 to 104 degrees, which starts a hundred and
    // fifty kilometres inside the night side and ends well into the morning:
    // the Sun comes up over the horizon as the ship crosses.
    //
    // At 1.08 radii the limb sits 67.8 degrees off the nadir, so the camera is
    // tilted 55 up to put the horizon in the lower third — from this low, the
    // ground fills 141 degrees and is not a globe any more, it is a landscape.
    aimPitch: 55,
    stops: circularStops({ radius: 1.08, from: 82, to: 104, seconds: 88 }),
  },
  {
    id: 'mercury-noon',
    name: 'Mercury at perihelion',
    blurb: 'The hardest light in the solar system, on the ground it falls on.',
    body: 'mercury',
    // Ten times Earth's sunlight and a black sky: no air to soften an edge, no
    // scattering to fill a shadow. The Sun is nearly two degrees across here,
    // three times the disc seen from Earth, and everything it does not touch is
    // simply black. Measured, the arc runs from one degree of solar elevation
    // to seventy-eight — sunrise to very nearly noon — so the shadows start as
    // long as the Moon's and are gone by the end. On Mercury the shadows are
    // not the point; the point is that there is nothing between the light and
    // the rock.
    aimPitch: 38,
    stops: circularStops({ radius: 1.22, from: 132, to: 168, seconds: 80 }),
  },
  {
    id: 'charon',
    name: 'Charon, with Pluto behind',
    blurb: 'A twelve-hundredth of the sunlight, and two worlds locked facing each other.',
    body: 'charon',
    subject: 'pluto',
    // The far end of the register. Sunlight here is 1/1250 of Earth's — noon on
    // Charon is a deep dusk — and Pluto hangs seven degrees wide and does not
    // move, because the two are locked facing each other: from this hemisphere
    // Pluto has never risen and never set. It is the only place in the system
    // where that is true of a body that large.
    fov: 34,
    stops: hyperbolaStops({
      periapsis: 1.9, eccentricity: 6, argument: 180,
      inclination: 14, entryRadius: 5.5, seconds: 78,
    }),
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
const tourAim = vec();
const tourBack = vec();
const timeA = vec();
const timeB = vec();
const aimTo = vec();
const aimWant = vec();
const aimAxis = vec();
const aimSoon = vec();
const aimNext = vec();

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
  // A journey has no stops; nothing should be asking, but an empty list must
  // not throw its way out of a frame.
  if (n === 0) { out[0] = 0; out[1] = 0; out[2] = 0; return; }
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

/**
 * One control point of a journey, pinned to a body.
 *
 * The offset is frozen when the route starts and the body's live position is
 * added back every frame, so the path travels with the Moon and with Mars
 * instead of aiming at where they were when you set off.
 */
interface TourNode {
  body: string;
  off: [number, number, number];
}

const crP0 = vec();
const crP1 = vec();
const crP2 = vec();
const crP3 = vec();
const crA1 = vec();
const crA2 = vec();
const crA3 = vec();
const crB1 = vec();
const crB2 = vec();
const crEdge = vec();

const crLerp = (out: Vec3, a: Vec3, b: Vec3, w: number): void => {
  out.x = a.x + (b.x - a.x) * w;
  out.y = a.y + (b.y - a.y) * w;
  out.z = a.z + (b.z - a.z) * w;
};

/**
 * Centripetal Catmull-Rom through control points supplied by a getter, so the
 * same curve can be evaluated against frozen positions (for the timing table,
 * twelve thousand samples, no ephemeris) or against live ones (for the frame).
 *
 * Centripetal — knots spaced by the square root of the chord — rather than the
 * uniform kind used for the flypasts, and the difference is not cosmetic here.
 * A journey's control points are a few thousand kilometres apart around Mars
 * and tens of millions apart on the way to it. Uniform Catmull-Rom takes the
 * tangent at each point from its neighbours regardless of how far away they
 * are, so where the spacing changes the tangent is the wrong length for the
 * span it has to cover, and the curve loops back on itself to make up the
 * difference. Measured on the crossing to the Moon, the ship went forward
 * three thousand kilometres, came back twelve hundred, and went forward again
 * — twice, inside half a second. Centripetal parameterisation is the standard
 * cure and is provably free of cusps and self-intersection.
 */
const crAt = (
  get: (i: number, out: Vec3) => void, n: number, u: number, out: Vec3,
): void => {
  if (n === 0) { set(out, 0, 0, 0); return; }
  if (n === 1) { get(0, out); return; }
  // Beyond the ends, reflect through the last point rather than repeating it:
  // a repeated point has zero chord, and a zero knot span is a division by
  // zero dressed up as a duplicate.
  const fetch = (idx: number, dst: Vec3): void => {
    if (idx < 0) {
      get(0, dst); get(1, crEdge);
    } else if (idx > n - 1) {
      get(n - 1, dst); get(n - 2, crEdge);
    } else {
      get(idx, dst);
      return;
    }
    dst.x = 2 * dst.x - crEdge.x;
    dst.y = 2 * dst.y - crEdge.y;
    dst.z = 2 * dst.z - crEdge.z;
  };

  const i = Math.max(0, Math.min(n - 2, Math.floor(u)));
  const s = Math.max(0, Math.min(1, u - i));
  fetch(i - 1, crP0);
  fetch(i, crP1);
  fetch(i + 1, crP2);
  fetch(i + 2, crP3);

  const knot = (a: Vec3, b: Vec3): number => Math.max(
    1e-6, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)),
  );
  const t1 = knot(crP0, crP1);
  const t2 = t1 + knot(crP1, crP2);
  const t3 = t2 + knot(crP2, crP3);
  const t = t1 + s * (t2 - t1);

  crLerp(crA1, crP0, crP1, t / t1);
  crLerp(crA2, crP1, crP2, (t - t1) / (t2 - t1));
  crLerp(crA3, crP2, crP3, (t - t2) / (t3 - t2));
  crLerp(crB1, crA1, crA2, t / t2);
  crLerp(crB2, crA2, crA3, (t - t1) / (t3 - t1));
  crLerp(out, crB1, crB2, (t - t1) / (t2 - t1));
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

  /** Set while a journey rather than a pass is running. */
  private tour: TourLeg[] | null = null;

  /** Control points of a journey, and their world positions when it started. */
  private nodes: TourNode[] = [];
  private frozen: number[] = [];
  /** The bodies a journey visits, once each: its subjects and its obstacles. */
  private tourBodies: string[] = [];
  private tourBodyPos: number[] = [];

  /**
   * Where the camera is looking, as a state rather than as a result.
   *
   * The aim used to be computed fresh each frame and handed straight out, so
   * the moment the rule changed its mind the view changed with it — a swing of
   * a hundred degrees inside one frame if that is what the arithmetic said.
   * That is the same fault the manual controls had before they were given
   * torque and damping: a direction that is *assigned* can move at any speed.
   * Here it is integrated instead, through a critically damped spring with a
   * rate ceiling, so no rule and no join can produce a turn faster than a
   * ship could make.
   */
  private aimDir = vec();
  private aimRate = 0;
  aimSubject = '';

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

  start(route: FlybyRoute, t = 0): void {
    this.route = route;
    this.active = true;
    this.elapsed = 0;
    this.message = route.name;

    set(this.aimDir, 0, 0, 0);
    this.aimRate = 0;
    this.aimSubject = '';

    if (route.legs && route.legs.length > 1) {
      this.tour = route.legs;
      // The authored seconds no longer place anything; they only say how long
      // the journey lasts. Where the ship is at each moment inside that comes
      // from the timing table, as it does for a flypast.
      this.total = route.legs.reduce((a, l) => a + l.seconds, 0);
      this.buildTourNodes(route.legs, t);
      this.buildTourTiming();
      return;
    }
    this.tour = null;
    this.nodes = [];

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

  /**
   * Lay the whole journey out as one curve.
   *
   * It used to be built as legs: a straight run to a body, then a separate,
   * much slower arc around it, then the next straight run. Two different kinds
   * of motion meeting at a boundary, and every fault reported against this
   * route came from a boundary — the position jumping, the speed stepping by a
   * factor of seventy, the ship appearing to stop dead alongside the Moon and
   * then set off again. Each was fixed in turn and the next one surfaced,
   * which is the sign that the joins were not the problem: having joins was.
   *
   * So there are none. Every waypoint of the journey — the passes and the
   * crossings alike — goes into a single Catmull-Rom, which is continuous in
   * position and tangent by construction, and the ship runs along it under one
   * speed profile from Earth to Earth. There is no moment at which anything
   * hands over to anything, because there is only one thing.
   *
   * The passes are centred on closest approach rather than ending at it, which
   * is what makes them read as flying past a place instead of arriving at one.
   */
  private buildTourNodes(legs: TourLeg[], t: number): void {
    const ARC = 17;
    const centres = legs.map((l) => ephemeris.position(l.body, t, vec()));

    const arcs: Vec3[][] = legs.map((leg, i) => {
      const radius = getBody(leg.body).radius;
      const q = leg.radii * radius;
      const centre = centres[i]!;

      // The authored standoff, as a direction from the body: which side the
      // pass happens on, and so what the light does.
      this.legPoint(leg, t, tourAim, 0);
      const approach = normalize(vec(), sub(vec(), tourAim, centre));

      const inDir = i > 0
        ? normalize(vec(), sub(vec(), centre, centres[i - 1]!)) : null;
      const outDir = i < legs.length - 1
        ? normalize(vec(), sub(vec(), centres[i + 1]!, centre)) : null;

      // How far out each end of the pass reaches, before the crossing takes
      // over. Bounded by the neighbour it is reaching towards, because a fixed
      // number of radii does not know how far away anything is: a hundred and
      // fifty Earth radii is nine hundred and fifty thousand kilometres, and
      // the Moon is at three hundred and eighty. The departure overshot the
      // destination and the crossing had to double back to reach it — measured,
      // a hundred and seventy-seven degrees, twice, in the control points
      // themselves.
      const gap = (other: number): number => {
        const o = centres[other];
        return o ? len(sub(vec(), o, centre)) : Infinity;
      };
      const reach = (dist: number): number => Math.min(radius * 150, dist * 0.25);

      let e: number;
      let peri: Vec3;
      let along: Vec3;
      let from: number;
      let to: number;

      if (inDir && outDir) {
        // A real encounter: the velocity turns by the angle between where the
        // ship came from and where it is going, and that angle fixes the shape
        // — e = 1 / sin(delta/2) is the standard deflection relation. Nothing
        // here is authored, which is the point: the pass and the two crossings
        // are one trajectory, so they cannot disagree at the ends.
        const delta = Math.acos(Math.max(-1, Math.min(1, dot(inDir, outDir))));
        e = Math.max(1.001, 1 / Math.max(1e-3, Math.sin(delta / 2)));
        const h = cross(vec(), inDir, outDir);
        if (len(h) < 1e-6) {
          // Turned right around — comes back the way it came, so the plane is
          // free. Take it from the authored side, which is what that field is
          // for and the only place it still has a say on a middle pass.
          cross(h, inDir, approach);
          if (len(h) < 1e-6) set(h, 0, 0, 1);
        }
        normalize(h, h);
        const sum = addScaled(vec(), inDir, outDir, 1);
        if (len(sum) < 1e-3) cross(sum, h, inDir);
        along = normalize(sum, sum);
        peri = normalize(vec(), cross(vec(), along, h));
        const limit = Math.acos(-1 / e) * 0.985;
        to = Math.min(limit, this.trueAnomalyAt(q, e, reach(gap(i + 1))));
        from = -Math.min(limit, this.trueAnomalyAt(q, e, reach(gap(i - 1))));
      } else {
        // The ends of the journey. There is only one asymptote to satisfy, so
        // the shape is free and the authored side decides it: leave from
        // closest approach on the lit side, or arrive at it.
        const away = outDir
          ? outDir
          : normalize(vec(), scale(vec(), inDir!, -1));
        const raw = Math.acos(Math.max(-1, Math.min(1, dot(approach, away))));
        const psi = Math.max((100 * Math.PI) / 180, Math.min((170 * Math.PI) / 180, raw));
        e = -1 / Math.cos(psi);
        const perp = addScaled(vec(), approach, away, -dot(approach, away));
        if (len(perp) < 1e-9) {
          cross(perp, away, axisZ);
          if (len(perp) < 1e-9) cross(perp, away, axisX);
        }
        normalize(perp, perp);
        peri = normalize(vec(), addScaled(vec(), scale(vec(), away, Math.cos(psi)), perp, Math.sin(psi)));
        const limit = Math.acos(-1 / e) * 0.985;
        const end = Math.min(
          limit, this.trueAnomalyAt(q, e, reach(gap(outDir ? i + 1 : i - 1))),
        );
        if (outDir) {
          along = normalize(vec(), addScaled(vec(), away, peri, -Math.cos(psi)));
          from = 0; to = end;
        } else {
          along = normalize(vec(), addScaled(vec(), inDir!, peri, Math.cos(psi)));
          from = -end; to = 0;
        }
      }

      const p = q * (1 + e);
      const points: Vec3[] = [];
      for (let k = 0; k < ARC; k++) {
        const nu = from + ((to - from) * k) / (ARC - 1);
        const r = p / (1 + e * Math.cos(nu));
        const point = copy(vec(), centre);
        addScaled(point, point, peri, r * Math.cos(nu));
        addScaled(point, point, along, r * Math.sin(nu));
        points.push(point);
      }
      return points;
    });

    const nodes: TourNode[] = [];
    const frozen: number[] = [];
    const bodies: string[] = [];
    const bodyPositions: number[] = [];
    const push = (body: string, world: Vec3): void => {
      ephemeris.position(body, t, tourAim);
      nodes.push({
        body,
        off: [world.x - tourAim.x, world.y - tourAim.y, world.z - tourAim.z],
      });
      frozen.push(world.x, world.y, world.z);
      if (!bodies.includes(body)) {
        bodies.push(body);
        bodyPositions.push(tourAim.x, tourAim.y, tourAim.z);
      }
    };

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i]!;
      const arc = arcs[i]!;
      for (const point of arc) push(leg.body, point);

      const next = legs[i + 1];
      if (!next) break;
      const nextArc = arcs[i + 1]!;
      const exit = arc[ARC - 1]!;
      const entry = nextArc[0]!;
      sub(tmp, entry, exit);
      const span = Math.max(1, len(tmp));

      // The crossing is a straight line, because both ends are already on
      // their asymptotes and an asymptote *is* a straight line. The two
      // asymptotes are offset from each other by the impact parameters, a few
      // thousand kilometres across tens of millions, which is a few
      // thousandths of a degree — below anything the eye or the pacing can
      // pick up.
      //
      // Spaced by doubling and halving so no two neighbouring segments differ
      // by more than a factor of two, whatever the ratio between a pass and
      // the crossing that follows it.
      const point = vec();
      const at = (f: number): Vec3 => addScaled(point, exit, tmp, f);
      const stepOut = Math.max(1, len(sub(vec(), exit, arc[ARC - 2]!)));
      const stepIn = Math.max(1, len(sub(vec(), nextArc[1]!, entry)));
      for (let d = stepOut; d < span * 0.5; d *= 2) push(leg.body, at(d / span));
      const back: number[] = [];
      for (let d = stepIn; d < span * 0.5; d *= 2) back.push(1 - d / span);
      for (let k = back.length - 1; k >= 0; k--) push(next.body, at(back[k]!));
    }

    this.nodes = nodes;
    this.frozen = frozen;
    this.tourBodies = bodies;
    this.tourBodyPos = bodyPositions;
  }

  /** True anomaly at which a conic of periapsis `q` and eccentricity `e` reaches `r`. */
  private trueAnomalyAt(q: number, e: number, r: number): number {
    const p = q * (1 + e);
    return Math.acos(Math.max(-1, Math.min(1, (p / Math.max(q, r) - 1) / e)));
  }

  /**
   * How much of the journey's time each stretch of it is worth.
   *
   * The same rule the flypasts use, and for the same reason: what an eye reads
   * motion from is how fast a surface slides across the field of view, not how
   * many metres are covered. Budgeting equal *angle* per second makes the ship
   * sweep slowly round a body at close range and cross the empty parts fast,
   * out of one continuous profile rather than out of a decision about which
   * leg it is on.
   *
   * The empty parts need a term of their own, because when nothing is near,
   * angle is nearly zero and they would take no time at all. Distance is the
   * wrong measure for it — Earth to Mars is two hundred times Earth to the
   * Moon, and would swallow the whole budget — so the term is the change in
   * the *logarithm* of the range: every factor of ten counts the same. That
   * puts the ratio between the crossings at about two to one instead of two
   * hundred, which is what lets the short hop be a hop and the long one still
   * feel long.
   */
  private buildTourTiming(): void {
    const n = this.nodes.length;
    const frozen = this.frozen;
    const get = (i: number, out: Vec3): void => {
      const k = Math.max(0, Math.min(n - 1, i)) * 3;
      set(out, frozen[k]!, frozen[k + 1]!, frozen[k + 2]!);
    };
    // Two passes, because where the samples go matters more than how many.
    //
    // Spread evenly over the curve's own parameter, every span between two
    // control points gets the same number however long it is — and they range
    // from five thousand kilometres around Mars to twenty million out in the
    // crossing. The crossings came out coarse enough that the ship's speed
    // stepped by a factor of two between frames while the Moon was still six
    // degrees wide behind it, and no amount of smoothing fixes an under-sampled
    // table; it only spreads the error. Twelve thousand samples placed by where
    // the time actually goes beat two hundred thousand placed evenly, and cost
    // a tenth as long to lay out.
    const spans = n - 1;
    const COARSE = 12;
    const weight: number[] = [];
    let coarse = 0;
    for (let j = 0; j < spans; j++) {
      let sum = 0;
      crAt(get, n, j, timeA);
      for (let k = 1; k <= COARSE; k++) {
        crAt(get, n, j + k / COARSE, timeB);
        sum += this.tourMetric(timeA, timeB);
        copy(timeA, timeB);
      }
      weight.push(sum);
      coarse += sum;
    }

    const BUDGET = 12000;
    this.param = [0];
    this.distance = [0];
    let acc = 0;
    crAt(get, n, 0, timeA);
    for (let j = 0; j < spans; j++) {
      const share = coarse > 0 ? weight[j]! / coarse : 1 / spans;
      const steps = Math.max(6, Math.round(BUDGET * share));
      for (let k = 1; k <= steps; k++) {
        const u = j + k / steps;
        crAt(get, n, u, timeB);
        acc += this.tourMetric(timeA, timeB);
        copy(timeA, timeB);
        this.param.push(u);
        this.distance.push(acc);
      }
    }
    this.totalLength = acc;
  }

  /**
   * How much is happening between two points of the path: the angle every body
   * sweeps past, plus a share for the stretches where nothing does.
   *
   * Summed over the bodies rather than taking the largest, and that is not a
   * detail. A maximum switches — there is a moment on the way out from the
   * Moon where Earth takes over as the thing setting the pace — and at a switch
   * the derivative jumps, so the ship's speed steps. Measured, nearly a factor
   * of two inside one frame with the Moon still six degrees wide behind it. A
   * sum of continuous terms has nowhere to switch. Where one body dominates it
   * is the same number to three figures; where two are comparable it hands over
   * smoothly, which is what was wanted at the switch in the first place.
   */
  private tourMetric(a: Vec3, b: Vec3): number {
    const EMPTY = 0.045;
    let angle = 0;
    let empty = 0;
    for (let i = 0; i < this.tourBodies.length; i++) {
      const radius = getBody(this.tourBodies[i]!).radius;
      const k = i * 3;
      const px = this.tourBodyPos[k]!;
      const py = this.tourBodyPos[k + 1]!;
      const pz = this.tourBodyPos[k + 2]!;
      const ax = a.x - px; const ay = a.y - py; const az = a.z - pz;
      const bx = b.x - px; const by = b.y - py; const bz = b.z - pz;
      const da = Math.max(radius, Math.hypot(ax, ay, az));
      const db = Math.max(radius, Math.hypot(bx, by, bz));
      const cos = (ax * bx + ay * by + az * bz) / (da * db);
      angle += Math.acos(Math.max(-1, Math.min(1, cos)));
      const ra = da / radius;
      const rb = db / radius;
      angle += Math.abs(Math.asin(1 / rb) - Math.asin(1 / ra));
      // Every factor of ten in range counts the same, so the crossing to Mars
      // is worth about twice the hop to the Moon rather than two hundred times
      // it. Distance is the wrong measure: it would swallow the whole budget.
      empty += Math.abs(Math.log(rb) - Math.log(ra));
    }
    return angle + EMPTY * empty;
  }

  /** A journey's control point, now, in the world. */
  private nodeAt(i: number, t: number, out: Vec3): void {
    const node = this.nodes[Math.max(0, Math.min(this.nodes.length - 1, i))]!;
    ephemeris.position(node.body, t, out);
    out.x += node.off[0];
    out.y += node.off[1];
    out.z += node.off[2];
  }

  /**
   * Where a leg's standoff point is, right now, in the world.
   *
   * Built from the body's live position and its scenic frame, so a journey
   * planned as "arrive three radii out, on the sunward side and a little above
   * the pole" comes out that way on whatever date it is run.
   */
  private legPoint(leg: TourLeg, t: number, out: Vec3, swing = 0): void {
    const pseudo: FlybyRoute = {
      id: '', name: '', blurb: '', body: leg.body, stops: [],
    };
    scenicFrame(pseudo, t);
    const [a0, b0, c] = leg.approach;
    const norm = Math.hypot(a0, b0, c) || 1;
    // Rotated about the polar axis by `swing`, which is how the pass around the
    // body is expressed and therefore how its *end* is addressed.
    const a = a0 * Math.cos(swing) - b0 * Math.sin(swing);
    const b = a0 * Math.sin(swing) + b0 * Math.cos(swing);
    scratchAt[0] = (a / norm) * leg.radii;
    scratchAt[1] = (b / norm) * leg.radii;
    scratchAt[2] = (c / norm) * leg.radii;
    toWorld(pseudo, scratchAt, out);
  }

  /** Where the ship is on a journey, in the world. */
  private sampleTour(seconds: number, t: number, out: Vec3): void {
    const n = this.nodes.length;
    if (n === 0) { set(out, 0, 0, 0); return; }
    crAt((i, o) => this.nodeAt(i, t, o), n, this.segmentAt(seconds), out);
    // The spline can bow inward between waypoints; never let it inside
    // anything it is flying past.
    for (let i = 0; i < this.tourBodies.length; i++) {
      const id = this.tourBodies[i]!;
      ephemeris.position(id, t, tourAim);
      sub(tourBack, out, tourAim);
      const floor = getBody(id).radius * 1.04;
      const d = len(tourBack);
      if (d < floor && d > 0) {
        normalize(tourBack, tourBack);
        copy(out, tourAim);
        addScaled(out, out, tourBack, floor);
      }
    }
  }

  /**
   * Where the camera is looking on a journey.
   *
   * Two separate things, and they were tangled together before. *What* to look
   * at is a judgement; *how fast the view may turn* is a property of the ship.
   * Deciding both in one expression meant that whenever the judgement changed,
   * the view changed with it, at whatever speed the arithmetic implied — which
   * is where the violent swings came from.
   *
   * The judgement: look at whichever body will be largest by the time the
   * camera has finished turning to it. Leaving the Moon for Mars, the Moon
   * fills the window and Mars is a dot — but the Moon will be gone in four
   * seconds and Mars is what the next half minute is about, so judging each
   * candidate at the moment you would actually arrive on it picks Mars without
   * needing to be told which leg this is. On the way out of Earth the same rule
   * keeps Earth, because turning away and back would cost more than it is
   * worth. Nothing here knows about legs.
   *
   * The turn: a critically damped spring with a ceiling on its rate. It cannot
   * start abruptly, it cannot overshoot, and it cannot exceed the ceiling — so
   * no decision the judgement makes, however sudden, can produce a snap.
   */
  private aimTour(dt: number, seconds: number, t: number, pos: Vec3, out: Vec3): void {
    const MAX_RATE = (13 * Math.PI) / 180;
    const TAU = 1.7;
    const started = len(this.aimDir) > 0.5;

    let best = this.aimSubject || this.tour![0]!.body;
    let bestSize = -1;
    for (const id of this.tourBodies) {
      ephemeris.position(id, t, aimTo);
      sub(aimWant, aimTo, pos);
      normalize(aimWant, aimWant);
      const turn = started
        ? Math.acos(Math.max(-1, Math.min(1, dot(this.aimDir, aimWant))))
        : 0;
      this.sampleTour(Math.min(this.total, seconds + turn / MAX_RATE), t, aimSoon);
      ephemeris.position(id, t, aimTo);
      sub(aimSoon, aimTo, aimSoon);
      const size = getBody(id).radius / Math.max(1, len(aimSoon));
      if (size > bestSize) { bestSize = size; best = id; }
    }
    this.aimSubject = best;

    ephemeris.position(best, t, aimTo);
    sub(aimWant, aimTo, pos);
    normalize(aimWant, aimWant);
    if (!started) { copy(this.aimDir, aimWant); this.aimRate = 0; }

    // Follow the subject's motion across the sky before correcting anything.
    //
    // A spring alone cannot track something that is moving: it settles at
    // whatever error makes its restoring force equal the rate it has to keep
    // up, and that lag is proportional to the speed. Measured at Mars, where
    // the line of sight swings eight degrees a second, the planet sat
    // thirty-eight degrees off centre for the whole pass — the shot of the
    // journey, framed at the edge. So the camera is turned at the rate the
    // subject is actually moving first, and the spring is left with nothing to
    // do but take out the genuine error. Which is what tracking anything by
    // hand amounts to: you move with it, and correct.
    const FEED = 0.05;
    this.sampleTour(Math.min(this.total, seconds + FEED), t + FEED, aimSoon);
    ephemeris.position(best, t + FEED, aimNext);
    sub(aimNext, aimNext, aimSoon);
    normalize(aimNext, aimNext);
    cross(aimAxis, aimWant, aimNext);
    const drift = Math.atan2(len(aimAxis), dot(aimWant, aimNext)) / FEED;
    if (len(aimAxis) > 1e-9 && drift > 1e-6) {
      normalize(aimAxis, aimAxis);
      // Generous ceiling: a genuine close pass really does sweep this fast,
      // and that sweep is the shot. This only catches the degenerate case.
      const step = Math.min(drift, (60 * Math.PI) / 180) * dt;
      cross(aimTo, aimAxis, this.aimDir);
      scale(this.aimDir, this.aimDir, Math.cos(step));
      addScaled(this.aimDir, this.aimDir, aimTo, Math.sin(step));
      normalize(this.aimDir, this.aimDir);
    }

    cross(aimAxis, this.aimDir, aimWant);
    const sine = len(aimAxis);
    const error = Math.atan2(sine, dot(this.aimDir, aimWant));
    const w = 1 / TAU;
    this.aimRate += (w * w * error - 2 * w * this.aimRate) * dt;
    this.aimRate = Math.max(0, Math.min(MAX_RATE, this.aimRate));
    if (sine > 1e-9) {
      normalize(aimAxis, aimAxis);
      const step = Math.min(error, this.aimRate * dt);
      // Rodrigues. The axis is perpendicular to the current aim by
      // construction, so the parallel term is zero.
      cross(aimTo, aimAxis, this.aimDir);
      scale(this.aimDir, this.aimDir, Math.cos(step));
      addScaled(this.aimDir, this.aimDir, aimTo, Math.sin(step));
      normalize(this.aimDir, this.aimDir);
    }
    copy(out, this.aimDir);
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
    if (this.tour) {
      this.sampleTour(this.elapsed, t, posA);
      this.sampleTour(this.elapsed + h, t + h, posB);
      copy(outPos, posA);
      sub(outVel, posB, posA);
      scale(outVel, outVel, 1 / h);
      this.aimTour(dt, this.elapsed, t, outPos, outLook);
      set(outUp, 0, 0, 1);
      if (this.elapsed >= this.total) {
        this.active = false;
        this.message = `${this.route.name} — complete`;
      }
      return true;
    }
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
    if (this.tour) {
      this.sampleTour(0, t, outPos);
      ephemeris.state(this.tour[0]!.body, t, tourAim, outVel);
      return;
    }
    this.sample(0, t, outPos);
    copy(outVel, bodyVel);
  }
}
