import * as THREE from 'three';
import { curvatureUniforms } from './curvature.js';
import { NOISE_GLSL, CURVATURE_GLSL, fbm2, ridged2 } from './noise.js';

export const TERRAIN_TYPES = { desert: 0, atoll: 1, arctic: 2 };
const MAX_RINGS = 8;

/** Height function in GLSL — mirrors heightAt() below exactly. */
export const HEIGHT_GLSL = /* glsl */ `
uniform int uTerrainType;
uniform vec2 uAtollCenter;
uniform vec2 uAtollAxes;
uniform vec4 uCrater; // x radius, y depth, z progress, w unused

float baseHeight(vec2 p) {
  float h = 0.0;
  if (uTerrainType == 0) {
    float r = length(p);
    float basin = fbm2(p / 9000.0, 4) * 90.0 + fbm2(p / 1700.0, 4) * 14.0 + fbm2(p / 210.0, 3) * 1.6;
    basin *= mix(0.2, 1.0, smoothstep(300.0, 4500.0, r));
    float warp = fbm2(p / 15000.0, 3) * 5000.0;
    float ex = p.x + warp;
    float east = smoothstep(17000.0, 27000.0, ex) * (1.0 - smoothstep(40000.0, 56000.0, ex));
    float west = (1.0 - smoothstep(-36000.0, -24000.0, ex)) * smoothstep(-62000.0, -46000.0, ex);
    float rid = ridged2(vec2(p.x / 5200.0, p.y / 21000.0), 7);
    float bajada = east * 160.0 + west * 120.0;
    h = basin + (east * 1350.0 + west * 1050.0) * rid + bajada;
  } else if (uTerrainType == 1) {
    vec2 q = (p - uAtollCenter) / uAtollAxes;
    float e = length(q) + fbm2(p / 9000.0, 3) * 0.07;
    float rd = (e - 1.0) * min(uAtollAxes.x, uAtollAxes.y);
    float lagoon = -52.0 + fbm2(p / 1600.0, 3) * 9.0;
    float ocean = -3.0 - max(rd, 0.0) * 0.42;
    ocean = max(ocean, -1400.0);
    float base = rd < 0.0 ? mix(lagoon, -3.0, smoothstep(-900.0, 0.0, rd)) : ocean;
    float reefW = 1.0 - smoothstep(120.0, 650.0, abs(rd));
    float reef = -0.7 + fbm2(p / 85.0, 3) * 0.35;
    h = mix(base, reef, reefW);
    float isl = smoothstep(0.04, 0.3, fbm2(p / 2600.0, 3)) * (1.0 - smoothstep(40.0, 230.0, abs(rd + 70.0)));
    float islandH = 2.8 + fbm2(p / 60.0, 3) * 0.6;
    h = mix(h, islandH, isl);
  } else {
    float land = 70.0 + fbm2(p / 12000.0, 5) * 150.0 + fbm2(p / 900.0, 4) * 10.0 + fbm2(p / 120.0, 3) * 1.2;
    float north = 1.0 - smoothstep(-40000.0, -12000.0, p.y);
    land += ridged2(p / 8000.0, 6) * 950.0 * north;
    float coastD = p.x + 30000.0 + fbm2(p / 20000.0, 4) * 16000.0 + fbm2(p / 3000.0, 3) * 1500.0;
    h = mix(-90.0, land, smoothstep(-900.0, 1600.0, coastD));
  }
  return h;
}

float terrainHeight(vec2 p) {
  float h = baseHeight(p);
  if (uCrater.x > 0.0 && uCrater.z > 0.0) {
    float k = length(p) / uCrater.x;
    float bowl = k < 1.0 ? -uCrater.y * (1.0 - k * k) : 0.0;
    float rim = uCrater.y * 0.16 * exp(-pow((k - 1.08) / 0.2, 2.0));
    h += (bowl + rim) * uCrater.z;
  }
  return h;
}
`;

