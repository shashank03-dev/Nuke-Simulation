# GROUND ZERO — The Atomic Test Archive

A full design brief, written before building anything. The code implements this document.

## 1. What it is

A photoreal, physically driven **three.js sandbox** that recreates four historic nuclear tests.
It also runs custom "what-if" detonations. The story is a light anthology frame: a declassified
archive of four events, each opened as a dossier. The main experience is the sandbox. You stand
anywhere, scrub time from microseconds to many minutes, and watch every phase of the event,
timed and sized by the published effects scaling laws.

> Scope boundary: only **effects** physics is modelled (fireball, blast, heat, cloud, fallout
> direction), using the open literature. That means Glasstone & Dolan, *The Effects of Nuclear
> Weapons* (1977), Brode (1955/1968) and Kinney & Graham (1985). Nothing about device design.

## 2. The anthology (story frame)

Intro: *"Between 1945 and 1996 the world detonated 2,056 nuclear devices. Four of them rewrote
what we thought was possible. This archive lets you stand where the observers stood."*

| # | Test | Date / local time | Place | Yield | Burst | Environment |
|---|------|------|-------|-------|-------|-------------|
| I | **Trinity** ("Gadget") | 16 Jul 1945, 05:29:45 | Jornada del Muerto, New Mexico | ~24.8 kt | 30.5 m steel tower | Pre-dawn desert, mountains, base camps |
| II | **Crossroads Baker** | 25 Jul 1946, 08:35 | Bikini Lagoon, Marshall Is. | 23 kt | 27 m underwater | Tropical lagoon, target fleet, cumulus |
| III | **Castle Bravo** ("Shrimp") | 1 Mar 1954, 06:45 | Namu Island reef, Bikini Atoll | 15 Mt (≈2.5× forecast) | Surface | Dawn over the atoll, 2 km crater, fallout |
| IV | **Tsar Bomba** (AN602) | 30 Oct 1961, 11:32 MSK | Sukhoy Nos, Novaya Zemlya | ~50 Mt | 4,000 m airburst | Low Arctic sun, snowfield, Tu-95V carrier |
| V | **Custom** | any | any of the above environments | 0.01 kt → 100 Mt | depth → 10 km altitude | Sandbox |

Each dossier has a typewritten briefing, the device name, the observers' human story (Fermi's
paper strips; the sailors watching USS *Arkansas* lifted; the *Daigo Fukuryū Maru* crew and
Rongelap; Durnovtsev's crew given a 50 % survival chance), and "archive notes" of verified facts.

## 3. Physics model (src/physics)

Units are SI internally. 1 world unit = 1 metre. W = yield in kilotons, 1 kt = 4.184e12 J.

* **Early fireball (hydrodynamic):** Taylor–Sedov, `R(t) = 1.033 (E t² / ρ₀)^(1/5)`. It is capped
  by the maximum fireball radius, `R_max ≈ 55 m · W^0.4` (airburst), with ×2^(1/3) for a surface
  burst because the hemisphere reflects.
* **Thermal pulse:** double-pulse history. The first minimum is at `t_min ≈ 0.0025·W^0.5 s`
  (shock breakaway) and the second maximum at `t_max ≈ 0.0417·W^0.44 s`. Thermal fraction is
  0.35 for an airburst, 0.18 for a surface burst and ≈0 underwater. Power follows the Glasstone
  normalised pulse shape.
* **Fireball temperature → colour:** blackbody curve (≈ 1e5 K early, ~2000 K minimum, 7700 K at
  the second max, cooling to 2000 K), converted to RGB. As it cools a reddish-brown NO₂ tint
  appears (visible in real footage).
* **Blast overpressure:** Kinney–Graham, from the scaled distance `Z = R / W_eff^(1/3)` (m/kg^(1/3))
  with `W_eff = 0.5 · W · 1e6 kg TNT`, doubled for ground reflection / the Mach stem. Airbursts
  use slant range. Underwater, the air-blast fraction is reduced.
* **Shock front position:** integrated from the Rankine–Hugoniot shock speed
  `U = c₀ √(1 + 6Δp / 7p₀)`, tabulated per detonation. This gives the true arrival times.
  The sound of the blast reaches an observer at the shock arrival time, while light arrives instantly.
* **Peak wind:** `u = (5Δp / 7p₀) · c₀ / √(1 + 6Δp / 7p₀)`.
* **Thermal fluence:** `Q = f·E·τ / (4π D²)`, with atmospheric transmission `τ = e^(−D/L)`
  (visibility L). Burn thresholds scale as W^0.06.
* **Prompt radiation:** an exponential mean-free-path fit, for the observer readout.
* **Mushroom cloud:** the stabilised top and cap radius are interpolated (log–log) from the
  observed record (Trinity ≈ 12 km, Bravo ≈ 40 km, Tsar ≈ 64 km). The rise follows
  `H(t) = H_top(1 − e^(−t/τ))`. The toroidal vortex cap forms at `t ≈ t_max·30`.
* **Crater:** apparent crater radius/depth for surface bursts: Trinity ≈ 80 m × 1.4 m with
  green trinitite glass, Bravo ≈ 2 km × 76 m.
* **Baker:** water column ≈ 600 m wide and 1.8 km tall, a Wilson condensation cloud at ~0.1–2 s,
  a base surge ring, and a 29 m wave at 300 m.

## 4. Rendering (src/render, src/fx)

* **Renderer:** three.js WebGL2, HalfFloat HDR targets, ACES tone mapping, physically based
  lights and shadows.
