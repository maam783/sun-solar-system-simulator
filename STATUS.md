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

## Sixth round: making the size *felt* rather than merely measured

The Sun spanned 103° and still did not read as vast, because the shot swept it
past at 26°/s — a rate the eye reads as a small nearby object, not a huge
distant one. Angular size had been fixed; angular rate had not.

- **Time is budgeted by swept angle, not by distance.** Equal metres per second
  is a crawl at nine radii and a blur at one, so the table that maps time to
  position now accumulates `step / distance` (the angle a step subtends) rather
  than `step`. Constant angle per second falls out, and with it the shape a
  cinematographer would choose: rush in from far out, sweep slowly at closest
  approach. Peak rate is now 3.5–4.1°/s across the three slingshots, and routes
  run 88–112 s rather than ~55.
- **A scale caption during each flypast** ("SUN — 1,392,700 km across · 109 ×
  Earth"). The most-cited cinematography technique for conveying scale is a
  known object in frame; Saturn has the rings and is the shot that always read
  best, and the others had nothing at all.

Background, recorded because it should drive future shot design: the emotion is
awe, whose two core appraisals are perceived vastness and need for accommodation
(Keltner & Haidt 2003). Whether a large object produces awe or dread depends
mostly on whether the viewer feels safe, which is an argument for keeping the
flypasts on rails.

## Seventh round: night sides, and the comparison drawn rather than stated

- **Planets were lit from every direction.** The ambient floor was added
  *outside* the irradiance scaling — `color = albedo * lit * uIrradiance;` then
  `color += albedo * 0.012;` — so it was an absolute value that the adaptive
  exposure then multiplied. The night side came out at 33% of the day side at
  Jupiter, 65% at Saturn, and **1494%** at Pluto, where the exposure opens 433×
  against a sunlight of 1/1500. Scaling the floor by `uIrradiance` puts every
  body at a constant 1.5%, so a terminator is a terminator again.
- **The size comparison was first drawn as a panel diagram, which missed the
  point.** What cinematographers mean by a reference object is something *in
  the frame*, sitting in the world and lit like everything else — not a chart
  beside it. A to-scale Earth is now placed in the scene next to whatever a
  flypast is looking at, at the *same range from the camera* as the subject's
  centre, so the two angular sizes are in their exact true ratio. Measured:
  Jupiter 23.3° against Earth 2.11° (ratio 11.0, true 11.0); the Sun 16.9°
  against 0.15° (ratio 109.6, true 109.2). It is in shot for about two thirds
  of each route, dropping out at closest approach when the subject overflows
  the frame. It is the only object in the simulation that is not really there,
  and the console says so while it is on screen.

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

### Eighth round — the flypasts were zooms

Reported: the star field and the planet seem to move together, "as if you were
zooming into a picture rather than flying around a real planet".

Correct, and it was geometry, not rendering. The hand-placed waypoints started
with a leg whose velocity pointed almost exactly at the body's centre — the
Jupiter route had an impact parameter of 0.3 radii, which is a dive at the
middle. On a radial approach the line of sight does not turn at all, so the
stars behind hold perfectly still, no new surface comes over the limb, and the
one thing that changes in the whole frame is the size of the disc. That is a
zoom, and the eye reads it as one.

Two causes, both fixed:

1. **The paths were radial.** A real encounter cannot be: the incoming
   asymptote misses the centre by the impact parameter, so the body drifts
   across the star field the whole way in and its surface streams underneath at
   closest approach. The four pass routes now take their waypoints from an
   actual hyperbola (`hyperbolaStops`), given as periapsis, eccentricity,
   argument and inclination. Shorter than the hand-tuned lists it replaced.

2. **The pacing counted a dive as a sweep.** Time was budgeted by
   `step / distance`, which measures any motion including purely radial motion,
   so the approach was handed a third of the shot for a stretch in which
   nothing moved. It is now budgeted by how far the body's *limb* travels
   across the sky: rotation of the line of sight plus change in angular radius.

Measured, before and after:

| route | line of sight turns (median) | share of shot below 0.3 deg/s |
|---|---|---|
| Jupiter | 1.18 -> **2.03 deg/s** | 34% -> **6%** |
| Saturn | 0.55 -> **2.37 deg/s** | 41% -> **5%** |
| Sun | -> 1.88 deg/s | 7% |
| Mars | -> 2.16 deg/s | 6% |
| Io (against Jupiter) | -> 3.88 deg/s | 3% |

Rotation now beats growth 2.6:1 where it used to lose, and the rate is far more
even (Jupiter peak 3.09 against a median of 2.03; it was 3.92 against 1.18).
The residual few per cent are the ease-in ramp at each end, not a stall.
Closest approach unchanged where it mattered: Sun 1.28 radii, Jupiter 1.5,
Saturn 2.05 through the ring plane.

Also: **Mars had no size reference at all.** Earth is nearly twice Mars, so at
1.45 Mars radii the camera would have been inside it and the placement code
pushed it permanently out of frame. Mars now uses the Moon (ratio 2.0), and the
reference borrows whichever body's real surface map it names instead of always
being Earth.

### Ninth round — the reference was a prop, not a body

Reported: the reference Earth sits to the right, so the slingshot flies through
it or just past it and then it is gone; and it is "lit as though from inside",
not following the same light as the body next to it. Plus: drop the top-left
console outside the full view, and drop the commentary under the six sights.

Both halves of the first complaint had one cause. The reference was pinned to
the *camera* — held a computed angle off the boresight, at the subject's range
— so it was a prop carried along beside the window rather than an object. Being
re-placed every frame, it slid into the ship's path during the wrap, and its
phase jumped rather than evolving, which is what "lit from inside" was: a fully
lit disc beside a planet showing a terminator.

It is now a body on a real circular orbit around the subject, and the renderer
only reads its position. Radius, orbital phase and inclination are chosen once
at route start by walking the whole shot and scoring the placement: how much of
the route it spends visible and in frame, penalised for sitting at a different
range from the subject, with anything the ship would pass close to rejected.
Inclination turned out to matter most — an equatorial orbit is in nearly the
same plane as the flight, so the planet gets between them; a steeply inclined
one never does.

| route | hidden behind subject | range vs subject | ship's closest pass |
|---|---|---|---|
| Jupiter | 53% -> **0%** | 1.38 -> **0.99** | 15.7 Earth radii |
| Saturn | 0% -> **3%** | 0.90 -> **0.87** | 7.5 Earth radii |
| Sun | 6% -> **0%** | 1.48 -> **1.00** | 134.8 Earth radii |
| Mars | 38% -> **0%** | 1.93 -> **1.06** | 3.1 Moon radii |

The range ratios near 1 mean the size comparison is still exact — the reference
really is at the subject's own distance — but now because the orbit puts it
there, not because it is held there. It is lit where it stands, so its phase
tracks the subject's within the tens of degrees the geometry actually implies.

HUD: the flight panel is hidden in the simple view (it is an instrument panel,
and the simple view is not flying by instruments), the route blurb no longer
sits in the middle of the view for the length of a shot, and the note owning up
to the reference is one short line.

### Tenth round — the reference Earth glowed

Reported, with a screenshot: Earth beside Jupiter is lit as though from within,
and much brighter than the planet next to it.

Earth's city lights were added *outside* `uIrradiance` — the same defect fixed
one round earlier for the ambient floor, three lines below it in the same
shader, and missed here. The lights were tuned as an absolute value at Earth's
own sunlight. At Jupiter the sunlight is a twenty-eighth of that, so the day
side dimmed by 28x while the lights stayed put and the adaptive exposure then
opened up against the dim scene and multiplied them. The night side filled
right in, which is why the disc read as fully lit *and* brighter than Jupiter:
what should have been the dark half was the part that was glowing.

Measured by rendering the flypast at 600x600 and reading the framebuffer back,
using a difference image so only the pixels the reference actually paints are
counted. (The first attempt measured a star sitting at the same screen position
— the blob was still there with the reference switched off.)

| | reference | Jupiter |
|---|---|---|
| phase | 143 deg | 139 deg |
| mean luminance | 25 | 60 |
| peak | 213 | 255 |

A crescent, dimmer than the planet, as it should be. The lights now contribute
2.6 of mean luminance instead of roughly 73, and no longer clip. At 1 AU the
scale factor is exactly 1, so nothing changes for the real Earth in Earth orbit.

### Eleventh round — put the reference on the line of sight

Asked for: the reference between the eye and the subject, crossing in front of
it, because that is where the effect is strongest. Correct — a known object *on*
the disc leaves nothing to argue about, and it is the transit-of-Venus
photograph.

The placement search now scores a transit five times a placement beside the
limb, weighted by how much of the subject's visible face is in sunlight (a
silhouette on the night side is black on black; a star has no phase).

