import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

/**
 * TextureLab — fetches CC0 HDRIs and PBR material sets live from Poly Haven
 * (https://polyhaven.com, API: https://api.polyhaven.com) with graceful procedural fallbacks.
 */
const API = 'https://api.polyhaven.com';
const TIMEOUT = 25000;

export class TextureLab {
  constructor(renderer) {
    this.renderer = renderer;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.fileCache = new Map();
    this.infoCache = new Map();
    this.texCache = new Map();
    this.hdrCache = new Map();
    this.credits = new Map(); // id -> {name, authors, type}
    this.listeners = new Set();
    this.pending = 0;
    this.done = 0;
    this.failed = [];
    this.textureLoader = new THREE.TextureLoader();
    this.textureLoader.setCrossOrigin('anonymous');
    this.hdrLoader = new HDRLoader();
    this.hdrLoader.setDataType(THREE.HalfFloatType);
  }

  onProgress(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(label) {
    for (const fn of this.listeners) fn({ pending: this.pending, done: this.done, label, failed: this.failed.length });
  }
  _begin(label) { this.pending++; this._emit(label); }
  _end(label, ok = true) { this.done++; if (!ok) this.failed.push(label); this._emit(label); }

  async _json(url) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } finally { clearTimeout(to); }
  }

  async files(id) {
    if (!this.fileCache.has(id)) {
      let p;
      try {
        const k = `ph-files-${id}`;
        const cached = sessionStorage.getItem(k);
        if (cached) p = Promise.resolve(JSON.parse(cached));
      } catch { /* storage unavailable */ }
      if (!p) p = this._json(`${API}/files/${id}`).then((j) => {
        try { sessionStorage.setItem(`ph-files-${id}`, JSON.stringify(j)); } catch { /* ignore */ }
        return j;
      });
      this.fileCache.set(id, p);
    }
    return this.fileCache.get(id);
  }

  async info(id) {
    if (!this.infoCache.has(id)) {
      this.infoCache.set(id, this._json(`${API}/info/${id}`).catch(() => null));
    }
    return this.infoCache.get(id);
  }

  async _credit(id, type) {
    const info = await this.info(id);
    this.credits.set(id, {
      id, type,
      name: info?.name || id,
      authors: info?.authors ? Object.keys(info.authors).join(', ') : 'Poly Haven',
      url: `https://polyhaven.com/a/${id}`,
    });
  }

  // ------------------------------------------------------------------ HDRI
  /**
   * Loads an equirectangular HDRI. Resolves {texture, sunDir, sunColor, fallback}
   */
  async loadHDRI(id, res = '2k') {
    const key = `${id}@${res}`;
    if (this.hdrCache.has(key)) return this.hdrCache.get(key);
    const p = (async () => {
      const label = `HDRI · ${id}`;
      this._begin(label);
      try {
        const f = await this.files(id);
        const entry = f.hdri[res] || f.hdri['1k'];
        const url = entry.hdr.url;
        const tex = await new Promise((resolve, reject) => {
          const to = setTimeout(() => reject(new Error('timeout')), TIMEOUT * 2);
          this.hdrLoader.load(url, (t) => { clearTimeout(to); resolve(t); }, undefined, (e) => { clearTimeout(to); reject(e); });
        });
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        const sun = findSun(tex);
        this._credit(id, 'HDRI');
        this._end(label, true);
        return { texture: tex, ...sun, fallback: false, id };
      } catch (e) {
        console.warn('[TextureLab] HDRI failed, using procedural sky', id, e);
        this._end(label, false);
        return { ...proceduralSky(), fallback: true, id };
      }
    })();
    this.hdrCache.set(key, p);
    return p;
  }

  // ------------------------------------------------------------------ PBR
  /**
   * Loads a PBR set: {map (sRGB), normalMap, arm (AO/Rough/Metal), disp}
   */
  async loadPBR(id, res = '2k', { repeat = 1 } = {}) {
    const key = `${id}@${res}`;
    if (this.texCache.has(key)) return this.texCache.get(key);
    const p = (async () => {
      const label = `PBR · ${id}`;
      this._begin(label);
      try {
        const f = await this.files(id);
        const pick = (k) => (f[k] && (f[k][res] || f[k]['1k']))?.jpg?.url;
        const urls = { map: pick('Diffuse'), normalMap: pick('nor_gl'), arm: pick('arm'), disp: pick('Displacement') };
        const load = (url, srgb) => new Promise((resolve, reject) => {
          if (!url) return resolve(null);
          this.textureLoader.load(url, (t) => {
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = this.maxAniso;
            t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            t.repeat.set(repeat, repeat);
            resolve(t);
          }, undefined, reject);
        });
        const [map, normalMap, arm, disp] = await Promise.all([
          load(urls.map, true), load(urls.normalMap, false), load(urls.arm, false), load(urls.disp, false).catch(() => null),
        ]);
        this._credit(id, 'Texture');
        this._end(label, true);
        return { id, map, normalMap, arm, disp, fallback: false };
      } catch (e) {
        console.warn('[TextureLab] PBR failed, procedural fallback', id, e);
        this._end(label, false);
        return { id, ...proceduralPBR(id), fallback: true };
      }
    })();
    this.texCache.set(key, p);
    return p;
  }

  /** Apply a PBR set to a MeshStandardMaterial */
  static applyPBR(mat, set, repeat = 1) {
    const clone = (t) => { if (!t) return null; const c = t.clone(); c.repeat.set(repeat, repeat); c.needsUpdate = true; return c; };
    mat.map = clone(set.map);
    mat.normalMap = clone(set.normalMap);
    const arm = clone(set.arm);
    mat.aoMap = arm; mat.roughnessMap = arm; mat.metalnessMap = arm;
    mat.roughness = 1; mat.metalness = 1;
    if (set.fallback) { mat.metalness = 0; mat.metalnessMap = null; }
    mat.needsUpdate = true;
    return mat;
  }

  creditList() { return [...this.credits.values()]; }
}

