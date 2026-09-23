import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PSI } from '../physics/effects.js';
import { applyCurvaturePatch } from './curvature.js';

/**
 * Props — scenario set dressing that reacts to the explosion.
 * Every reaction is a pure function of simulation time t, so the timeline can be scrubbed
 * backwards and forwards (debris flies analytically; nothing is integrated frame-to-frame).
 */

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function box(w, h, d, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.rotateX(rx).rotateY(ry).rotateZ(rz);
  g.translate(x, y, z);
  return g;
}
function cyl(rt, rb, h, x = 0, y = 0, z = 0, seg = 12, rx = 0, rz = 0) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  if (rx) g.rotateX(rx);
  if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}
/** Beam between two points (square section) */
function beam(a, b, s) {
  const d = new THREE.Vector3().subVectors(b, a);
  const L = d.length();
  const g = new THREE.BoxGeometry(s, L, s);
  const q = new THREE.Quaternion().setFromUnitVectors(UP, d.clone().normalize());
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  return g;
}
function nonIndexed(gs) { return gs.map((g) => (g.index ? g.toNonIndexed() : g)); }
function merge(gs) {
  const clean = nonIndexed(gs).map((g) => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); return g; });
  return mergeGeometries(clean, false);
}

// ================================================================== analytic debris
/**
 * Debris is spawned per structure; each fragment's trajectory is a closed-form function of
 * time since shock arrival: drag-limited horizontal flight + ballistic drop with ground clamp.
 */