What it cost, and why it is bounded. To be in front of the subject the
reference must be nearer by at least its own orbit radius, and that orbit has to
clear the surface, so a transit magnifies the reference by at least d / (d - 1):
**1.5x at three radii out, 1.14x at eight**. Unpriced, the search bought a
transit showing Earth at 2.2x — Saturn would have read as four Earths across
instead of nine, which is precisely the error a size reference must not make.
Transits are now rewarded on a ramp that pays nothing below 1.5x and, below
that, is *charged* rather than merely ignored, so a false transit cannot be
picked up as a side effect of a placement chosen for other reasons (which is
exactly what Saturn had been doing).

| route | transit | oversize | lit face behind | subject spans | ship's closest pass |
|---|---|---|---|---|---|
| Jupiter | 23 s | 1.22x | 0.94 | 19.5 deg | 14.2 Earth radii |
| Saturn | 25 s | 1.23x | 0.61 | 19.3 deg | 15.7 |
| Sun | 25 s | 1.22x | emits | 20.3 deg | 111.7 |
| Mars | none | — | — | — | 4.7 Moon radii |

Mars cannot have one: the Moon is half of Mars, so it can never fit *inside*
Mars's disc while also being in front of it. It keeps the placement beside the
limb, at a range within 8% of Mars's own.

The transit lands where the subject spans about 20 degrees rather than at
closest approach, and that is not a compromise that can be tuned away — it is
the same d / (d - 1). Close in, where the planet is a wall, an honest transit
does not exist. The reference is behind the subject for 36-45% of these shots
now, which is the other half of the trade.

### Twelfth round — the ship braked when you came off the throttle

Reported: the ship slows down when you let go of the throttle, which is not what
happens in space.

Correct, and it was the centre of the flight model rather than a detail. PILOT
commanded *velocity*: the drive drove the ship's velocity to
`referenceVel + cruiseSpeed * nose` at all times, so any speed above the setting
was actively braked away. Measured from the spawn state: with the throttle set
to 3,000 m/s the drive dragged the ship's 7,544 m/s orbital velocity down to
exactly 3,000 and held it. A second mechanism did the same thing from the other
side — the clearance ceiling was clamped onto the setting every frame, so
closing on anything slowed the ship whether or not the pilot had asked.

The drive now only acts while the pilot is asking:

- **throttle open** — servo to the commanded speed along the nose, as before,
  and the clearance ceiling caps what can be commanded;
- **throttle closed** — coast. The only acceleration applied is the gravity
  cancellation the mode is built on;
- **ALL STOP** — station keeping, latched. It is also the state the ship spawns
  in, so nothing changes about starting parked.

Measured after the change: 98,020 m/s held to the last digit over 20 s of
coasting, heading drift 0.00 deg, and 0.00 deg of course change while the ship
was turned 80 deg off its heading — the view moves, the trajectory does not.

One consequence worth stating: the "it will not offer a speed it could not stop
from" guarantee now only holds while the throttle is open. Coast into a planet
and the ship is destroyed, which is what the collision model and the respawn are
for.

### Thirteenth round — it was the wrong thing

Told plainly: this was built as a flight simulator, with crashes and instruments
and warnings, and that is not what was wanted. What was wanted is an impressive
demonstration of the solar system, with the physics real and overridden only
where the distances make it dull, and with almost nothing on the screen.

