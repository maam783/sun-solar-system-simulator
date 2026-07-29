/**
 * Physical constants and per-body physical data. SI units throughout
 * (metres, seconds, kilograms) unless a name says otherwise.
 *
 * Sources: IAU 2015 nominal values, JPL SSD planetary physical parameters,
 * IAU WGCCRE 2015 report (rotation), NASA planetary fact sheets (albedo).
 */

export const G = 6.6743e-11;                 // m^3 kg^-1 s^-2
export const C_LIGHT = 299792458;            // m/s (exact)
export const AU = 1.495978707e11;            // m (exact, IAU 2012)
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const DAY = 86400;                    // s
export const JULIAN_CENTURY = 36525 * DAY;   // s
export const OBLIQUITY_J2000 = 23.43929111 * DEG; // ecliptic obliquity at J2000

/** Solar luminosity, used for irradiance-based lighting. */
export const L_SUN = 3.828e26;               // W
/** Apparent V magnitude of the Sun seen from 1 AU. */
export const V_MAG_SUN = -26.74;

export type BodyKind = 'star' | 'planet' | 'dwarf' | 'moon';

export interface BodyPhysical {
  id: string;
  name: string;
  kind: BodyKind;
  parent: string | null;
  /** Gravitational parameter GM in m^3/s^2 (more precisely known than G*M separately). */
  mu: number;
  /** Mean radius, m. Used for rendering and gravity reference. */
  radius: number;
  /** Equatorial radius, m (rendering oblateness). */
  radiusEq: number;
  /** Polar radius, m. */
  radiusPol: number;
  /**
   * Collision radius, m. Solid surface for rocky bodies, the 1-bar level for
   * gas giants, the photosphere for the Sun. Touching this ends the flight.
   */
  radiusCollide: number;
  /** Geometric albedo (V band), for apparent-magnitude computation. */
  albedo: number;
  /** Base sRGB colour used by the procedural fallback material. */
  color: number;
  /** True if the body has a visible atmosphere limb. */
  atmosphere: boolean;
  /** Atmosphere rim colour (only meaningful when atmosphere is true). */
  atmosphereColor: number;
  /** Relative thickness of the rendered atmosphere shell (fraction of radius). */
  atmosphereScale: number;
}

const b = (
  id: string,
  name: string,
  kind: BodyKind,
  parent: string | null,
  mu: number,
  radius: number,
  opts: Partial<BodyPhysical> = {},
): BodyPhysical => ({
  id,
  name,
  kind,
  parent,
  mu,
  radius,
  radiusEq: opts.radiusEq ?? radius,
  radiusPol: opts.radiusPol ?? radius,
  radiusCollide: opts.radiusCollide ?? radius,
  albedo: opts.albedo ?? 0.1,
  color: opts.color ?? 0x998877,
  atmosphere: opts.atmosphere ?? false,
  atmosphereColor: opts.atmosphereColor ?? 0x88aaff,
  atmosphereScale: opts.atmosphereScale ?? 0.02,
});

