/**
 * Prepares the Poly Haven asset manifest + tiny first-paint previews.
 *
 *   node scripts/prepare-assets.mjs
 *
 * - Resolves every texture/HDRI the app uses through the Poly Haven API once, at dev time, and writes
 *   src/assets/manifest.json (download URLs per resolution + credits). The browser then skips ~40
 *   serial API round-trips and goes straight to the CDN.
 * - Writes 512 px WebP previews of each PBR map to public/ph/ so the scene can render within a second;
 *   the full-resolution originals still stream from dl.polyhaven.org and replace them in place.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { ENVIRONMENTS, SKY_PRESETS } from '../src/physics/scenarios.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT_PUBLIC = path.join(ROOT, 'public', 'ph');
const OUT_MANIFEST = path.join(ROOT, 'src', 'assets', 'manifest.json');
const API = 'https://api.polyhaven.com';
const PROP_TEXTURES = ['rusty_metal', 'concrete_wall_008', 'weathered_plank_siding', 'roof_07', 'rusty_painted_metal', 'bark_brown_02'];
const MAPS = { Diffuse: 'map', nor_gl: 'normalMap', arm: 'arm' };
const PREVIEW = 512;

const json = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return r.json(); };
const buf = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${r.status} ${u}`); return Buffer.from(await r.arrayBuffer()); };

const textures = new Set(PROP_TEXTURES);
for (const e of Object.values(ENVIRONMENTS)) for (const id of Object.values(e.textures)) textures.add(id);
const hdris = new Set(Object.values(ENVIRONMENTS).map((e) => e.hdri));
for (const s of SKY_PRESETS) if (s.id !== 'scenario') hdris.add(s.id);

await fs.mkdir(OUT_PUBLIC, { recursive: true });
const manifest = { generated: new Date().toISOString(), textures: {}, hdris: {} };

for (const id of textures) {
  const [files, info] = await Promise.all([json(`${API}/files/${id}`), json(`${API}/info/${id}`)]);
  const entry = { name: info.name, authors: Object.keys(info.authors || {}).join(', '), maps: {} };
  for (const [k, key] of Object.entries(MAPS)) {
    const res = {};
    for (const r of ['1k', '2k', '4k']) if (files[k]?.[r]?.jpg) res[r] = files[k][r].jpg.url;
    // preview: downscale the 1k original (sRGB-agnostic resize; normals renormalised by the GPU sampler)
    const src = await buf(res['1k']);
    const out = path.join(OUT_PUBLIC, `${id}_${key}.webp`);
    await sharp(src).resize(PREVIEW, PREVIEW).webp({ quality: key === 'normalMap' ? 92 : 85, effort: 6 }).toFile(out);
    res.preview = `/ph/${id}_${key}.webp`;
    entry.maps[key] = res;
  }
  manifest.textures[id] = entry;
  console.log('texture', id);
}
for (const id of hdris) {
  const [files, info] = await Promise.all([json(`${API}/files/${id}`), json(`${API}/info/${id}`)]);
  const res = {};
  for (const r of ['1k', '2k', '4k']) if (files.hdri?.[r]?.hdr) res[r] = files.hdri[r].hdr.url;
  manifest.hdris[id] = { name: info.name, authors: Object.keys(info.authors || {}).join(', '), res };
  console.log('hdri', id);
}
await fs.writeFile(OUT_MANIFEST, JSON.stringify(manifest, null, 1));
const bytes = (await fs.readdir(OUT_PUBLIC)).length;
console.log(`manifest: ${Object.keys(manifest.textures).length} textures, ${Object.keys(manifest.hdris).length} hdris, ${bytes} preview files`);