* **Sky & light:** Poly Haven HDRIs as background and IBL. The sun direction is found
  automatically from the HDR's brightest texel and drives the directional light.
* **Terrain:** a large procedural fBm heightfield (per-scenario recipe) with PBR materials fetched
  from Poly Haven (diffuse, normal and ARM). It uses anti-tiling (two scales plus rotation) and
  macro variation. The terrain shader also draws the damage rings, the crater deformation and
  trinitite, thermal scorching over time, and the dust-front shadowing.
* **Ocean:** a custom Gerstner-wave shader with procedural normals, Fresnel, sky reflection,
  foam, shock "slick" rings and the Baker disturbance.
* **Volumetrics (the centrepiece):** a half-resolution ray-marched volume pass that reads scene
  depth and renders:
  * the fireball (turbulent fBm sphere, blackbody emission, limb darkening, early "rope-trick" spikes)
  * the rising toroidal cap (torus SDF with curl-noise detail and a rolling vortex)
  * the stem, dust skirt and the Wilson condensation rings/collars
  * the Baker water column and cauliflower cloud
  * lighting: sun single-scattering, internal emission, multi-scatter approximation
* **Shock wave:** a screen-space refraction shell at the exact shock radius, plus a ground dust
  front, a Wilson cloud dome in humid scenarios, and an ocean ring.
* **Flash:** an HDR point light at the fireball with the thermal-pulse intensity, sky wash,
  simulated eye adaptation and white-out.
* **Post:** bloom (UnrealBloom on HDR), heat-shimmer distortion, chromatic aberration, vignette,
  grain and lens-flare streaks.
* **Photo mode:** a Rapatronic (EG&G) high-speed camera look. It locks time at µs–ms frames,
  renders monochrome high-contrast in an archive frame with a metadata stamp, and exports a PNG.
* **Quality presets** Low / Medium / High / Ultra control the volume steps, resolution scale,
  shadow map size and texture resolution (1k / 2k).

## 5. Scene contents

* Trinity: the 30 m steel tower (lattice), the jumbo containment vessel outline, and the
  bunkers S-10000, W-10000 and N-10000 and Base Camp. Joshua-less creosote shrubs are instanced.
  The Oscura mountains are on the horizon.
* Baker: a target fleet of procedural ship hulls (USS *Arkansas*, USS *Saratoga* silhouette, a
  destroyer array) and LSM-60 at zero. Atoll islands ring the lagoon.
* Bravo: the Namu reef, atoll islets with palms, the bunker on Enyu, and a crater that erodes
  the reef.
* Tsar: snowfield and ridges, a Tu-95V aircraft escaping at 45 km slant, and the Sukhoy Nos
  coastline with the Arctic ocean.
* Custom test array: frame houses, trees, poles and vehicles along a radial line. Each reacts
  to overpressure (5 psi collapse → debris), wind (trees bend, snap and later lean to the
  afterwind) and thermal fluence (charring, then ignition smoke).

## 6. Sandbox tools (UI)

* **Timeline:** a logarithmic scrub bar from 1 µs to 15 min with phase markers (X-ray fireball,
  hydrodynamic growth, breakaway, thermal maximum, toroid formation, stabilisation). Play /
  pause, time scale 1/10,000× to 60×, and a live T+ clock in µs / ms / s / min.
* **Physics HUD at the observer:** distance, time until light/blast, peak overpressure (psi/kPa),
  peak wind, thermal fluence (cal/cm²), prompt dose (rem) and the effect description.
* **Damage rings:** fireball, 20 psi, 5 psi, 1 psi, 3rd-degree burns, 1st-degree burns, and the
  500 rem prompt radiation line. Drawn on the ground and labelled.
* **Observer positions:** per-scenario historical posts (e.g. S-10000 at 9.1 km, Compañia Hill
  at 32 km, USS *Mount McKinley*, the Tu-95V cockpit). Click-to-place on terrain, plus free
  orbit, observer eye, aircraft and orbital cameras.
* **Custom controls:** yield (log slider), burst height/depth, environment, sky preset,
  humidity, wind.

## 7. Audio (Web Audio, fully procedural)

Environment beds (desert wind and crickets, surf, Arctic wind), a countdown, and exact
**silence until the shock arrives** at the observer. The shock itself is an N-wave crack plus
a sub-bass thump and long rolling thunder with ground echoes. Then the afterwind, and Geiger
clicks scaled to the prompt dose readout.

## 8. Texture sources (fetched live, CC0)

Poly Haven API (`api.polyhaven.com/files/{id}` → `dl.polyhaven.org`):
HDRIs: `qwantani_dawn_puresky`, `kloofendal_48d_partly_cloudy_puresky`, `qwantani_sunrise_puresky`,
`syferfontein_1d_clear_puresky`, `qwantani_night_puresky`, `kloofendal_43d_clear_puresky`,
`kloofendal_overcast_puresky`, `qwantani_dusk_2_puresky`.
PBR: `gravelly_sand`, `dry_ground_rocks`, `coast_sand_01`, `coral_ground_02`, `snow_02`,
`snow_field_aerial`, `rock_face`, `weathered_plank_siding`, `roof_07`, `rusty_metal`,
`concrete_wall_008`, `rusty_painted_metal`, `blue_metal_plate`, `bark_brown_02`.
Every asset falls back to a procedural texture if the network fails. Credits are shown in the UI.

## 9. Delivery

Vite + three.js. It is deployed on Vercel under the owner's account at `nuke-simulation.vercel.app`.
