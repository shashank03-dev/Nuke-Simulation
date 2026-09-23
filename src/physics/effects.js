/**
 * Nuclear-explosion EFFECTS model.
 *
 * Everything here is from the open literature on weapons *effects* (no device physics):
 *  - Glasstone & Dolan, "The Effects of Nuclear Weapons", 3rd ed. (1977)
 *  - G.I. Taylor (1950) / L.I. Sedov blast-wave similarity solution
 *  - Kinney & Graham, "Explosive Shocks in Air" (1985) scaled overpressure fit
 *  - Rankine–Hugoniot relations for shock speed / particle velocity
 *
 * Units: SI (m, s, Pa, J) unless noted. Yield W is in kilotons TNT.
 */

export const KT_J = 4.184e12;          // 1 kiloton TNT in joules
export const P0 = 101325;              // sea-level ambient pressure (Pa)
export const RHO0 = 1.225;             // sea-level air density (kg/m^3)
export const C0 = 340.3;               // sound speed (m/s)
export const PSI = 6894.76;            // Pa per psi
export const CAL_CM2 = 4.184e4;        // J/m^2 per cal/cm^2

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;

/** log-log interpolation through a sorted table [[x, y], ...] */
function logInterp(table, x) {
  if (x <= table[0][0]) {
    const [x0, y0] = table[0], [x1, y1] = table[1];
    const k = Math.log(y1 / y0) / Math.log(x1 / x0);
    return y0 * Math.pow(x / x0, k);
  }
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      const t = Math.log(x / x0) / Math.log(x1 / x0);
      return Math.exp(lerp(Math.log(y0), Math.log(y1), t));
    }
  }
  const n = table.length;
  const [x0, y0] = table[n - 2], [x1, y1] = table[n - 1];
  const k = Math.log(y1 / y0) / Math.log(x1 / x0);
  return y1 * Math.pow(x / x1, k);
}

/**
 * Observed stabilized cloud-top altitudes (km) vs yield (kt).
 * Anchors: Trinity (~21 kt) ≈ 11–12 km, Ivy Mike (10.4 Mt) ≈ 33–37 km,
 * Castle Bravo (15 Mt) ≈ 40 km, Tsar Bomba (50 Mt) ≈ 64–67 km.
 */
const CLOUD_TOP_KM = [
  [0.001, 0.6], [0.01, 1.2], [0.1, 2.6], [1, 4.8], [10, 8.8], [20, 11.2], [100, 14.5],
  [1000, 20.5], [10000, 33], [15000, 39], [50000, 64], [100000, 72],
];
/** Stabilized cloud cap radius (km). Bravo ~ 50 km wide at 10 min, Tsar ~ 95 km wide. */
const CLOUD_CAP_KM = [
  [0.001, 0.08], [0.01, 0.16], [0.1, 0.35], [1, 0.75], [10, 1.6], [20, 2.1], [100, 3.6],
  [1000, 9.5], [10000, 22], [15000, 26], [50000, 46], [100000, 55],
];

/** Kinney–Graham: overpressure ratio Δp/p0 at scaled distance Z (m/kg^1/3). */
export function kinneyGraham(Z) {
  const a = Z / 4.5, b = Z / 0.048, c = Z / 0.32, d = Z / 1.35;
  return (808 * (1 + a * a)) / Math.sqrt((1 + b * b) * (1 + c * c) * (1 + d * d));
}

/** Rankine–Hugoniot shock front speed for a given overpressure (Pa), γ = 1.4 */
export function shockSpeed(dp) {
  return C0 * Math.sqrt(1 + (6 * dp) / (7 * P0));
}
/** Peak particle (wind) velocity behind the shock (m/s) */
export function peakWind(dp) {
  return ((5 * dp) / (7 * P0)) * C0 / Math.sqrt(1 + (6 * dp) / (7 * P0));
}
/** Peak dynamic pressure (Pa) */
export function dynamicPressure(dp) {
  return (5 * dp * dp) / (2 * (dp + 7 * P0));
}

