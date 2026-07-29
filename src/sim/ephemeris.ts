/**
 * Positions and velocities of every simulated body, heliocentric, in the
 * ecliptic J2000 frame, SI units.
 *
 * Planets come from the Standish element set; moons from mean elements in
 * their parent's equatorial plane; Earth's Moon from a truncated lunar series,
 * because a fixed ellipse is off by several degrees once evection and the
 * variation are left out — an error a pilot in lunar orbit would see.
 *
 * Two caches keep this cheap enough to call from inside the integrator:
 *  - an exact-value memo keyed on time, so the four RK4 stages of a substep
 *    (which share only three distinct times) never recompute the same state;
 *  - a per-frame quadratic interpolation over three exact samples, used for
 *    every body slow enough that a parabola through the frame is exact to
 *    centimetres.
 */

import { AU, BODIES, DAY, DEG, getBody, JULIAN_CENTURY } from '../data/constants';
import { PLANET_ELEMENTS_BY_ID } from '../data/elements.planets';
import { MOON_ELEMENTS_BY_ID, MOON_ELEMENTS_EPOCH } from '../data/elements.moons';
import { elementsToState, wrapPi } from './kepler';
import { parentEquatorMatrix } from './frames';
import { apply } from '../math/mat3d';
import type { Vec3 } from '../math/vec3d';
import { add, copy, scale, set, sub, vec } from '../math/vec3d';

const TWO_PI = Math.PI * 2;

/** Fraction of the Earth-Moon mass that sits in the Moon. */
const MOON_MASS_FRACTION =
  getBody('moon').mu / (getBody('earth').mu + getBody('moon').mu);

// ---------------------------------------------------------------------------
// Earth's Moon: truncated ELP-style series (Meeus, abridged).
// Longitude to about 0.2 deg, latitude 0.1 deg, distance 0.3 percent — an
// order of magnitude better than a mean ellipse and far below what is visible.
// ---------------------------------------------------------------------------