/** Finds the sun as the luminance-weighted centroid of the brightest texels of an equirect HDR */
function findSun(tex) {
  const img = tex.image;
  const { width: w, height: h, data } = img;
  const isHalf = data instanceof Uint16Array;
  const toF = isHalf ? THREE.DataUtils.fromHalfFloat : (x) => x;
  const stride = data.length / (w * h); // 4 (RGBA)
  let maxL = 0, mi = 0;
  const step = Math.max(1, Math.floor(w / 512));
  const lumAt = (i) => 0.2126 * toF(data[i]) + 0.7152 * toF(data[i + 1]) + 0.0722 * toF(data[i + 2]);
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
    const i = (y * w + x) * stride;
    const L = lumAt(i);
    if (L > maxL) { maxL = L; mi = y * w + x; }
  }
  // centroid around peak
  const px = mi % w, py = Math.floor(mi / w);
  let sx = 0, sy = 0, sz = 0, sw = 0, cr = 0, cg = 0, cb = 0;
  const R = Math.max(4, Math.floor(w / 128));
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const x = (px + dx + w) % w, y = Math.min(h - 1, Math.max(0, py + dy));
    const i = (y * w + x) * stride;
    const L = lumAt(i);
    if (L < maxL * 0.3) continue;
    const d = equirectDir(x + 0.5, y + 0.5, w, h);
    sx += d.x * L; sy += d.y * L; sz += d.z * L; sw += L;
    cr += toF(data[i]); cg += toF(data[i + 1]); cb += toF(data[i + 2]);
  }
  const dir = new THREE.Vector3(sx, sy, sz).normalize();
  const col = new THREE.Color(cr, cg, cb);
  const m = Math.max(col.r, col.g, col.b) || 1;
  col.multiplyScalar(1 / m);
  // average sky luminance (ambient) — upper hemisphere
  let aL = 0, n = 0;
  for (let y = 0; y < h / 2; y += step * 4) for (let x = 0; x < w; x += step * 4) { aL += lumAt((y * w + x) * stride); n++; }
  return { sunDir: dir, sunColor: col, sunPeak: maxL, skyLum: aL / Math.max(1, n) };
}

