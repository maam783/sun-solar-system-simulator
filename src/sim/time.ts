/**
 * Simulation clock.
 *
 * `t` is seconds past the J2000.0 epoch (2000-01-01 12:00 TT). Everything in
 * the simulation — ephemerides, rotation, autopilot schedules — is a function
 * of this one number. The clock starts at the real current date so the planets
 * stand where they actually stand today.
 */

import { DAY, JULIAN_CENTURY } from '../data/constants';

/** Unix seconds at the J2000 epoch (2000-01-01T11:58:55.816Z UTC). */
const J2000_UNIX = 946727935.816;
/** TT - UTC, seconds. Constant here: leap seconds are not modelled. */
const TT_MINUS_UTC = 69.184;

export const J2000_JD = 2451545.0;

/** Seconds past J2000 for a given wall-clock time (Unix milliseconds). */
export const simTimeFromUnixMs = (unixMs: number): number =>
  unixMs / 1000 - J2000_UNIX + TT_MINUS_UTC;

/** Seconds past J2000 right now. */
export const simTimeNow = (): number => simTimeFromUnixMs(Date.now());

/** Seconds past J2000 for an ISO date string, e.g. "2026-07-29T00:00:00Z". */
export const simTimeFromISO = (iso: string): number => simTimeFromUnixMs(Date.parse(iso));

export const julianDate = (t: number): number => J2000_JD + t / DAY;
export const daysSinceJ2000 = (t: number): number => t / DAY;
export const centuriesSinceJ2000 = (t: number): number => t / JULIAN_CENTURY;

/** Calendar date for display. Returns a UTC-based Date (TT offset removed). */
export const dateFromSimTime = (t: number): Date =>
  new Date((t + J2000_UNIX - TT_MINUS_UTC) * 1000);

export const formatSimDate = (t: number): string => {
  const d = dateFromSimTime(t);
  if (!Number.isFinite(d.getTime())) return '--------- --:--:--';
  const p = (n: number, w = 2) => String(Math.floor(n)).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`
  );
};

/** Human-readable duration, chosen unit by magnitude. */
export const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds)) return '--';
  const s = Math.abs(seconds);
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  if (s < DAY) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  if (s < 365.25 * DAY) return `${Math.floor(s / DAY)}d ${Math.floor((s % DAY) / 3600)}h`;
  return `${(s / (365.25 * DAY)).toFixed(2)} yr`;
};

export class SimClock {
  /** Seconds past J2000. */
  t: number;
  /** Sim seconds elapsed since the flight started (for mission-elapsed time). */
  elapsed = 0;

  constructor(t0: number = simTimeNow()) {
    this.t = t0;
  }

  advance(dt: number): void {
    this.t += dt;
    this.elapsed += dt;
  }

  reset(t0: number): void {
    this.t = t0;
    this.elapsed = 0;
  }
}