/** Geocentric ecliptic position of the Moon, metres. */
export const moonGeocentric = (t: number, out: Vec3): Vec3 => {
  const T = t / JULIAN_CENTURY;
  const Lp = (218.316 + 481267.881 * T) * DEG;   // mean longitude
  const M = (357.529 + 35999.050 * T) * DEG;     // Sun's mean anomaly
  const Mp = (134.963 + 477198.867 * T) * DEG;   // Moon's mean anomaly
  const D = (297.850 + 445267.111 * T) * DEG;    // mean elongation
  const F = (93.272 + 483202.018 * T) * DEG;     // argument of latitude

  // Leading terms of the ELP series (Meeus tables 47.A and 47.B). The named
  // ones are the classical inequalities; together they hold longitude to a few
  // hundredths of a degree, which is well under the Moon's apparent radius.
  const lon = Lp + (
    6.288774 * Math.sin(Mp) +                 // equation of the centre
    1.274027 * Math.sin(2 * D - Mp) +         // evection
    0.658314 * Math.sin(2 * D) +              // variation
    0.213618 * Math.sin(2 * Mp) +
    -0.185116 * Math.sin(M) +                 // annual equation
    -0.114332 * Math.sin(2 * F) +
    0.058793 * Math.sin(2 * D - 2 * Mp) +
    0.057066 * Math.sin(2 * D - M - Mp) +
    0.053322 * Math.sin(2 * D + Mp) +
    0.045758 * Math.sin(2 * D - M) +
    -0.040923 * Math.sin(M - Mp) +
    -0.034720 * Math.sin(D) +                 // parallactic inequality
    -0.030383 * Math.sin(M + Mp) +
    0.015327 * Math.sin(2 * D - 2 * F) +
    -0.012528 * Math.sin(Mp + 2 * F) +
    0.010980 * Math.sin(Mp - 2 * F) +
    0.010675 * Math.sin(4 * D - Mp) +
    0.010034 * Math.sin(3 * Mp) +
    0.008548 * Math.sin(4 * D - 2 * Mp) +
    -0.007888 * Math.sin(2 * D + M - Mp) +
    -0.006766 * Math.sin(2 * D + M) +
    -0.005163 * Math.sin(D - Mp) +
    0.004987 * Math.sin(D + M) +
    0.004036 * Math.sin(2 * D - M + Mp) +
    0.003994 * Math.sin(2 * D + 2 * Mp) +
    0.003861 * Math.sin(4 * D) +
    0.003665 * Math.sin(2 * D - 3 * Mp)
  ) * DEG;

  const lat = (
    5.128122 * Math.sin(F) +
    0.280602 * Math.sin(Mp + F) +
    0.277693 * Math.sin(Mp - F) +
    0.173237 * Math.sin(2 * D - F) +
    0.055413 * Math.sin(2 * D - Mp + F) +
    0.046271 * Math.sin(2 * D - Mp - F) +
    0.032573 * Math.sin(2 * D + F) +
    0.017198 * Math.sin(2 * Mp + F) +
    0.009266 * Math.sin(2 * D + Mp - F) +
    0.008822 * Math.sin(2 * Mp - F) +
    0.008216 * Math.sin(2 * D - M - F) +
    0.004324 * Math.sin(2 * D - 2 * Mp - F) +
    0.004200 * Math.sin(2 * D + Mp + F) +
    -0.003359 * Math.sin(2 * D + M - F) +
    0.002463 * Math.sin(2 * D - M - Mp + F)
  ) * DEG;

  const rKm =
    385000.56 +
    -20905.355 * Math.cos(Mp) +
    -3699.111 * Math.cos(2 * D - Mp) +
    -2955.968 * Math.cos(2 * D) +
    -569.925 * Math.cos(2 * Mp) +
    48.888 * Math.cos(M) +
    -3.149 * Math.cos(2 * F) +
    246.158 * Math.cos(2 * D - 2 * Mp) +
    -152.138 * Math.cos(2 * D - M - Mp) +
    -170.733 * Math.cos(2 * D - M) +
    -204.586 * Math.cos(M - Mp) +
    -129.620 * Math.cos(D) +
    108.743 * Math.cos(M + Mp) +
    104.755 * Math.cos(2 * D + Mp) +
    79.661 * Math.cos(Mp - 2 * F) +
    -34.782 * Math.cos(4 * D - Mp) +
    -23.210 * Math.cos(3 * Mp) +
    -21.636 * Math.cos(4 * D - 2 * Mp) +
    24.208 * Math.cos(2 * D + M - Mp) +
    30.824 * Math.cos(2 * D + M) +
    -8.379 * Math.cos(D - Mp) +
    -16.675 * Math.cos(D + M) +
    -12.831 * Math.cos(2 * D - M + Mp) +
    -10.445 * Math.cos(2 * D + 2 * Mp) +
    -11.650 * Math.cos(4 * D) +
    14.403 * Math.cos(2 * D - 3 * Mp);

  // The series gives longitude from the equinox of date. The simulation frame
  // is fixed to J2000, and the equinox has since precessed forward by p_A, so
  // that has to come back off - it is a third of a degree by the 2020s, which
  // is most of the Moon's own apparent diameter.
  const precession = (1.39697128 * T + 0.00030865 * T * T) * DEG;
  const lonJ2000 = lon - precession;

  const r = rKm * 1000;
  const cosLat = Math.cos(lat);
  return set(out,
    r * cosLat * Math.cos(lonJ2000),
    r * cosLat * Math.sin(lonJ2000),
    r * Math.sin(lat));
};

// ---------------------------------------------------------------------------

// Scratch vectors are deliberately split by owner. Sharing one pool across
// computeState and the position()/velocity() wrappers aliased Earth's output
// velocity onto the lunar series' workspace, which silently poisoned the
// cached value for every later reader.
const discardPos = vec();
const discardVel = vec();
const planetBack = vec();
const planetFwd = vec();
const planetVelDiscard = vec();
const moonSampleBack = vec();
const moonSampleFwd = vec();
const moonA = vec();
const moonB = vec();
const relPos = vec();
const relVel = vec();
const parentPos = vec();
const parentVel = vec();

interface Memo {
  t: number;
  pos: Vec3;
  vel: Vec3;
}

interface FrameSample {
  /** exact samples at the frame start, midpoint and end */
  p0: Vec3; p1: Vec3; p2: Vec3;
  v0: Vec3; v1: Vec3; v2: Vec3;
  /** true when the body turns too far in one frame for a parabola to fit */
  needsExact: boolean;
}

export class Ephemeris {
  /** Ordered body ids; indices into this array are used by the hot paths. */
  readonly ids: string[] = BODIES.map((b) => b.id);
  readonly indexOf = new Map<string, number>(this.ids.map((id, i) => [id, i]));

  private readonly memo = new Map<string, Memo>();
  private readonly samples = new Map<string, FrameSample>();
  private frameT0 = 0;
  private frameDt = 1;
  private frameValid = false;

  constructor() {
    for (const id of this.ids) {
      this.memo.set(id, { t: Number.NaN, pos: vec(), vel: vec() });
      this.samples.set(id, {
        p0: vec(), p1: vec(), p2: vec(),
        v0: vec(), v1: vec(), v2: vec(),
        needsExact: true,
      });
    }
  }