/** three.js equirect convention (EquirectangularReflectionMapping) */
function equirectDir(x, y, w, h) {
  const u = x / w, v = y / h;
  const phi = (u - 0.5) * 2 * Math.PI; // longitude
  const theta = (0.5 - v) * Math.PI;   // latitude
  // three samples equirect with: u = atan(dir.z, dir.x) / (2π) + 0.5
  return new THREE.Vector3(Math.cos(theta) * Math.cos(phi), Math.sin(theta), Math.cos(theta) * Math.sin(phi));
}

// ---------------------------------------------------------------- fallbacks
function proceduralSky() {
  const w = 256, h = 128;
  const data = new Float32Array(w * h * 4);
  const sun = new THREE.Vector3(0.4, 0.25, -0.6).normalize();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = equirectDir(x + 0.5, y + 0.5, w, h);
    const up = Math.max(0, d.y);
    const hor = Math.pow(1 - up, 4);
    const i = (y * w + x) * 4;
    let r = 0.25 + 0.5 * hor, g = 0.38 + 0.4 * hor, b = 0.7 + 0.2 * hor;
    if (d.y < 0) { r = g = b = 0.12; }
    const s = Math.pow(Math.max(0, d.dot(sun)), 900) * 400;
    data[i] = r + s; data[i + 1] = g + s * 0.95; data[i + 2] = b + s * 0.85; data[i + 3] = 1;
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.magFilter = THREE.LinearFilter; tex.flipY = true; tex.needsUpdate = true;
  return { texture: tex, sunDir: sun, sunColor: new THREE.Color(1, 0.95, 0.85), sunPeak: 400, skyLum: 0.5 };
}

const FALLBACK_TINTS = {
  sand: [196, 170, 130], snow: [235, 238, 245], coral: [220, 212, 190], rock: [120, 110, 100],
  metal: [110, 100, 92], plank: [150, 130, 110], roof: [90, 80, 75], concrete: [150, 148, 142], bark: [80, 60, 45],
};
function proceduralPBR(id) {
  const key = Object.keys(FALLBACK_TINTS).find((k) => id.includes(k)) || (id.includes('snow') ? 'snow' : 'sand');
  const [r0, g0, b0] = FALLBACK_TINTS[key] || FALLBACK_TINTS.sand;
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const img = g.createImageData(S, S);
  const n = document.createElement('canvas'); n.width = n.height = S;
  const gn = n.getContext('2d');
  const nimg = gn.createImageData(S, S);
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0, a = 1, f = 1 / 64;
    for (let o = 0; o < 5; o++) { v += a * (Math.sin(x * f * 6.28 + o * 1.7) * Math.cos(y * f * 6.28 + o * 2.3)); a *= 0.5; f *= 2; }
    v = v * 0.5 + (Math.random() - 0.5) * 0.35;
    hgt[y * S + x] = v;
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4, v = hgt[y * S + x];
    img.data[i] = r0 * (0.85 + 0.15 * v); img.data[i + 1] = g0 * (0.85 + 0.15 * v); img.data[i + 2] = b0 * (0.85 + 0.15 * v); img.data[i + 3] = 255;
    const dx = hgt[y * S + ((x + 1) % S)] - v, dy = hgt[((y + 1) % S) * S + x] - v;
    const nv = new THREE.Vector3(-dx * 2, -dy * 2, 1).normalize();
    nimg.data[i] = (nv.x * 0.5 + 0.5) * 255; nimg.data[i + 1] = (nv.y * 0.5 + 0.5) * 255; nimg.data[i + 2] = (nv.z * 0.5 + 0.5) * 255; nimg.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); gn.putImageData(nimg, 0, 0);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace;
  const normalMap = new THREE.CanvasTexture(n);
  for (const t of [map, normalMap]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  // arm: AO=1, rough=0.9, metal=0
  const a = document.createElement('canvas'); a.width = a.height = 4;
  const ga = a.getContext('2d'); ga.fillStyle = `rgb(255, ${key === 'metal' ? 160 : 230}, ${key === 'metal' ? 200 : 0})`; ga.fillRect(0, 0, 4, 4);
  const arm = new THREE.CanvasTexture(a); arm.wrapS = arm.wrapT = THREE.RepeatWrapping;
  return { map, normalMap, arm, disp: null };
}