export class DebrisField {
  constructor(max = 4000) {
    const g = new THREE.BoxGeometry(1, 1, 1);
    this.mat = new THREE.MeshStandardMaterial({ color: 0x7a6552, roughness: 0.9 });
    this.mesh = new THREE.InstancedMesh(g, this.mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'debris';
    this.max = max;
    this.items = [];
    this.colors = new Float32Array(max * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);
    applyCurvaturePatch(this.mat);
  }
  clear() { this.items.length = 0; this.mesh.count = 0; }
  /** origin, ground height, size, count, initial speed, direction (unit xz), tArrival, color */
  add({ origin, ground, size = [0.8, 0.3, 0.1], count = 40, speed = 30, dir, t0, color = [0.5, 0.42, 0.34], spread = 6, seed = 1 }) {
    const R = rng(seed);
    for (let i = 0; i < count && this.items.length < this.max; i++) {
      const sx = size[0] * (0.4 + R()), sy = size[1] * (0.4 + R()), sz = size[2] * (0.5 + R());
      const ang = (R() - 0.5) * 0.9;
      const c = Math.cos(ang), s = Math.sin(ang);
      const dx = dir.x * c - dir.z * s, dz = dir.x * s + dir.z * c;
      const v = speed * (0.35 + R() * 0.9);
      this.items.push({
        p: [origin.x + (R() - 0.5) * spread, origin.y + R() * spread * 0.6, origin.z + (R() - 0.5) * spread],
        v: [dx * v, (0.15 + R() * 0.5) * v * 0.5 + 3, dz * v],
        w: [(R() - 0.5) * 20, (R() - 0.5) * 20, (R() - 0.5) * 20],
        s: [sx, sy, sz], ground, t0, k: 0.35 + R() * 0.6,
        col: color.map((x) => x * (0.7 + R() * 0.5)),
      });
    }
  }
  update(t) {
    let n = 0;
    const m = this.mesh;
    for (const it of this.items) {
      const dt = t - it.t0;
      if (dt < 0) continue;
      const k = it.k;
      const e = (1 - Math.exp(-k * dt)) / k;
      let x = it.p[0] + it.v[0] * e;
      let z = it.p[2] + it.v[2] * e;
      // vertical: drag-limited rise, then gravity (terminal velocity ~ g/k)
      let y = it.p[1] + (it.v[1] + 9.81 / k) * e - (9.81 / k) * dt;
      let rest = false;
      if (y < it.ground + it.s[1] * 0.5) { y = it.ground + it.s[1] * 0.5; rest = true; }
      const ang = rest ? Math.min(dt, 3) : dt;
      tmpQ.setFromEuler(new THREE.Euler(it.w[0] * ang * 0.2, it.w[1] * ang * 0.2, it.w[2] * ang * 0.2));
      tmpM.compose(tmpV.set(x, y, z), tmpQ, tmpS.set(it.s[0], it.s[1], it.s[2]));
      m.setMatrixAt(n, tmpM);
      this.colors[n * 3] = it.col[0]; this.colors[n * 3 + 1] = it.col[1]; this.colors[n * 3 + 2] = it.col[2];
      n++;
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    m.instanceColor.needsUpdate = true;
  }
}

// ================================================================== vegetation (GPU reactive)
/**
 * Instanced vegetation whose blast / thermal response runs in the vertex+fragment shader.
 * Per-instance: peak overpressure (psi), thermal fluence (cal/cm²), shock arrival (s), bearing from GZ.
 */
export class Vegetation {
  constructor(geometry, material, instances, { kind = 'shrub' } = {}) {
    const n = instances.length;
    this.mesh = new THREE.InstancedMesh(geometry, material, n);
    this.mesh.name = `veg-${kind}`;
    const aFx = new Float32Array(n * 4);
    const col = new Float32Array(n * 3);
    instances.forEach((it, i) => {
      tmpQ.setFromAxisAngle(UP, it.rot);
      tmpM.compose(tmpV.set(it.x, it.y, it.z), tmpQ, tmpS.set(it.s, it.s * (it.sy || 1), it.s));
      this.mesh.setMatrixAt(i, tmpM);
      aFx[i * 4] = it.psi; aFx[i * 4 + 1] = it.Q; aFx[i * 4 + 2] = it.arr; aFx[i * 4 + 3] = Math.atan2(it.z, it.x);
      col[i * 3] = it.c[0]; col[i * 3 + 1] = it.c[1]; col[i * 3 + 2] = it.c[2];
    });
    geometry.setAttribute('aFx', new THREE.InstancedBufferAttribute(aFx, 4));
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.uniforms = { uT: { value: -10 }, uTherm: { value: 0 }, uIgnite: { value: 10 }, uKind: { value: kind === 'palm' ? 1 : kind === 'tree' ? 2 : 0 } };
    const U = this.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, U);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aFx; uniform float uT; uniform float uTherm; uniform float uIgnite; uniform int uKind;
          varying float vChar; varying float vBurn;
          uniform vec3 uCamPos;
          vec3 applyCurvature(vec3 w) { vec2 d = w.xz - uCamPos.xz; w.y -= dot(d, d) * 7.848e-8; return w; }`)
        .replace('#include <begin_vertex>', `
          vec3 transformed = vec3(position);
          float dt = uT - aFx.z;
          float psi = aFx.x;
          // bend away from ground zero after the shock passes; stripping/flattening at high psi
          float h = max(position.y, 0.0);
          float hn = h / 6.0;
          float bend = 0.0;
          float flatten = 0.0;
          if (dt > 0.0) {
            float peak = clamp(psi / 3.0, 0.0, 1.4);
            float osc = exp(-dt * 1.3) * cos(dt * 7.0);
            bend = peak * (0.6 + 0.6 * osc);
            // afterwind (reverse flow toward the rising fireball) tips survivors back a little later on
            bend -= clamp(psi / 6.0, 0.0, 0.3) * smoothstep(4.0, 14.0, dt);
            flatten = smoothstep(4.0, 9.0, psi);
          }
          vec2 away = vec2(cos(aFx.w), sin(aFx.w));
          // instance rotation is baked in instanceMatrix; express bend in object space approx via inverse yaw
          transformed.y *= mix(1.0, 0.18, flatten);
          transformed.xz += away * bend * hn * hn * 3.5 * (1.0 - flatten * 0.6);
          if (uKind == 1) transformed.xz += away * flatten * hn * 4.0;
          vChar = clamp(uTherm * aFx.y / uIgnite, 0.0, 3.0);
          vBurn = dt > 0.0 ? 0.0 : 1.0;`)
        .replace('#include <project_vertex>', `
          vec4 mvPosition = vec4(transformed, 1.0);
          #ifdef USE_INSTANCING
            // apply rotation+scale from the instance matrix but keep the away-bend in world space
            vec3 bentWorld = (instanceMatrix * vec4(position * vec3(1.0, mix(1.0, 0.18, flatten), 1.0), 1.0)).xyz;
            bentWorld.xz += away * bend * hn * hn * 3.5 * length(instanceMatrix[0].xyz) * (1.0 - flatten * 0.6);
            if (uKind == 1) bentWorld.xz += away * flatten * hn * 4.0 * length(instanceMatrix[0].xyz);
            mvPosition = vec4(bentWorld, 1.0);
          #endif
          mvPosition = modelMatrix * mvPosition;
          mvPosition.xyz = applyCurvature(mvPosition.xyz);
          mvPosition = viewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying float vChar; varying float vBurn; uniform float uT;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          float ch = smoothstep(0.35, 1.0, vChar);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.03, 0.028), ch);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          // flash ignition: glowing embers until the blast wave arrives and snuffs most of them
          float emb = smoothstep(1.0, 2.2, vChar) * (0.4 + 0.6 * vBurn);
          totalEmissiveRadiance += vec3(2.2, 0.55, 0.08) * emb * 0.8;`);
    };
    material.customProgramCacheKey = () => `veg-${kind}`;
  }
  update(t, thermalProgress, igniteThreshold) {
    this.uniforms.uT.value = t;
    this.uniforms.uTherm.value = thermalProgress;
    this.uniforms.uIgnite.value = igniteThreshold;
  }
}

function shrubGeometry() {
  const parts = [];
  const R = rng(7);
  for (let i = 0; i < 6; i++) {
    const g = new THREE.IcosahedronGeometry(0.5 + R() * 0.35, 1);
    g.scale(1, 0.7 + R() * 0.4, 1);
    g.translate((R() - 0.5) * 0.9, 0.45 + R() * 0.5, (R() - 0.5) * 0.9);
    parts.push(g);
  }
  const pos = merge(parts);
  // jitter vertices for an organic silhouette
  const p = pos.attributes.position;
  for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (0.85 + R() * 0.3), p.getY(i) * (0.85 + R() * 0.3), p.getZ(i) * (0.85 + R() * 0.3));
  pos.computeVertexNormals();
  return pos;
}

function palmGeometry() {
  const parts = [];
  // curved trunk
  const segs = 8;
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    const a = new THREE.Vector3(Math.pow(t0, 2) * 1.6, t0 * 11, 0);
    const b = new THREE.Vector3(Math.pow(t1, 2) * 1.6, t1 * 11, 0);
    const g = beam(a, b, 0.42 - t0 * 0.14);
    parts.push(g);
  }
  // fronds: long drooping blades
  const top = new THREE.Vector3(1.6, 11, 0);
  for (let i = 0; i < 9; i++) {
    const ang = (i / 9) * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
    let prev = top.clone();
    for (let k = 1; k <= 4; k++) {
      const p = top.clone().addScaledVector(dir, k * 1.4).add(new THREE.Vector3(0, 0.6 * k - 0.35 * k * k, 0));
      const g = beam(prev, p, 0.12);
      g.scale(1, 1, 1);
      const blade = new THREE.BoxGeometry(1.25, 0.04, 0.9);
      blade.applyMatrix4(new THREE.Matrix4().lookAt(prev, p, UP));
      blade.translate((prev.x + p.x) / 2, (prev.y + p.y) / 2, (prev.z + p.z) / 2);
      parts.push(g, blade);
      prev = p;
    }
  }
  return merge(parts);
}

function treeGeometry() {
  const parts = [cyl(0.18, 0.28, 5, 0, 2.5, 0, 7)];
  const R = rng(3);
  for (let i = 0; i < 7; i++) {
    const g = new THREE.IcosahedronGeometry(1.4 + R() * 0.8, 1);
    g.translate((R() - 0.5) * 2.4, 5 + R() * 2.4, (R() - 0.5) * 2.4);
    parts.push(g);
  }
  return merge(parts);
}

// ================================================================== structures
function frameHouse(R) {
  const w = 8 + R() * 3, d = 7 + R() * 3, h = 2.8;
  const walls = box(w, h * 2, d, 0, h, 0);
  const roofH = 2.6;
  const shape = new THREE.Shape([new THREE.Vector2(-w / 2 - 0.4, 0), new THREE.Vector2(w / 2 + 0.4, 0), new THREE.Vector2(0, roofH)]);
  const roof = new THREE.ExtrudeGeometry(shape, { depth: d + 0.8, bevelEnabled: false });
  roof.translate(0, h * 2, -d / 2 - 0.4);
  const chim = box(0.8, 3, 0.8, w * 0.25, h * 2 + 1.4, 0);
  const porch = box(w * 0.5, 0.2, 1.6, 0, 0.1, d / 2 + 0.8);
  return { walls: merge([walls, porch]), roof: merge([roof, chim]), w, d, h: h * 2 + roofH };
}

export class Structure {
  constructor({ group, walls, roof, wallMat, roofMat, pos, ground, psi, Q, arr, name }) {
    this.group = group; this.pos = pos; this.ground = ground; this.psi = psi; this.Q = Q; this.arr = arr; this.name = name;
    this.wallMat = wallMat; this.roofMat = roofMat;
    this.collapsed = this.psi >= 5;
    this.damaged = this.psi >= 2.5;
    this.baseColor = wallMat.color.clone();
    this.fireGlow = 0;
  }
  update(t, thermalProgress, ignite) {
    const dt = t - this.arr;
    const g = this.group;
    // charring from the thermal pulse (it arrives with the light, before the blast)
    const ch = Math.min(1, Math.max(0, (this.Q * thermalProgress - ignite * 0.5) / (ignite * 1.5)));
    const c = this.baseColor.clone().lerp(new THREE.Color(0.04, 0.035, 0.03), ch);
    this.wallMat.color.copy(c);
    this.roofMat.color.copy(new THREE.Color(1, 1, 1).lerp(new THREE.Color(0.05, 0.05, 0.05), ch));
    // heat-bloom smoke: surfaces facing the flash smoke & flame briefly before the shock blows it out
    const burn = ch > 0.3 ? Math.min(1, ch) * (dt < 0 ? 1 : Math.exp(-dt * 3)) : 0;
    this.wallMat.emissive.setRGB(1.6 * burn, 0.45 * burn, 0.06 * burn);
    if (dt <= 0) {
      g.visible = true; g.rotation.set(0, g.userData.yaw, 0); g.position.set(this.pos.x, this.ground, this.pos.z); g.scale.set(1, 1, 1);
      return;
    }
    if (this.collapsed) {
      // the Upshot-Knothole houses: blown apart within ~0.5 s of arrival
      const k = Math.min(1, dt / 0.35);
      g.visible = k < 1;
      g.scale.set(1, 1 - k * 0.85, 1);
      return;
    }
    // damaged: rack and shake
    const shake = Math.exp(-dt * 2.5) * Math.sin(dt * 30) * Math.min(1, this.psi / 3) * 0.05;
    const lean = this.damaged ? Math.min(0.12, (this.psi - 2) * 0.05) * Math.min(1, dt / 0.4) : 0;
    const bearing = Math.atan2(this.pos.z, this.pos.x);
    g.rotation.set(Math.sin(bearing) * (lean + shake), g.userData.yaw, -Math.cos(bearing) * (lean + shake));
    g.visible = true;
  }
}

// ================================================================== the builders
export class Props {
  constructor(scene, terrain, lab, quality) {
    this.scene = scene;
    this.terrain = terrain;
    this.lab = lab;
    this.quality = quality;
    this.root = new THREE.Group();
    this.root.name = 'props';
    scene.add(this.root);
    this.debris = new DebrisField(quality.debris);
    this.root.add(this.debris.mesh);
    this.items = [];     // objects with update(t, ctx)
    this.structures = [];
    this.veg = [];
    this.materials = {};
  }

  async materialsFor(env) {
    const res = this.quality.texRes;
    const want = ['rusty_metal', 'concrete_wall_008', 'weathered_plank_siding', 'roof_07', 'rusty_painted_metal', 'bark_brown_02'];
    const sets = await Promise.all(want.map((id) => this.lab.loadPBR(id, res)));
    const byId = Object.fromEntries(sets.map((s) => [s.id, s]));
    const mk = (id, repeat, extra = {}) => {
      const m = new THREE.MeshStandardMaterial({ color: 0xffffff, ...extra });
      const TL = this.lab.constructor;
      TL.applyPBR(m, byId[id], repeat);
      applyCurvaturePatch(m);
      return m;
    };
    this.materials = {
      steel: mk('rusty_metal', 1),
      concrete: mk('concrete_wall_008', 1),
      siding: () => mk('weathered_plank_siding', 1),
      roof: () => mk('roof_07', 1),
      hull: mk('rusty_painted_metal', 1, { color: new THREE.Color(0.46, 0.5, 0.54) }),
      deck: mk('weathered_plank_siding', 1, { color: new THREE.Color(0.75, 0.7, 0.62) }),
      bark: mk('bark_brown_02', 1),
      white: (() => { const m = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.35, metalness: 0.2 }); applyCurvaturePatch(m); return m; })(),
      dark: (() => { const m = new THREE.MeshStandardMaterial({ color: 0x1a1c1e, roughness: 0.5, metalness: 0.4 }); applyCurvaturePatch(m); return m; })(),
      earth: (() => { const m = new THREE.MeshStandardMaterial({ color: 0x8a7458, roughness: 1 }); applyCurvaturePatch(m); return m; })(),
    };
  }

  clear() {
    for (const c of [...this.root.children]) if (c !== this.debris.mesh) this.root.remove(c);
    this.debris.clear();
    this.items = []; this.structures = []; this.veg = [];
    this.aircraft = null;
  }

  async build(scenario, env, det) {
    this.clear();
    await this.materialsFor(env);
    const list = scenario.props || [];
    for (const p of list) {
      if (p === 'trinityTower') this.trinityTower(det);
      if (p === 'bunkers') this.bunkers(scenario);
      if (p === 'shrubs') this.shrubs(det, scenario, env);
      if (p === 'palms') this.palms(det, scenario);
      if (p === 'fleet') this.fleet(det);
      if (p === 'tu95') this.tu95(det, scenario);
      if (p === 'testArray') this.testArray(det, env);
    }
  }

  place(obj, x, z, yOff = 0, water = false) {
    const y = water ? 0 : this.terrain.heightAt(x, z);
    obj.position.set(x, y + yOff, z);
    return y;
  }

  // ------------------------------------------------------------ Trinity
  trinityTower(det) {
    const g = new THREE.Group();
    g.name = 'trinity-tower';
    const H = 30.5, base = 8.5, top = 3.2;
    const beams = [];
    const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    const L = (i, y) => { const k = y / H; const s = (base * (1 - k) + top * k) / 2; return new THREE.Vector3(legs[i][0] * s, y, legs[i][1] * s); };
    for (let i = 0; i < 4; i++) beams.push(beam(L(i, 0), L(i, H), 0.35));
    const levels = 7;
    for (let l = 0; l <= levels; l++) {
      const y = (l / levels) * H;
      for (let i = 0; i < 4; i++) beams.push(beam(L(i, y), L((i + 1) % 4, y), 0.18));
      if (l < levels) {
        const y2 = ((l + 1) / levels) * H;
        for (let i = 0; i < 4; i++) {
          beams.push(beam(L(i, y), L((i + 1) % 4, y2), 0.1));
          beams.push(beam(L((i + 1) % 4, y), L(i, y2), 0.1));
        }
      }
    }
    // platform + the corrugated-iron shack that housed the Gadget
    beams.push(box(5, 0.3, 5, 0, H, 0));
    const tower = new THREE.Mesh(merge(beams), this.materials.steel);
    tower.castShadow = true;
    const shack = new THREE.Mesh(merge([box(3.6, 2.6, 3.6, 0, H + 1.45, 0), box(4, 0.2, 4, 0, H + 2.85, 0)]), this.materials.steel);
    shack.castShadow = true;
    // ladder / hoist cable
    const cable = new THREE.Mesh(cyl(0.03, 0.03, H + 2, 1.2, (H + 2) / 2, 0.8, 4), this.materials.dark);
    g.add(tower, shack, cable);
    this.place(g, 0, 0);
    this.root.add(g);
    // "Jumbo" — the 214-ton steel vessel, left on its own tower 800 yd away. It survived.
    const jumbo = new THREE.Group();
    const vessel = new THREE.Mesh(merge([cyl(3.05, 3.05, 7.6, 0, 0, 0, 24, 0, Math.PI / 2), new THREE.SphereGeometry(3.05, 24, 12).translate(3.8, 0, 0), new THREE.SphereGeometry(3.05, 24, 12).translate(-3.8, 0, 0)]), this.materials.steel);
    vessel.position.y = 12;
    vessel.castShadow = true;
    const stand = [];
    for (const [x, z] of [[-4, -3], [4, -3], [-4, 3], [4, 3]]) stand.push(beam(new THREE.Vector3(x, 0, z), new THREE.Vector3(x * 0.6, 12, z * 0.6), 0.4));
    const standM = new THREE.Mesh(merge(stand), this.materials.steel); standM.castShadow = true;
    jumbo.add(vessel, standM);
    this.place(jumbo, 520, -480);
    this.root.add(jumbo);
    this.items.push({
      update: (t) => { g.visible = t < 0; },
    });
    // Jumbo's support tower was flattened; the vessel survived
    const jumboArr = det.arrivalTime(Math.hypot(520, 480));
    this.items.push({
      update: (t) => {
        const dt = t - jumboArr;
        if (dt < 0) { standM.visible = true; vessel.position.set(0, 12, 0); vessel.rotation.set(0, 0, 0); return; }
        const k = Math.min(1, dt / 0.8);
        standM.visible = k < 0.5;
        vessel.position.set(k * 6, 12 - k * 9, 0);
        vessel.rotation.set(0, 0, -k * 0.35);
      },
    });
  }

  bunkers(scenario) {
    for (const o of scenario.observers) {
      if (o.air || o.eye > 30) continue;
      const g = new THREE.Group();
      const bunker = new THREE.Mesh(merge([box(12, 3, 7, 0, 1.5, 0), box(3, 2.4, 1, 0, 1.2, -4)]), this.materials.concrete);
      const mound = new THREE.Mesh(new THREE.SphereGeometry(10, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2).scale(1.4, 0.45, 1), this.materials.earth);
      mound.position.set(0, 0, 3);
      bunker.castShadow = mound.castShadow = true;
      bunker.receiveShadow = mound.receiveShadow = true;
      g.add(bunker, mound);
      const [x, z] = o.pos;
      // bunker sits behind the observer, facing ground zero
      const dir = new THREE.Vector2(-x, -z).normalize();
      this.place(g, x - dir.x * 14, z - dir.y * 14, -0.3);
      g.rotation.y = Math.atan2(dir.x, dir.y);
      this.root.add(g);
    }
  }

  _scatter(n, seed, pick) {
    const R = rng(seed);
    const out = [];
    let guard = 0;
    while (out.length < n && guard++ < n * 20) {
      const p = pick(R);
      if (p) out.push(p);
    }
    return out;
  }

  _vegInstances(pts, det, color, scaleRange, R) {
    const h = Math.max(0, det.hob);
    return pts.map(([x, z, y]) => {
      const D = Math.hypot(Math.hypot(x, z), h - y);
      return {
        x, y, z, s: scaleRange[0] + R() * (scaleRange[1] - scaleRange[0]), rot: R() * Math.PI * 2,
        psi: det.overpressureAtSlant(D) / PSI, Q: det.isUnderwater ? 0 : det.thermalFluence(D), arr: det.arrivalTime(D),
        c: color.map((c) => c * (0.75 + R() * 0.4)),
      };
    });
  }

  shrubs(det, scenario, env) {
    const R = rng(11);
    const T = this.terrain;
    const n = this.quality.veg;
    const centres = [[0, 0, 5500], ...scenario.observers.filter((o) => !o.air && o.eye < 30).map((o) => [o.pos[0], o.pos[1], 900])];
    const pts = [];
    const per = Math.floor(n / centres.length);
    for (const [cx, cz, rad] of centres) {
      for (let i = 0; i < per; i++) {
        const a = R() * Math.PI * 2, r = Math.sqrt(R()) * rad;
        const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        if (Math.hypot(x, z) < 60) continue;
        pts.push([x, z, T.heightAt(x, z)]);
      }
    }
    const snow = env.terrain === 'arctic';
    const color = snow ? [0.18, 0.2, 0.16] : [0.2, 0.22, 0.1];
    const inst = this._vegInstances(pts, det, color, [0.5, 1.4], R);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, flatShading: false });
    const v = new Vegetation(shrubGeometry(), mat, inst, { kind: 'shrub' });
    mat.onBeforeCompile = wrapCurvatureUniform(mat.onBeforeCompile);
    this.root.add(v.mesh);
    this.veg.push(v);
  }

  palms(det, scenario) {
    const R = rng(21);
    const T = this.terrain;
    const pts = [];
    const n = Math.floor(this.quality.veg * 0.4);
    const centres = scenario.observers.filter((o) => !o.air && o.eye < 30).map((o) => [o.pos[0], o.pos[1], 2500]);
    centres.push([0, 0, 25000]);
    let guard = 0;
    while (pts.length < n && guard++ < n * 40) {
      const [cx, cz, rad] = centres[Math.floor(R() * centres.length)];
      const a = R() * Math.PI * 2, r = Math.sqrt(R()) * rad;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const y = T.heightAt(x, z);
      if (y < 1.6) continue;
      pts.push([x, z, y]);
    }
    const inst = this._vegInstances(pts, det, [0.32, 0.36, 0.18], [0.7, 1.25], R);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    const v = new Vegetation(palmGeometry(), mat, inst, { kind: 'palm' });
    mat.onBeforeCompile = wrapCurvatureUniform(mat.onBeforeCompile);
    this.root.add(v.mesh);
    this.veg.push(v);
  }

  // ------------------------------------------------------------ Crossroads fleet
  ship({ length, beam: bm, kind }) {
    const L = length, B = bm;
    const shape = new THREE.Shape();
    shape.moveTo(-L / 2, -B / 2 * 0.8);
    shape.quadraticCurveTo(-L / 2 - B * 0.2, 0, -L / 2, B / 2 * 0.8);
    shape.lineTo(L * 0.2, B / 2);
    shape.quadraticCurveTo(L * 0.45, B / 2 * 0.6, L / 2, 0);
    shape.quadraticCurveTo(L * 0.45, -B / 2 * 0.6, L * 0.2, -B / 2);
    shape.closePath();
    const hullH = kind === 'carrier' ? 14 : kind === 'battleship' ? 11 : 7;
    const hull = new THREE.ExtrudeGeometry(shape, { depth: hullH, bevelEnabled: false });
    hull.rotateX(-Math.PI / 2);
    hull.translate(0, -hullH * 0.45, 0);
    const sup = [];
    const deckY = hullH * 0.55;
    if (kind === 'carrier') {
      sup.push(box(L * 0.95, 1.2, B * 1.35, 0, deckY + 5, 0));
      sup.push(box(L * 0.12, 18, 5, L * 0.08, deckY + 14, B * 0.55));
      sup.push(cyl(2.4, 2.4, 10, L * 0.12, deckY + 24, B * 0.55, 10));
    } else if (kind === 'battleship') {
      sup.push(box(L * 0.22, 9, B * 0.45, 0, deckY + 4.5, 0));
      sup.push(box(L * 0.08, 12, B * 0.25, L * 0.02, deckY + 14, 0));
      sup.push(cyl(2.6, 3, 12, -L * 0.06, deckY + 12, 0, 10));
      for (const x of [L * 0.3, L * 0.18, -L * 0.2, -L * 0.32]) {
        sup.push(cyl(5, 5.5, 3, x, deckY + 1.5, 0, 14));
        for (const dz of [-1.3, 0, 1.3]) sup.push(cyl(0.45, 0.45, 16, x + 8 * Math.sign(x), deckY + 2.2, dz, 6, 0, Math.PI / 2));
      }
    } else if (kind === 'destroyer') {
      sup.push(box(L * 0.25, 5, B * 0.5, L * 0.1, deckY + 2.5, 0));
      sup.push(cyl(1.4, 1.6, 6, -L * 0.05, deckY + 5, 0, 8));
      sup.push(cyl(1.4, 1.6, 6, -L * 0.14, deckY + 5, 0, 8));
      sup.push(box(4, 2, 3, L * 0.32, deckY + 1, 0));
    } else {
      sup.push(box(L * 0.18, 5, B * 0.6, -L * 0.3, deckY + 2.5, 0));
    }
    const g = new THREE.Group();
    const hm = new THREE.Mesh(hull, this.materials.hull);
    const sm = new THREE.Mesh(merge(sup), this.materials.hull);
    hm.castShadow = sm.castShadow = true;
    g.add(hm, sm);
    if (kind === 'carrier') {
      const deck = new THREE.Mesh(box(L * 0.95, 0.3, B * 1.35, 0, deckY + 5.7, 0), this.materials.deck);
      deck.castShadow = true;
      g.add(deck);
    }
    return g;
  }

  fleet(det) {
    const R = rng(46);
    const ships = [
      { name: 'LSM-60', length: 62, beam: 10.5, kind: 'lsm', x: 0, z: 0, yaw: 0.3 },
      { name: 'USS Arkansas', length: 171, beam: 32, kind: 'battleship', x: -150, z: 80, yaw: 1.1 },
      { name: 'USS Saratoga', length: 270, beam: 33, kind: 'carrier', x: 380, z: -300, yaw: -0.4 },
      { name: 'Nagato', length: 215, beam: 34, kind: 'battleship', x: 700, z: 500, yaw: 0.8 },
      { name: 'USS Pensacola', length: 178, beam: 20, kind: 'destroyer', x: -900, z: -600, yaw: 2.1 },
      { name: 'USS New York', length: 175, beam: 29, kind: 'battleship', x: -1400, z: 900, yaw: 0.4 },
    ];
    for (let i = 0; i < 26; i++) {
      const a = R() * Math.PI * 2, r = 500 + R() * 2600;
      ships.push({ name: 'target', length: 95 + R() * 25, beam: 11, kind: 'destroyer', x: Math.cos(a) * r, z: Math.sin(a) * r, yaw: R() * 6 });
    }
    for (const s of ships) {
      const g = this.ship(s);
      g.position.set(s.x, 0, s.z);
      g.rotation.y = s.yaw;
      this.root.add(g);
      const r = Math.hypot(s.x, s.z);
      const arr = det.arrivalTime(r);
      const phase = R() * 6;
      const isZero = s.name === 'LSM-60';
      const isArk = s.name === 'USS Arkansas';
      this.items.push({
        update: (t, ctx) => {
          // gentle swell
          let y = Math.sin(ctx.time * 0.7 + phase) * 0.35;
          let rx = Math.sin(ctx.time * 0.5 + phase) * 0.012, rz = Math.cos(ctx.time * 0.6 + phase) * 0.01;
          g.visible = true;
          if (isZero && t > 0) { g.visible = false; return; }
          if (isArk && t > 0) {
            // Arkansas: heaved up into the column's base, stood on end, and gone under within seconds
            const k = Math.min(1, t / 1.2);
            y += Math.sin(Math.min(t, 3) / 3 * Math.PI) * 55 * k - Math.max(0, t - 3) * 8;
            rx += k * 1.25;
            if (t > 14) g.visible = false;
          } else if (t > 0) {
            // radial gravity wave passes
            const c = 23, front = c * t;
            const env = Math.exp(-(((r - front * 0.8) / (front * 0.35 + 60)) ** 2)) * (r < front + 200 ? 1 : 0);
            const A = 29 * 300 / Math.max(r, 300) * env;
            y += A * Math.sin(2 * Math.PI / 180 * (r - front));
            if (t > arr) {
              const dt = t - arr;
              rz += Math.exp(-dt * 0.8) * Math.sin(dt * 3) * Math.min(0.15, 40 / r);
            }
          }
          g.position.y = y;
          g.rotation.set(rx, s.yaw, rz);
        },
      });
    }
  }

  // ------------------------------------------------------------ Tu-95V + the falling bomb
  tu95(det, scenario) {
    const white = this.materials.white;
    const plane = new THREE.Group();
    plane.name = 'tu95v';
    const parts = [];
    parts.push(cyl(1.45, 1.45, 36, 0, 0, 0, 16, 0, Math.PI / 2));
    parts.push(new THREE.ConeGeometry(1.45, 6, 16).rotateZ(-Math.PI / 2).translate(21, 0, 0));
    parts.push(new THREE.ConeGeometry(1.45, 9, 16).rotateZ(Math.PI / 2).translate(-22.5, 0.4, 0));
    // swept wings (35°)
    const wing = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(-13, 25), new THREE.Vector2(-16.5, 25), new THREE.Vector2(-8, 0)]);
    const wg = new THREE.ExtrudeGeometry(wing, { depth: 0.6, bevelEnabled: false });
    wg.rotateX(Math.PI / 2); wg.translate(4, 0, 0);
    const wg2 = wg.clone().scale(1, 1, -1);
    parts.push(wg, wg2);
    const tail = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(-7, 8), new THREE.Vector2(-9.5, 8), new THREE.Vector2(-6, 0)]);
    const tg = new THREE.ExtrudeGeometry(tail, { depth: 0.4, bevelEnabled: false });
    tg.translate(-16, 1, -0.2);
    parts.push(tg);
    const hs = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(-4, 7), new THREE.Vector2(-6, 7), new THREE.Vector2(-5, 0)]);
    const hg = new THREE.ExtrudeGeometry(hs, { depth: 0.3, bevelEnabled: false });
    hg.rotateX(Math.PI / 2); hg.translate(-17, 0.8, 0);
    parts.push(hg, hg.clone().scale(1, 1, -1));
    const props = [];
    for (const zz of [-7, -14, 7, 14]) {
      const x = 4 - Math.abs(zz) * 0.52;
      parts.push(cyl(0.8, 0.9, 7, x + 1, -0.2, zz, 10, 0, Math.PI / 2));
      const disc = new THREE.Mesh(new THREE.CircleGeometry(2.8, 20).rotateY(Math.PI / 2).translate(x + 4.6, -0.2, zz),
        new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
      props.push(disc);
    }
    const body = new THREE.Mesh(merge(parts), white);
    body.castShadow = true;
    plane.add(body, ...props);
    plane.scale.setScalar(1);
    this.root.add(plane);

    // bomb + parachute
    const bombG = new THREE.Group();
    const bomb = new THREE.Mesh(merge([cyl(1.05, 1.05, 6, 0, 0, 0, 16), new THREE.SphereGeometry(1.05, 16, 8).translate(0, -3, 0), new THREE.ConeGeometry(1.05, 2, 16).rotateX(Math.PI).translate(0, 4, 0).scale(1, -1, 1)]), this.materials.white);
    const chute = new THREE.Mesh(new THREE.SphereGeometry(18, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2.4), new THREE.MeshStandardMaterial({ color: 0xd8c9a8, roughness: 0.9, side: THREE.DoubleSide }));
    chute.position.y = 55;
    const lines = new THREE.Mesh(new THREE.ConeGeometry(12, 50, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0x777777, wireframe: true }));
    lines.position.y = 29;
    bombG.add(bomb, chute, lines);
    this.root.add(bombG);

    const obs = scenario.observers.find((o) => o.id === 'tu95');
    const [px, pz] = obs.pos;
    const arr = det.arrivalTime(Math.hypot(Math.hypot(px, pz), obs.eye - det.hob));
    this.items.push({
      update: (t) => {
        // aircraft flying away from GZ at ~ 230 m/s
        const x = px - 230 * t;
        let y = obs.eye;
        let roll = Math.sin(t * 0.3) * 0.01, pitch = 0;
        if (t > arr) {
          const dt = t - arr;
          y -= Math.min(1000, 1000 * (1 - Math.exp(-dt / 6)));
          pitch = Math.exp(-dt * 0.4) * Math.sin(dt * 6) * 0.08;
          roll += Math.exp(-dt * 0.3) * Math.sin(dt * 4.3) * 0.1;
        }
        plane.position.set(x, y, pz);
        plane.rotation.set(roll, Math.PI, pitch);
        // bomb descending under canopy (≈34 m/s) until detonation
        bombG.visible = t < 0;
        bombG.position.set(0, det.hob - t * 34, 0);
      },
      follow: plane,
    });
    this.aircraft = plane;
  }

  // ------------------------------------------------------------ sandbox test array
  testArray(det, env) {
    const R = rng(99);
    const ranges = [350, 600, 900, 1300, 1800, 2400, 3200, 4200, 5500, 7000, 9000, 12000, 15000, 19000, 24000];
    const h = Math.max(0, det.hob);
    const water = env.water;
    for (const [i, r] of ranges.entries()) {
      const ang = (R() - 0.5) * 0.12;
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r + 60;
      const ground = water ? Math.max(0, this.terrain.heightAt(x, z)) : this.terrain.heightAt(x, z);
      if (water && this.terrain.heightAt(x, z) < 0.2) continue;
      const D = Math.hypot(Math.hypot(x, z), h - ground);
      const psi = det.overpressureAtSlant(D) / PSI;
      const Q = det.isUnderwater ? 0 : det.thermalFluence(D);
      const arr = det.arrivalTime(D);
      const hs = frameHouse(R);
      const wallMat = this.materials.siding();
      const roofMat = this.materials.roof();
      wallMat.emissive = new THREE.Color(0, 0, 0);
      const g = new THREE.Group();
      const wm = new THREE.Mesh(hs.walls, wallMat);
      const rm = new THREE.Mesh(hs.roof, roofMat);
      wm.castShadow = rm.castShadow = wm.receiveShadow = rm.receiveShadow = true;
      g.add(wm, rm);
      g.userData.yaw = Math.atan2(-x, -z) + (R() - 0.5) * 0.4;
      g.rotation.y = g.userData.yaw;
      g.position.set(x, ground, z);
      this.root.add(g);
      const s = new Structure({ group: g, walls: wm, roof: rm, wallMat, roofMat, pos: new THREE.Vector3(x, ground, z), ground, psi, Q, arr, name: `House ${(r / 1000).toFixed(1)} km` });
      this.structures.push(s);
      if (s.collapsed) {
        const dir = new THREE.Vector3(x, 0, z).normalize();
        const wind = Math.min(180, 20 + psi * 9);
        this.debris.add({ origin: new THREE.Vector3(x, ground + 2, z), ground, size: [2.2, 0.25, 0.12], count: 70, speed: wind, dir, t0: arr, color: [0.55, 0.47, 0.38], spread: 8, seed: i * 7 + 1 });
        this.debris.add({ origin: new THREE.Vector3(x, ground + 6, z), ground, size: [1.4, 0.08, 1.1], count: 25, speed: wind * 1.1, dir, t0: arr, color: [0.3, 0.26, 0.24], spread: 7, seed: i * 7 + 2 });
      }
      // a utility pole and a parked car beside each house
      const pole = new THREE.Mesh(merge([cyl(0.15, 0.2, 10, 0, 5, 0, 6), box(2.2, 0.15, 0.15, 0, 9.3, 0)]), this.materials.bark);
      pole.castShadow = true;
      pole.position.set(x + 14, ground, z - 10);
      this.root.add(pole);
      const car = new THREE.Mesh(merge([box(4.6, 0.9, 1.8, 0, 0.75, 0), box(2.6, 0.7, 1.6, -0.2, 1.55, 0)]), this.materials.hull.clone());
      car.material.color.setHSL(R(), 0.35, 0.35);
      car.castShadow = true;
      car.position.set(x - 8, ground, z + 9);
      car.rotation.y = R() * 3;
      this.root.add(car);
      const carBase = car.position.clone();
      const carYaw = car.rotation.y;
      this.items.push({
        update: (t) => {
          const dt = t - arr;
          const pDown = psi > 4;
          pole.rotation.set(0, 0, 0);
          if (dt > 0 && psi > 2) {
            const k = Math.min(1, dt / 0.6);
            const b = Math.atan2(z, x);
            const tilt = (pDown ? Math.PI / 2 : Math.min(0.5, (psi - 2) * 0.2)) * k;
            pole.rotation.set(Math.sin(b) * tilt, 0, -Math.cos(b) * tilt);
          }
          car.position.copy(carBase); car.rotation.set(0, carYaw, 0);
          if (dt > 0 && psi > 3) {
            const tt = Math.min(dt, 4);
            const v = Math.min(60, psi * 4);
            const dir = new THREE.Vector3(x, 0, z).normalize();
            const d = v * (1 - Math.exp(-tt)) ;
            car.position.addScaledVector(dir, d);
            car.rotation.set(Math.min(tt * 3, psi > 8 ? 9 : 1.6) * Math.sin(Math.atan2(z, x)), carYaw, -Math.min(tt * 3, psi > 8 ? 9 : 1.6) * Math.cos(Math.atan2(z, x)));
          }
        },
      });
    }
    // rows of trees along the array
    const pts = [];
    for (let r = 250; r < 26000; r += 70 + R() * 90) {
      for (let k = 0; k < 3; k++) {
        const x = r + (R() - 0.5) * 40, z = (R() - 0.5) * 180 + 60 + (k - 1) * 90;
        const y = this.terrain.heightAt(x, z);
        if (water && y < 0.3) continue;
        pts.push([x, z, y]);
      }
    }
    const inst = this._vegInstances(pts, det, [0.16, 0.24, 0.1], [0.8, 1.3], R);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    const v = new Vegetation(treeGeometry(), mat, inst, { kind: 'tree' });
    mat.onBeforeCompile = wrapCurvatureUniform(mat.onBeforeCompile);
    this.root.add(v.mesh);
    this.veg.push(v);
  }

  update(t, ctx) {
    for (const it of this.items) it.update(t, ctx);
    for (const s of this.structures) s.update(t, ctx.thermalProgress, ctx.ignite);
    for (const v of this.veg) v.update(t, ctx.thermalProgress, ctx.ignite);
    this.debris.update(t);
  }
}

/** Vegetation shaders declare uCamPos themselves; bind it to the shared curvature uniform. */
import { curvatureUniforms } from './curvature.js';
function wrapCurvatureUniform(prev) {
  return (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uCamPos = curvatureUniforms.uCamPos;
  };
}