  /** Exact heliocentric state of a body, with a one-slot per-body time memo. */
  state(id: string, t: number, outPos: Vec3, outVel: Vec3): void {
    const memo = this.memo.get(id);
    if (memo && memo.t === t) {
      copy(outPos, memo.pos);
      copy(outVel, memo.vel);
      return;
    }
    this.computeState(id, t, outPos, outVel);
    if (memo) {
      memo.t = t;
      copy(memo.pos, outPos);
      copy(memo.vel, outVel);
    }
  }

  position(id: string, t: number, out: Vec3): Vec3 {
    this.state(id, t, out, discardVel);
    return out;
  }

  velocity(id: string, t: number, out: Vec3): Vec3 {
    this.state(id, t, discardPos, out);
    return out;
  }

  private computeState(id: string, t: number, outPos: Vec3, outVel: Vec3): void {
    if (id === 'sun') {
      // The Standish elements are heliocentric, so the Sun defines the origin.
      set(outPos, 0, 0, 0);
      set(outVel, 0, 0, 0);
      return;
    }

    if (id === 'earth') {
      // The element set tracks the Earth-Moon barycentre; the Earth itself is
      // pulled off it toward the Moon by the mass ratio.
      this.planetState('earth', t, outPos, outVel);
      this.moonRelativeState(t, moonA, moonB);
      outPos.x -= MOON_MASS_FRACTION * moonA.x;
      outPos.y -= MOON_MASS_FRACTION * moonA.y;
      outPos.z -= MOON_MASS_FRACTION * moonA.z;
      outVel.x -= MOON_MASS_FRACTION * moonB.x;
      outVel.y -= MOON_MASS_FRACTION * moonB.y;
      outVel.z -= MOON_MASS_FRACTION * moonB.z;
      return;
    }

    if (id === 'moon') {
      this.state('earth', t, outPos, outVel);
      this.moonRelativeState(t, moonA, moonB);
      add(outPos, outPos, moonA);
      add(outVel, outVel, moonB);
      return;
    }

    if (PLANET_ELEMENTS_BY_ID.has(id)) {
      this.planetState(id, t, outPos, outVel);
      return;
    }

    const moonEl = MOON_ELEMENTS_BY_ID.get(id);
    if (moonEl) {
      const n = TWO_PI / (moonEl.periodDays * DAY);
      const argPeri = (moonEl.lonPeri - moonEl.lonNode) * DEG;
      const meanAnomaly = wrapPi(
        (moonEl.L - moonEl.lonPeri) * DEG + n * (t - MOON_ELEMENTS_EPOCH),
      );
      elementsToState(
        {
          a: moonEl.a,
          e: moonEl.e,
          i: moonEl.i * DEG,
          lonNode: moonEl.lonNode * DEG,
          argPeri,
          meanAnomaly,
        },
        // Relative two-body motion is governed by the sum of the masses.
        getBody(moonEl.parent).mu + getBody(id).mu,
        relPos,
        relVel,
        n,
      );
      // Elements are referred to the parent's equator; rotate into the ecliptic.
      const m = parentEquatorMatrix(moonEl.parent, t);
      apply(relPos, m, relPos);
      apply(relVel, m, relVel);
      this.state(moonEl.parent, t, parentPos, parentVel);
      add(outPos, parentPos, relPos);
      add(outVel, parentVel, relVel);
      return;
    }

    throw new Error(`no ephemeris for body: ${id}`);
  }

  /**
   * Planet velocity, as the exact derivative of the modelled position.
   *
   * The elements themselves drift with time — the semi-major axis, the
   * eccentricity and above all the perihelion all move — so the two-body
   * velocity of a frozen ellipse is not the derivative of the trajectory this
   * model actually traces. The gap is small (a fraction of a m/s out of tens
   * of km/s) but it is a genuine inconsistency, and it shows up as a ship
   * spawned in "circular" orbit breathing in and out by 800 m every
   * revolution. Central-differencing the position removes it entirely, and
   * three Kepler solves instead of one is not worth optimising away.
   */
  private planetState(id: string, t: number, outPos: Vec3, outVel: Vec3): void {
    const h = 60;
    this.planetPosition(id, t, outPos);
    this.planetPosition(id, t - h, planetBack);
    this.planetPosition(id, t + h, planetFwd);
    sub(outVel, planetFwd, planetBack);
    scale(outVel, outVel, 1 / (2 * h));
  }

