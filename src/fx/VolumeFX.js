import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { blackbodyRGB } from '../physics/effects.js';
import { createCloudNoise } from './noise3d.js';
import { EARTH_R } from '../world/noise.js';

/**
 * VolumeFX — half-resolution ray-marched participating media.
 *
 * Renders, depth-tested against the opaque scene:
 *   • the fireball (blackbody emission from the Detonation temperature history, mottled surface,
 *     "rope-trick" spikes along tower guy-wires in the first milliseconds)
 *   • its morph into the rising toroidal cap with poloidal circulation (the roll of the mushroom)
 *   • the stem (afterwind updraft, twisted, dust-laden), the ground dust skirt
 *   • the Wilson condensation cloud (thin shell behind the shock in humid air) and stem collars
 *   • Crossroads Baker: spray dome, hollow water column, cauliflower head, base surge
 * Lighting: sun single-scattering with a short shadow march, "powder" term, sky ambient,
 * illumination from the fireball itself, and aerial perspective.
 * Output: rgb = in-scattered + emitted radiance, a = transmittance.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform sampler3D tNoise;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uNear, uFar;
uniform float uTime;
uniform int uSteps;
uniform vec3 uSunDir, uSunCol, uAmbTop, uAmbBot;
uniform vec3 uFogCol; uniform float uFogDen;
uniform vec4 uBound;   // radius, top, bottom, active
uniform vec4 uFire;    // centerY, radius, morph, visible
uniform vec4 uCap;     // Rt, tube, flatten, spin
uniform vec3 uFireEmit;
uniform vec3 uGlowEmit;
uniform vec3 uFireLight;
uniform vec4 uStem;    // radius, topY, strength, baseY
uniform vec4 uSkirt;   // radius, height, strength, _
uniform vec4 uWilson;  // radius, thickness, opacity, centerY
uniform vec4 uCollar;  // y1, y2, radius, strength
uniform vec4 uBakerA;  // columnH, columnR, strength, domeR
uniform vec4 uBakerB;  // surgeR, surgeH, surgeStrength, headR
uniform vec4 uBakerC;  // domeStrength, headStrength, on, _
uniform vec3 uAlbCap, uAlbStem, uAlbSkirt;
uniform vec4 uRope;    // strength, length factor, hob, _
uniform vec4 uSigma;   // cap, stem, skirt, wilson extinction per metre
uniform float uCurv;

// smoothstep that is well defined for reversed edges
float ss(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }
vec4 N3(vec3 p) { return texture(tNoise, p); }

float perspectiveDepthToViewZ(float d, float n, float f) { return (n * f) / ((f - n) * d - f); }

// returns extinction-weighted density components through out params
void medium(vec3 p, out float sig, out vec3 alb, out vec3 emit) {
  sig = 0.0; alb = vec3(0.0); emit = vec3(0.0);
  float wsum = 0.0;

  // ---------------------------------------------------------------- fireball / cap
  if (uFire.w > 0.0) {
    vec3 c = p - vec3(0.0, uFire.x, 0.0);
    float Rf = uFire.y, m = uFire.z;
    float R = uCap.x, r = uCap.y;
    float scale = mix(Rf, r, m);
    float bound = max(Rf, R + r) * 1.6 + scale;
    if (dot(c, c) < bound * bound) {
      float dS = length(c) - Rf;
      vec2 q = vec2(length(c.xz) - R, c.y / uCap.z);
      float dT = length(q) - r;
      vec3 e = c - vec3(0.0, r * 0.3, 0.0);
      vec3 rad = vec3(R + r * 0.85, r * 0.8 * uCap.z + r * 0.25, R + r * 0.85);
      float dD = (length(e / rad) - 1.0) * min(rad.y, rad.x);
      float dCap = smin(dT, dD, r * 0.55);
      float d = mix(dS, dCap, m);
      // poloidal roll: rotate the noise lookup around the tube so the cap visibly churns
      vec2 dir = c.xz / max(length(c.xz), 1e-3);
      vec2 qr = rot(uCap.w) * q;
      vec3 pc = vec3(dir.x * (R + qr.x), qr.y * uCap.z, dir.y * (R + qr.x));
      vec3 np = mix(c, pc, m) / scale;
      vec4 n1 = N3(np * 0.85 + vec3(0.13, uTime * 0.002, 0.71));
      vec4 n2 = N3(np * 2.3 + vec3(0.41, 0.2, 0.05));
      vec4 n3 = N3(np * 4.1 + vec3(0.7, 0.1, 0.3));
      float billow = (n1.r - 0.5) * 1.0 + (n2.g - 0.5) * 0.5 + (n3.a - 0.5) * 0.14;
      // billows: displacement proportional to the tube size but bounded so the cap keeps its flattened form
      d -= billow * scale * mix(0.14, 0.26, m);
      float soft = scale * mix(0.035, 0.055, m);
      float dens = ss(0.0, soft, -d);
      if (dens > 0.0) {
        float inner = clamp(-d / scale, 0.0, 1.0);
        float s = mix(0.3, 1.0, m) * dens;
        // hot fireball emission: limb darkening + mottling, plus the NO2-tinted glowing core later
        vec3 fe = uFireEmit * (0.55 + 0.9 * inner) * (0.75 + 0.5 * n2.g) * (1.0 - m * 0.85);
        vec3 ge = uGlowEmit * pow(inner, 1.5) * (0.4 + 1.2 * n1.r);
        float sg = uSigma.x * s * mix(12.0, 1.0, ss(0.0, 0.25, m));
        // emission coefficient = extinction × radiance, so an optically thick region shows exactly fe/ge
        emit += (fe + ge) * sg;
        sig += sg; alb += uAlbCap * sg; wsum += sg;
      }
      // rope tricks: guy-wires flash to plasma ahead of the fireball
      if (uRope.x > 0.0) {
        for (int i = 0; i < 4; i++) {
          float a = float(i) * 1.5708 + 0.785;
          vec3 wdir = normalize(vec3(cos(a), -1.05, sin(a)));
          float tl = dot(c, wdir);
          if (tl > 0.0 && tl < Rf * uRope.y) {
            float dl = length(c - wdir * tl);
            float rr = Rf * 0.07 * (1.0 - tl / (Rf * uRope.y) * 0.6);
            float sp = ss(rr, rr * 0.4, dl) * uRope.x;
            emit += uFireEmit * 1.1 * uSigma.x * 12.0 * sp;
            sig += uSigma.x * 12.0 * sp; alb += uAlbCap * uSigma.x * sp; wsum += uSigma.x * sp;
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------- stem
  if (uStem.z > 0.0) {
    float yb = uStem.w, yt = uStem.y;
    float rs = uStem.x;
    if (p.y > yb - 20.0 && p.y < yt + rs * 2.0 && dot(p.xz, p.xz) < rs * rs * 16.0) {
      float yn = clamp((p.y - yb) / max(yt - yb, 1.0), 0.0, 1.0);
      float rad = rs * (0.7 + 1.3 * ss(0.72, 1.0, yn) + 0.9 * (1.0 - ss(0.0, 0.1, yn)));
      float ang = p.y / rs * 0.35 - uTime * 0.05;
      vec3 sp = vec3(rot(ang) * p.xz, p.y - uTime * rs * 0.04).xzy / rs;
      vec4 n = N3(sp * 0.7 + vec3(0.5, 0.0, 0.2));
      vec4 n2 = N3(sp * 2.2);
      float d = length(p.xz) - rad * (0.65 + 0.6 * n.r + 0.25 * n2.a);
      float dens = ss(0.0, rad * 0.2, -d);
      dens *= ss(yt + rs * 1.2, yt - rs * 0.5, p.y) * uStem.z;
      if (dens > 0.0) {
        float sg = uSigma.y * dens;
        sig += sg; alb += uAlbStem * sg; wsum += sg;
      }
    }
  }

  // ---------------------------------------------------------------- dust skirt
  if (uSkirt.z > 0.0) {
    float Rk = uSkirt.x, h = uSkirt.y;
    if (p.y < h * 2.2 && dot(p.xz, p.xz) < Rk * Rk * 1.7) {
      vec3 sp = p / h;
      vec4 n = N3(sp * 0.12 + vec3(0.3, -uTime * 0.01, 0.9));
      vec4 n2 = N3(sp * 0.5);
      float rr = length(p.xz) / Rk;
      float top = h * (0.35 + 0.8 * n.r) * (1.0 - rr * 0.55) + h * 0.9 * (1.0 - ss(0.0, 0.25, rr));
      float e = max(rr - (0.85 + 0.25 * n2.g), (p.y - top) / h);
      float dens = ss(0.1, -0.25, e) * uSkirt.z;
      if (dens > 0.0) {
        float sg = uSigma.z * dens;
        sig += sg; alb += uAlbSkirt * sg; wsum += sg;
      }
    }
  }

  // ---------------------------------------------------------------- Wilson cloud (condensation shell)
  if (uWilson.z > 0.0) {
    vec3 c = p - vec3(0.0, uWilson.w, 0.0);
    float rr = length(c);
    float th = uWilson.y;
    if (abs(rr - uWilson.x) < th * 2.0 && p.y > -5.0) {
      vec3 sp = c / uWilson.x;
      vec4 n = N3(sp * 1.6 + 0.3);
      float d = abs(rr - uWilson.x + (n.r - 0.5) * th * 1.4) - th * (0.4 + 0.8 * n.g);
      float dens = ss(0.0, -th * 0.5, d) * uWilson.z;
      // striations & fading at the base
      dens *= 0.6 + 0.4 * N3(vec3(sp.xz * 3.0, sp.y * 16.0)).g;
      if (dens > 0.0) {
        float sg = uSigma.w * dens;
        sig += sg; alb += vec3(0.95) * sg; wsum += sg;
      }
    }
  }

  // ---------------------------------------------------------------- condensation collars around the stem
  if (uCollar.w > 0.0) {
    for (int i = 0; i < 2; i++) {
      float y = i == 0 ? uCollar.x : uCollar.y;
      float R = uCollar.z * (i == 0 ? 1.0 : 1.25);
      vec2 q = vec2(length(p.xz) - R * 0.7, (p.y - y) * 3.5);
      vec4 n = N3(p / R * 1.6 + float(i) * 0.37);
      float d = length(q) - R * (0.2 + 0.45 * n.r);
      float dens = ss(0.0, -R * 0.2, d) * uCollar.w;
      if (dens > 0.0) {
        float sg = uSigma.w * 1.5 * dens;
        sig += sg; alb += vec3(0.97) * sg; wsum += sg;
      }
    }
  }

  // ---------------------------------------------------------------- Crossroads Baker
  if (uBakerC.z > 0.0) {
    float H = uBakerA.x, Rc = uBakerA.y;
    vec3 wat = vec3(0.86, 0.88, 0.9);
    // spray dome
    if (uBakerA.w > 0.0) {
      float rr = length(p);
      vec4 n = N3(p / uBakerA.w * 0.8);
      float d = abs(rr - uBakerA.w * 0.8) - uBakerA.w * (0.18 + 0.2 * n.r);
      float dens = ss(0.0, -uBakerA.w * 0.1, d) * step(0.0, p.y) * uBakerC.x;
      sig += uSigma.x * dens * 2.0; alb += wat * uSigma.x * dens * 2.0; wsum += uSigma.x * dens * 2.0;
    }
    // hollow column
    if (uBakerA.z > 0.0 && H > 1.0 && p.y > -5.0 && p.y < H * 1.05 && dot(p.xz, p.xz) < Rc * Rc * 4.0) {
      float yn = p.y / H;
      float rad = Rc * (0.9 + 0.35 * yn * yn);
      vec3 sp = p / Rc;
      vec4 n = N3(sp * vec3(1.2, 0.35, 1.2) + vec3(0.0, -uTime * 0.02, 0.0));
      vec4 n2 = N3(sp * 1.9);
      float wall = Rc * (0.28 + 0.15 * n.r);
      float d = abs(length(p.xz) - rad * 0.78) - wall;
      d -= (n2.g - 0.5) * Rc * 0.25;
      float rr2 = length(p.xz) / (rad * 1.25);
      float topY = H * (1.0 - 0.35 * rr2 * rr2) + (n.r - 0.5) * Rc * 0.9;
      float dens = ss(0.0, -Rc * 0.12, d) * ss(topY + Rc * 0.2, topY - Rc * 0.3, p.y) * uBakerA.z;
      sig += uSigma.y * dens * 3.0; alb += wat * uSigma.y * dens * 3.0; wsum += uSigma.y * dens * 3.0;
    }
    // cauliflower head
    if (uBakerB.w > 0.0) {
      vec3 c = p - vec3(0.0, max(H, uBakerC.w) + uBakerB.w * 0.35, 0.0);
      float Rh = uBakerB.w;
      if (dot(c, c) < Rh * Rh * 4.0) {
        vec4 n = N3(c / Rh * 0.55 + vec3(0.2, uTime * 0.003, 0.4));
        vec4 n2 = N3(c / Rh * 1.6);
        vec3 e = c / vec3(Rh, Rh * 0.8, Rh);
        float d = (length(e) - 1.0) * Rh - (n.r - 0.45) * Rh * 0.55 - (n2.g - 0.5) * Rh * 0.2;
        float dens = ss(0.0, -Rh * 0.12, d) * uBakerC.y;
        sig += uSigma.x * dens; alb += wat * uSigma.x * dens; wsum += uSigma.x * dens;
      }
    }
    // base surge: a doughnut of radioactive mist rolling outward over the lagoon
    if (uBakerB.z > 0.0) {
      float Rs = uBakerB.x, hs = uBakerB.y;
      if (p.y < hs * 2.5) {
        vec3 sp = p / hs;
        vec4 n = N3(sp * 0.2 + vec3(0.0, 0.0, -uTime * 0.01));
        vec4 n2 = N3(sp * 0.7);
        float rr = length(p.xz);
        vec2 q = vec2(rr - Rs * 0.85, p.y - hs * 0.5);
        float dT = length(q * vec2(0.7, 1.0)) - hs * (0.7 + 0.5 * n.r);
        float dF = max(rr - Rs * 0.9, p.y - hs * (0.4 + 0.5 * n2.g));
        float d = min(dT, dF);
        float dens = ss(0.0, -hs * 0.35, d) * uBakerB.z;
        sig += uSigma.z * dens; alb += vec3(0.8, 0.82, 0.84) * uSigma.z * dens; wsum += uSigma.z * dens;
      }
    }
  }
  if (wsum > 0.0) alb /= wsum;
}

float mediumSigma(vec3 p) { float s; vec3 a, e; medium(p, s, a, e); return s; }

float hgPhase(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

float ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }

void main() {
  if (uBound.w < 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 vp = uProjInv * vec4(ndc, 1.0, 1.0);
  vec3 vdir = normalize(vp.xyz / vp.w);
  vec3 rd = normalize((uCamWorld * vec4(vdir, 0.0)).xyz);
  vec3 ro = uCamPos;

  float depth = texture(tDepth, vUv).r;
  float viewZ = perspectiveDepthToViewZ(depth, uNear, uFar);
  float tScene = depth >= 0.99999 ? 1e9 : (-viewZ) / max(-vdir.z, 1e-4);

  // ray / bounding-cylinder intersection
  float R = uBound.x;
  float a = dot(rd.xz, rd.xz), b = 2.0 * dot(ro.xz, rd.xz), c = dot(ro.xz, ro.xz) - R * R;
  float disc = b * b - 4.0 * a * c;
  if (disc < 0.0 || a < 1e-8) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float sq = sqrt(disc);
  float t0 = (-b - sq) / (2.0 * a), t1 = (-b + sq) / (2.0 * a);
  // slab
  float ty0 = (uBound.z - ro.y) / rd.y, ty1 = (uBound.y - ro.y) / rd.y;
  if (abs(rd.y) < 1e-6) { ty0 = -1e9; ty1 = 1e9; if (ro.y < uBound.z || ro.y > uBound.y) { gl_FragColor = vec4(0,0,0,1); return; } }
  float tya = min(ty0, ty1), tyb = max(ty0, ty1);
  float tn = max(max(t0, tya), 0.0);
  float tf = min(min(t1, tyb), tScene);
  if (tf <= tn) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  int N = uSteps;
  float dt = (tf - tn) / float(N);
  float jitter = ign(gl_FragCoord.xy);
  vec3 L = vec3(0.0);
  float T = 1.0;
  float tFirst = -1.0;
  float cosSun = dot(rd, uSunDir);
  float phase = mix(hgPhase(cosSun, 0.55), hgPhase(cosSun, -0.2), 0.3);
  float lightStep = max(uCap.y, uFire.y) * 0.22 + 30.0;
  vec3 fireC = vec3(0.0, uFire.x, 0.0);

  for (int i = 0; i < 256; i++) {
    if (i >= N) break;
    float t = tn + (float(i) + jitter) * dt;
    vec3 pr = ro + rd * t;
    // undo the camera-relative Earth curvature so samples line up with the rendered ground
    vec2 dd = pr.xz - ro.xz;
    vec3 p = pr + vec3(0.0, dot(dd, dd) * uCurv, 0.0);
    float sg; vec3 alb, em;
    medium(p, sg, alb, em);
    if (sg > 1e-7 || dot(em, em) > 1e-6) {
      if (tFirst < 0.0) tFirst = t;
      // sun shadow march
      float od = 0.0;
      vec3 lp = p;
      float ls = lightStep;
      for (int k = 0; k < 3; k++) {
        lp += uSunDir * ls;
        od += mediumSigma(lp) * ls;
        ls *= 2.2;
      }
      float Ts = exp(-od);
      float powder = 1.0 - exp(-sg * dt * 2.0);
      float hN = clamp(p.y / max(uBound.y, 1.0), 0.0, 1.0);
      // ambient: sky light plus a crude multiple-scattering boost (clouds glow almost as bright as the sky)
      vec3 amb = mix(uAmbBot, uAmbTop, hN) * (1.6 + 1.2 * Ts);
      // light from the fireball / glowing core
      vec3 fd = p - fireC;
      float fr = max(uFire.y, uCap.y * 0.6);
      vec3 fl = uFireLight * (fr * fr) / (dot(fd, fd) + fr * fr);
      float stepT = exp(-sg * dt);
      // energy-conserving integration of in-scattering + emission over the step (Hillaire 2015)
      vec3 Sint = sg > 1e-7
        ? (alb * (uSunCol * Ts * phase * (0.6 + 0.8 * powder) * 4.0 + amb + fl) * sg + em) * (1.0 - stepT) / sg
        : em * dt;
      L += T * Sint;
      T *= stepT;
      if (T < 0.004) break;
    }
  }
  // aerial perspective on the cloud
  if (tFirst > 0.0) {
    float fog = exp(-tFirst * uFogDen);
    L = L * fog + (1.0 - T) * uFogCol * (1.0 - fog);
  }
  L = min(L, vec3(60000.0));
  gl_FragColor = vec4(L, T);
}
`;

export class VolumeFX {
  constructor() {
    this.noise = createCloudNoise(64);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDepth: { value: null },
        tNoise: { value: this.noise },
        uProjInv: { value: new THREE.Matrix4() },
        uCamWorld: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uNear: { value: 1 }, uFar: { value: 1000 },
        uTime: { value: 0 },
        uSteps: { value: 72 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunCol: { value: new THREE.Color(1, 1, 1) },
        uAmbTop: { value: new THREE.Color(0.3, 0.35, 0.45) },
        uAmbBot: { value: new THREE.Color(0.2, 0.18, 0.16) },
        uFogCol: { value: new THREE.Color(0.6, 0.65, 0.7) },
        uFogDen: { value: 1 / 60000 },
        uBound: { value: new THREE.Vector4() },
        uFire: { value: new THREE.Vector4() },
        uCap: { value: new THREE.Vector4(1, 1, 1, 0) },
        uFireEmit: { value: new THREE.Color() },
        uGlowEmit: { value: new THREE.Color() },
        uFireLight: { value: new THREE.Color() },
        uStem: { value: new THREE.Vector4() },
        uSkirt: { value: new THREE.Vector4() },
        uWilson: { value: new THREE.Vector4() },
        uCollar: { value: new THREE.Vector4() },
        uBakerA: { value: new THREE.Vector4() },
        uBakerB: { value: new THREE.Vector4() },
        uBakerC: { value: new THREE.Vector4() },
        uAlbCap: { value: new THREE.Color(0.8, 0.78, 0.75) },
        uAlbStem: { value: new THREE.Color(0.6, 0.5, 0.4) },
        uAlbSkirt: { value: new THREE.Color(0.6, 0.5, 0.4) },
        uRope: { value: new THREE.Vector4() },
        uSigma: { value: new THREE.Vector4(0.02, 0.01, 0.01, 0.004) },
        uCurv: { value: 1 / (2 * EARTH_R) },
      },
    });
    this.quad = new FullScreenQuad(this.material);
    this.target = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, depthBuffer: false });
    this.target.texture.minFilter = THREE.LinearFilter;
    this.target.texture.magFilter = THREE.LinearFilter;
    this.scale = 0.5;
    this.state = {};
  }

  setSize(w, h) { this.target.setSize(Math.max(2, Math.floor(w * this.scale)), Math.max(2, Math.floor(h * this.scale))); }
  setQuality(q) { this.scale = q.volScale; this.material.uniforms.uSteps.value = q.volSteps; }

  /**
   * Compute all volume parameters from the Detonation at sim-time t.
   * env: {dustColor, humidity}, scenario, lighting: {sunDir, sunColor, ambTop, ambBot, fogCol, fogDen}
   */
  update(det, t, env, scenario, light, realTime) {
    const U = this.material.uniforms;
    U.uTime.value = realTime * 0.3 + Math.max(0, t);
    U.uSunDir.value.copy(light.sunDir);
    U.uSunCol.value.copy(light.sunColor);
    U.uAmbTop.value.copy(light.ambTop);
    U.uAmbBot.value.copy(light.ambBot);
    U.uFogCol.value.copy(light.fogCol);
    U.uFogDen.value = light.fogDen;
    const S = this.state;

    if (!det || t <= 0) {
      U.uBound.value.w = 0;
      S.active = false;
      return;
    }
    S.active = true;
    const uw = det.isUnderwater;
    const W = det.W;
    const Rf = det.fireballRadius(t);
    const capH = det.capCenterHeight(t);
    const m = det.toroidMorph(t);
    const Rt = det.capRadiusAt(t);
    const tube = det.capTubeAt(t);
    const hob = Math.max(0, det.hob);
    const fireY = uw ? 0 : Math.max(capH, hob);

    // ------- fireball & cap
    const T = det.fireballTemperature(t);
    const bb = blackbodyRGB(T);
    let lum = det.fireballLuminance(t);
    // first-pulse spike: X-ray fireball is tiny but blinding
    lum = Math.max(lum, det.thermalPower(t) * 1.2);
    const E0 = 900; // HDR radiance scale for the fireball surface at the principal maximum
    const no2 = T < 3200 ? Math.min(1, (3200 - T) / 1500) : 0;
    const tint = [1, 1 - 0.35 * no2, 1 - 0.55 * no2];
    let fe = bb.map((c, i) => c * lum * E0 * tint[i]);
    // keep radiance inside half-float range (the X-ray fireball would otherwise overflow the buffers)
    const feMax = Math.max(...fe);
    if (feMax > 24000) fe = fe.map((c) => (c * 24000) / feMax);
    U.uFireEmit.value.setRGB(fe[0], fe[1], fe[2]);
    // late glowing core: orange-red, decaying over tens of seconds (visible in Trinity/Tsar films)
    const glowTau = 6 + 3 * Math.pow(W, 0.2);
    const glow = Math.exp(-Math.max(0, t - det.tMax * 3) / glowTau) * smooth(det.tMax, det.tMax * 6, t);
    U.uGlowEmit.value.setRGB(9 * glow, 2.6 * glow, 0.6 * glow).multiplyScalar(uw ? 0 : 1);
    U.uFireLight.value.setRGB(fe[0] * 0.02 + 5 * glow, fe[1] * 0.02 + 1.6 * glow, fe[2] * 0.02 + 0.4 * glow).multiplyScalar(uw ? 0 : 1);
    U.uFire.value.set(fireY, Rf, m, uw ? 0 : 1);
    // caps flatten as they spread; megaton clouds punch into the stratosphere and pancake
    const flatten = (W > 2000 ? 0.5 : 0.62) + (1 - m) * 0.3;
    // poloidal circulation angle: roughly one roll per ~rise timescale
    const spin = (t / (det.riseTau * 0.45)) * Math.PI * 2 * 0.25;
    U.uCap.value.set(Rt, tube, flatten, spin);

    // rope tricks (tower / low shots only, first few ms)
    const ropeOn = scenario?.id === 'trinity' || (hob > 0 && hob < det.Rmax * 0.5);
    const rope = ropeOn && !uw ? Math.max(0, 1 - t / (det.tMin * 0.9)) * smooth(0, det.tMin * 0.05, t) : 0;
    U.uRope.value.set(rope, 1.25, hob, 0);

    // ------- stem & skirt
    const sf = det.surfaceFactor;
    const scaledHob = hob / det.RmaxAir;
    const lowBurst = Math.max(0, 1 - scaledHob / 3.5);
    const stemR = Math.max(0.28 * det.Rmax, 0.13 * det.capRadius * smooth(0, det.riseTau * 1.5, t)) * (uw ? 0 : 1);
    const stemStrength = smooth(det.tToroid * 0.4, det.tToroid * 2.5, t) * (0.25 + 0.75 * lowBurst);
    U.uStem.value.set(stemR, fireY - tube * 0.5, uw ? 0 : stemStrength, 0);
    const shockR = det.shockRadius(t);
    const skirtR = Math.min(shockR * 0.95, det.Rmax * (1.2 + 1.4 * smooth(det.tMax, det.tToroid * 4, t)));
    const skirtH = det.Rmax * (0.18 + 0.55 * smooth(det.tMax * 2, det.tToroid * 5, t));
    const skirtS = (uw ? 0 : 1) * smooth(det.tMax * 0.5, det.tMax * 4, t) * (0.35 + 0.65 * lowBurst) * (1 - 0.6 * smooth(det.stabilizeTime, det.stabilizeTime * 3, t));
    U.uSkirt.value.set(skirtR, skirtH, skirtS, 0);

    // ------- Wilson cloud
    const hum = env.humidity ?? 0.5;
    const tw0 = det.tMax * 0.6, tw1 = tw0 + 1.5 * Math.sqrt(Math.cbrt(W)) * (uw ? 1.2 : 1);
    const wilsonOp = hum > 0.55 ? smooth(tw0 * 0.5, tw0 * 1.5, t) * (1 - smooth(tw0 + (tw1 - tw0) * 0.4, tw1, t)) * (hum - 0.4) * 1.6 : 0;
    const wilsonR = det.shockRadius(Math.min(t, tw0 * 3 + 0.2)) * 0.96;
    U.uWilson.value.set(wilsonR, wilsonR * 0.07, wilsonOp, hob);

    // condensation collars around the rising stem (humid layers)
    const collarS = hum > 0.5 && !uw ? smooth(det.tToroid * 1.5, det.tToroid * 4, t) * (1 - smooth(det.stabilizeTime * 0.6, det.stabilizeTime * 1.4, t)) * 0.8 : 0;
    U.uCollar.value.set(capH * 0.45, capH * 0.63, stemR * 1.5, collarS * 0.45);

    // ------- Baker
    if (uw) {
      const colH = t < 12 ? 1850 * (1 - Math.exp(-t / 1.6)) : 1850 * Math.max(0, 1 - (t - 12) / 40) ** 0.5;
      const colS = smooth(0.02, 0.3, t) * (1 - smooth(25, 90, t));
      const domeR = t < 1.5 ? 60 + 330 * Math.sqrt(t) : 0;
      const domeS = domeR > 0 ? 1 - smooth(0.6, 1.5, t) : 0;
      U.uBakerA.value.set(colH, 310, colS, domeR);
      const surgeT = Math.max(0, t - 9);
      const surgeR = surgeT > 0 ? 350 + 1800 * Math.pow(surgeT / 150, 0.55) : 0;
      const surgeS = surgeT > 0 ? smooth(0, 8, surgeT) * (1 - smooth(300, 900, surgeT)) : 0;
      const headR = smooth(0.8, 6, t) * (320 + 330 * smooth(3, 40, t)) * (1 - 0.3 * smooth(60, 400, t));
      U.uBakerB.value.set(surgeR, 260 + 80 * smooth(10, 120, t), surgeS, headR);
      // the cauliflower head stays aloft after the column falls back
      U.uBakerC.value.set(domeS, headR > 1 ? 1 - smooth(300, 1200, t) : 0, 1, 1650 * smooth(0.5, 9, t));
    } else {
      U.uBakerA.value.set(0, 0, 0, 0);
      U.uBakerB.value.set(0, 0, 0, 0);
      U.uBakerC.value.set(0, 0, 0, 0);
    }

    // ------- albedos (dust vs condensation vs coral)
    const dust = env.dustColor;
    const whiteness = env.groundType === 'coral' ? 0.85 : env.groundType === 'snow' ? 0.75 : 0.2;
    U.uAlbSkirt.value.setRGB(...dust);
    U.uAlbStem.value.setRGB(dust[0], dust[1], dust[2]).lerp(new THREE.Color(0.9, 0.9, 0.9), Math.max(whiteness, 1 - lowBurst));
    const capBase = new THREE.Color(0.86, 0.84, 0.82).lerp(new THREE.Color(...dust), (1 - whiteness) * lowBurst * 0.5);
    // reddish-brown NO2 cast in the young cloud
    const no2Cloud = smooth(det.tMax * 3, det.tToroid, t) * (1 - smooth(det.tToroid * 3, det.stabilizeTime * 0.6, t));
    capBase.lerp(new THREE.Color(0.72, 0.42, 0.28), no2Cloud * 0.6);
    U.uAlbCap.value.copy(capBase);

    // extinction coefficients scale with cloud size (thin in absolute terms, still opaque at scale)
    const capSig = 2.5 / Math.max(40, tube);
    U.uSigma.value.set(capSig, 2.2 / Math.max(30, stemR * 1.5), 1.6 / Math.max(20, skirtH), 0.22 / Math.max(20, wilsonR * 0.07));
    if (uw) U.uSigma.value.set(3 / 250, 3 / 200, 2.2 / 250, U.uSigma.value.w);

    // ------- bounding cylinder
    let rad = Math.max(Rf * 1.4, (Rt + tube) * 1.6, stemR * 4);
    if (skirtS > 0) rad = Math.max(rad, skirtR * 1.35);
    if (wilsonOp > 0) rad = Math.max(rad, wilsonR * 1.15);
    if (collarS > 0) rad = Math.max(rad, stemR * 2.6 * 1.3 * 1.25);
    let top = Math.max(fireY + Rf * 1.4, fireY + tube * 2.2, wilsonOp > 0 ? hob + wilsonR * 1.15 : 0);
    if (uw) {
      const A = U.uBakerA.value, B = U.uBakerB.value;
      rad = Math.max(rad, A.y * 2.2, A.w * 1.4, B.x * 1.3, B.w * 2);
      top = Math.max(top, A.x + B.w * 2.2, U.uBakerC.value.w + B.w * 2.2, A.w * 1.4, B.y * 2.5);
    }
    U.uBound.value.set(rad, top, -60 - light.curvDrop, 1);
    S.fireY = fireY; S.Rf = Rf; S.fe = fe; S.glow = glow; S.m = m; S.shockR = shockR; S.top = top; S.rad = rad;
  }

  render(renderer, camera, depthTexture) {
    const U = this.material.uniforms;
    U.tDepth.value = depthTexture;
    U.uProjInv.value.copy(camera.projectionMatrixInverse);
    U.uCamWorld.value.copy(camera.matrixWorld);
    U.uCamPos.value.copy(camera.position);
    U.uNear.value = camera.near;
    U.uFar.value = camera.far;
    renderer.setRenderTarget(this.target);
    if (U.uBound.value.w < 0.5) {
      renderer.setClearColor(0x000000, 1);
      renderer.clear(true, false, false);
    } else {
      this.quad.render(renderer);
    }
    renderer.setRenderTarget(null);
  }
}

function smooth(a, b, x) {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
}
