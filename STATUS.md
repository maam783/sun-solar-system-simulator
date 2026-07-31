# Build status

Every milestone below is checked with the command or URL that proved it, so the
work can be picked up cold.

Last full verification: 2026-07-30.

## Milestones

- [x] **M0 — Scaffold and harness.**
      Vite + TypeScript strict, vitest, `.claude/launch.json`, `window.SIM`
      debug API, scenario runner.
      *Proof:* `npm run verify` exits 0; `?scenario=boot` logs `status=PASS`.

- [x] **M1 — f64 maths, time, ephemeris, frames.**
      vec3d/mat3d/quat, Kepler solvers (elliptic + hyperbolic), Standish planet
      elements, 15 moons calibrated against Horizons, truncated lunar series,
      IAU rotation models.
      *Proof:* `node tools/fetch-fixtures.mjs` then `npx vitest run`. Measured
      against 48 Horizons state vectors — planets ≤ 0.074° (Saturn, which is the
      published accuracy of the element set), Moon 0.013°, Io/Europa ≤ 1.2°
      (bounded, from apsidal precession this model holds fixed).

- [x] **M2 — Renderer.**
      Floating origin, logarithmic depth, limb-darkened Sun, procedural and
      textured planet materials, atmospheric limb, Saturn's rings with the
      planet's shadow, 8,920-star HYG sky, magnitude-correct impostors,
      adaptive exposure.
      *Proof:* `?scenario=angular-sizes` → Sun 0.5249°, Moon 0.4904°,
      Earth 140.4°. Screenshots reviewed for Jupiter, Saturn, the Sun and Earth.

- [x] **M3 — Ship dynamics.**
      RK4 with adaptive substeps, gravity from all bodies with distant moons
      folded into their parent, swept collision, 0.1 c drive ceiling, OVERRIDE
      stages, destroy and respawn.
      *Proof:* `npx vitest run tests/unit/integrator.test.ts` — 16 tests
      including a full simulated year matched against the analytic two-body
      solution to 1e-11 in energy.

- [x] **M4 — Time warp and cockpit console.**
      Warp 1×–1,000,000× with automatic backing-off driven by integrator
      feedback, HUD, target selector, edge markers, warnings, rocket-equation
      reality check.
      *Proof:* `?scenario=leo-orbit` → altitude error 0.57 m after a full orbit
      at 200× warp, eccentricity 8.8e-8.

- [x] **M5 — Autopilot.**
      Flip-and-burn guidance with braking-profile feedforward, explicit gravity
      compensation, obstacle avoidance, station keeping on arrival, attitude
      holds, auto-warp scheduling.
      *Proof:* `?scenario=moon-direct,mars-direct,saturn-direct` — all arrive
      within 2e-6 % of the standoff distance holding station to 0.2 m/s.

- [x] **M6 — Assets.**
      `node tools/fetch-assets.mjs` — 12 textures and 8,920 stars. Procedural
      fallback for every body.
      *Proof:* `?scenario=no-assets` passes with textures deleted.

- [x] **M7 — Hohmann mode and polish.**
      Transfer planner and executor with phase-angle wait, help overlay,
      analytic solar-glare occlusion, WebGL context-loss recovery.
      *Proof:* `?scenario=hohmann-mars` → Δv1 2944.7 m/s, Δv2 2648.9 m/s,
      258.87 d, phase 44.34°, synodic 780 d.

- [x] **M8 — Acceptance.**
      *Proof:* see below.

## Acceptance criteria

- [x] `npm run verify` exits 0 — 102 unit tests across 4 files.
- [x] `npm run build` exits 0.
- [x] `?scenario=tour` → `[SCEN] name=SUMMARY status=PASS ran=14 failed=0`.
- [x] Zero `console.error` on a clean load; only `[ASSETS]`-prefixed warnings
      for the moons that have no downloadable texture.
- [x] Frame cost measured at 0.22 ms (0.046 ms simulation + 0.035 ms render
      submission, 16 draw calls) — far inside a 60 fps budget. Note that
      `requestAnimationFrame` is throttled when the tab is hidden, so the FPS
      readout only means anything with the window visible.
- [x] Screenshots reviewed: Earth's limb with atmosphere from 400 km; Jupiter
      as a 39°-wide banded wall from 3 radii with the Great Red Spot; Saturn
      with the Cassini Division and its shadow on the rings; the Sun as a
      28°-wide disc with a warm limb.

