/**
 * Keplerian elements for the major planets, from E. M. Standish (JPL SSD),
 * "Keplerian Elements for Approximate Positions of the Major Planets".
 *
 * Table 1 (validity 1800 AD – 2050 AD, the interval this simulator targets).
 * Each element is linear in T = Julian centuries past J2000:
 *     x(T) = x0 + xDot * T
 *
 * Angles in degrees, semi-major axis in AU. `L` is the mean longitude and
 * `lonPeri` the longitude of perihelion, so the argument of periapsis is
 * omega = lonPeri - lonNode and the mean anomaly M = L - lonPeri.
 *
 * Elements are heliocentric and referred to the mean ecliptic and equinox of
 * J2000 — exactly the frame the simulation uses, so no rotation is needed.
 *
 * Accuracy over 1800–2050 is a few arcminutes in heliocentric longitude, far
 * below anything visible at the scales flown here. `tests/unit/ephemeris.test.ts`
 * pins every row against JPL Horizons state vectors.
 */

export interface PlanetElements {
  id: string;
  /** semi-major axis, AU, and its rate per Julian century */
  a: number; aDot: number;
  /** eccentricity (dimensionless) */
  e: number; eDot: number;
  /** inclination, degrees */
  i: number; iDot: number;
  /** mean longitude, degrees */
  L: number; LDot: number;
  /** longitude of perihelion, degrees */
  lonPeri: number; lonPeriDot: number;
  /** longitude of ascending node, degrees */
  lonNode: number; lonNodeDot: number;
}

export const PLANET_ELEMENTS: readonly PlanetElements[] = [
  {
    id: 'mercury',
    a: 0.38709927, aDot: 0.00000037,
    e: 0.20563593, eDot: 0.00001906,
    i: 7.00497902, iDot: -0.00594749,
    L: 252.25032350, LDot: 149472.67411175,
    lonPeri: 77.45779628, lonPeriDot: 0.16047689,
    lonNode: 48.33076593, lonNodeDot: -0.12534081,
  },
  {
    id: 'venus',
    a: 0.72333566, aDot: 0.00000390,
    e: 0.00677672, eDot: -0.00004107,
    i: 3.39467605, iDot: -0.00078890,
    L: 181.97909950, LDot: 58517.81538729,
    lonPeri: 131.60246718, lonPeriDot: 0.00268329,
    lonNode: 76.67984255, lonNodeDot: -0.27769418,
  },
  {
    // Earth-Moon barycentre. The Earth itself is offset from this by the
    // Moon's pull; ephemeris.ts applies that correction explicitly.
    id: 'earth',
    a: 1.00000261, aDot: 0.00000562,
    e: 0.01671123, eDot: -0.00004392,
    i: -0.00001531, iDot: -0.01294668,
    L: 100.46457166, LDot: 35999.37244981,
    lonPeri: 102.93768193, lonPeriDot: 0.32327364,
    lonNode: 0.0, lonNodeDot: 0.0,
  },
  {
    id: 'mars',
    a: 1.52371034, aDot: 0.00001847,
    e: 0.09339410, eDot: 0.00007882,
    i: 1.84969142, iDot: -0.00813131,
    L: -4.55343205, LDot: 19140.30268499,
    lonPeri: -23.94362959, lonPeriDot: 0.44441088,
    lonNode: 49.55953891, lonNodeDot: -0.29257343,
  },
  {
    id: 'jupiter',
    a: 5.20288700, aDot: -0.00011607,
    e: 0.04838624, eDot: -0.00013253,
    i: 1.30439695, iDot: -0.00183714,
    L: 34.39644051, LDot: 3034.74612775,
    lonPeri: 14.72847983, lonPeriDot: 0.21252668,
    lonNode: 100.47390909, lonNodeDot: 0.20469106,
  },
  {
    id: 'saturn',
    a: 9.53667594, aDot: -0.00125060,
    e: 0.05386179, eDot: -0.00050991,
    i: 2.48599187, iDot: 0.00193609,
    L: 49.95424423, LDot: 1222.49362201,
    lonPeri: 92.59887831, lonPeriDot: -0.41897216,
    lonNode: 113.66242448, lonNodeDot: -0.28867794,
  },
  {
    id: 'uranus',
    a: 19.18916464, aDot: -0.00196176,
    e: 0.04725744, eDot: -0.00004397,
    i: 0.77263783, iDot: -0.00242939,
    L: 313.23810451, LDot: 428.48202785,
    lonPeri: 170.95427630, lonPeriDot: 0.40805281,
    lonNode: 74.01692503, lonNodeDot: 0.04240589,
  },
  {
    id: 'neptune',
    a: 30.06992276, aDot: 0.00026291,
    e: 0.00859048, eDot: 0.00005105,
    i: 1.77004347, iDot: 0.00035372,
    L: -55.12002969, LDot: 218.45945325,
    lonPeri: 44.96476227, lonPeriDot: -0.32241464,
    lonNode: 131.78422574, lonNodeDot: -0.00508664,
  },
  {
    id: 'pluto',
    a: 39.48211675, aDot: -0.00031596,
    e: 0.24882730, eDot: 0.00005170,
    i: 17.14001206, iDot: 0.00004818,
    L: 238.92903833, LDot: 145.20780515,
    lonPeri: 224.06891629, lonPeriDot: -0.04062942,
    lonNode: 110.30393684, lonNodeDot: -0.01183482,
  },
];

export const PLANET_ELEMENTS_BY_ID: ReadonlyMap<string, PlanetElements> = new Map(
  PLANET_ELEMENTS.map((el) => [el.id, el]),
);