  private planetPosition(id: string, t: number, outPos: Vec3): void {
    const el = PLANET_ELEMENTS_BY_ID.get(id);
    if (!el) throw new Error(`no planet elements for ${id}`);
    const T = t / JULIAN_CENTURY;

    const a = (el.a + el.aDot * T) * AU;
    const e = el.e + el.eDot * T;
    const i = (el.i + el.iDot * T) * DEG;
    const L = (el.L + el.LDot * T) * DEG;
    const lonPeri = (el.lonPeri + el.lonPeriDot * T) * DEG;
    const lonNode = (el.lonNode + el.lonNodeDot * T) * DEG;

    elementsToState(
      {
        a,
        e,
        i,
        lonNode,
        argPeri: lonPeri - lonNode,
        meanAnomaly: wrapPi(L - lonPeri),
      },
      getBody('sun').mu,
      outPos,
      planetVelDiscard,
    );
  }

  /**
   * Moon position and velocity relative to Earth. The series gives position
   * only, so velocity comes from a central difference — a two-minute step is
   * short against the 27-day orbit and long against f64 rounding.
   */
  private moonRelativeState(t: number, outPos: Vec3, outVel: Vec3): void {
    const h = 120;
    moonGeocentric(t, outPos);
    moonGeocentric(t - h, moonSampleBack);
    moonGeocentric(t + h, moonSampleFwd);
    sub(outVel, moonSampleFwd, moonSampleBack);
    scale(outVel, outVel, 1 / (2 * h));
  }

  // -------------------------------------------------------------------------
  // Per-frame interpolation
  // -------------------------------------------------------------------------

  /**
   * Sample every active body at the start, middle and end of the frame.
   * Bodies that sweep more than `maxAngle` radians in one frame are flagged for
   * exact evaluation instead, since a parabola no longer tracks them.
   */
  beginFrame(t0: number, dt: number, activeIds: readonly string[], maxAngle = 0.05): void {
    this.frameT0 = t0;
    this.frameDt = dt === 0 ? 1 : dt;
    this.frameValid = true;
    const half = t0 + dt / 2;
    const end = t0 + dt;

    // Anything not sampled this frame must fall through to the exact solver,
    // otherwise it would be interpolated from a previous frame's samples.
    for (const s of this.samples.values()) s.needsExact = true;

    for (const id of activeIds) {
      const s = this.samples.get(id);
      if (!s) continue;
      s.needsExact = this.meanMotion(id) * Math.abs(dt) > maxAngle;
      if (s.needsExact) continue;
      this.state(id, t0, s.p0, s.v0);
      this.state(id, half, s.p1, s.v1);
      this.state(id, end, s.p2, s.v2);
    }
  }

  endFrame(): void {
    this.frameValid = false;
  }

  private meanMotion(id: string): number {
    if (id === 'sun') return 0;
    const moonEl = MOON_ELEMENTS_BY_ID.get(id);
    if (moonEl) return TWO_PI / (moonEl.periodDays * DAY);
    if (id === 'moon') return TWO_PI / (27.321582 * DAY);
    const el = PLANET_ELEMENTS_BY_ID.get(id);
    if (el) return Math.abs(el.LDot * DEG) / JULIAN_CENTURY;
    return 0;
  }

  /**
   * Interpolated state at any time inside the current frame. Falls back to the
   * exact solver when the frame cache is cold or the body is moving too fast
   * for the parabola.
   */
  frameState(id: string, t: number, outPos: Vec3, outVel: Vec3): void {
    const s = this.samples.get(id);
    if (!this.frameValid || !s || s.needsExact) {
      this.state(id, t, outPos, outVel);
      return;
    }
    const u = (t - this.frameT0) / this.frameDt;
    // Quadratic Lagrange basis on nodes u = 0, 1/2, 1.
    const w0 = 2 * u * u - 3 * u + 1;
    const w1 = -4 * u * u + 4 * u;
    const w2 = 2 * u * u - u;
    set(outPos,
      s.p0.x * w0 + s.p1.x * w1 + s.p2.x * w2,
      s.p0.y * w0 + s.p1.y * w1 + s.p2.y * w2,
      s.p0.z * w0 + s.p1.z * w1 + s.p2.z * w2);
    set(outVel,
      s.v0.x * w0 + s.v1.x * w1 + s.v2.x * w2,
      s.v0.y * w0 + s.v1.y * w1 + s.v2.y * w2,
      s.v0.z * w0 + s.v1.z * w1 + s.v2.z * w2);
  }

  framePosition(id: string, t: number, out: Vec3): Vec3 {
    this.frameState(id, t, out, discardVel);
    return out;
  }
}

/** Shared instance; the simulation is single-threaded so one cache is enough. */
export const ephemeris = new Ephemeris();