Removed outright: the size reference (Earth and the Moon in shot — "Klimbim"),
and from the default view the reticle, the prograde/retrograde/target markers,
the collision-course and g-load warnings, the flight panel, the navigation
panel, the time panel and the mouse hint. What is left on screen is one panel
listing the sights, and it fades out four seconds after the last input. The
whole instrument console still exists, unchanged and still exercised by the
scenarios, on the backquote key.

Fullscreen on **F**, which is the actual answer to "I am always looking at the
universe through a browser window".

Sound, which the demo had none of: a very quiet ambient bed, a ship hum, an
occasional hull creak, and a drive that is audible *only while the engine is
burning* — so the long coasting stretches are silent, which is the physics said
a second way. Generated with ElevenLabs; levels are deliberately low.

The radio beacon is synthesised rather than sampled, from the real Quindar
tones (2,525 Hz key, 2,475 Hz unkey, 250 ms) with band-limited noise for the
open circuit. Apollo's air-to-ground audio is public domain and would have been
easy to drop in, but a recognisable quotation from one lunar mission fights a
view of Saturn instead of dressing it.

Also corrected from the round before: "coasting" was the wrong word for what
happens off the throttle. Measured over 150 s, the inertial speed changes by
+0.06 m/s in 150,124 — four parts in ten million, and upward, which is
integrator round-off. Nothing decays. The 0.8 m/s the readout loses over that
time is Earth accelerating around the Sun underneath a speed quoted relative
to it.

The atmosphere shells were also wrong, and visibly so: brightest exactly at
their own geometric edge, which made a hard, nearly opaque grey collar and put
the sphere's polygon edges in the one place they would show. They now fade
exponentially with the height the line of sight grazes at, so the haze is gone
well inside the mesh boundary. Peak contribution fell from 142 to 34 of 255 per
channel. The shell also follows the planet's LOD now instead of sitting at 48
segments while the planet went to 256 — though honesty demands the note that
the segment count alone did not measurably move the visible edge in testing
(0.69 px of ripple against 0.68 px), so the fade is what did the work.

### Fourteenth round — the mouse is a head, not a hand

Reported: the "your cursor is hidden, press Esc" banner is bad and its purpose
is unclear; looking around should always be possible with the mouse, and the
ship should be steered some other way, with keys that are far less coarse than
they are.

The banner is not ours — it is the browser's own pointer-lock notification, and
it cannot be styled or suppressed. The only way to be rid of it is not to take
pointer lock, so we do not. The cursor is now simply *where you are looking*:
centre of the window is straight ahead, the edge is 66 degrees over, mapped
absolutely so it can never drift or spin, with nothing to engage or release.
It only tracks over the canvas, so reaching for the panel does not swing the
view on the way.

The head is now separate from the hull. `World.head` carries pitch and yaw
relative to the ship, and the camera is the hull's orientation with the head
turned on top of it. Measured: 65.9 degrees of camera swing at the window edge
against **0.000 degrees of course change** — which is what a window is for, and
what actually happens when you turn your head in a moving vehicle. A click
points the ship where you are looking; that is the only thing that couples the
two.

Coarseness, both fixed by measurement rather than feel:

- Steering was 0.9 rad/s, 51 deg/s — a rate for dodging, not for framing a
  planet. Now 0.2 rad/s, and 0.04 with shift held.
- The throttle e-folded every 0.42 s, so a tap went from a walking pace to a
  thousand kilometres a second with nothing in between. Now 0.75 per second:
  holding W from a standstill takes **17.5 s** to reach 1,000 km/s instead of
  about 5, and the whole range to the 0.1 c cap is about twenty seconds. Shift
  scales the input to a fifth.

Installable as a desktop app: a web manifest with `display: fullscreen`, icons
drawn for it, and the Apple meta tags. Chrome and Edge offer *Install*, Safari
17 and later *Add to Dock*. That is the real answer to "I am always looking at
the universe through a browser window" — better than the F key, because there
is no browser around it at any point.

### Fifteenth round — looking around had to be something you ask for

Reported: with the view following the cursor the application cannot be
operated, because the view changes the whole time; and the install option
could not be found.

The first is mine and it was an over-correction. Removing pointer lock was
right — the banner it puts over the view is the browser's own and cannot be
suppressed — but mapping the cursor's *position* to the look direction means
every reach for a button turns the sky on the way, and there is no way to hold
still. Looking around now needs the button held, which is the whole difference:
it is always available, never accidental, and the cursor stays where it is put.

Measured: mouse movement with no button held moves the view **0.0 degrees**; a
400 px drag turns it 73 degrees; after release the view holds exactly where it
was; a press that never moved more than 5 px is taken as a click and points the
ship instead. Limits at 155 degrees of yaw and 77 of pitch.

The install option was missing because a browser will not offer to install a
page without a registered service worker carrying a fetch handler — the
manifest alone is not enough. There is one now, network-first with the cache as
a fallback, so the installed app also opens without a network. `display` is
`standalone`, which is the value desktop browsers actually act on, with
`fullscreen` offered ahead of it through `display_override`.

### Sixteenth round — a wide lens, a stale worker, and a mix set blind

Three reports, and the diagnosis differs for each.

**"No parallax, the planet is stuck to the star wallpaper."** The parallax is
correct and was measured: translating the ship three Mars radii sideways moves
the planet 0.487 in screen coordinates while the stars move **0.000** — the
planet slides across a fixed field, which is what the stars being at parsecs
means. But dragging to look is *pure rotation*, and rotation produces no
parallax anywhere in the universe. Nothing to fix there.

**"And it gets distorted."** That one is real, and it is the field of view.
three takes a *vertical* angle, so the horizontal follows from the window: 60
degrees down a 16:9 frame is 91 across, and the reported screenshot was wider
still. Rectilinear projection stretches anything off-axis by 1/cos of its angle,
and it was measured at **1.241** near the edge — while the centre came out at
1.000, so the aspect handling was never wrong. The horizontal angle is now
capped at 72 degrees with the vertical derived from it, which brings edge
stretch to **1.118** and, more usefully, makes it the same on every window shape
instead of worsening with width.