/** Blackbody colour (linear sRGB, normalised to max channel 1) — Planck fit (Tanner Helland/CIE-ish). */
export function blackbodyRGB(T) {
  const t = clamp(T, 800, 40000) / 100;
  let r, g, b;
  if (t <= 66) r = 1; else r = clamp(1.292936186 * Math.pow(t - 60, -0.1332047592), 0, 1);
  if (t <= 66) g = clamp(0.3900815788 * Math.log(t) - 0.6318414438, 0, 1);
  else g = clamp(1.129890861 * Math.pow(t - 60, -0.0755148492), 0, 1);
  if (t >= 66) b = 1; else if (t <= 19) b = 0; else b = clamp(0.5432067891 * Math.log(t - 10) - 1.19625408675, 0, 1);
  // sRGB -> linear
  const lin = (c) => Math.pow(c, 2.2);
  return [lin(r), lin(g), lin(b)];
}

/**
 * A Detonation encapsulates every scaling law for a given yield / burst geometry.
 * @param {object} o
 * @param {number} o.yieldKt   yield in kilotons
 * @param {number} o.hob       height of burst in metres (negative = depth below water/ground)
 * @param {string} o.medium    'air' | 'surface' | 'underwater'
 * @param {number} [o.visibility] meteorological visibility (m)
 * @param {number} [o.humidity] 0..1 (Wilson cloud)
 */
export class Detonation {
  constructor({ yieldKt, hob = 0, medium = 'air', visibility = 40000, humidity = 0.5, crater = null, groundType = 'soil' }) {
    this.W = Math.max(1e-4, yieldKt);
    this.hob = hob;
    this.medium = medium;
    this.visibility = visibility;
    this.humidity = humidity;
    this.groundType = groundType;
    this.E = this.W * KT_J;

    const W = this.W;
    // ---- Fireball ----------------------------------------------------------------
    // Max luminous fireball radius (airburst) ≈ 55 m · W^0.4  (Glasstone §2.12 order)
    this.RmaxAir = 55 * Math.pow(W, 0.4);
    // Surface / near-surface: reflected hemisphere → volume doubled → radius × 2^(1/3)
    const scaledHob = Math.max(0, hob) / this.RmaxAir;
    this.surfaceFactor = medium === 'underwater' ? 0 : clamp(1 - scaledHob, 0, 1);
    this.Rmax = this.RmaxAir * lerp(1, Math.pow(2, 1 / 3), this.surfaceFactor);
    if (medium === 'underwater') this.Rmax = this.RmaxAir * 0.6;

    // Thermal pulse timing (Glasstone ch. 7)
    this.tMin = 0.0025 * Math.pow(W, 0.5);   // first minimum ~ shock breakaway (s)
    this.tMax = 0.0417 * Math.pow(W, 0.44);  // second (principal) thermal maximum (s)
    this.tMin = Math.max(this.tMin, 2e-5);

    // Thermal partition
    let f = 0.35;
    if (medium === 'surface' || this.surfaceFactor > 0.6) f = lerp(0.35, 0.2, this.surfaceFactor);
    if (medium === 'underwater') f = 0.002;
    this.thermalFraction = f;

    // Blast partition (≈50% in air; much less coupled into air underwater)
    this.blastFraction = medium === 'underwater' ? 0.12 : 0.5;
    // Ground reflection / Mach-stem enhancement: ×2 near the surface, fading for very high bursts
    const hobScaled = Math.max(0, hob) / Math.cbrt(W); // m/kt^(1/3)
    this.reflection = medium === 'underwater' ? 1.6 : lerp(2.0, 1.35, clamp((hobScaled - 250) / 600, 0, 1));
    this.Wtnt = this.E / 4.184e6 * this.blastFraction; // kg TNT (1 kg TNT = 4.184 MJ)

    // ---- Cloud -----------------------------------------------------------------
    // Baker's cauliflower cloud topped out near 2–2.5 km: most energy went into lifting water
    this.cloudTop = logInterp(CLOUD_TOP_KM, W) * 1000 * (medium === 'underwater' ? 0.21 : 1);
    this.capRadius = logInterp(CLOUD_CAP_KM, W) * 1000 * (medium === 'underwater' ? 0.45 : 1);
    // Rise timescale: ~60 s for 20 kt; ~2.5 min for multi-megaton
    this.riseTau = 58 * Math.pow(W / 20, 0.12);
    this.stabilizeTime = this.riseTau * 4.2;
    // Cap vertical half-thickness; megaton clouds punch the tropopause and flatten (anvil).
    this.capHalfThick = this.capRadius * 0.36 * (W > 2000 ? 0.7 : 0.85) * 1.1;
    this.capCenterFinal = this.cloudTop - this.capHalfThick * 1.05;
    // Toroidal circulation develops once the fireball starts to rise.
    this.tToroid = Math.max(this.tMax * 12, 1.2 * Math.pow(W, 0.18));

    // ---- Crater ------------------------------------------------------------------
    if (crater) {
      this.crater = { ...crater };
    } else if (medium === 'surface' || this.surfaceFactor > 0.55) {
      const k = groundType === 'coral' ? 40 : groundType === 'snow' ? 28 : 30;
      const s = medium === 'surface' ? 1 : clamp((this.surfaceFactor - 0.55) / 0.45, 0, 1);
      const r = k * Math.cbrt(W) * s;
      this.crater = r > 2 ? { radius: r, depth: r * (groundType === 'coral' ? 0.076 : 0.1) * s, glass: groundType === 'soil' } : null;
    } else this.crater = null;

    this._buildShockTable();
  }

