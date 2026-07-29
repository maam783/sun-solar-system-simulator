/**
 * Body orientation from the IAU WGCCRE 2015 rotation models.
 *
 * Each model gives the north pole direction in ICRF equatorial coordinates
 * (right ascension alpha0, declination delta0, both drifting slowly with
 * Julian centuries T) and the prime-meridian angle W, which grows linearly
 * with days d past J2000. Together they fix the body-fixed frame, and hence
 * axial tilt, rotation period and the position of the terminator.
 *
 * Small periodic terms (below a degree, from nutation and libration) are
 * dropped: they are far below anything visible from a cockpit. Earth's Moon
 * keeps its three leading libration terms because its near-side alignment is
 * something a pilot actually looks at.
 *
 * Moons marked `sync: true` have no tabulated model here; they are synchronous
 * rotators, so frames.ts derives their orientation from the orbit itself
 * (spin axis along the orbit normal, prime meridian facing the parent). That
 * is exact for a tidally locked body and gets Triton's retrograde spin right
 * for free.
 */

export interface RotationModel {
  id: string;
  /** pole right ascension at J2000, degrees, and its drift per Julian century */
  ra0: number; raT: number;
  /** pole declination at J2000, degrees, and its drift per Julian century */
  dec0: number; decT: number;
  /** prime meridian angle at J2000, degrees */
  w0: number;
  /** prime meridian rate, degrees per day (negative = retrograde rotation) */
  wDot: number;
  /** derive orientation from the orbit instead (tidally locked bodies) */
  sync?: boolean;
}

export const ROTATION_MODELS: readonly RotationModel[] = [
  { id: 'sun',     ra0: 286.13,     raT:  0.0,      dec0: 63.87,   decT:  0.0,    w0:  84.176, wDot:   14.1844000 },
  { id: 'mercury', ra0: 281.0103,   raT: -0.0328,   dec0: 61.4155, decT: -0.0049, w0: 329.5988, wDot:    6.1385108 },
  // Venus rotates retrograde: wDot is negative, no other special-casing needed.
  { id: 'venus',   ra0: 272.76,     raT:  0.0,      dec0: 67.16,   decT:  0.0,    w0: 160.20,  wDot:   -1.4813688 },
  { id: 'earth',   ra0:   0.00,     raT: -0.641,    dec0: 90.00,   decT: -0.557,  w0: 190.147, wDot:  360.9856235 },
  { id: 'mars',    ra0: 317.68143,  raT: -0.1061,   dec0: 52.88650, decT: -0.0609, w0: 176.630, wDot:  350.89198226 },
  { id: 'jupiter', ra0: 268.056595, raT: -0.006499, dec0: 64.495303, decT: 0.002413, w0: 284.95, wDot: 870.5360000 },
  { id: 'saturn',  ra0:  40.589,    raT: -0.036,    dec0: 83.537,  decT: -0.004,  w0:  38.90,  wDot:  810.7939024 },
  // Uranus' pole lies almost in the ecliptic; the negative rate is its
  // retrograde spin in the IAU convention.
  { id: 'uranus',  ra0: 257.311,    raT:  0.0,      dec0: -15.175, decT:  0.0,    w0: 203.81,  wDot: -501.1600928 },
  { id: 'neptune', ra0: 299.36,     raT:  0.0,      dec0: 43.46,   decT:  0.0,    w0: 253.18,  wDot:  536.3128492 },
  { id: 'pluto',   ra0: 132.993,    raT:  0.0,      dec0: -6.163,  decT:  0.0,    w0: 302.695, wDot:   56.3625225 },

  // Moons with tabulated models.
  { id: 'moon',     ra0: 269.9949, raT: 0.0031,  dec0: 66.5392, decT: 0.0130, w0:  38.3213, wDot:  13.17635815 },
  { id: 'io',       ra0: 268.05,   raT: -0.009,  dec0: 64.50,   decT: 0.003,  w0: 200.39,  wDot: 203.4889538 },
  { id: 'europa',   ra0: 268.08,   raT: -0.009,  dec0: 64.51,   decT: 0.003,  w0:  36.022, wDot: 101.3747235 },
  { id: 'ganymede', ra0: 268.20,   raT: -0.009,  dec0: 64.57,   decT: 0.003,  w0:  44.064, wDot:  50.3176081 },
  { id: 'callisto', ra0: 268.72,   raT: -0.009,  dec0: 64.83,   decT: 0.003,  w0: 259.51,  wDot:  21.5710715 },
  { id: 'titan',    ra0:  39.4827, raT:  0.0,    dec0: 83.4279, decT: 0.0,    w0: 186.5855, wDot: 22.5769768 },

  // Synchronous rotators without a tabulated model here.
  { id: 'phobos',    ra0: 0, raT: 0, dec0: 0, decT: 0, w0: 0, wDot: 0, sync: true },
  { id: 'deimos',    ra0: 0, raT: 0, dec0: 0, decT: 0, w0: 0, wDot: 0, sync: true },
  { id: 'mimas',     ra0: 0, raT: 0, dec0: 0, decT: 0, w0: 0, wDot: 0, sync: true },
  { id: 'enceladus', ra0: 0, raT: 0, dec0: 0, decT: 0, w0: 0, wDot: 0, sync: true },
  { id: 'rhea',      ra0: 0, raT: 0, dec0: 0, decT: 0, w0: 0, wDot: 0, sync: true },
  { id: 'iapetus',   ra0: 0, raT: 0, dec0: 0, decT: 0, w0: 0, wDot: 0, sync: true },
  { id: 'titania',   ra0: 0, raT: 0, dec0: 0, decT: 0, w0: 0, wDot: 0, sync: true },
  { id: 'oberon',    ra0: 0, raT: 0, dec0: 0, decT: 0, w0: 0, wDot: 0, sync: true },
  { id: 'triton',    ra0: 0, raT: 0, dec0: 0, decT: 0, w0: 0, wDot: 0, sync: true },
  { id: 'charon',    ra0: 0, raT: 0, dec0: 0, decT: 0, w0: 0, wDot: 0, sync: true },
];

export const ROTATION_BY_ID: ReadonlyMap<string, RotationModel> = new Map(
  ROTATION_MODELS.map((m) => [m.id, m]),
);

/**
 * Leading libration terms for the Moon's pole and prime meridian (IAU E1-E3).
 * Amplitudes are degrees; arguments are degrees, linear in days past J2000.
 */
export const MOON_LIBRATION = {
  e1: { c: 125.045, rate: -0.0529921, ra: -3.8787, dec: 1.5419, w: 3.5610 },
  e2: { c: 250.089, rate: -0.1059842, ra: -0.1204, dec: 0.0239, w: 0.1208 },
  e3: { c: 260.008, rate: 13.0120009, ra: 0.0700, dec: -0.0278, w: -0.0642 },
} as const;
