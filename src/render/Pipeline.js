import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * HDR render pipeline:
 *   scene (MSAA HDR + depth) → volume (half-res raymarch) → composite (shock refraction, heat shimmer,
 *   flash air-light, glare) → bloom (mip chain) → final (exposure / eye adaptation, ACES, grade, grain,
 *   vignette, chromatic aberration, Rapatronic photo mode) → screen
 */

const QUAD_VERT = /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMPOSITE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene, tDepth, tVol;
uniform mat4 uProjInv, uCamWorld;
uniform vec3 uCamPos;
uniform float uNear, uFar, uTime;
uniform vec4 uShock;     // radius, strength, width, burstY
uniform vec4 uHeat;      // fireball uv.x, uv.y, radius(uv), strength
uniform vec3 uBurst;     // world burst point
uniform vec2 uBurstUV;   // its screen position
uniform vec3 uFlash;     // flash radiance scale (rgb)
uniform float uVis;      // visibility (m)
uniform vec2 uRes;
uniform vec2 uVolTexel;

float perspectiveDepthToViewZ(float d, float n, float f) { return (n * f) / ((f - n) * d - f); }
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }

// depth-aware upsample of the half-res volume buffer (avoids halos around the tower / ships)
vec4 volUp(vec2 uv) {
  // tent-filtered upsample: hides the ray-march dither of the half-res volume buffer
  vec2 o = uVolTexel * 0.75;
  vec4 c = texture(tVol, uv) * 0.4;
  c += texture(tVol, uv + vec2(o.x, o.y)) * 0.15;
  c += texture(tVol, uv + vec2(-o.x, o.y)) * 0.15;
  c += texture(tVol, uv + vec2(o.x, -o.y)) * 0.15;
  c += texture(tVol, uv + vec2(-o.x, -o.y)) * 0.15;
  return c;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 vp = uProjInv * vec4(ndc, 1.0, 1.0);
  vec3 vdir = normalize(vp.xyz / vp.w);
  vec3 rd = normalize((uCamWorld * vec4(vdir, 0.0)).xyz);
  float depth = texture(tDepth, vUv).r;
  float viewZ = perspectiveDepthToViewZ(depth, uNear, uFar);
  float tHit = depth >= 0.99999 ? 1e9 : (-viewZ) / max(-vdir.z, 1e-4);

  vec2 uv = vUv;
  vec3 add = vec3(0.0);
  // ---- shock-front refraction: the thin shell of compressed air bends light at its limb
  if (uShock.y > 0.0) {
    vec3 B = vec3(0.0, uShock.w, 0.0);
    vec3 oc = B - uCamPos;
    float tc = dot(oc, rd);
    float dmin = length(oc - rd * tc);
    float camIn = length(oc) - uShock.x; // >0 : camera outside the shell
    if (camIn > 0.0) {
      float w = uShock.z;
      float f = exp(-pow((dmin - uShock.x) / w, 2.0));
      float inner = (1.0 - smoothstep(uShock.x - w * 3.0, uShock.x, dmin)) * 0.35;
      vec3 hit = uCamPos + rd * tc;
      float behind = step(tc, tHit + uShock.x);
      float above = smoothstep(-20.0, 30.0, hit.y);
      vec2 dir = normalize(vUv - uBurstUV + 1e-5);
      float s = (f + inner * 0.3) * uShock.y * behind * above;
      uv += dir * s * 0.006;
      add += vec3(0.9, 0.92, 0.95) * f * uShock.y * behind * above * 0.015;
    }
  }
  // ---- heat shimmer above the fireball / hot ground
  if (uHeat.w > 0.0) {
    float d = length((vUv - uHeat.xy) * vec2(uRes.x / uRes.y, 1.0));
    float mask = exp(-pow(d / (uHeat.z * 1.6 + 0.02), 2.0));
    vec2 n = vec2(vn(vUv * 90.0 + vec2(0.0, uTime * 6.0)), vn(vUv * 90.0 + vec2(17.0, uTime * 5.0))) - 0.5;
    uv += n * uHeat.w * mask * 0.006;
  }
  vec3 scene = texture(tScene, uv).rgb;
  vec4 vol = volUp(uv);
  vec3 col = scene * vol.a + vol.rgb;

  // ---- flash air-light: the air itself scatters the fireball's light toward the eye
  if (dot(uFlash, uFlash) > 0.0) {
    vec3 toB = normalize(uBurst - uCamPos);
    float cosA = dot(rd, toB);
    float path = min(tHit, uVis * 3.0);
    float scat = 1.0 - exp(-path / uVis);
    float g = 0.75;
    float ph = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosA, 1.5) * 0.08 + 0.05;
    col += uFlash * scat * ph;
    // glare / veiling luminance in the eye
    float ang = acos(clamp(cosA, -1.0, 1.0));
    col += uFlash * 0.0006 / (ang * ang + 0.0004);
  }
  col += add;
  gl_FragColor = vec4(col, 1.0);
}
`;

const BRIGHT_FRAG = /* glsl */ `
precision highp float; varying vec2 vUv; uniform sampler2D tIn; uniform float uThreshold; uniform vec2 uTexel;
void main() {
  vec3 c = vec3(0.0);
  c += texture(tIn, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(tIn, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture(tIn, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture(tIn, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float l = max(max(c.r, c.g), c.b);
  float k = max(0.0, l - uThreshold) / max(l, 1e-4);
  gl_FragColor = vec4(min(c * k, vec3(4000.0)), 1.0);
}`;
const DOWN_FRAG = /* glsl */ `
precision highp float; varying vec2 vUv; uniform sampler2D tIn; uniform vec2 uTexel;
void main() {
  vec3 c = texture(tIn, vUv).rgb * 4.0;
  c += texture(tIn, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(tIn, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture(tIn, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture(tIn, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;
const UP_FRAG = /* glsl */ `
precision highp float; varying vec2 vUv; uniform sampler2D tIn; uniform sampler2D tPrev; uniform vec2 uTexel; uniform float uMix;
void main() {
  vec3 c = vec3(0.0);
  c += texture(tIn, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
  c += texture(tIn, vUv + uTexel * vec2( 1.0, 0.0)).rgb * 2.0;
  c += texture(tIn, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
  c += texture(tIn, vUv + uTexel * vec2(0.0,  1.0)).rgb * 2.0;
  c += texture(tIn, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture(tIn, vUv + uTexel * vec2( 1.0, -1.0)).rgb;
  c += texture(tIn, vUv + uTexel * vec2(-1.0,  1.0)).rgb;
  c += texture(tIn, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c /= 12.0;
  gl_FragColor = vec4(texture(tPrev, vUv).rgb + c * uMix, 1.0);
}`;

const FINAL_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tHDR, tBloom;
uniform float uExposure, uBloom, uTime, uGrain, uVignette, uCA, uPhoto, uWhite, uSat;
uniform vec3 uLift, uGain;
uniform vec2 uRes;

vec3 RRTAndODTFit(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 ACES(vec3 c) {
  const mat3 IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = IN * c; c = RRTAndODTFit(c); c = OUT * c; return clamp(c, 0.0, 1.0);
}
float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec2 uv = vUv;
  vec2 d = uv - 0.5;
  // chromatic aberration grows with the flash
  float ca = uCA * (0.002 + dot(d, d) * 0.01);
  vec3 hdr;
  hdr.r = texture(tHDR, uv - d * ca).r;
  hdr.g = texture(tHDR, uv).g;
  hdr.b = texture(tHDR, uv + d * ca).b;
  vec3 bloom = texture(tBloom, uv).rgb;
  vec3 c = hdr + bloom * uBloom;
  c *= uExposure;
  c += uWhite;
  c = ACES(c * 0.6);
  // grade
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat);
  c = c * uGain + uLift * (1.0 - c);
  if (uPhoto > 0.5) {
    // Rapatronic: orthochromatic-ish monochrome, crushed blacks, hard contrast, heavy grain
    float m = dot(c, vec3(0.1, 0.5, 0.4));
    m = smoothstep(0.08, 0.92, m);
    m = pow(m, 1.35);
    c = vec3(m) * vec3(1.0, 0.985, 0.95);
  }
  // vignette
  float v = 1.0 - dot(d * vec2(uRes.x / uRes.y, 1.0), d * vec2(uRes.x / uRes.y, 1.0)) * uVignette;
  c *= clamp(v, 0.0, 1.0);
  c = toSRGB(clamp(c, 0.0, 1.0));
  // film grain (applied in display space, luminance-weighted)
  float g = h(uv * uRes + fract(uTime * 37.0) * 100.0) - 0.5;
  c += g * uGrain * (0.6 + 0.4 * (1.0 - dot(c, vec3(0.333))));
  gl_FragColor = vec4(c, 1.0);
}`;

export class Pipeline {
  constructor(renderer) {
    this.renderer = renderer;
    this.w = 2; this.h = 2;
    this.samples = 4;
    this.sceneRT = this._makeSceneRT();
    this.hdrRT = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
    this.bloomLevels = 6;
    this.bloomDown = [];
    this.bloomUp = [];
    for (let i = 0; i < this.bloomLevels; i++) {
      this.bloomDown.push(new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false }));
      this.bloomUp.push(new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false }));
    }
    const mk = (frag, uniforms) => new FullScreenQuad(new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false }));
    this.composite = mk(COMPOSITE_FRAG, {
      tScene: { value: null }, tDepth: { value: null }, tVol: { value: null },
      uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uNear: { value: 1 }, uFar: { value: 1 }, uTime: { value: 0 },
      uShock: { value: new THREE.Vector4() }, uHeat: { value: new THREE.Vector4() },
      uBurst: { value: new THREE.Vector3() }, uBurstUV: { value: new THREE.Vector2() }, uFlash: { value: new THREE.Vector3() }, uVis: { value: 40000 },
      uRes: { value: new THREE.Vector2() }, uVolTexel: { value: new THREE.Vector2() },
    });
    this.bright = mk(BRIGHT_FRAG, { tIn: { value: null }, uThreshold: { value: 1.0 }, uTexel: { value: new THREE.Vector2() } });
    this.down = mk(DOWN_FRAG, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.up = mk(UP_FRAG, { tIn: { value: null }, tPrev: { value: null }, uTexel: { value: new THREE.Vector2() }, uMix: { value: 1 } });
    this.final = mk(FINAL_FRAG, {
      tHDR: { value: null }, tBloom: { value: null },
      uExposure: { value: 1 }, uBloom: { value: 0.06 }, uTime: { value: 0 }, uGrain: { value: 0.035 }, uVignette: { value: 0.35 },
      uCA: { value: 0.3 }, uPhoto: { value: 0 }, uWhite: { value: 0 }, uSat: { value: 1 },
      uLift: { value: new THREE.Vector3(0.0, 0.0, 0.0) }, uGain: { value: new THREE.Vector3(1, 1, 1) },
      uRes: { value: new THREE.Vector2() },
    });
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    this.black.needsUpdate = true;
  }

  _makeSceneRT() {
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples: this.samples });
    rt.depthTexture = new THREE.DepthTexture(2, 2);
    rt.depthTexture.type = THREE.FloatType;
    rt.depthTexture.format = THREE.DepthFormat;
    return rt;
  }

  setSamples(n) {
    if (n === this.samples) return;
    this.samples = n;
    this.sceneRT.dispose();
    this.sceneRT = this._makeSceneRT();
    this.sceneRT.setSize(this.w, this.h);
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.sceneRT.setSize(w, h);
    this.hdrRT.setSize(w, h);
    let bw = Math.max(2, w >> 1), bh = Math.max(2, h >> 1);
    for (let i = 0; i < this.bloomLevels; i++) {
      this.bloomDown[i].setSize(bw, bh);
      this.bloomUp[i].setSize(bw, bh);
      bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1);
    }
    this.composite.material.uniforms.uRes.value.set(w, h);
    this.final.material.uniforms.uRes.value.set(w, h);
  }

  /**
   * @param fx {shock, heat, burst, flash, visibility, exposure, bloom, ca, photo, white, grade}
   */
  render(scene, camera, volume, fx, time) {
    const r = this.renderer;
    // 1. scene
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(scene, camera);
    // 2. volume
    volume.render(r, camera, this.sceneRT.depthTexture);
    // 3. composite
    const C = this.composite.material.uniforms;
    C.tScene.value = this.sceneRT.texture;
    C.tDepth.value = this.sceneRT.depthTexture;
    C.tVol.value = volume.target.texture;
    C.uVolTexel.value.set(1 / volume.target.width, 1 / volume.target.height);
    C.uProjInv.value.copy(camera.projectionMatrixInverse);
    C.uCamWorld.value.copy(camera.matrixWorld);
    C.uCamPos.value.copy(camera.position);
    C.uNear.value = camera.near; C.uFar.value = camera.far;
    C.uTime.value = time;
    C.uShock.value.copy(fx.shock);
    C.uHeat.value.copy(fx.heat);
    C.uBurst.value.copy(fx.burst);
    C.uBurstUV.value.copy(fx.burstUV);
    C.uFlash.value.copy(fx.flash);
    C.uVis.value = fx.visibility;
    r.setRenderTarget(this.hdrRT);
    this.composite.render(r);
    // 4. bloom
    let src = this.hdrRT.texture;
    let sw = this.w, sh = this.h;
    this.bright.material.uniforms.tIn.value = src;
    this.bright.material.uniforms.uThreshold.value = fx.bloomThreshold ?? 1.0;
    this.bright.material.uniforms.uTexel.value.set(1 / sw, 1 / sh);
    r.setRenderTarget(this.bloomDown[0]);
    this.bright.render(r);
    for (let i = 1; i < this.bloomLevels; i++) {
      const s = this.bloomDown[i - 1];
      this.down.material.uniforms.tIn.value = s.texture;
      this.down.material.uniforms.uTexel.value.set(1 / s.width, 1 / s.height);
      r.setRenderTarget(this.bloomDown[i]);
      this.down.render(r);
    }
    // upsample: up[L-1] = down[L-1]; up[i] = down[i] + blur(up[i+1])
    let prev = this.bloomDown[this.bloomLevels - 1];
    for (let i = this.bloomLevels - 2; i >= 0; i--) {
      this.up.material.uniforms.tIn.value = prev.texture;
      this.up.material.uniforms.tPrev.value = this.bloomDown[i].texture;
      this.up.material.uniforms.uTexel.value.set(1 / prev.width, 1 / prev.height);
      this.up.material.uniforms.uMix.value = 1.0;
      r.setRenderTarget(this.bloomUp[i]);
      this.up.render(r);
      prev = this.bloomUp[i];
    }
    // 5. final
    const F = this.final.material.uniforms;
    F.tHDR.value = this.hdrRT.texture;
    F.tBloom.value = this.bloomUp[0].texture;
    F.uExposure.value = fx.exposure;
    F.uBloom.value = fx.bloom;
    F.uTime.value = time;
    F.uCA.value = fx.ca;
    F.uPhoto.value = fx.photo ? 1 : 0;
    F.uWhite.value = fx.white;
    F.uGrain.value = fx.photo ? 0.09 : fx.grain ?? 0.03;
    F.uVignette.value = fx.photo ? 0.9 : 0.35;
    F.uSat.value = fx.saturation ?? 1;
    if (fx.lift) F.uLift.value.copy(fx.lift);
    if (fx.gain) F.uGain.value.copy(fx.gain);
    r.setRenderTarget(null);
    this.final.render(r);
  }
}