  get isUnderwater() { return this.medium === 'underwater'; }

  /** Taylor–Sedov blast radius (m) */
  sedovRadius(t) {
    return 1.033 * Math.pow((this.E * t * t) / RHO0, 0.2);
  }

  /** Luminous fireball radius (m) at time t */
  fireballRadius(t) {
    if (t <= 0) return 0;
    const rs = this.sedovRadius(t) * (this.medium === 'underwater' ? 0.5 : 1);
    const p = 4;
    // soft-min between hydrodynamic growth and the maximum radius
    const r = Math.pow(Math.pow(rs, -p) + Math.pow(this.Rmax, -p), -1 / p);
    // late slight growth as it becomes the toroid
    return r * (1 + 0.15 * clamp((t - this.tMax * 5) / (this.tToroid * 2), 0, 1));
  }

  /** Normalised thermal power (1 = principal maximum). Double pulse. */
  thermalPower(t) {
    if (t <= 0) return 0;
    const tau = t / this.tMax;
    const second = (2 * tau * tau) / (1 + tau * tau * tau * tau);
    // First pulse: extremely brief, peaks ~ tMin/5, collapses at tMin (ionised shock front is opaque)
    const t1 = this.tMin * 0.18;
    const l = Math.log(t / t1);
    const first = 0.9 * Math.exp(-(l * l) / 0.9) * (t < this.tMin ? 1 : Math.exp(-(t - this.tMin) / (this.tMin * 0.3)));
    const dip = t < this.tMin * 1.6 ? lerp(0.25, 1, clamp(t / (this.tMin * 1.6), 0, 1) ** 2) : 1;
    return first + second * dip;
  }

  /** Apparent radiating temperature of the fireball (K) */
  fireballTemperature(t) {
    if (t <= 0) return 0;
    if (t < this.tMin) {
      // X-ray fireball → hydrodynamic: very hot, then the shock front cools & becomes opaque
      const k = t / this.tMin;
      return lerp(60000, 2600, Math.pow(k, 0.45));
    }
    if (t < this.tMax) {
      const k = (t - this.tMin) / (this.tMax - this.tMin);
      return lerp(2600, 7700, Math.sin(k * Math.PI * 0.5));
    }
    // cooling: 7700 K → ~2000 K over ~10 tMax, then glow to ~1100 K over tens of seconds
    const k = (t - this.tMax) / (this.tMax * 9);
    if (k < 1) return lerp(7700, 2100, Math.pow(k, 0.6));
    const k2 = (t - this.tMax * 10) / (8 + this.tToroid * 4);
    return lerp(2100, 900, clamp(k2, 0, 1));
  }