**"The installed app keeps running the old build."** Mine, and a bad call: the
service worker existed only to make the browser offer to install the page, and
it cached the document as well. An installed copy therefore kept starting the
build it was installed with. The document is never cached now, and is fetched
with the HTTP cache bypassed as well, because Pages serves HTML with ten
minutes of freshness. Only content-hashed assets are kept. The page also asks
for an update on every start and reloads once when a new worker takes over.

**"There is one ambient loop, a beep and a hiss, and that is all."** Measured
rather than guessed. The files were fine; the mix was not, having been set
blind: the hull creak sat at -39 dBFS in the file and -59 after its gain, so it
never happened, and the radio beacon was the most prominent thing in a mix
where it should be the rarest. Levels are now set against each file's measured
loudness, and there are three new sounds tied to things that actually occur —
a cold-gas puff on steering, a spool-up on the override drive, and a sub-bass
swell when passing close to something enormous. The beacon is a third as loud
and roughly half as frequent.

### Seventeenth round — sound, weight, light, and the Earthrise

**Sound.** The hull creak is gone. The attitude thrusters were a hiss that kept
running after the key was released, because a whole sample was fired off on
each press; they now loop while the valve is open and close in 80 ms, at a
third of the level. And the radio carries a voice: six invented lines of
traffic that name no mission, place or date, band-limited at run time to the
300-3,000 Hz a voice circuit passes, with a presence peak at 1.7 kHz, sitting
between the same real Quindar tones as before. Yes, those were already there —
they were mixed at 0.028 and roughly inaudible, which is why they were reported
missing. They are at 0.075 now and carry the speech.

**Weight.** Steering was an angle added per frame, which is exactly as digital
as it read. The arrows now ask for torque: rate builds over about 1.7 s and
settles over 2.2 when released, topping out near 15 deg/s. The decay is the
flight assistant trimming the rate out, not friction — there is none.

**Light.** Researched rather than adjusted. A Lambertian surface sits at
L = E x albedo / pi, so at true scale the Moon is 4,850 cd/m2, Earth 12,130,
Jupiter 780, Saturn 210 and Pluto 13 — against a computer monitor at 300 and
sunlit snow at 30,000. Bright, then, and Earth genuinely is 2.5x the Moon. But
the adaptation exponent was 0.85, which opens the exposure 420x across a 1500:1
range and leaves a ratio of 3.6 — measured on screen, Pluto came out at mean
126 against the Moon's 108. Everything was equally lit. At 0.55 about a seventh
of the real range survives. Nothing was clipping, so this is not a brightness
cut; it is the falloff being allowed to show.

**Textures.** 2048 across is 5.3 km per pixel on the Moon — a fine globe from
orbit and obvious mush from 157 km up. The Moon, Earth, Mars and Jupiter now
have 8192-wide maps, four times the linear detail, loaded *after* the small
ones and swapped in on arrival so no first frame waits on 24 MB.

**The Earthrise, rebuilt.** Every complaint about it was a separate fault:

- *No orientation.* The camera aimed straight at Earth, which is straight at
  the ground while Earth is behind the Moon. Routes can now tilt the aim off
  the subject; this one is 9 degrees up, so the horizon sits in the lower third
  and Earth arrives from the bottom of the frame.
- *Over in half a second.* The old arc swept 108 degrees. The geometry says the
  window is 1.9 degrees wide: at 1.09 radii the limb sits 66.5 degrees off the
  Earth direction, and Earth's disc is 1.9 across, so the rise happens between
  65.55 and 67.45 degrees of orbital angle and nowhere else. The arc is now 6.5
  degrees straddling exactly that. Measured: 36 s of ground going by under an
  empty sky, **20 s of Earth coming up**, 44 s of it hanging there.
- *A full Earth.* Routes can now ask for a phase rather than for maximum light.
  This one asks for 0.55 and gets it — a half Earth, as in the photograph, and
  it puts the Sun far enough round to rake the ground the ship is crossing.
- Altitude is a constant 157 km, near enough to Apollo 8's 110 that the ground
  moves at the same sort of rate.

Not done this round, and worth saying plainly: more routes, and music timed to
the moment of the rise.

### Eighteenth round — five optimisations, all measured

**The hum was audible on its own.** It sat at -24.8 dBFS played, above the
ambient bed. Down 6 dB to -30.8, which puts it under the music instead of
beside it.

**The radio did not sound compressed, and the voice was wrong.** Two separate
faults. The voice is now one operator rather than a cast — a capsule
communicator is one person on one console, and the sameness is half of what
makes traffic sound like traffic — flat, unhurried, mature American.

The compression was the missing half. Band-limiting alone was never going to be
enough: what the ear recognises in a space link is the *dynamics*, every
syllable arriving at the same level with the peaks clipped rather than
reproduced. The chain is now 300-2,700 Hz, a presence peak at 1.8 kHz, 14 dB of
drive into a 20:1 limiter at -26 dB, soft clipping through tanh, and a second
low-pass to keep the distortion's harmonics inside the circuit. Measured
against the old chain on the same file: crest factor **20.6 dB down to 12.1**,
peak essentially unchanged. Limiting raised the RMS by 8.1 dB, which would have
made a level that was already right too loud, so the gain takes exactly that
back out — what changes is the character, not the volume.

**Steering still turned too fast.** It was 0.16 of torque against 0.6 of
damping: 15.3 deg/s reached in 1.7 s, so a tap was most of a turn. At 0.04
against 0.28 it is **8.2 deg/s reached in 3.6 s**, settling over 4.5. A quarter
of the authority, which is about right for thrusters against a hull.

**The cursor stayed visible when everything else faded.** The canvas sets its
own cursor inline while dragging, and an inline style beats a stylesheet rule.
The idle rule is `!important` now. Measured: `none` when idle, `grab` when not.

**Looking around was too sensitive and stopped short of all the way round.**
Sensitivity halved: a 400 px drag turns the view **32.1 degrees**, down from
73.3. And yaw is no longer clamped — it was stopping at 155 degrees each way,
a leftover from when the mouse steered the hull. A nose has a forward; a head
does not. Yaw wraps freely now (measured: 4,800 px of drag comes out at 25
degrees rather than jammed at 155), and only pitch keeps a stop, at 83 degrees,
which is anatomy rather than a limit.