## Defects found and fixed during the build

Recorded because each was found by a test rather than by looking at the screen,
and each was invisible in a screenshot:

1. **Ephemeris scratch aliasing.** `framePosition()` passed a shared scratch
   vector as its velocity output, and `computeState('earth')` used that same
   scratch for the lunar series — so Earth's *cached velocity* was overwritten
   with a Moon position.
2. **Planet velocity ignored element drift.** Deriving velocity from
   `sqrt(mu/a³)` on a drifting element set left a 0.27 m/s inconsistency with
   the derivative of the modelled position. A ship spawned in a "circular" orbit
   breathed in and out by 800 m every revolution. Central-differencing the
   position cut it to 2.6 m and the 24-hour energy drift by 1700×.
3. **Guidance had no feedforward.** Pure proportional tracking of a
   `sqrt(2·a·d)` braking profile needs a standing velocity error of `a·τ` to
   produce the braking — the ship would have arrived 420 m/s fast.
4. **Autopilot did not budget for gravity.** It spent the whole thrust budget
   steering, so a 1 g burn out of low Earth orbit flew straight into Earth.
5. **Standoff point motion.** The sunward standoff point circles the planet once
   per planetary year; ignoring its velocity left a permanent 1.4 m/s tracking
   error that stopped arrival ever latching.
6. **Arrival never latched.** `phase = 'arrived'` was immediately overwritten by
   the phase classifier at the end of the same function.
7. **Custom shaders bypassed the colour pipeline.** A `ShaderMaterial` does not
   get three.js's tone-mapping and sRGB chunks automatically, so exposure did
   nothing and everything rendered dark. (Including the matching `_pars_` chunks
   as well is a redefinition error — three already injects those.)
8. **Mars' pole declination.** Wrong by 1.5°, which put its axial tilt at 23.9°
   instead of 25.19°. Caught by testing obliquity against the orbit normal
   rather than the ecliptic.

## Follow-up round: making it a ship rather than a console

The first build was accurate and unpleasant to fly. Every nudge rewrote the
orbit, so the pilot spent the trip managing consequences instead of looking out
of the window — realistic in the sense of a physics console, not in the sense of
"what would this look like out of the window".

- **PILOT flight model** is now the default: the drive commands velocity and
  cancels local gravity, so pointing and going works and letting go parks you.
  Acceleration is capped at 5000 g and the cruise ceiling is tied to the
  clearance ahead (`min(sqrt(a·room), room/8)`), so the ship cannot build a
  speed it could not stop from. ORBITAL is the old Newtonian model, opt-in.
- **Six sightseeing routes**, each a spline through waypoints given in a scenic
  frame anchored to the body (toward the subject, along its pole, across), so a
  route reads as a description of a shot and comes out right at any date.
- **ORBIT HERE fixed.** It engaged the interplanetary autopilot toward the
  *navigation target*, so pressing it in low Earth orbit set off for the Moon at
  full thrust. It now circularises around the nearest body.
- **HUD split.** Flight, sights, navigation and time by default; the orbital
  elements, rocket-equation panel and attitude holds sit behind ENGINEERING.
- Three new scenarios (`flypasts`, `orbit-here`, `pilot-mode`) keep all of it
  honest — 14 in the tour now.

One defect the tests caught during this round: `flightModel` defaulted to
`pilot` in `World`, which silently turned every headless physics test into a
test of a hovering ship. The physics layer now defaults to Newtonian and the
interactive build opts in.

## Third round: usability

Feedback was that the console was still a wall of contradictory controls
(PILOT / ORBITAL / ALL STOP next to FLY THERE / ORBIT HERE / STOP, and a
throttle label that said "station keeping" in one mode and "main drive" in
another), and that the flypasts surged and stalled.

- **Simple view is now the default**: the flight panel and the sights, nothing
  else. No navigation panel, no time panel, no prograde/retrograde/target
  markers jumping about over the view. One button unfolds the full console.
- **Flypasts no longer pump.** The easing was applied per leg, which brings the
  ship to a standstill at *every waypoint* — measured at 725, 379 and 544 km/s
  between peaks of 50,000. Fixed in two steps: one ease across the whole route
  rather than one per leg, then a full arc-length reparameterisation of the
  spline, because a Catmull-Rom curve does not travel at a constant rate in its
  own parameter. Now: zero local minima, cruise speed constant to 1.00.
