import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import MANIFEST from './manifest.json';

/**
 * TextureLab — CC0 HDRIs and PBR material sets from Poly Haven (https://polyhaven.com).
 *
 * Fast start without losing quality:
 *  • URLs come from a manifest resolved at dev time (scripts/prepare-assets.mjs), so the browser goes
 *    straight to the dl.polyhaven.org CDN instead of making two API round-trips per asset.
 *  • Every PBR map first appears as a 512 px WebP preview (~200 KB per material). The original
 *    Poly Haven 1k/2k JPEGs then stream in the background and replace the preview in place, so the
 *    final image is the full-resolution original.
 *  • HDRIs appear at 1k first and upgrade to the quality preset's resolution.
 *  • Images are decoded off the main thread (createImageBitmap) and uploads are spread over frames.
 * Anything missing from the manifest falls back to the live Poly Haven API, then to procedural textures.
 */
const API = 'https://api.polyhaven.com';
const TIMEOUT = 25000;
const MAP_KEYS = { map: 'Diffuse', normalMap: 'nor_gl', arm: 'arm' };

async function fetchBitmap(url, signal) {
  const r = await fetch(url, { signal, mode: 'cors' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const blob = await r.blob();
  return createImageBitmap(blob, { imageOrientation: 'flipY', colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
}

export class TextureLab {
  constructor(renderer) {
    this.renderer = renderer;
    this.maxAniso = renderer.capabilities.getMaxAnisotropy();
    this.fileCache = new Map();
    this.texCache = new Map();
    this.hdrCache = new Map();
    this.hdrUpgrades = new Map();
    this.credits = new Map(); // id -> {name, authors, type}
    this.listeners = new Set();
    this.upgradeListeners = new Set();
    this.pending = 0;
    this.done = 0;
    this.failed = [];
    this.hdrLoader = new HDRLoader();
    this.hdrLoader.setDataType(THREE.HalfFloatType);
    this.queue = [];          // background full-resolution upgrades
    this.ready = [];          // decoded upgrades waiting for a frame to upload
    this.active = 0;
    this.upgradesEnabled = false;
  }

  onProgress(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onHDRIUpgrade(fn) { this.upgradeListeners.add(fn); return () => this.upgradeListeners.delete(fn); }
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

  /** Live API fallback for assets that are not in the manifest */
  async files(id) {
    if (!this.fileCache.has(id)) this.fileCache.set(id, this._json(`${API}/files/${id}`));
    return this.fileCache.get(id);
  }

  _credit(id, type, entry) {
    this.credits.set(id, { id, type, name: entry?.name || id, authors: entry?.authors || 'Poly Haven', url: `https://polyhaven.com/a/${id}` });
  }

  // ------------------------------------------------------------------ background upgrades
  /** Start streaming full-resolution originals (call once the first frame is on screen). */
  startUpgrades() { this.upgradesEnabled = true; this._pump(); }

  _enqueue(job) { this.queue.push(job); this._pump(); }

  _pump() {
    if (!this.upgradesEnabled) return;
    while (this.active < 3 && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      job.fetch()
        .then((data) => { this.ready.push({ job, data }); })
        .catch((e) => console.warn('[TextureLab] upgrade failed', job.label, e))
        .finally(() => { this.active--; this._pump(); });
    }
  }

  /** Called once per frame: upload at most one decoded upgrade so the frame rate never hitches. */
  tick() {
    const item = this.ready.shift();
    if (item) item.job.apply(item.data);
    return this.queue.length + this.ready.length + this.active;
  }

  // ------------------------------------------------------------------ HDRI
  _loadHDR(url) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('timeout')), TIMEOUT * 2);
      this.hdrLoader.load(url, (t) => { clearTimeout(to); resolve(t); }, undefined, (e) => { clearTimeout(to); reject(e); });
    });
  }

  /**
   * Loads an equirectangular HDRI. Resolves quickly with the 1k version; when `res` is higher the full
   * version streams in the background and is announced through onHDRIUpgrade(fn).
   * Resolves {texture, sunDir, sunColor, fallback, id}
   */
  async loadHDRI(id, res = '2k') {
    if (this.hdrCache.has(id)) {
      this._scheduleHDRUpgrade(id, res);
      return this.hdrCache.get(id);
    }
    const p = (async () => {
      const label = `HDRI · ${id}`;
      this._begin(label);
      try {
        const m = MANIFEST.hdris[id];
        let url1k;
        if (m) { url1k = m.res['1k']; this._credit(id, 'HDRI', m); }
        else { const f = await this.files(id); url1k = f.hdri['1k'].hdr.url; this._credit(id, 'HDRI'); }
        const tex = await this._loadHDR(url1k);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        const sun = findSun(tex);
        this._end(label, true);
        return { texture: tex, ...sun, fallback: false, id, res: '1k' };
      } catch (e) {
        console.warn('[TextureLab] HDRI failed, using procedural sky', id, e);
        this._end(label, false);
        return { ...proceduralSky(), fallback: true, id, res: '1k' };
      }
    })();
    this.hdrCache.set(id, p);
    p.then((r) => { if (!r.fallback) this._scheduleHDRUpgrade(id, res); });
    return p;
  }

  _scheduleHDRUpgrade(id, res) {
    if (res === '1k') return;
    const key = `${id}@${res}`;
    if (this.hdrUpgrades.has(key)) {
      const done = this.hdrUpgrades.get(key);
      if (done !== true) return;
      // already upgraded: re-announce so a re-applied sky picks the sharp version
      const tex = this._hdrFull.get(key);
      if (tex) for (const fn of this.upgradeListeners) fn(id, tex);
      return;
    }
    this.hdrUpgrades.set(key, 'queued');
    this._hdrFull ||= new Map();
    this._enqueue({
      label: `HDRI ${id} ${res}`,
      fetch: async () => {
        const m = MANIFEST.hdris[id];
        const url = m ? (m.res[res] || m.res['2k']) : (await this.files(id)).hdri[res].hdr.url;
        return this._loadHDR(url);
      },
      apply: (tex) => {
        tex.mapping = THREE.EquirectangularReflectionMapping;
        tex.colorSpace = THREE.LinearSRGBColorSpace;
        this.hdrUpgrades.set(key, true);
        this._hdrFull.set(key, tex);
        for (const fn of this.upgradeListeners) fn(id, tex);
      },
    });
  }

  // ------------------------------------------------------------------ PBR
  _makeTex(bitmap, srgb) {
    const t = new THREE.Texture(bitmap);
    t.flipY = false; // already flipped at decode time (ImageBitmap)
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = this.maxAniso;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  }

  /** Swap a texture's pixels for a higher-resolution image (dimensions change → reallocate). */
  _swap(tex, bitmap) {
    const old = tex.image;
    tex.dispose();
    tex.image = bitmap;
    tex.needsUpdate = true;
    if (old && old.close) setTimeout(() => old.close(), 2000);
  }

  /**
   * Loads a PBR set: {map (sRGB), normalMap, arm (AO/Rough/Metal)}.
   * Resolves as soon as the previews are decoded; full-resolution maps replace them in place.
   */
  async loadPBR(id, res = '2k') {
    if (this.texCache.has(id)) { this._scheduleUpgrade(id, res); return this.texCache.get(id); }
    const p = (async () => {
      const label = `PBR · ${id}`;
      this._begin(label);
      try {
        const m = MANIFEST.textures[id];
        const set = { id, fallback: false, res: 'preview' };
        if (m) {
          this._credit(id, 'Texture', m);
          const bms = await Promise.all(Object.keys(MAP_KEYS).map((k) => fetchBitmap(m.maps[k].preview)));
          Object.keys(MAP_KEYS).forEach((k, i) => { set[k] = this._makeTex(bms[i], k === 'map'); });
        } else {
          const f = await this.files(id);
          this._credit(id, 'Texture');
          const bms = await Promise.all(Object.entries(MAP_KEYS).map(([, k]) => fetchBitmap(f[k]['1k'].jpg.url)));
          Object.keys(MAP_KEYS).forEach((k, i) => { set[k] = this._makeTex(bms[i], k === 'map'); });
          set.res = '1k';
        }
        this._end(label, true);
        return set;
      } catch (e) {
        console.warn('[TextureLab] PBR failed, procedural fallback', id, e);
        this._end(label, false);
        return { id, ...proceduralPBR(id), fallback: true, res: 'fallback' };
      }
    })();
    this.texCache.set(id, p);
    p.then((set) => { if (!set.fallback) this._scheduleUpgrade(id, res); });
    return p;
  }

  _scheduleUpgrade(id, res) {
    const order = ['preview', '1k', '2k', '4k'];
    this._texTarget ||= new Map();
    const cur = this._texTarget.get(id) || 'preview';
    if (order.indexOf(res) <= order.indexOf(cur)) return;
    this._texTarget.set(id, res);
    this.texCache.get(id).then((set) => {
      for (const k of Object.keys(MAP_KEYS)) {
        this._enqueue({
          label: `${id} ${k} ${res}`,
          fetch: async () => {
            const m = MANIFEST.textures[id];
            const url = m ? (m.maps[k][res] || m.maps[k]['2k']) : (await this.files(id))[MAP_KEYS[k]][res].jpg.url;
            return fetchBitmap(url);
          },
          apply: (bitmap) => {
            // a later request may have asked for a different resolution; ignore stale results
            if (this._texTarget.get(id) !== res) { bitmap.close?.(); return; }
            this._swap(set[k], bitmap);
            set.res = res;
          },
        });
      }
    });
  }

  /** Apply a PBR set to a MeshStandardMaterial (textures are shared, so upgrades reach every user). */
  static applyPBR(mat, set) {
    mat.map = set.map;
    mat.normalMap = set.normalMap;
    mat.aoMap = set.arm; mat.roughnessMap = set.arm; mat.metalnessMap = set.arm;
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
  // (clamped so the sun disc itself does not dominate the average)
  for (let y = 0; y < h / 2; y += step * 2) for (let x = 0; x < w; x += step * 2) { aL += Math.min(8, lumAt((y * w + x) * stride)); n++; }
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