export const BODIES: BodyPhysical[] = [
  b('sun', 'Sun', 'star', null, 1.32712440018e20, 6.957e8, {
    radiusCollide: 6.957e8, albedo: 1, color: 0xfff6e5,
  }),

  // --- Planets -------------------------------------------------------------
  b('mercury', 'Mercury', 'planet', 'sun', 2.2031868551e13, 2.4394e6, {
    albedo: 0.142, color: 0x9c8e82,
  }),
  b('venus', 'Venus', 'planet', 'sun', 3.24858592e14, 6.0518e6, {
    albedo: 0.689, color: 0xe8d8a8, atmosphere: true,
    atmosphereColor: 0xf5e6b8, atmosphereScale: 0.012,
  }),
  b('earth', 'Earth', 'planet', 'sun', 3.986004418e14, 6.371e6, {
    radiusEq: 6.378137e6, radiusPol: 6.356752e6, radiusCollide: 6.371e6,
    albedo: 0.434, color: 0x2b5faa, atmosphere: true,
    atmosphereColor: 0x6ab0ff, atmosphereScale: 0.016,
  }),
  b('mars', 'Mars', 'planet', 'sun', 4.282837362e13, 3.3895e6, {
    radiusEq: 3.3962e6, radiusPol: 3.3762e6,
    albedo: 0.17, color: 0xc1643c, atmosphere: true,
    atmosphereColor: 0xd8a583, atmosphereScale: 0.008,
  }),
  // Gas giants: collision radius is the 1-bar level (equatorial), i.e. the
  // "cloud tops" a ship would slam into.
  b('jupiter', 'Jupiter', 'planet', 'sun', 1.26686534e17, 6.9911e7, {
    radiusEq: 7.1492e7, radiusPol: 6.6854e7, radiusCollide: 6.9911e7,
    albedo: 0.538, color: 0xc9a882, atmosphere: true,
    atmosphereColor: 0xd9c3a0, atmosphereScale: 0.012,
  }),
  b('saturn', 'Saturn', 'planet', 'sun', 3.7931187e16, 5.8232e7, {
    radiusEq: 6.0268e7, radiusPol: 5.4364e7, radiusCollide: 5.8232e7,
    albedo: 0.499, color: 0xd8c07a, atmosphere: true,
    atmosphereColor: 0xe6d5a5, atmosphereScale: 0.012,
  }),
  b('uranus', 'Uranus', 'planet', 'sun', 5.793939e15, 2.5362e7, {
    radiusEq: 2.5559e7, radiusPol: 2.4973e7,
    albedo: 0.488, color: 0x9fd8e0, atmosphere: true,
    atmosphereColor: 0xb8ecf2, atmosphereScale: 0.014,
  }),
  b('neptune', 'Neptune', 'planet', 'sun', 6.836529e15, 2.4622e7, {
    radiusEq: 2.4764e7, radiusPol: 2.4341e7,
    albedo: 0.442, color: 0x3d5ef2, atmosphere: true,
    atmosphereColor: 0x6f8dff, atmosphereScale: 0.014,
  }),
  b('pluto', 'Pluto', 'dwarf', 'sun', 8.71e11, 1.1883e6, {
    albedo: 0.52, color: 0xcfc0ae,
  }),

  // --- Moons ---------------------------------------------------------------
  b('moon', 'Moon', 'moon', 'earth', 4.9048695e12, 1.7374e6, {
    albedo: 0.136, color: 0x8f8b85,
  }),
  b('phobos', 'Phobos', 'moon', 'mars', 7.087e5, 1.11e4, {
    albedo: 0.071, color: 0x7a6a5c,
  }),
  b('deimos', 'Deimos', 'moon', 'mars', 9.615e4, 6.2e3, {
    albedo: 0.068, color: 0x8a7a6a,
  }),
  b('io', 'Io', 'moon', 'jupiter', 5.9599156e12, 1.8216e6, {
    albedo: 0.63, color: 0xd6c25c,
  }),
  b('europa', 'Europa', 'moon', 'jupiter', 3.2027121e12, 1.5608e6, {
    albedo: 0.67, color: 0xb8a58c,
  }),
  b('ganymede', 'Ganymede', 'moon', 'jupiter', 9.8878328e12, 2.6341e6, {
    albedo: 0.43, color: 0x8e8378,
  }),
  b('callisto', 'Callisto', 'moon', 'jupiter', 7.1792895e12, 2.4103e6, {
    albedo: 0.22, color: 0x6b5f55,
  }),
  b('mimas', 'Mimas', 'moon', 'saturn', 2.5026e9, 1.982e5, {
    albedo: 0.962, color: 0xbdbdbd,
  }),
  b('enceladus', 'Enceladus', 'moon', 'saturn', 7.2027e9, 2.521e5, {
    albedo: 1.0, color: 0xe8f0f2,
  }),
  b('rhea', 'Rhea', 'moon', 'saturn', 1.53939e11, 7.634e5, {
    albedo: 0.949, color: 0xc8c4bd,
  }),
  b('titan', 'Titan', 'moon', 'saturn', 8.9781372e12, 2.5747e6, {
    albedo: 0.22, color: 0xd39b4a, atmosphere: true,
    atmosphereColor: 0xe0a95c, atmosphereScale: 0.08,
  }),
  b('iapetus', 'Iapetus', 'moon', 'saturn', 1.20512e11, 7.345e5, {
    albedo: 0.25, color: 0x8a7f6e,
  }),
  b('titania', 'Titania', 'moon', 'uranus', 2.2843e11, 7.884e5, {
    albedo: 0.35, color: 0x9a8d84,
  }),
  b('oberon', 'Oberon', 'moon', 'uranus', 1.9241e11, 7.614e5, {
    albedo: 0.31, color: 0x8d8078,
  }),
  b('triton', 'Triton', 'moon', 'neptune', 1.4279e12, 1.3534e6, {
    albedo: 0.76, color: 0xd6cec4,
  }),
  b('charon', 'Charon', 'moon', 'pluto', 1.058e11, 6.06e5, {
    albedo: 0.35, color: 0xa89f96,
  }),
];

export const BODY_BY_ID: ReadonlyMap<string, BodyPhysical> = new Map(
  BODIES.map((body) => [body.id, body]),
);

export const getBody = (id: string): BodyPhysical => {
  const found = BODY_BY_ID.get(id);
  if (!found) throw new Error(`unknown body id: ${id}`);
  return found;
};

/**
 * Absolute magnitude V(1,0): the visual magnitude the body would have at 1 AU
 * from both Sun and observer at zero phase angle.
 *
 * H = 5*log10(1329 / (D_km * sqrt(albedo))) — the standard photometric
 * relation, with 1329 km the constant implied by the Sun's V magnitude.
 * Deriving it from radius and albedo avoids a table of hand-copied numbers.
 */
export const absoluteMagnitude = (body: BodyPhysical): number => {
  const diameterKm = (2 * body.radius) / 1000;
  return 5 * Math.log10(1329 / (diameterKm * Math.sqrt(body.albedo)));
};

/** Saturn's ring system geometry (metres from Saturn's centre). */
export const SATURN_RING_INNER = 7.4658e7;   // inner edge of the C ring
export const SATURN_RING_OUTER = 1.40270e8;  // outer edge of the A ring