- **Earthrise works.** Two separate faults. Earth spans 1.8° from the Moon, so
  at a 60° field of view it was a 28-pixel speck: routes can now specify a lens,
  and this one uses 24°. But the real problem was that the camera pointed
  *straight at Earth* while the track climbed to 2.3 lunar radii off-axis,
  putting the limb 17° outside the frame — an Earthrise with no horizon to rise
  over. The track now stays in the narrow band either side of the grazing line,
  and the limb is in frame 100% of the route.
- **Impostor sprites were all the same warm yellow** regardless of the body,
  because the glow texture's own gradient was tinted. It is neutral white now;
  only the Sun's glare keeps the warm falloff.

## Fourth round: shots and surfaces

- **Three routes are slingshots now** rather than tangential passes. Jupiter,
  Mars and the Sun each come in on the dark side, wrap right round the body at
  1.3–2.9 radii and leave in a different direction with the lit face astern.
  Measured sweep: 174°, 176°, 177°. The camera holds the subject throughout, so
  it swings round to look back on its own as the ship departs.
- **Earthrise waits for light.** Earth's phase seen from the Moon depends only
  on where the Sun is, so no repositioning rescues the shot during a new Earth —
  the clock moves instead, searching forward in two-hour steps for a date when
  the subject is well lit. Measured: jumps about 9.5 days, Earth then 90% lit.
  Which real date it lands on does not matter; the geometry is real on all of
  them.
- **The Sun uses its photosphere image.** It was the only body whose texture was
  skipped, leaving fine 3-D noise as the whole surface — and fine noise aliases
  into big drifting blotches when the disc is small, then resolves as you close.
  That reads exactly as "the sunspots are shrinking as I approach". The
  procedural fallback is coarser now for the same reason.
- Saturn's ring shadow was **not** a missing section: the shadow cylinder is
  6.03e7 m across and the rings run to 1.40e8 m, so it covers ±54° of azimuth at
  the inner edge and ±25° at the outer — a wedge that narrows outward, which is
  what Cassini photographs show. Shadowed ring material was being taken down to
  6% brightness though, which reads as a hole; it sits at 14% now.

## Fifth round: the Sun was framed worse than anything else

Reported as "the Sun looks unrealistically small — no bigger than Earth or
Saturn". It was, and the cause was framing rather than rendering: the solar
route flew at three radii while the planet routes flew at one and a half, so
the largest object in the solar system got the smallest shot in the list — 36°
against Jupiter's 83° and Saturn's 67°.

- The route now passes at 1.28 radii, where the Sun spans **103°** and fills
  the window edge to edge for seven seconds. It is the largest shot in the set,
  which is the right order.
- The glare halo now fades out as the disc resolves (full below 4°, gone by
  24°). Glare is what an unresolved light source does to an eye; once the Sun
  is a disc spanning tens of degrees it *is* the sky, and a bright blob laid
  over it only hid how big it had become.
- Solar radiance raised from 4 to 7, so a close pass saturates rather than
  merely being bright.

Worth recording: a close pass at true scale needs superluminal speed. Rounding
the Sun at 1.3 radii inside a minute means about 1e10 m of track, so the HUD
reads 1.32 c during that flypast. The routes are camera moves on rails and are
not bound by the drive's 0.1 c ceiling — the speed shown is the real speed of
the real path, and the panel says FLYPAST while it runs.

## Known approximations

Deliberate, and documented where they live:

- Minor moons use fixed mean elements; their apsides and nodes really precess,
  so their phase oscillates within roughly 2e radians of orbit angle (~1.2° for
  Europa). Orbit size, plane and period stay correct.
- Moons of moons are not supported; no body has one that matters here.
- Planetary oblateness (J2) is not in the force model — only in the rendered
  shape.
- Light travel time is not modelled: bodies are drawn where they are, not where
  they were seen to be.
- Above 100× warp, manual attitude input is ignored; the autopilot and hold
  modes set attitude directly.
- Sightseeing routes fly the ship kinematically rather than steering it onto a
  path. They are camera moves; a guidance loop that mostly got there would only
  make the framing worse.
- A close pass at true scale is genuinely fast: crossing Saturn in under a
  minute means thousands of km/s. The speed readout during a flypast is real,
  and large.
