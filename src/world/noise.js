/**
 * Deterministic value-noise shared by GLSL and JS.
 * PCG integer hash → identical lattice values on CPU and GPU, so props / cameras can be placed on
 * the exact GPU-displaced terrain. Earth curvature helpers live here too.
 */

export const EARTH_R = 6371000;

export const NOISE_GLSL = /* glsl */ `
uint pcgHash(uint v) {
  uint state = v * 747796405u + 2891336453u;
  uint word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
float hash2i(ivec2 p) {
  uint h = pcgHash(uint(p.x) + pcgHash(uint(p.y)));
  return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  ivec2 ii = ivec2(i);
  float a = hash2i(ii);
  float b = hash2i(ii + ivec2(1, 0));
  float c = hash2i(ii + ivec2(0, 1));
  float d = hash2i(ii + ivec2(1, 1));
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}
float fbm2(vec2 p, int oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 10; i++) {
    if (i >= oct) break;
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(17.13, -9.71);
    a *= 0.5;
  }
  return s;
}
float ridged2(vec2 p, int oct) {
  float s = 0.0, a = 0.5, w = 1.0;
  for (int i = 0; i < 10; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(vnoise(p));
    n *= n;
    s += a * n * w;
    w = clamp(n * 1.6, 0.0, 1.0);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(-5.3, 11.1);
    a *= 0.5;
  }
  return s;
}
`;

// ---------------------------------------------------------------- JS mirror
function pcgHash(v) {
  const state = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const shift = ((state >>> 28) + 4) >>> 0;
  const word = Math.imul(((state >>> shift) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}
function hash2i(x, y) {
  const h = pcgHash(((x | 0) + pcgHash(y | 0)) >>> 0);
  return h / 4294967295;
}
export function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const a = hash2i(ix, iy), b = hash2i(ix + 1, iy), c = hash2i(ix, iy + 1), d = hash2i(ix + 1, iy + 1);
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const ab = a + (b - a) * ux, cd = c + (d - c) * ux;
  return (ab + (cd - ab) * uy) * 2 - 1;
}
export function fbm2(x, y, oct) {
  let s = 0, a = 0.5;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y);
    // GLSL mat2(1.6,1.2,-1.2,1.6) is column-major: [c0=(1.6,1.2), c1=(-1.2,1.6)]
    const nx = 1.6 * x - 1.2 * y + 17.13;
    const ny = 1.2 * x + 1.6 * y - 9.71;
    x = nx; y = ny;
    a *= 0.5;
  }
  return s;
}
export function ridged2(x, y, oct) {
  let s = 0, a = 0.5, w = 1;
  for (let i = 0; i < oct; i++) {
    let n = 1 - Math.abs(vnoise(x, y));
    n *= n;
    s += a * n * w;
    w = Math.min(1, Math.max(0, n * 1.6));
    const nx = 1.6 * x - 1.2 * y - 5.3;
    const ny = 1.2 * x + 1.6 * y + 11.1;
    x = nx; y = ny;
    a *= 0.5;
  }
  return s;
}

/** Vertex chunk that bends world space by Earth curvature (relative to the camera). */
export const CURVATURE_GLSL = /* glsl */ `
uniform vec3 uCamPos;
vec3 applyCurvature(vec3 w) {
  vec2 d = w.xz - uCamPos.xz;
  w.y -= dot(d, d) * ${(1 / (2 * EARTH_R)).toExponential(8)};
  return w;
}
`;