### Nineteenth round — the thrusters had gone silent

Reported, and correct. Two faults compounding.

The replacement sample is front-loaded: one second long, -35 dBFS overall, with
all of its energy in the first third (-30.2 dBFS) and silence after (-61.6 and
-80.1). That is exactly what was asked of it — a quarter-second puff — and the
wrong shape for anything sustained.

Then the loop window cut the sound out. `loopStart`/`loopEnd` exist to skip MP3
padding on the two-minute beds; applied to a one-second clip they play 0.05 s to
0.6 s, which is mostly the silent part. Measured: **-40.8 dBFS in the window,
-60 dBFS after the gain**. Inaudible, and inaudible for a reason that had
nothing to do with the level it was set to.

Fixed by not looping at all, which is also more nearly right: a cold-gas
thruster fires in pulses and is not held open to trim attitude. The puff now
repeats about four times a second while a key is down, jittered so it does not
turn into a drum machine, and scheduling simply stops on release — the pulse in
flight finishes by itself, which is what a valve closing sounds like.

Measured on a rendered three-second train: **-26.1 dBFS overall, -22.7 during a
pulse**, peak 0.156, no clipping. Against -60 before, and still less intrusive
than the -24.3 dBFS of continuous hiss that was reported as far too loud,
because it pulses rather than stands.

### Twentieth round — a knock instead of a bubble, and no loop to find

**The thrusters bubbled.** The sample was the fault, and it was the fault I
asked for: "dull, muffled, almost no hiss" produces a soft blub, and four of
those a second is bubbling. From inside a hull a reaction control thruster is a
hammer blow on a bulkhead with a short gas tail. The replacement measures
**peak 0.477 reached in 14 ms, crest factor 22.7 dB** — a transient rather than
a swell — and the rate is down from four a second to two and a half, with the
jitter widened so a train of identical knocks does not turn into a machine.
Rendered: -27 dBFS, peak 0.41, no clipping.

**Sixteen lines of traffic instead of six**, and flatter. Stability at maximum
and style at zero, at 0.88 speed, on a level narration voice — a console
operator reads numbers off a screen, and nothing about it is good news. Two
voices now, an operator and a distant station, because traffic has two ends.

**Four ambient beds instead of one, crossfading.** A two-minute loop is
recognisable by its third pass and unhearable afterwards. Each bed fades in
over eight seconds, holds, and fades out while the next is already coming up,
and the next is never the one just played. The four came out 3.5 dB apart
(-14.5, -12.6, -15.2, -16.1 dBFS), which would have made every crossfade a
step, so the gains equalise them to about -30 dBFS played whichever is up.

### Twenty-first round — the thruster hisses again, correctly

Asked, reasonably: a thruster should hiss, not knock. What was that?

It was accuracy applied where accuracy was not the standard. From inside a hull
a reaction control thruster is not a jet — it is the valve and the pressure
pulse arriving through the structure, which crews describe as a muffled hammer
blow, and outside in vacuum there is nothing to hear at all. The knock was
defensible on those grounds and wrong on the grounds that actually govern this
project: realism here was defined as *what someone who has never been to space
expects*, and what they expect is escaping gas. Accuracy that reads as a
mistake is not worth having. The original complaint was that the hiss was too
loud and too harsh, not that it was a hiss; removing it was an over-correction.

So it is gas again, held while a key is down, closing in 120 ms — which was the
one part of the first attempt that was right, since a valve stops when it shuts.
The sample is eight seconds of steady hiss, measured at 0.7 dB of variation
across the whole file, so the loop cannot pump. Being eight seconds long also
means the loop window that made this silent once — it trims 0.4 s off each end
to skip MP3 padding, which on a one-second clip removed the only sound in it —
now removes padding and nothing else. Playback starts at a random point, so
repeated taps are not the same sound twice.

"Too hissy" turned out to mean too *sharp*: the raw sample is broadband to
11 kHz, which is a tsss rather than the shhh of gas through a wall. A 3.2 kHz
low-pass fixes the character and costs 19.5 dB, so the gain is largely makeup.
Measured through the whole chain: **-33 dBFS played, peak 0.12, no clipping**,
against the hull hum at -30.8 and the harsh first version at -24.3.

### Twenty-second round — roll had been left behind

Reported: Q and E are still digital. They were. Pitch and yaw were moved onto
torque and roll was not — it went on adding `1.6 * dt` radians per frame, which
is an instant **92 deg/s** for as long as the key is down and nothing at all the
moment it is not. Eleven times the rate of the other two axes, with no build and
no settle.

It now goes through the same mill, with 1.4x the authority of pitch and yaw
because there is less of a ship to swing about its long axis — true of nearly
every vehicle. Measured on the recurrence: **11.5 deg/s at the top**, 2.8 after
one second, 6.5 after three, settling back through 4.8 and 3.1 over the five
after release.

The difference a tap makes is the whole point. A 0.15 s press used to roll the
ship 13.8 degrees; it now rolls it 0.04 and leaves it turning at half a degree
a second, which then trims itself out.

The attitude thrusters hiss for roll too now, which they did not before.

### Twenty-third round — it was never the sound, it was the cache

Reported: the thrusters still knock, no hiss.

They do, and the file is not the reason. The one on the server is byte-identical
to the local hiss — same MD5, 129,193 bytes — and measures as broadband noise to
11.4 kHz across eight steady seconds. What was being heard was an older take,
out of the service worker's cache.

That is my error, and specifically my reasoning: the worker served assets
cache-first on the grounds that build assets carry a content hash and so cannot
go stale. True of the bundle, which Vite renames every build. False for
everything in `public/`, which is copied through verbatim —
`assets/audio/rcs.mp3` keeps that name forever, so every replacement of that
file changed nothing for anyone who had already loaded it once. It refreshed in
the background and was heard on the *next* visit, which is why three successive
thruster sounds were each reported as unchanged while the deployed file was
right every time. It also cost me a false measurement earlier in the same way.