  /** Visual luminance multiplier of the fireball emission (arbitrary HDR units) */
  fireballLuminance(t) {
    const T = this.fireballTemperature(t);
    // Stefan–Boltzmann-ish, normalised at 7700 K
    const s = Math.pow(T / 7700, 4);
    return s * 1.0;
  }

  /** Total thermal energy released (J) */
  get thermalEnergy() { return this.E * this.thermalFraction; }

  // ---------------------------------------------------------------- blast
  /** Scaled distance for slant range D (m) */
  scaledDistance(D) {
    return D / Math.cbrt(this.Wtnt * this.reflection);
  }
  /** Peak static overpressure (Pa) at slant range D */
  overpressureAtSlant(D) {
    return kinneyGraham(this.scaledDistance(Math.max(D, 0.5))) * P0;
  }
  /** Peak overpressure at a ground point (range r from ground zero, height y above burst ground) */
  overpressureAtGround(r, y = 0) {
    const h = Math.max(0, this.hob) - y;
    const D = Math.sqrt(r * r + h * h);
    let dp = this.overpressureAtSlant(D);
    return dp;
  }

  _buildShockTable() {
    // integrate t(R) = ∫ dR / U(Δp(R))
    const N = 600;
    const Rmin = 0.05, RmaxT = 400000;
    this._R = new Float64Array(N);
    this._T = new Float64Array(N);
    let t = 0;
    let prevR = Rmin;
    // very early: Sedov gives t for R = Rmin
    t = Math.sqrt(Math.pow(Rmin / 1.033, 5) * RHO0 / this.E);
    this._R[0] = Rmin; this._T[0] = t;
    for (let i = 1; i < N; i++) {
      const R = Rmin * Math.pow(RmaxT / Rmin, i / (N - 1));
      const Rm = 0.5 * (R + prevR);
      // in the very strong regime use Sedov speed (more faithful than KG extrapolation)
      const tSed = Math.sqrt(Math.pow(Rm / 1.033, 5) * RHO0 / this.E);
      const uSed = 0.4 * Rm / tSed;
      const uKG = shockSpeed(this.overpressureAtSlant(Rm));
      const u = Math.max(Math.min(uSed, uKG * 1.6), C0);
      t += (R - prevR) / u;
      this._R[i] = R; this._T[i] = t;
      prevR = R;
    }
  }

