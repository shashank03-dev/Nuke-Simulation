# GROUND ZERO — The Atomic Test Archive

A photoreal **three.js** sandbox that recreates four historic nuclear tests and lets you set off your own.
Every radius, arrival time and cloud height comes from the published nuclear **effects** scaling laws.

| | Test | Date | Yield | Burst |
|---|---|---|---|---|
| I | **Trinity** | 16 Jul 1945 | 24.8 kt | 30.5 m tower |
| II | **Crossroads Baker** | 25 Jul 1946 | 23 kt | 27 m underwater |
| III | **Castle Bravo** | 1 Mar 1954 | 15 Mt | surface (reef) |
| IV | **Tsar Bomba** | 30 Oct 1961 | ≈50 Mt | 4 km airburst |
| V | **Custom** | — | 10 t → 100 Mt | −60 m → 20 km |

## What's simulated

- **Fireball**: Taylor–Sedov growth, then the maximum radius (≈ 55 m·W^0.4). It has a double thermal pulse
  (breakaway at 0.0025·W^0.5 s, thermal maximum at 0.0417·W^0.44 s) and blackbody colour from its temperature history.
  Tower shots show "rope-trick" spikes in the first milliseconds.
- **Blast**: Kinney–Graham overpressure with ground reflection. The shock front's position is integrated from the
  Rankine–Hugoniot shock speed, so arrival times at every observer are physical.
  You hear **nothing** until the shock reaches you.
- **Heat & radiation**: thermal fluence with atmospheric transmission, burn thresholds, ignition and charring of
  vegetation and houses, and prompt dose with Geiger clicks.
- **Cloud**: a ray-marched volumetric fireball morphs into a toroidal cap with poloidal circulation. It also has an
  afterwind stem, a dust skirt, the Wilson condensation cloud and stem collars. Rise and stabilised height follow the
  observed record (Trinity ≈ 12 km, Bravo ≈ 40 km, Tsar ≈ 64 km).
- **Baker**: spray dome, a hollow 1.8 km water column, the cauliflower head, the base surge, radial gravity waves,
  and the target fleet (USS *Arkansas* is lifted and sunk).
- **Ground**: craters (Bravo's 2 km × 76 m), green trinitite glass, scorching and a shock dust front. **Earth
  curvature** is applied to everything, so Bravo's cloud seen from the Lucky Dragon, 145 km away, rises from below
  the horizon.
- **Sandbox tools**: a logarithmic timeline from 1 µs to 25 min with automatic slow motion, and historical observer
  posts. You can also click-to-place an observer, orbit or fly with the aircraft, see live readouts (overpressure,
  wind, fluence, dose, arrival countdown), draw damage rings and use a **Rapatronic** photo mode with PNG export.

## Textures

All HDRIs and PBR materials are **CC0 from [Poly Haven](https://polyhaven.com)**. They are fetched live through the
public API (`api.polyhaven.com/files/{id}`), and the sun direction is detected from each HDRI. If the network
fails, every asset falls back to a procedural texture. Credits are listed in the app.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in dist/
```

URL flags for direct links: `?scenario=bravo&t=60&obs=enyu&q=high&play=1&photo=1&hud=0`.
Quality presets: `q=low|medium|high|ultra`.

Keys: <kbd>Space</kbd> play · <kbd>D</kbd> detonate · <kbd>R</kbd> reset · <kbd>P</kbd> photo mode ·
<kbd>O</kbd> orbit · <kbd>V</kbd> observer · <kbd>H</kbd> hide UI · <kbd>1–8</kbd> time scale.

## Sources

Glasstone & Dolan, *The Effects of Nuclear Weapons* (1977) · G. I. Taylor (1950) · Kinney & Graham,
*Explosive Shocks in Air* (1985) · DOE/NV-209 · LANL Trinity archive · Weisgall, *Operation Crossroads* (1994).

The project models what a nuclear explosion *does*, not how a weapon is built. See `docs/DESIGN_BRIEF.md`.
