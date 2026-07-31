# Where this stands

Working notes for picking the project up cold. `STATUS.md` records what was
built and every defect found; this file records the *live* state and the open
problem.

Live: <https://maam783.github.io/sun-solar-system-simulator/>
Repo: <https://github.com/maam783/sun-solar-system-simulator> (public, Pages via
GitHub Actions on push to `main`).

## Verification, as of the last commit

- `npm run verify` → 102 unit tests, 4 files, green.
- `?scenario=tour` → 14 scenarios, all PASS. Drive it headlessly with
  `window.SCENARIO_RUNNER.runSync()`; browsers suspend `requestAnimationFrame`
  in a hidden tab, so the animation loop cannot be relied on.
- `window.SIM` exposes the whole simulation. `SIM.frame(dt)` advances one
  complete frame by hand (simulation + render + console).

**Watch out:** with the browser pane hidden, the canvas falls back to 2×2 px.
Anything that depends on apparent size — LOD, the mesh/impostor switch, ring
visibility, pixel readback from the canvas — is meaningless in that state.
Measure geometry (angles, distances, lit fractions) instead, or make the pane
visible.

## The open problem: the flypasts do not feel big

Reported: rounding the Sun takes about three seconds, which destroys the sense
of scale. The user is right, and the diagnosis so far is incomplete — angular
size was fixed, angular *rate* was not.

Numbers as they stand for the solar route:

| | value |
|---|---|
| closest approach | 1.28 solar radii (8.9e8 m) |
| angular diameter there | 103° |
| speed at closest approach | ~4e8 m/s (1.32 c) |
| resulting angular rate | v/d ≈ 0.45 rad/s ≈ **26°/s** |
| time for the disc to sweep past | ~4 s |

26°/s is the rate of a nearby object flicking past. Perceived size comes far
more from how *slowly* something moves across the field than from how much of
the field it covers, so the shot reads as small-and-close rather than
vast-and-distant.

Rough target: 2–4°/s at closest approach, which for the Sun means
v = 0.05 rad/s × 8.9e8 m ≈ 4e7 m/s, i.e. a half-circuit of a few minutes rather
than a few seconds.

Other candidate causes, not yet investigated:
- **No scale anchor.** The ship is not drawn and nothing of known size is in
  frame, so an unmarked sphere has no cue to read size from. Saturn's rings are
  the one route that has a natural anchor, and it is the one that reads best.
- **Texture stretch at close range.** A 2K map over a 103° disc is heavily
  magnified; smooth, detail-free surfaces read as small. This already forced
  Jupiter and Mars back from 1.09 to ~1.3–1.5 radii once.
- **Constant speed through the whole pass.** Fixed earlier to stop the routes
  pumping (they used to stall at every waypoint), but a *single* slow-down into
  closest approach is different from repeated surging, and is what a
  cinematographer would do.

Next step the user asked for: research what actually triggers the sense of
overwhelming scale in humans, and rebuild the routes around that rather than
around guesses.

## Architecture, briefly

- `src/sim/` — physics, all f64 SI, heliocentric ecliptic J2000. `world.ts` is
  the entry point and owns clock, ship, force model, autopilot, pilot drive and
  flypast director.
- `src/sim/flyby.ts` — the sightseeing routes. Waypoints are given in a *scenic
  frame* per body (X toward the subject or the Sun, Z along the body's pole,
  offsets in body radii). The spline is Catmull-Rom, reparameterised by arc
  length so speed is constant, with one ease-in/ease-out across the whole route.
  `FlybyRoute` supports `fov` (per-shot lens) and `needsLitSubject` (moves the
  clock to a date when the subject is lit).
- `src/sim/pilot.ts` — PILOT drive: commands velocity, cancels gravity, caps
  acceleration at 5000 g, and caps cruise speed by the clearance ahead.
- `src/render/scene.ts` — floating origin, logarithmic depth, adaptive exposure.
- `src/ui/hud.ts` — simple view by default; `setSimple(false)` unfolds the full
  console.

## Things that are settled and should not be re-litigated

- Planet positions are validated against 48 JPL Horizons vectors; do not "fix"
  the element tables without re-running `tools/check-ephemeris.mjs`.
- Custom `ShaderMaterial`s must include `<tonemapping_fragment>` and
  `<colorspace_fragment>` but *not* the matching `_pars_` chunks.
- `World.flightModel` defaults to `'orbital'` so headless tests exercise real
  physics; `main.ts` opts into `'pilot'`.
- Saturn's ring shadow is correct geometry, not a missing section.
