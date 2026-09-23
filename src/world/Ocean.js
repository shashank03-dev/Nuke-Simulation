import * as THREE from 'three';
import { curvatureUniforms } from './curvature.js';
import { NOISE_GLSL, CURVATURE_GLSL } from './noise.js';

/**
 * Ocean — Gerstner-wave surface on a camera-centred polar grid, built on MeshPhysicalMaterial
 * so it gets correct IBL reflections, sun glints and the nuclear flash for free.
 * Adds: reef-depth colouring (reads the terrain height), the shock-front "slick",
 * Baker's radial gravity waves and the base-surge foam.
 */
const WAVES = [
  // dir(deg), wavelength(m), steepness, amplitude(m)
  [20, 62, 0.28, 0.55],
  [55, 31, 0.24, 0.28],
  [-15, 17, 0.2, 0.13],
  [80, 9.5, 0.18, 0.07],
  [-60, 5.3, 0.14, 0.035],
];

export class Ocean {
  constructor(terrainUniforms, heightGLSL) {
    this.uniforms = {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector2() },
      uCamPos: curvatureUniforms.uCamPos,
      uShock: { value: new THREE.Vector4() },   // radius, strength, ..., ...
      uBaker: { value: new THREE.Vector4() },   // time since burst, enabled, surge radius, surge strength
      uDeep: { value: new THREE.Color(0.012, 0.06, 0.1) },
      uShallow: { value: new THREE.Color(0.1, 0.55, 0.55) },
      uSeaState: { value: 1 },
      uFlash: { value: 0 },
    };
    this.terrainUniforms = terrainUniforms;
    this.heightGLSL = heightGLSL;
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.06, metalness: 0, transparent: true, ior: 1.333,
      clearcoat: 0, specularIntensity: 1, envMapIntensity: 1,
    });
    this._patch(mat);
    this.mesh = new THREE.Mesh(this._geometry(), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ocean';
  }

  _geometry(nr = 300, nt = 420, rmin = 1.5, R = 330000) {
    const a = Math.log(R / rmin + 1);
    const pos = new Float32Array((nr * nt + 1) * 3);
    let k = 3;
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

  _patch(mat) {
    const U = this.uniforms, TU = this.terrainUniforms;
    const waveDecl = WAVES.map(([d, L, Q, A], i) => {
      const r = (d * Math.PI) / 180;
      const k = (2 * Math.PI) / L;
      const w = Math.sqrt(9.81 * k);
      return `  gerstner(p, vec2(${Math.cos(r).toFixed(5)}, ${Math.sin(r).toFixed(5)}), ${k.toFixed(6)}, ${w.toFixed(6)}, ${Q.toFixed(3)}, ${A.toFixed(4)} * uSeaState * fade, disp, dN);`;
    }).join('\n');
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U, {
        uTerrainType: TU.uTerrainType, uAtollCenter: TU.uAtollCenter, uAtollAxes: TU.uAtollAxes, uCrater: TU.uCrater,
      });
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          ${NOISE_GLSL}
          ${this.heightGLSL}
          ${CURVATURE_GLSL}
          uniform float uTime; uniform vec2 uCenter; uniform float uSeaState;
          uniform vec4 uBaker;
          varying vec3 vWorld; varying float vDepth; varying float vDist; varying vec3 vWN; varying float vCrest;
          void gerstner(vec2 p, vec2 D, float k, float w, float Q, float A, inout vec3 disp, inout vec3 dN) {
            float f = k * dot(D, p) - w * uTime;
            float c = cos(f), s = sin(f);
            disp.x += Q * A * D.x * c;
            disp.z += Q * A * D.y * c;
            disp.y += A * s;
            dN.x -= D.x * k * A * c;
            dN.z -= D.y * k * A * c;
            dN.y -= Q * k * A * s;
          }`)
        .replace('#include <beginnormal_vertex>', `
          vec2 p = position.xz + uCenter;
          float dist0 = length(position.xz);
          float fade = 1.0 - smoothstep(600.0, 6000.0, dist0);
          vec3 disp = vec3(0.0);
          vec3 dN = vec3(0.0, 1.0, 0.0);
          ${waveDecl}
          // Baker: radial gravity waves leaving the column (shallow-water speed sqrt(g h), h≈55 m)
          if (uBaker.y > 0.0 && uBaker.x > 0.0) {
            float r = length(p);
            float c = 23.0;
            float front = c * uBaker.x;
            float kx = 2.0 * 3.14159 / 180.0;
            float env = exp(-pow((r - front * 0.8) / (front * 0.35 + 60.0), 2.0)) * step(r, front + 200.0);
            float A = 29.0 * 300.0 / max(r, 300.0) * env * uBaker.y;
            float ph = kx * (r - front);
            disp.y += A * sin(ph);
            vec2 rd = p / max(r, 1.0);
            dN.xz -= rd * kx * A * cos(ph);
          }
          vec3 objectNormal = normalize(dN);
          vWN = objectNormal;
          vCrest = disp.y;`)
        .replace('#include <begin_vertex>', `
          vec3 transformed = vec3(p.x + disp.x, disp.y, p.y + disp.z);
          vWorld = transformed;
          vDist = dist0;
          vDepth = max(0.0, -terrainHeight(p));`)
        .replace('#include <project_vertex>', `
          vec4 mvPosition = viewMatrix * vec4(applyCurvature(transformed), 1.0);
          gl_Position = projectionMatrix * mvPosition;`)
        .replace('#include <worldpos_vertex>', `vec4 worldPosition = vec4(transformed, 1.0);`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          ${NOISE_GLSL}
          uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec4 uShock; uniform vec4 uBaker;
          uniform float uFlash;
          varying vec3 vWorld; varying float vDepth; varying float vDist; varying vec3 vWN; varying float vCrest;`)
        .replace('#include <map_fragment>', `
          float shallow = exp(-vDepth / 9.0);
          vec3 wc = mix(uDeep, uShallow, shallow);
          float foam = 0.0;
          // shock slick: the fast dark ring on the water ahead of the column (Baker footage)
          float rG = length(vWorld.xz);
          if (uShock.y > 0.0) {
            float band = max(uShock.x * 0.03, 15.0);
            float ring = exp(-pow((rG - uShock.x) / band, 2.0));
            float inside = 1.0 - smoothstep(uShock.x * 0.85, uShock.x, rG);
            wc = mix(wc, wc * 0.35, ring * uShock.y);
            wc = mix(wc, wc * 1.25 + 0.02, inside * uShock.y * 0.3);
          }
          if (uBaker.w > 0.0) {
            // base surge foam and churned water
            float s = 1.0 - smoothstep(uBaker.z * 0.85, uBaker.z * 1.05, rG);
            foam = max(foam, s * uBaker.w * (0.55 + 0.45 * vnoise(vWorld.xz / 18.0 + uTime * 0.2)));
          }
          foam = max(foam, smoothstep(0.9, 2.2, vCrest) * 0.4);
          foam = max(foam, shallow * smoothstep(0.55, 0.95, vnoise(vWorld.xz / 6.0 + vec2(uTime * 0.3, 0.0))) * step(vDepth, 0.7) * 0.7);
          diffuseColor.rgb = mix(wc, vec3(0.85, 0.88, 0.9), foam);
          diffuseColor.a = mix(mix(0.72, 0.985, 1.0 - shallow), 1.0, foam);
        `)
        .replace('#include <roughnessmap_fragment>', `
          float roughnessFactor = mix(0.03, 0.22, smoothstep(300.0, 20000.0, vDist)) + foam * 0.6;`)
        .replace('#include <normal_fragment_maps>', `
          {
            // micro ripples: two scrolling noise layers → normal perturbation
            vec2 q = vWorld.xz;
            float e = 0.35;
            float fadeN = 1.0 - smoothstep(80.0, 1500.0, vDist);
            float n0 = vnoise(q / 3.1 + vec2(uTime * 0.21, uTime * 0.13)) + 0.5 * vnoise(q / 1.3 - vec2(uTime * 0.31, -uTime * 0.17));
            float nx = vnoise((q + vec2(e, 0.0)) / 3.1 + vec2(uTime * 0.21, uTime * 0.13)) + 0.5 * vnoise((q + vec2(e, 0.0)) / 1.3 - vec2(uTime * 0.31, -uTime * 0.17));
            float nz = vnoise((q + vec2(0.0, e)) / 3.1 + vec2(uTime * 0.21, uTime * 0.13)) + 0.5 * vnoise((q + vec2(0.0, e)) / 1.3 - vec2(uTime * 0.31, -uTime * 0.17));
            vec3 pn = normalize(vWN + vec3(-(nx - n0), 0.0, -(nz - n0)) * 0.55 * fadeN);
            normal = normalize((viewMatrix * vec4(pn, 0.0)).xyz);
          }`);
      mat.userData.shader = shader;
    };
    mat.customProgramCacheKey = () => 'ocean-v1';
  }

  setPalette(deep, shallow, seaState = 1) {
    this.uniforms.uDeep.value.setRGB(...deep);
    this.uniforms.uShallow.value.setRGB(...shallow);
    this.uniforms.uSeaState.value = seaState;
  }

  update(camera, time) {
    const snap = 4;
    this.uniforms.uCenter.value.set(Math.round(camera.position.x / snap) * snap, Math.round(camera.position.z / snap) * snap);
    this.uniforms.uTime.value = time;
  }
}