The worker now serves nothing from the cache while there is a network; the cache
is only what lets the installed app open without one. And `AUDIO_VERSION` is
appended to every audio URL, so a stale entry cannot match even in a client
whose worker has not updated yet — the fix lands on the next load rather than
the one after.

### Twenty-fourth round — inverted pitch, a better Earth, and the throttling

**Arrow keys inverted for pitch**, as asked: up pitches the nose down. A
preference, not a correctness question.

**Earth's map is now NASA's Blue Marble: Next Generation**, downsampled from
21600x10800 at 2 km per pixel rather than re-compressed from someone else's
8k. Anisotropic filtering also went from 8 to the hardware maximum of 16, which
matters more than it sounds: from low orbit nearly every texel is seen at a
grazing angle, and that is exactly the case ordinary mip-mapping blurs away.

There is a ceiling here that no texture reaches. 8192 across is 4.9 km per
pixel on Earth; from a 400 km orbit the eye is asking for about 170 m, which
would need 40,000 pixels across and 500 MB of video memory. So past 1:1 the
surface is an interpolation, and interpolation is smooth in a way nothing real
is — which is the tell that reads as a photograph being enlarged. A fine grain
now modulates the albedo as the magnification passes 1:1, tied to the body's
own frame so it sits still. It invents nothing; it breaks up the smoothness.

Also fixed: the two maps race, and the small one is not reliably the faster.
Earth was measured still on the 2,048 map with the 8,192 one already decoded.
A smaller map can no longer replace a larger one.

**The speed near planets really was throttled**, and by an arbitrary rule of
mine. Measured, the eight-second clearance rule allowed 1.3 km/s ten kilometres
up, 12.5 at a hundred and 50 at four hundred — everywhere the binding
constraint, and everywhere far tighter than the drive's ability to stop.

Loosening it turned out to be more interesting than changing a number. The
first attempt, 2.5 s, produced a **17.4 km/s impact** in the dive test. The
reason is that the other term — sqrt(a x room), the speed a ship can shed in
the room it has — is right for a ship that brakes at full authority and wrong
for this one, which is a proportional servo: its deceleration is the tracking
error over tau, that ceiling falls at about a/2 however fast the ship goes, the
error never grows, the braking stays gentle, and the ship rides tens of km/s
above the limit all the way down. Writing the servo lag into the formula only
brought it to 7.0 km/s.

A ceiling **linear** in the clearance does not have that failure, because the
servo can track it: at room/T the speed settles at T/(T-tau) times it — a fixed
overshoot rather than a fixed excess. So the braking term is gone and the
linear rule is the whole of it, at five seconds. Measured: the dive now arrives
at **82 m/s with 3.1 s of warning**, against 125 m/s under the old rule, while
the ship will hold about 105 km/s at 400 km where it used to manage 59.

The scenario's warning-time assertion moved from 4 s to 2 s to match. That is a
loosened promise, not a corrected test.

### Twenty-fifth round — two controls on one axis

Reported: up/down is not inverted, and it will not go down at all — something
pushes up.

Both are one fault, and it explains a claim from the round before as well. The
arrow keys were driving the ship's attitude through *two* paths at once:

- `main.ts` aims the ship directly through the torque model — inverted, gentle,
  building over seconds;
- `input.command.pitch` still went on to `world.command`, and from there to
  `Ship.updateAttitude` — not inverted, immediate.

Held briefly, the immediate path wins and nothing looks inverted. Held longer,
the torque path builds against it and the axis stalls or reverses, which is
exactly "it will not go down, something pushes up". Two opposed controls on one
axis feel like nothing else.

It also silently undid the roll inertia added a round earlier: Q and E were
going through the same duplicate, so the instant path was still there under the
new one.

Attitude now has one owner. In PILOT the block that aims the ship owns it and
the command fields are zeroed; ORBITAL, where nothing calls `aim`, keeps them.
Measured through the real frame path: ArrowUp turns the nose **down** 13.1
degrees in four seconds, ArrowDown turns it **up** by the same, symmetric to
two decimal places.

### Twenty-sixth round — a way back to forward

Asked for: something that returns the view to dead ahead, because once you have
looked away there is nothing to say where the ship is pointing.

**C**, and a button in the sights panel, which is the only thing on screen.

It swings rather than cuts, over about 1.5 s, and that is the whole design. A
cut would leave you facing forward without ever having seen yourself turn,
which answers where forward *is* but not the question actually being asked,
which is where it *was* relative to where you were looking. Watching the view
come round answers both. Measured from 51 degrees of pitch and 160 of yaw:
152 -> 70 -> 32 -> 15 -> 6.7 -> 3.1 degrees, settled by 1.5 s.

Taking hold of the mouse cancels a swing in progress — measured, it stops where
it was rather than continuing — so changing your mind never costs you the view.

The attitude-hold cycle moved from C to X to make room. It is a full-console
control and the markers it drives are not drawn in the simple view anyway.

### Twenty-seventh round — the yellow blob, and the Sun

**Thrusters** another 10 dB down, to about 20 dB under the hull hum.

**Every distant planet was the same white dot**, and the cause is a double
count. A point source's brightness here comes from its apparent magnitude,
which is already what an observer sees — the eye's adaptation is inside that
number. The sprites were then multiplied by the scene exposure as well, which
out past Jupiter runs at 15x. Measured from twelve AU, Jupiter and Saturn both
rendered **255,255,255**, with nothing left of #c9a882 or #d8c07a.

Impostors are no longer tone-mapped, so what is written is what was asked for.
Measured again, each now matches its own colour to two decimal places: Jupiter
1/0.83/0.65 against a material of 1/0.84/0.65, Saturn 1/0.89/0.57 against
1/0.89/0.57, Mars 1/0.52/0.31 against 1/0.52/0.31, Venus 1/0.93/0.72 against
1/0.93/0.72.

A note on the measuring, because it went wrong twice first: from twelve AU
several impostors overlap and saturate, so the difference between "sprite on"
and "sprite off" is only the *unsaturated remainder* and its hue means nothing.
The reading that counted came from hiding the glare, the stars and every other
body.

**Earth's night side** was still on the 2,048 map while the day side went to
8,192 — sharp continents, smeared cities. It is 8,192 now as well, and a
smaller map cannot replace a larger one here either.

