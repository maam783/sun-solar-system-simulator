# Build status

Every milestone below is checked with the command or URL that proved it, so the
work can be picked up cold.

Last full verification: 2026-07-29.

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
- [x] `?scenario=tour` → `[SCEN] name=SUMMARY status=PASS ran=11 failed=0`.
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