  /** Shock arrival time (s) at slant range D */
  arrivalTime(D) {
    const R = this._R, T = this._T;
    if (D <= R[0]) return T[0];
    let lo = 0, hi = R.length - 1;
    if (D >= R[hi]) return T[hi] + (D - R[hi]) / C0;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R[m] < D) lo = m; else hi = m; }
    const k = (D - R[lo]) / (R[hi] - R[lo]);
    return lerp(T[lo], T[hi], k);
  }
  /** Shock-front radius (m) at time t */
  shockRadius(t) {
    const R = this._R, T = this._T;
    if (t <= T[0]) return Math.max(0, this.sedovRadius(t));
    let lo = 0, hi = T.length - 1;
    if (t >= T[hi]) return R[hi] + (t - T[hi]) * C0;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m; else hi = m; }
    const k = (t - T[lo]) / (T[hi] - T[lo]);
    return lerp(R[lo], R[hi], k);
  }

  // ---------------------------------------------------------------- thermal
  /** Thermal fluence (cal/cm^2) at slant range D */
  thermalFluence(D) {
    const tau = Math.exp(-D / (this.visibility * 0.75));
    const Q = (this.thermalEnergy * tau) / (4 * Math.PI * D * D);
    return Q / CAL_CM2;
  }
  /** fluence needed for burn degree n (1..3), weakly yield dependent (longer pulses are less efficient) */
  burnThreshold(n) {
    const base = n === 1 ? 2.5 : n === 2 ? 4.8 : 7.2;
    return base * Math.pow(this.W / 20, 0.06);
  }

  // ---------------------------------------------------------------- radiation
  /** Prompt (initial) radiation dose (rem) at slant range D — mean-free-path fit */
  promptDose(D) {
    if (this.medium === 'underwater') return 9.6e8 * this.W * 0.3 * Math.exp(-D / 380) / (D * D);
    return (9.6e8 * this.W * Math.exp(-D / 410)) / (D * D);
  }

  // ---------------------------------------------------------------- inverse (ring radii)
  _solveRange(fn, target, lo = 1, hi = 800000) {
    // fn decreasing in r
    if (fn(lo) < target) return 0;
    if (fn(hi) > target) return hi;
    for (let i = 0; i < 80; i++) {
      const m = Math.sqrt(lo * hi);
      if (fn(m) > target) lo = m; else hi = m;
    }
    return Math.sqrt(lo * hi);
  }
  /** ground range at which peak overpressure equals psi */
  rangeForPsi(psi) {
    return this._solveRange((r) => this.overpressureAtGround(r) / PSI, psi);
  }
  rangeForFluence(cal) {
    const h = Math.max(0, this.hob);
    return this._solveRange((r) => this.thermalFluence(Math.hypot(r, h)), cal);
  }
  rangeForDose(rem) {
    const h = Math.max(0, this.hob);
    return this._solveRange((r) => this.promptDose(Math.hypot(r, h)), rem);
  }

  /** All the rings the HUD draws */
  rings() {
    const fb = this.Rmax;
    // A fireball that would only graze the ground is pushed back up by its own reflected shock
    // (as happened with Tsar Bomba), so it never touches down.
    const touches = this.hob < 0.85 * fb;
    const fbGround = !touches ? 0 : this.hob > 0 ? Math.sqrt(Math.max(0, fb * fb - this.hob * this.hob)) : fb;
    const underwaterThermal = this.medium === 'underwater';
    return [
      { id: 'fireball', label: 'Fireball', radius: fbGround, color: '#ffd27a' },
      { id: 'psi20', label: '20 psi · reinforced concrete destroyed', radius: this.rangeForPsi(20), color: '#ff3b2f' },
      { id: 'rad500', label: '500 rem prompt dose', radius: this.rangeForDose(500), color: '#7dff5a' },
      { id: 'psi5', label: '5 psi · most buildings collapse', radius: this.rangeForPsi(5), color: '#ff8a1f' },
      { id: 'burn3', label: '3rd-degree burns', radius: underwaterThermal ? 0 : this.rangeForFluence(this.burnThreshold(3)), color: '#ffcf33' },
      { id: 'psi1', label: '1 psi · windows shatter', radius: this.rangeForPsi(1), color: '#5ab8ff' },
      { id: 'burn1', label: '1st-degree burns', radius: underwaterThermal ? 0 : this.rangeForFluence(this.burnThreshold(1)), color: '#c9a0ff' },
    ].filter((r) => r.radius > 0.5);
  }

  // ---------------------------------------------------------------- cloud kinematics
  /** Height (m) of the cloud-cap centre above ground at time t */
  capCenterHeight(t) {
    const h0 = Math.max(0, this.hob);
    // buoyant rise starts only after the principal thermal maximum
    const tp = Math.max(0, t - this.tMax * 2);
    const s = 1 - Math.exp(-Math.pow(tp / this.riseTau, 1.4));
    return h0 + (this.capCenterFinal - h0) * s;
  }
  /** Toroid major radius (m) at time t */
  capRadiusAt(t) {
    const s = 1 - Math.exp(-Math.pow(t / (this.riseTau * 0.75), 1.0));
    const r0 = this.Rmax * 0.75;
    const late = 1 + 0.25 * clamp((t - this.stabilizeTime) / (this.stabilizeTime * 2), 0, 1);
    return lerp(r0, this.capRadius * 0.62, s) * late;
  }
  /** Toroid minor (tube) radius at time t */
  capTubeAt(t) {
    const s = 1 - Math.exp(-Math.pow(t / (this.riseTau * 0.7), 1.0));
    return lerp(this.Rmax * 0.8, this.capRadius * 0.36, s);
  }
  /** 0 (sphere) → 1 (fully developed toroid) */
  toroidMorph(t) {
    return clamp((t - this.tToroid * 0.35) / (this.tToroid * 3.5), 0, 1);
  }

  /**
   * Observer readout at world position (x, y, z) relative to ground zero at origin
   * (burst point at (0, hob, 0)).
   */
  observerReport(x, y, z) {
    const r = Math.hypot(x, z);
    const h = Math.max(0, this.hob) - y;
    const D = Math.max(1, Math.hypot(r, h));
    const dp = this.overpressureAtSlant(D);
    const psi = dp / PSI;
    const report = {
      groundRange: r,
      slantRange: D,
      lightDelay: D / 299792458,
      arrival: this.arrivalTime(D),
      overpressurePa: dp,
      overpressurePsi: psi,
      wind: peakWind(dp),
      dynamicPsi: dynamicPressure(dp) / PSI,
      thermal: this.medium === 'underwater' ? 0 : this.thermalFluence(D),
      dose: this.promptDose(D),
      insideFireball: D < this.Rmax,
    };
    report.effects = describeEffects(report, this);
    return report;
  }
}