**The Sun.** Its disc is about 1.6e9 cd/m2: three hundred thousand times a
sunlit planet, half a million times a white monitor. Nothing can display that,
and the only honest rendering of something that far past the top of the range
is one that is *always* at the top of it, at every exposure the adaptation can
reach. At an irradiance of 7 it was not — measured, the disc came out at a mean
of 218 from three solar radii with nothing clipped at all, which is a bright
lamp rather than something you cannot look at. At 60 the same view means 251
with a fifth of it clipped, and the centre saturates at every distance.

### Twenty-eighth round — the audio graph was never swept up

Reported: the sound stutters and sometimes cuts out entirely, recovers after
about a minute, and it seems worse near planets.

Four faults, and the "near planets" was the clue that found the first.

**Nothing was ever disconnected.** Measured on the shipped file: seven sounds
created per-play nodes, and there were *zero* `disconnect` calls in the whole
module. Every one-shot stayed wired to the master gain for the life of the
page. Near a planet the proximity swell fires every twenty-five seconds and the
radio every couple of minutes, so that is exactly where the graph grew fastest
and the audio thread had the most to carry. Every node now has an `onended`
that releases it and its chain — verified: 80 created, 80 live, **0 live once
they end**.

**The ambient beds hung on `setTimeout`.** A timer is the wrong thing to hang
music on. A stalled main thread runs it late while the outgoing bed stops at
its own end regardless, and the gap is as long as the stall — which is the
"cuts out entirely and comes back" exactly. Timing now comes from
`ctx.currentTime`, checked in the per-frame update, with the next bed brought
up a whole eight-second fade before the current one ends.

**A suspended context was never resumed.** Browsers suspend audio under load or
on focus loss and nothing brings it back by itself.

Honest limit: the stutter cannot be reproduced here. This environment renders
into a 2x2 canvas, so frame times measure 0.2-0.3 ms near Jupiter and say
nothing about a real GPU under an 8k texture at maximum anisotropy. These are
the causes that could be found and proved; if it persists, the remaining
suspect is render load starving the audio thread, and that needs a machine that
is actually drawing the thing.

### Twenty-ninth round — three more sights, a bigger Sun, and the drag reversed

**The drag is reversed**, as asked: the view now follows the hand. Worth
recording that the measurement disagreed with the report — from rendered
pixels, a 250 px drag right moved Earth's centroid from x=369 to x=96, which is
*left*, already the convention that was asked for. It was flipped anyway,
because the person looking at it is better evidence than a harness that had
been wrong twice the same day. It now measures right-goes-right. Deltas also
come from `clientX/clientY` rather than `movementX/movementY`, which some
browsers report in physical pixels and others in CSS pixels — the same drag was
turning twice as far on a Retina display.

**The Sun's halo is sized in degrees of sky now, not pixels.** It was 90 px
plus a little, about four degrees from Earth's orbit, which is a dot. What is
being drawn is not the corona — beside an unocculted photosphere the corona is
a millionth of the brightness and simply invisible — it is the scatter inside
the observer's own eye, and that reaches tens of degrees. That is why you
cannot look anywhere *near* the Sun rather than merely not at it. Base 22
degrees, growing with the disc; measured, the glare now spans about 60 degrees
of a 45-degree frame from 1 AU, a hard core in a wide faint veil.

**Three new sights**, each chosen from the geometry rather than by taste:

- **Dawn on the far side.** The idea was asked for, and the light is the whole
  of it: along the terminator the Sun comes in at nothing degrees and every rim
  and crater wall throws a shadow its own length. Measured, the solar elevation
  under the ship runs **-8 to +14 degrees** across the pass — sunrise, exactly.
  At 1.08 radii the Moon fills 135 degrees and stops being a globe.
- **Mercury at perihelion.** Ten times Earth's sunlight, a two-degree Sun, and
  nothing between the light and the rock. The arc runs from 1 degree of solar
  elevation to 78 — dawn to nearly noon.
- **Charon, with Pluto behind.** A twelve-hundredth of the sunlight, and the
  only place where a body that size hangs fixed in the sky: the two are locked
  facing each other, so from that hemisphere Pluto has never risen or set.

The flypast suite then failed at 78% and was right to stop me — but it was
measuring the wrong thing. It tested whether the subject's *centre* was in
frame, which is the same test only while the subject is small. A route may aim
off it on purpose; the dawn pass tilts 55 degrees up, so the Moon's centre is
far outside a frame that contains nothing but Moon. It now tests whether any of
the subject is on screen: 99.8%.

### Thirtieth round — the colours were the Sun

Reported with a screenshot: the Charon flypast fills the frame with sheets of
pink, green and yellow.

It was the Sun, drawn as a point source. Anything too small to be a disc gets an
impostor sprite whose size grows with brightness past a saturation magnitude, so
that Venus reads as a hard spark with a halo rather than clipping. The rule is
exponential in magnitude, magnitude has no floor, and it was written with Venus
at -4 in mind. The Sun from Pluto is -19, which the same expression answers with
a factor of 3,980.

Measured: the Sun's impostor at Pluto was **37,550 pixels wide** — fifty times
the frame — against 4 to 7 px for every other body. A single radial gradient
stretched that far bands hard in eight bits, and additive blending turned the
bands into the colours reported.

Two false leads first, both cleared by measurement rather than by argument: the
star field (hiding it changed the frame by nothing at all) and the solar glare
(hiding it left 99% of the frame *more* strongly coloured, not less).

The Sun no longer takes the point-source path at all — it has a mesh and a glare
sized in degrees of sky, and both were already right — and the growth is capped
at 64 px so nothing else can repeat it. Measured after: worst frame of the
Charon route is 1% lit at a mean of 33 with **0% strongly coloured**, against
100% lit at 249 with 35% coloured before, and the largest impostor anywhere is
7 px.

### Thirty-first round — the glare was a canvas gradient

Reported with a screenshot: green dashes scattered through the solar halo.