export class Terrain {
  constructor() {
    this.type = 0;
    this.atollCenter = new THREE.Vector2(0, 0);
    this.atollAxes = new THREE.Vector2(18000, 9500);
    this.crater = new THREE.Vector4(0, 0, 0, 0);
    this.uniforms = {
      uTerrainType: { value: 0 },
      uAtollCenter: { value: this.atollCenter },
      uAtollAxes: { value: this.atollAxes },
      uCrater: { value: this.crater },
      uCenter: { value: new THREE.Vector2() },
      uCamPos: curvatureUniforms.uCamPos,
      uTex0: { value: null }, uNor0: { value: null }, uArm0: { value: null },
      uTex1: { value: null }, uNor1: { value: null }, uArm1: { value: null },
      uTex2: { value: null }, uNor2: { value: null }, uArm2: { value: null },
      uTex3: { value: null },
      uScale0: { value: 1 / 5 }, uScale1: { value: 1 / 7 }, uScale2: { value: 1 / 14 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uGlass: { value: new THREE.Vector3(0, 0, 0) }, // radius, progress, craterGlassOn
      uRingR: { value: new Array(MAX_RINGS).fill(0) },
      uRingC: { value: new Array(MAX_RINGS).fill(0).map(() => new THREE.Color()) },
      uRingCount: { value: 0 },
      uRingsOn: { value: 0 },
      uShock: { value: new THREE.Vector4(0, 0, 0, 0) }, // radius, strength, dust amount, time
      uThermal: { value: new THREE.Vector4(0, 0, 0, 0) }, // K (cal/cm2·m2), visibility, progress, hob
      uGroundGlow: { value: new THREE.Vector4(0, 0, 0, 0) }, // rgb, radius
      uDustColor: { value: new THREE.Color(0.6, 0.5, 0.4) },
      uSnow: { value: 0 },
      uBurnThresh: { value: 7 },
    };
    this.mesh = new THREE.Mesh(this._buildGeometry(), this._buildMaterial());
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -1;
    this.mesh.name = 'terrain';
  }

  _buildGeometry(nr = 420, nt = 560, rmin = 1.2, R = 320000) {
    const a = Math.log(R / rmin + 1);
    const pos = new Float32Array((nr * nt + 1) * 3);
    let k = 3; // index 0 = centre
    for (let i = 1; i <= nr; i++) {
      const r = rmin * (Math.exp((a * i) / nr) - 1);
      for (let j = 0; j < nt; j++) {
        const th = ((j + (i % 2) * 0.5) / nt) * Math.PI * 2;
        pos[k++] = Math.cos(th) * r; pos[k++] = 0; pos[k++] = Math.sin(th) * r;
      }
    }
    // typed index buffer: ~1.4 M indices built without array growth
    const idx = new Uint32Array(nt * 3 + (nr - 1) * nt * 6);
    let q = 0;
    for (let j = 0; j < nt; j++) { idx[q++] = 0; idx[q++] = 1 + ((j + 1) % nt); idx[q++] = 1 + j; }
    for (let i = 1; i < nr; i++) {
      const r0 = 1 + (i - 1) * nt, r1 = 1 + i * nt;
      for (let j = 0; j < nt; j++) {
        const j1 = (j + 1) % nt;
        idx[q++] = r0 + j; idx[q++] = r0 + j1; idx[q++] = r1 + j;
        idx[q++] = r0 + j1; idx[q++] = r1 + j1; idx[q++] = r1 + j;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R);
    return g;
  }

  _buildMaterial() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
    const U = this.uniforms;
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          ${NOISE_GLSL}
          ${HEIGHT_GLSL}
          ${CURVATURE_GLSL}
          uniform vec2 uCenter;
          varying vec3 vWorld;
          varying vec3 vWN;
          varying float vDist;`)
        .replace('#include <beginnormal_vertex>', `
          vec2 wxz = position.xz + uCenter;
          float dist0 = length(position.xz);
          float eps = max(0.35, dist0 * 0.004);
          float h0 = terrainHeight(wxz);
          float hx = terrainHeight(wxz + vec2(eps, 0.0));
          float hz = terrainHeight(wxz + vec2(0.0, eps));
          vec3 objectNormal = normalize(vec3(-(hx - h0) / eps, 1.0, -(hz - h0) / eps));
          vWN = objectNormal;`)
        .replace('#include <begin_vertex>', `
          vec3 transformed = vec3(wxz.x, h0, wxz.y);
          vWorld = transformed;
          vDist = dist0;`)
        .replace('#include <project_vertex>', `
          vec4 mvPosition = viewMatrix * vec4(applyCurvature(transformed), 1.0);
          gl_Position = projectionMatrix * mvPosition;`)
        .replace('#include <worldpos_vertex>', `
          vec4 worldPosition = vec4(transformed, 1.0);`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          ${NOISE_GLSL}
          uniform int uTerrainType;
          uniform sampler2D uTex0; uniform sampler2D uNor0; uniform sampler2D uArm0;
          uniform sampler2D uTex1; uniform sampler2D uNor1; uniform sampler2D uArm1;
          uniform sampler2D uTex2; uniform sampler2D uNor2; uniform sampler2D uArm2;
          uniform sampler2D uTex3;
          uniform float uScale0; uniform float uScale1; uniform float uScale2;
          uniform vec3 uTint;
          uniform vec3 uGlass;
          uniform vec4 uCrater;
          uniform float uRingR[${MAX_RINGS}];
          uniform vec3 uRingC[${MAX_RINGS}];
          uniform int uRingCount;
          uniform float uRingsOn;
          uniform vec4 uShock;
          uniform vec4 uThermal;
          uniform vec4 uGroundGlow;
          uniform vec3 uDustColor;
          uniform float uSnow;
          uniform float uBurnThresh;
          varying vec3 vWorld;
          varying vec3 vWN;
          varying float vDist;

          // anti-tiling: two rotated/scaled samples blended by low-frequency noise
          vec4 sampleAT(sampler2D t, vec2 uv, float m) {
            vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.43 + vec2(0.37, 0.71);
            return mix(texture(t, uv), texture(t, uv2), m);
          }
          vec3 unpackN(vec4 s) { return s.xyz * 2.0 - 1.0; }
        `)
        .replace('#include <map_fragment>', `
          vec2 wp = vWorld.xz;
          float atm = smoothstep(-0.35, 0.35, vnoise(wp / 37.0));
          // macro variation
          float macro = fbm2(wp / 700.0, 4);
          float macro2 = fbm2(wp / 60.0, 3);
          vec3 wN = normalize(vWN);
          float slope = 1.0 - wN.y;

          vec2 uv0 = wp * uScale0, uv1 = wp * uScale1, uv2 = wp * uScale2;
          vec4 c0 = sampleAT(uTex0, uv0, atm);
          vec4 c1 = sampleAT(uTex1, uv1, 1.0 - atm);
          vec4 c2 = sampleAT(uTex2, uv2, atm);
          vec4 a0 = sampleAT(uArm0, uv0, atm);
          vec4 a1 = sampleAT(uArm1, uv1, 1.0 - atm);
          vec4 a2 = sampleAT(uArm2, uv2, atm);
          vec3 n0 = unpackN(sampleAT(uNor0, uv0, atm));
          vec3 n1 = unpackN(sampleAT(uNor1, uv1, 1.0 - atm));
          vec3 n2 = unpackN(sampleAT(uNor2, uv2, atm));

          float wDetail = smoothstep(0.05, 0.35, macro + macro2 * 0.35);
          float wRock = smoothstep(0.22, 0.42, slope + macro2 * 0.08);
          if (uTerrainType == 1) {
            // atoll: sand above water, coral/reef flats near sea level & below
            wDetail = 1.0 - smoothstep(-0.2, 0.8, vWorld.y);
            wRock = 0.0;
          }
          vec3 alb = mix(c0.rgb, c1.rgb, wDetail);
          vec4 arm = mix(a0, a1, wDetail);
          vec3 tn = normalize(mix(n0, n1, wDetail));
          alb = mix(alb, c2.rgb, wRock);
          arm = mix(arm, a2, wRock);
          tn = normalize(mix(tn, n2, wRock));
          alb *= uTint * (0.86 + 0.28 * (macro * 0.5 + 0.5));

          // distance: fade texture detail to average to kill far moiré
          float far = smoothstep(2500.0, 16000.0, vDist);
          vec3 avg = mix(textureLod(uTex0, vec2(0.5), 12.0).rgb, textureLod(uTex2, vec2(0.5), 12.0).rgb, wRock) * uTint;
          alb = mix(alb, avg * (0.8 + 0.4 * (macro * 0.5 + 0.5)), far * 0.85);

          float rG = length(wp);
          // thermal scorching: fluence at this point once the pulse has been delivered
          float slant = length(vec2(rG, uThermal.w));
          float Q = uThermal.x * exp(-slant / (uThermal.y * 0.75)) / max(slant * slant, 1.0) * uThermal.z;
          float scorch = smoothstep(uBurnThresh * 1.5, uBurnThresh * 12.0, Q);
          if (uSnow > 0.5) {
            // snow melts/sublimates: darker wet surface, exposed ground
            alb = mix(alb, vec3(0.38, 0.4, 0.42) * alb, scorch * 0.8);
          } else {
            alb = mix(alb, alb * vec3(0.32, 0.27, 0.23), scorch * 0.85);
          }

          // Trinitite: fused green glass
          float glass = 0.0;
          if (uGlass.z > 0.5) {
            float gr = uGlass.x * (1.0 + 0.25 * fbm2(wp / 60.0, 3));
            glass = (1.0 - smoothstep(gr * 0.5, gr, rG)) * uGlass.y;
            glass *= smoothstep(-0.2, 0.4, fbm2(wp / 7.0, 3) + 0.25);
            vec3 trinitite = vec3(0.26, 0.36, 0.24) * (0.7 + 0.5 * macro2);
            alb = mix(alb, trinitite, glass * 0.85);
          }
          // crater floor darkened / disturbed
          if (uCrater.x > 0.0) {
            float ck = rG / uCrater.x;
            float cm = (1.0 - smoothstep(0.7, 1.35, ck)) * uCrater.z;
            alb = mix(alb, alb * vec3(0.72, 0.7, 0.68), cm * (uTerrainType == 1 ? 0.0 : 0.6));
          }
          diffuseColor.rgb *= alb;
        `)
        .replace('#include <roughnessmap_fragment>', `
          // natural ground is never glossy; only the fused trinitite glass is
          float roughnessFactor = mix(max(arm.g, 0.82), 0.2, glass * 0.8);
        `)
        .replace('#include <metalnessmap_fragment>', `
          float metalnessFactor = 0.0;
        `)
        .replace('#include <normal_fragment_maps>', `
          {
            // world-space UDN blend on an XZ-planar mapping, then back to view space
            vec3 T = vec3(1.0, 0.0, 0.0), B = vec3(0.0, 0.0, -1.0);
            vec3 Nw = wN;
            T = normalize(T - Nw * dot(T, Nw));
            B = normalize(cross(Nw, T));
            float nStrength = mix(0.6, 0.2, far);
            vec3 pn = normalize(Nw + (T * tn.x + B * tn.y) * nStrength);
            normal = normalize((viewMatrix * vec4(pn, 0.0)).xyz);
          }
        `)
        .replace('#include <aomap_fragment>', `
          float ambientOcclusion = mix(arm.r, 1.0, far);
          reflectedLight.indirectDiffuse *= ambientOcclusion;
          reflectedLight.indirectSpecular *= ambientOcclusion;
        `)
        .replace('#include <emissivemap_fragment>', `
          #include <emissivemap_fragment>
          // heated ground / molten glass
          if (uGroundGlow.w > 0.0) {
            float gk = rG / uGroundGlow.w;
            totalEmissiveRadiance += uGroundGlow.rgb * exp(-gk * gk * 1.5) * (0.6 + 0.4 * macro2);
          }
          // shock front: dust sheet lifted as the front passes
          if (uShock.y > 0.0) {
            float band = uShock.x * 0.02 + 20.0;
            float front = exp(-pow((rG - uShock.x) / band, 2.0));
            float behind = (1.0 - smoothstep(uShock.x * 0.6, uShock.x, rG)) * uShock.z;
            diffuseColor.rgb = mix(diffuseColor.rgb, uDustColor, clamp(front * uShock.y + behind * 0.5, 0.0, 0.85));
          }
          // damage rings
          if (uRingsOn > 0.0) {
            float px = max(fwidth(rG), 0.5);
            for (int i = 0; i < ${MAX_RINGS}; i++) {
              if (i >= uRingCount) break;
              float d = abs(rG - uRingR[i]);
              float line = (1.0 - smoothstep(px * 0.8, px * 2.0, d)) * (1.0 - smoothstep(15.0, 90.0, px));
              float fill = (1.0 - smoothstep(uRingR[i] - px, uRingR[i] + px, rG)) * 0.012;
              // rings are a measurement overlay: draw them relative to the scene's brightness
              diffuseColor.rgb = mix(diffuseColor.rgb, uRingC[i], line * 0.75 * uRingsOn);
              totalEmissiveRadiance += uRingC[i] * (line * 0.25 + fill) * uRingsOn;
            }
          }
        `);
      mat.userData.shader = shader;
    };
    mat.customProgramCacheKey = () => 'terrain-v1';
    return mat;
  }

  /** CPU mirror of GLSL baseHeight + crater */
  heightAt(x, z) {
    const t = this.type;
    let h = 0;
    const ss = (a, b, v) => { const k = Math.min(1, Math.max(0, (v - a) / (b - a))); return k * k * (3 - 2 * k); };
    const mix = (a, b, k) => a + (b - a) * k;
    if (t === 0) {
      const r = Math.hypot(x, z);
      let basin = fbm2(x / 9000, z / 9000, 4) * 90 + fbm2(x / 1700, z / 1700, 4) * 14 + fbm2(x / 210, z / 210, 3) * 1.6;
      basin *= mix(0.2, 1.0, ss(300, 4500, r));
      const warp = fbm2(x / 15000, z / 15000, 3) * 5000;
      const ex = x + warp;
      const east = ss(17000, 27000, ex) * (1 - ss(40000, 56000, ex));
      const west = (1 - ss(-36000, -24000, ex)) * ss(-62000, -46000, ex);
      const rid = ridged2(x / 5200, z / 21000, 7);
      h = basin + (east * 1350 + west * 1050) * rid + east * 160 + west * 120;
    } else if (t === 1) {
      const qx = (x - this.atollCenter.x) / this.atollAxes.x, qz = (z - this.atollCenter.y) / this.atollAxes.y;
      const e = Math.hypot(qx, qz) + fbm2(x / 9000, z / 9000, 3) * 0.07;
      const rd = (e - 1) * Math.min(this.atollAxes.x, this.atollAxes.y);
      const lagoon = -52 + fbm2(x / 1600, z / 1600, 3) * 9;
      let ocean = -3 - Math.max(rd, 0) * 0.42; ocean = Math.max(ocean, -1400);
      const base = rd < 0 ? mix(lagoon, -3, ss(-900, 0, rd)) : ocean;
      const reefW = 1 - ss(120, 650, Math.abs(rd));
      const reef = -0.7 + fbm2(x / 85, z / 85, 3) * 0.35;
      h = mix(base, reef, reefW);
      const isl = ss(0.04, 0.3, fbm2(x / 2600, z / 2600, 3)) * (1 - ss(40, 230, Math.abs(rd + 70)));
      const islandH = 2.8 + fbm2(x / 60, z / 60, 3) * 0.6;
      h = mix(h, islandH, isl);
    } else {
      let land = 70 + fbm2(x / 12000, z / 12000, 5) * 150 + fbm2(x / 900, z / 900, 4) * 10 + fbm2(x / 120, z / 120, 3) * 1.2;
      const north = 1 - ss(-40000, -12000, z);
      land += ridged2(x / 8000, z / 8000, 6) * 950 * north;
      const coastD = x + 30000 + fbm2(x / 20000, z / 20000, 4) * 16000 + fbm2(x / 3000, z / 3000, 3) * 1500;
      h = mix(-90, land, ss(-900, 1600, coastD));
    }
    const c = this.crater;
    if (c.x > 0 && c.z > 0) {
      const k = Math.hypot(x, z) / c.x;
      const bowl = k < 1 ? -c.y * (1 - k * k) : 0;
      const rim = c.y * 0.16 * Math.exp(-(((k - 1.08) / 0.2) ** 2));
      h += (bowl + rim) * c.z;
    }
    return h;
  }

  /** Ground height, clamped to sea level where there is water */
  surfaceAt(x, z, water) {
    const h = this.heightAt(x, z);
    return water ? Math.max(h, 0) : h;
  }

  setType(name) {
    this.type = TERRAIN_TYPES[name] ?? 0;
    this.uniforms.uTerrainType.value = this.type;
    this.uniforms.uSnow.value = name === 'arctic' ? 1 : 0;
  }

  setTextures(sets, tint = [1, 1, 1]) {
    const U = this.uniforms;
    const [b, d, r, s] = sets;
    U.uTex0.value = b.map; U.uNor0.value = b.normalMap; U.uArm0.value = b.arm;
    U.uTex1.value = d.map; U.uNor1.value = d.normalMap; U.uArm1.value = d.arm;
    U.uTex2.value = r.map; U.uNor2.value = r.normalMap; U.uArm2.value = r.arm;
    U.uTex3.value = s.map;
    for (const set of sets) for (const t of [set.map, set.normalMap, set.arm]) if (t) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.needsUpdate = true; }
    U.uTint.value.setRGB(...tint);
  }

  setRings(rings, on) {
    const U = this.uniforms;
    const n = Math.min(MAX_RINGS, rings.length);
    for (let i = 0; i < MAX_RINGS; i++) {
      U.uRingR.value[i] = i < n ? rings[i].radius : 0;
      if (i < n) U.uRingC.value[i].set(rings[i].color).multiplyScalar(1.2);
    }
    U.uRingCount.value = n;
    U.uRingsOn.value = on ? 1 : 0;
  }

  update(camera) {
    const snap = 2;
    this.uniforms.uCenter.value.set(Math.round(camera.position.x / snap) * snap, Math.round(camera.position.z / snap) * snap);
  }
}
