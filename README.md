# Sun — a true-scale solar system flight simulator

Fly a human-sized ship through the real solar system, at the real size, from the
window.

Nothing is scaled up for legibility. Jupiter is 143,000 km across because
Jupiter is 143,000 km across, so from four radii out it fills the window like a
wall and there is no way to see all of it at once. The Sun is 1.4 million km
across and the ship is 50 m long. That ratio *is* the simulation.

**[▶ Fly it in your browser](https://maam783.github.io/sun-solar-system-simulator/)**

## Running it locally

```bash
npm install && npm run dev
```

Then open <http://localhost:5173>. Click the window to capture the mouse for
flying, **Esc** to hand the cursor back to the console, and **H** for the full
control list.

You start in a 400 km orbit over the daylight side of Earth, on today's actual
date, with the planets where they actually are.

## Two ways to use it

**Click a flypast.** The *Sights* panel has six of them — through Saturn's
rings, over Jupiter's cloud tops at 1.04 radii, Earthrise from behind the lunar
limb, Io with Jupiter filling twenty degrees of sky, three and a half radii off
the Sun, a low pass across Mars. Each is a camera move about a minute long; the
ship flies it and points itself at the subject. Nothing to pilot.

**Or fly it yourself.** Flying is four keys: point with the mouse, **W** faster,
**S** slower, **Space** to stop. The ship holds itself against gravity, so
letting go of everything leaves you parked next to whatever you were looking at,
and it will not offer a speed it could not stop from before hitting what it is
near. That is *PILOT* mode, and it is the default.

*ORBITAL* mode is the other one: Newtonian, thrust changes your orbit, and
managing the consequences is the game. **ORBIT HERE** drops you into a real
circular orbit around whatever you are closest to. Both modes fly through the
same solar system — the difference is the drive, not the physics of the world.

## What is simulated properly

- **Positions.** Planets come from the JPL/Standish element set, the Moon from a
  truncated lunar series, and the other fifteen moons from mean elements fitted
  directly to JPL Horizons ephemeris. Checked against 48 Horizons state vectors:
  planets agree to better than 0.075°, the Moon to 47 arcseconds.
- **Orientation.** IAU rotation models, so axial tilts, rotation periods and the
  position of the terminator are right. Venus turns backwards, Uranus lies on its
  side, and Jupiter's day is ten hours long.
- **Gravity.** Every body is a point mass and the ship feels all of them, all the
  time, integrated with adaptive-substep RK4 in double precision. Gravity assists,
  three-body wandering and tidal perturbations are not scripted — they fall out.
- **Collisions.** Swept against each body's surface. At override speeds a single
  frame crosses several AU, so endpoint tests would fly straight through planets;
  this doesn't.
- **Light.** Bodies are lit by real solar irradiance, which is 1/27 of Earth's at
  Jupiter and 1/1500 at Pluto. The view is exposed for the local light level the
  way an eye adapts, so the outer system reads as dim without going black.
  Anything under a couple of pixels across is drawn as a point of its true
  apparent magnitude, which is why Venus is a hard white spark and Pluto is not
  there at all.
- **Stars.** 8,920 real stars from the HYG catalogue down to magnitude 7. The
  constellations out of the window are the real ones, seen from where you are.

## The deliberate exceptions

Everything above is real. These are not, and the simulator says so:

0. **The PILOT drive commands velocity, not acceleration.** Point, pick a speed,
   and the ship goes — cancelling local gravity as it does. A real ship is a
   projectile with a small engine, which is why flying one is mostly consequence
   management. This is the trade that makes the thing a spaceship rather than a
   physics console. ORBITAL mode gives it back.
1. **Unlimited propellant.** The drive never runs out. The console shows the mass
   ratio a real rocket would have needed for the Δv you have spent so far — for a
   3 g run to Mars, a chemical rocket would need a mass ratio of about 10^275.
2. **The OVERRIDE drive**, at 1c / 5c / 20c / 100c. Explicitly faster than light.
   Dropping back to NORMAL sheds the excess speed; it is the one place the
   simulation discards energy on purpose.
3. **NORMAL mode stops the drive at 0.1 c.** Not an arbitrary limit — that is
   where the Lorentz factor reaches 1.005, so the Newtonian mechanics this
   simulator actually integrates is still accurate to 0.5% in momentum and 0.75%
   in energy. Past it the model would be quietly wrong.

| speed | γ − 1 (momentum error) | kinetic energy error |
|---|---|---|
| 0.05 c | 0.13 % | 0.19 % |
| **0.10 c** | **0.50 %** | **0.75 %** |
| 0.20 c | 2.1 % | 3 % |
| 0.30 c | 4.8 % | 7 % |

**Time warp is not an exception.** Up to 1,000,000× it replays the same physics
faster, and it backs off automatically near a gravity well — not by a rule about
distance, but because the integrator reports the largest step it can carry
accurately and the warp drops to it.

## Getting anywhere

Real distances are the problem the whole interface exists to solve. At a
continuous 1 g burn — flip over halfway and decelerate — Mars is 2.1 days away
and Pluto is 17.7. So:

| destination | at 1 g (flip and burn) | peak speed | at 5c override |
|---|---|---|---|
| Mars | 2.1 days | 874 km/s | 52 s |
| Jupiter | 5.9 days | 2,480 km/s | 7 min |
| Saturn | 8.4 days | 3,550 km/s | 14 min |
| Pluto | 17.7 days | 7,520 km/s | 64 min |

The **navigation computer** flies those profiles. It follows a desired-velocity
field recomputed every integration substep:

```
v_desired = v_standoff + d̂ · min(cap, √(2 · a_brake · distance))
```

The square root is exactly the speed from which the ship can still stop in the
distance remaining, so it can never build a speed it cannot shed. It compensates
local gravity explicitly, steers around anything in the way, and parks four
planetary radii out on the sunlit side.

There is also a **Hohmann transfer** mode, which is the honest version: the
fuel-optimal two-burn solution, with the phase-angle wait. Earth to Mars comes
out at Δv 2,945 and 2,649 m/s, 259 days in flight, departing every 780 days.

## Verifying it

```bash
npm run verify     # typecheck + 102 unit tests
```

The unit tests cover the Kepler solvers, the ephemeris against committed JPL
Horizons fixtures, the IAU frames, and integrator accuracy — including a
full simulated year against the analytic two-body solution, which it matches to
one part in 10¹¹ in energy.

The simulator also checks itself in the browser. Load `?scenario=tour` and it
flies fourteen scripted flights and prints machine-readable results:

```
[SCEN] name=angular-sizes  status=PASS sun_deg=0.5249 moon_deg=0.4904 earth_deg=140.4
[SCEN] name=leo-orbit      status=PASS altitude_err_m=0.57 period_s=5544.9 eccentricity=8.8e-8
[SCEN] name=mars-direct    status=PASS dist_err_pct=2.1e-6 station_ms=0.21 t_sim_h=58.6
[SCEN] name=jupiter-slingshot status=PASS vinf_ratio_err_pct=0.045 turn_err_pct=0.006 helio_gain_kms=8.59
[SCEN] name=hohmann-mars   status=PASS dv1_ms=2944.7 dv2_ms=2648.9 tof_days=258.9 phase_deg=44.34
[SCEN] name=flypasts       status=PASS routes=6 subject_in_frame_pct=99.8 closest_radii=1.04
[SCEN] name=orbit-here     status=PASS eccentricity=1.6e-7 altitude_drift_m=0.59 gload=0
[SCEN] name=pilot-mode     status=PASS station_drift_m=5.8 warning_seconds=6.5 impact_speed_ms=125
```

The last three cover the parts a physics test cannot: that every flypast keeps
its subject in frame and clears the surface, that "orbit here" means *here*, and
that holding the throttle open straight at a planet for three minutes cannot
produce a fast impact.

The slingshot one is the nicest: it confirms that a Jupiter encounter is elastic
in Jupiter's frame — the ship leaves with the speed it arrived with, to within
0.045% — while gaining 8.6 km/s in the Sun's frame, borrowed from Jupiter's
orbital motion. Nothing implements that. It is what integrating Newtonian
gravity does.

Individual scenarios run the same way: `?scenario=jupiter-slingshot`, or a
comma-separated list.

## Controls

| | |
|---|---|
| Mouse | Point the nose (click to capture; drag also works) |
| **W / S** | **Faster / slower** |
| **Space** | **All stop** |
| **Esc** | **Release the mouse, or take back control from a flypast** |
| Q / E | Roll |
| A D R F | Translate left, right, up, down |
| Z | Drive lock (ORBITAL) |
| , / . | Drive power down / up (ORBITAL, 0.1 g – 100 g) |
| Tab / T | Cycle target |
| N | Engage / abort autopilot |
| 1 2 3 | Autopilot at 1 g / 3 g / 10 g |
| C | Cycle attitude hold (prograde, retrograde, target, nadir) |
| V | Point at target |
| O | Toggle the OVERRIDE drive |
| [ / ] | Time warp down / up |
| G | Flight assist on / off |
| P | Pause |
| R | Respawn in Earth orbit |
| + / − | Zoom |
| H | Controls |

## Assets

Textures and the star catalogue are fetched by `npm run assets`; the ephemeris
fixtures by `npm run fixtures`. Every body has a procedural fallback surface, so
a failed download degrades the view rather than breaking it — the `no-assets`
scenario keeps that path permanently tested. Sources and licences are in
[public/assets/ATTRIBUTION.md](public/assets/ATTRIBUTION.md).

## Built with

Three.js (WebGL2), TypeScript, Vite. Simulation state is double-precision SI
throughout; the renderer uses a floating origin — the camera sits at the scene
origin and every body is placed at (body − ship), computed in f64 and narrowed
to f32 only at the last step — with a logarithmic depth buffer spanning one metre
to ten thousand AU.