export function describeEffects(r, det) {
  const out = [];
  if (r.insideFireball) return ['Inside the fireball — vaporised'];
  const p = r.overpressurePsi;
  if (p > 20) out.push('Heavily built concrete structures destroyed');
  else if (p > 10) out.push('Reinforced buildings severely damaged; most people killed');
  else if (p > 5) out.push('Most residential buildings collapse');
  else if (p > 3) out.push('Frame houses badly damaged; serious injuries common');
  else if (p > 1) out.push('Windows shatter; flying glass injuries');
  else if (p > 0.2) out.push('Occasional glass breakage');
  else out.push('Blast audible as distant thunder');
  if (r.thermal > det.burnThreshold(3)) out.push('3rd-degree burns to exposed skin; clothing ignites');
  else if (r.thermal > det.burnThreshold(2)) out.push('2nd-degree burns (blistering)');
  else if (r.thermal > det.burnThreshold(1)) out.push('1st-degree burns (like severe sunburn)');
  else if (r.thermal > 0.3) out.push('Intense heat on the skin, like an open oven');
  if (r.dose > 1000) out.push('Lethal prompt radiation dose');
  else if (r.dose > 500) out.push('~50% lethal prompt radiation dose');
  else if (r.dose > 100) out.push('Radiation sickness likely');
  if (r.wind > 70) out.push(`Hurricane-force winds (${Math.round(r.wind * 3.6)} km/h)`);
  return out;
}

/** Format helpers shared by UI */
export function fmtTime(t) {
  const a = Math.abs(t);
  const s = t < 0 ? '−' : '+';
  if (a < 1e-3) return `T${s}${(a * 1e6).toFixed(a < 1e-5 ? 2 : 1)} µs`;
  if (a < 1) return `T${s}${(a * 1e3).toFixed(a < 0.01 ? 3 : a < 0.1 ? 2 : 1)} ms`;
  if (a < 60) return `T${s}${a.toFixed(a < 10 ? 3 : 2)} s`;
  const m = Math.floor(a / 60), sec = a - m * 60;
  return `T${s}${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
export function fmtDist(m) {
  if (m < 1000) return `${m.toFixed(0)} m`;
  if (m < 100000) return `${(m / 1000).toFixed(2)} km`;
  return `${(m / 1000).toFixed(0)} km`;
}
export function fmtYield(kt) {
  if (kt < 1) return `${(kt * 1000).toFixed(kt < 0.01 ? 1 : 0)} t`;
  if (kt < 1000) return `${kt.toFixed(kt < 10 ? 1 : 0)} kt`;
  return `${(kt / 1000).toFixed(kt < 10000 ? 2 : 1)} Mt`;
}
