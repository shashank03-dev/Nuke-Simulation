import * as THREE from 'three';

/**
 * Tileable 3-D cloud noise, baked once on the CPU into a Data3DTexture.
 *  R: Perlin–Worley (billowy base shape, the classic "cauliflower" of a convective cloud)
 *  G: Worley fbm, higher frequency (erosion detail)
 *  B: gradient-ish value fbm (turbulence / displacement)
 *  A: Worley, very high frequency (fine curls for the stem / dust)
 */
export function createCloudNoise(N = 64) {
  const data = new Uint8Array(N * N * N * 4);
  const hash = (x, y, z, s) => {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) + Math.imul(s, 144665)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  // --- Worley (tileable with period P cells) → 1 − distance to nearest feature point
  function worley(x, y, z, P, seed) {
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    let md = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const ix = cx + dx, iy = cy + dy, iz = cz + dz;
      const wx = ((ix % P) + P) % P, wy = ((iy % P) + P) % P, wz = ((iz % P) + P) % P;
      const fx = ix + hash(wx, wy, wz, seed), fy = iy + hash(wx, wy, wz, seed + 1), fz = iz + hash(wx, wy, wz, seed + 2);
      const d = (fx - x) ** 2 + (fy - y) ** 2 + (fz - z) ** 2;
      if (d < md) md = d;
    }
    return 1 - Math.min(1, Math.sqrt(md));
  }
  // --- tileable value noise with period P
  function vnoise(x, y, z, P, seed) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = x - ix, fy = y - iy, fz = z - iz;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
    const H = (a, b, c) => hash(((a % P) + P) % P, ((b % P) + P) % P, ((c % P) + P) % P, seed);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(H(ix, iy, iz), H(ix + 1, iy, iz), u), l(H(ix, iy + 1, iz), H(ix + 1, iy + 1, iz), u), v),
      l(l(H(ix, iy, iz + 1), H(ix + 1, iy, iz + 1), u), l(H(ix, iy + 1, iz + 1), H(ix + 1, iy + 1, iz + 1), u), v), w);
  }
  const remap = (v, a, b, c, d) => c + ((v - a) / (b - a)) * (d - c);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const px = x / N, py = y / N, pz = z / N;
    // value fbm (periods 4, 8, 16)
    let vf = 0, a = 0.5, amp = 0;
    for (let o = 0, P = 4; o < 4; o++, P *= 2) { vf += a * vnoise(px * P, py * P, pz * P, P, 11 + o); amp += a; a *= 0.5; }
    vf /= amp;
    // worley fbm
    const w1 = worley(px * 4, py * 4, pz * 4, 4, 3);
    const w2 = worley(px * 8, py * 8, pz * 8, 8, 5);
    const w3 = worley(px * 16, py * 16, pz * 16, 16, 7);
    const wfbm = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
    // perlin-worley
    const pw = Math.min(1, Math.max(0, remap(vf, wfbm - 1, 1, 0, 1)));
    const w4 = worley(px * 24, py * 24, pz * 24, 24, 9);
    const i = (x + y * N + z * N * N) * 4;
    data[i] = Math.round(pw * 255);
    data[i + 1] = Math.round((w2 * 0.625 + w3 * 0.25 + w4 * 0.125) * 255);
    data[i + 2] = Math.round(vf * 255);
    data[i + 3] = Math.round(w4 * 255);
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