Not reproducible here, on either browser available, so this is a fix for the
most plausible cause rather than for a fault that could be caught in the act.
What the shape says, though, is fairly specific. The marks are discrete, a few
pixels across, spread through the halo and only where it is bright — which is
what individual *texels* look like when magnified. The glow was a 128 px canvas
gradient, and the halo now spans twenty-odd degrees of sky, several hundred
pixels, so every texel was being blown up five or six times.

Canvas gradients are dithered by the browser at low alpha, browsers do not
agree on how, and additive blending over a bright halo is exactly the operation
that turns an invisible dither pattern into visible speckle. That the artefact
appears on Safari and not here fits a rendering path that differs by browser.

The texture is now computed directly from the same piecewise falloff — no
canvas, no browser in the question — at 256 across, four times the texels.
Measured: the largest alpha step between neighbouring texels is 9 of 255, which
is a smooth ramp rather than a dithered one, and a render at pixel ratio 2 into
an 1800x1800 buffer gives 2.59 million halo pixels and **zero** green.

(The first check of the texture reported 65,504 texels "with a green cast" and
was simply a bad test: it flagged G above B, which for a warm halo is every
texel of it. The number that means something is the alpha step.)

### Thirty-second round — a journey, and the real sky

**The sky was already real, and that was not the complaint.** The 8,920 stars
come from the HYG catalogue at their true coordinates, magnitudes and colours;
the constellations are the right ones. What was missing is the part no star
catalogue holds because it is not stars — the band itself. Without it a sky
reads as a scatter of dots, which is exactly what a catalogue is.

There is now a photograph behind them: ESO's all-sky panorama by Serge Brunier,
4,096 across, CC BY 4.0. It is in galactic coordinates, so the sphere carries
the rotation into the ecliptic — and that was got wrong first: the matrix was
transposed and put the galactic centre at ecliptic longitude 116.9 instead of
266.8. Corrected, it lands on 266.84 and -5.54, the measured values to the
second decimal.

Then checked by looking rather than by trusting the arithmetic. Mean brightness
toward the galactic centre 24.3, toward the anticentre 9.7, at the north
galactic pole 2.3 and at the south 2.1 — bright toward the middle, dim toward
the rim, dark at both poles, and the two poles agreeing with each other, which
is the symmetry that would have failed had the rotation been wrong. Hiding the
sky drops the centre to 0.7.

It is not tone-mapped, for the same reason the stars are not: its brightness is
absolute, and at Pluto's fiftyfold exposure a tone-mapped Milky Way is a white
sheet.

**The long way round.** Earth to the Moon to Mars and home, 142 seconds.

The difficulty of a journey at this scale is that most of it is nothing, and
both honest presentations are wrong for a demonstration: fly it at a survivable
speed and it takes months, or cut, and lose the only thing the distance had to
say. So each leg runs on a raised-cosine speed profile — still at both ends,
enormous through the middle. That shape is what makes a hundred million
kilometres read as *far* rather than as *slow*, because the eye reads change,
and a constant rate is no change at all.

The aim crossfades across each leg: back at what is being left for the first
third, forward at what is coming for the last, swinging between them in the
middle where there is nothing to see either way.

Measured end to end: Earth at 1.95 radii, the Moon at 3.13 at t=42, Mars at
3.60 at t=87, Earth again at t=131, peak speed 51.6 c on the Mars legs. Those
are camera moves on rails, as the flypasts are.

The flypast suite caught two things and was right about both: a journey has no
waypoint list, and the spline read one anyway; and framing was being counted
against a route that does not make that promise, which dragged the figure to
84% while looking like a failure of the passes. Journeys are now excluded from
that count rather than excused within it: 99.8%.

### Thirty-third round — the journey, corrected three ways

**It halted at each body.** Holding the standoff exactly is a halt, and a
journey that halts is a slideshow. Each stop is now an arc *around* the body,
eased at both ends: 130 degrees at the Moon, **240 at Mars**, 150 on the way
home. Measured over the whole tour the line of sight sweeps 345 degrees around
Mars — it goes right round — with the disc reaching 52 degrees at 2.3 radii.

**The camera turned away far too late.** It swung on a fixed fraction of the
leg: back for the first third, forward after two thirds. The arithmetic says why
that fails. Earth stops being a readable disc — eight pixels — 2.19% of the way
along a leg to Mars, which the old speed profile reached at **15.2% of the
leg's time**, and it is a bare dot by 24.7%. The swing was *starting* at 33%,
nine points after there was anything left to watch.

Two fixes. The swing now follows the apparent size of what is being left rather
than the clock: it holds while that body is wider than six degrees and is done
by two thirds of a degree, with a time limit finishing it by the middle of the
leg so the short hop to the Moon does not spend itself looking backwards. And
the departure is slower — a creep of 3% of full speed through the first quarter
— which buys **23.4%** of the leg's time before Earth is down to eight pixels.

That figure was found rather than guessed, and the first guess was wrong in the
wrong direction: a creep of 0.16 gave 8.2%, *worse* than the cosine it replaced,
because a constant sixth of full speed is faster off the mark than a curve that
starts at nothing.

**Mars arrived as a red blob and then jumped.** Two faults at one seam. The disc
and the halo swapped at a single pixel count and they do not agree on size — a
point source is sized by brightness, a disc by geometry — so a big soft blob was
replaced by a smaller sharp planet. They overlap now: the mesh starts at 0.8 px
and the halo is gone by 2.2, and the largest step in drawn size between
neighbouring distances is **1.06x**.

And the halo was enormous: capped at 64 px, which was an emergency stop put in
for the Sun, while Mars's disc at that range was 1.7 px — thirty-eight times
too big, which is the blob itself. It is tied to the disc now, 3.5x its size
with a floor of 7 px. From 600 radii inward the drawn size tracks the true one
within a few per cent, all the way to 296 px against 307.

Found while measuring that: the halo kept its last visibility once the disc took
over, because the branch that sets it stops running there — so a 142 px glare
was still being drawn around a 76 px Mars, indefinitely.

**The sky is at its source resolution**, 6000 across rather than 4096. That is
3.6 arcmin per texel against 2.5 for a screen pixel at 45 degrees on 1080p, so
it stays a little soft, and there is no fixing that from here: 6000 is what the
photograph is.
