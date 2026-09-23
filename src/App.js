import * as THREE from 'three';
import { Detonation, blackbodyRGB, PSI, CAL_CM2 } from './physics/effects.js';
import { ENVIRONMENTS, getScenario } from './physics/scenarios.js';
import { TextureLab } from './assets/TextureLab.js';
import { Terrain, HEIGHT_GLSL } from './world/Terrain.js';
import { Ocean } from './world/Ocean.js';
import { Props } from './world/Props.js';
import { curvatureUniforms } from './world/curvature.js';
import { EARTH_R } from './world/noise.js';
import { VolumeFX } from './fx/VolumeFX.js';
import { Pipeline } from './render/Pipeline.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { CameraRig } from './CameraRig.js';

export const QUALITY = {
  low: { name: 'Low', pixelRatio: 0.7, volScale: 0.33, volSteps: 40, shadow: 1024, texRes: '1k', hdrRes: '1k', samples: 0, veg: 2500, debris: 1200 },
  medium: { name: 'Medium', pixelRatio: 1, volScale: 0.45, volSteps: 60, shadow: 2048, texRes: '1k', hdrRes: '2k', samples: 2, veg: 5000, debris: 2500 },
  high: { name: 'High', pixelRatio: 1.25, volScale: 0.5, volSteps: 84, shadow: 2048, texRes: '2k', hdrRes: '2k', samples: 4, veg: 9000, debris: 4000 },
  ultra: { name: 'Ultra', pixelRatio: 2, volScale: 0.7, volSteps: 128, shadow: 4096, texRes: '2k', hdrRes: '4k', samples: 4, veg: 15000, debris: 5000 },
};

const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

export class App {
  constructor(canvas, { quality = 'high' } = {}) {
    this.canvas = canvas;
    this.qualityKey = quality;
    this.quality = QUALITY[quality];
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false, alpha: false });
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.autoClear = false;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.5, 700000);
    this.camera.position.set(0, 2, 9000);
    this.scene.add(this.camera);

    this.lab = new TextureLab(renderer);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.terrain = new Terrain();
    this.scene.add(this.terrain.mesh);
    this.ocean = new Ocean(this.terrain.uniforms, HEIGHT_GLSL);
    this.scene.add(this.ocean.mesh);
    this.props = new Props(this.scene, this.terrain, this.lab, this.quality);
    this.volume = new VolumeFX();
    this.volume.setQuality(this.quality);
    this.pipeline = new Pipeline(renderer);
    this.pipeline.setSamples(this.quality.samples);
    this.audio = new AudioEngine();
    this.rig = new CameraRig(this.camera, canvas, this);

    // ---- lights
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(this.quality.shadow, this.quality.shadow);
    const sc = this.sun.shadow.camera;
    sc.left = -450; sc.right = 450; sc.top = 450; sc.bottom = -450; sc.near = 10; sc.far = 60000;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);

    this.flash = new THREE.SpotLight(0xffffff, 0, 0, 0.3, 0.8, 2);
    this.flash.castShadow = true;
    this.flash.shadow.mapSize.set(2048, 2048);
    this.flash.shadow.bias = -0.0002;
    this.flash.shadow.camera.near = 10;
    this.scene.add(this.flash, this.flash.target);
    this.flashFill = new THREE.PointLight(0xffffff, 0, 0, 2);
    this.scene.add(this.flashFill);
    this.skyFlash = new THREE.HemisphereLight(0xbfd6ff, 0x806a55, 0);
    this.scene.add(this.skyFlash);

    // ---- simulation state
    this.t = -12;
    this.playing = false;
    this.rate = 1;
    this.tStart = -12;
    this.tEnd = 600;
    this.exposure = 1;
    this.params = null;
    this.scenario = null;
    this.env = null;
    this.det = null;
    this.ringsOn = true;
    this.photo = false;
    this.sky = null;
    this.skyPreset = 'scenario';
    this.listeners = {};
    this.lastFrame = performance.now();
    this.realTime = 0;
    this.lightInfo = {
      sunDir: new THREE.Vector3(0, 1, 0), sunColor: new THREE.Color(1, 1, 1),
      ambTop: new THREE.Color(), ambBot: new THREE.Color(), fogCol: new THREE.Color(), fogDen: 1e-5, curvDrop: 0,
    };
    this.fx = {
      shock: new THREE.Vector4(), heat: new THREE.Vector4(), burst: new THREE.Vector3(), burstUV: new THREE.Vector2(),
      flash: new THREE.Vector3(), visibility: 40000, exposure: 1, bloom: 0.05, ca: 0.2, photo: false, white: 0,
      bloomThreshold: 1.2, lift: new THREE.Vector3(0, 0, 0), gain: new THREE.Vector3(1, 1, 1), saturation: 1,
    };
    this.report = null;
    this.frameMs = 16;
    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, data) { for (const fn of this.listeners[ev] || []) fn(data); }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ratio = Math.max(0.5, Math.min(dpr, this.quality.pixelRatio));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    const bw = Math.floor(w * ratio), bh = Math.floor(h * ratio);
    this.pipeline.setSize(bw, bh);
    this.volume.setSize(bw, bh);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setQuality(key) {
    this.qualityKey = key;
    this.quality = QUALITY[key];
    this.props.quality = this.quality;
    this.volume.setQuality(this.quality);
    this.pipeline.setSamples(this.quality.samples);
    this.sun.shadow.mapSize.set(this.quality.shadow, this.quality.shadow);
    this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
    this._resize();
    if (this.scenario) this.rebuild({ textures: true });
  }

  // ------------------------------------------------------------------ scenarios
  async loadScenario(id, overrides = {}) {
    const sc = getScenario(id);
    this.scenario = sc;
    this.params = {
      yieldKt: sc.yieldKt, hob: sc.hob, medium: sc.medium, env: sc.env,
      humidity: ENVIRONMENTS[sc.env].humidity, historical: true, ...overrides,
    };
    this.skyPreset = 'scenario';
    this.observerId = sc.defaultObserver;
    await this.rebuild({ textures: true, sky: true, resetTime: true });
    this.rig.setObserver(sc.observers.find((o) => o.id === this.observerId));
    this.emit('scenario', sc);
  }

  /** Called when yield / height / environment changes. */
  async setParams(p) {
    const envChanged = p.env && p.env !== this.params.env;
    Object.assign(this.params, p, { historical: false });
    // derive medium from burst height + environment
    const env = ENVIRONMENTS[this.params.env];
    if (this.params.hob < 0) this.params.medium = env.water ? 'underwater' : 'surface';
    else if (this.params.hob <= 3) this.params.medium = 'surface';
    else this.params.medium = 'air';
    if (envChanged) this.params.humidity = env.humidity;
    await this.rebuild({ textures: envChanged, sky: envChanged });
  }

  _makeDetonation() {
    const P = this.params, env = ENVIRONMENTS[P.env];
    const sc = this.scenario;
    let crater = null;
    if (P.historical && sc.crater) crater = sc.crater;
    let hob = P.hob;
    if (P.medium === 'underwater' && !env.water) hob = 0;
    const det = new Detonation({
      yieldKt: P.yieldKt, hob, medium: P.medium, visibility: env.visibility, humidity: P.humidity,
      crater, groundType: env.groundType,
    });
    // cumulative thermal-energy fraction table (for scorching / ignition over the pulse)
    const N = 200;
    const ts = [], cum = [];
    let acc = 0, prevT = 0;
    const t0 = det.tMin * 0.01, t1 = det.tMax * 60;
    for (let i = 0; i <= N; i++) {
      const t = t0 * Math.pow(t1 / t0, i / N);
      acc += det.thermalPower(t) * (t - prevT);
      prevT = t; ts.push(t); cum.push(acc);
    }
    det._thT = ts; det._thC = cum.map((c) => c / acc);
    det.thermalProgress = (t) => {
      if (t <= t0) return 0;
      if (t >= t1) return 1;
      const k = Math.log(t / t0) / Math.log(t1 / t0) * N;
      const i = Math.floor(k);
      return det._thC[i] + (det._thC[Math.min(N, i + 1)] - det._thC[i]) * (k - i);
    };
    return det;
  }

  async rebuild({ textures = false, sky = false, resetTime = false } = {}) {
    const P = this.params;
    const env = ENVIRONMENTS[P.env];
    this.env = env;
    this.det = this._makeDetonation();
    const det = this.det;
    this.tEnd = Math.max(300, Math.min(1500, det.stabilizeTime * 2.2));
    if (resetTime) { this.t = this.tStart; this.playing = false; }

    // terrain
    this.terrain.setType(env.terrain);
    if (P.env === 'lagoon') { this.terrain.atollCenter.set(9000, 6000); this.terrain.atollAxes.set(18000, 9500); }
    if (P.env === 'atoll') { this.terrain.atollCenter.set(11300, 11300); this.terrain.atollAxes.set(20000, 13700); }
    this.ocean.mesh.visible = env.water;
    if (env.terrain === 'arctic') this.ocean.setPalette([0.01, 0.03, 0.05], [0.05, 0.16, 0.2], 1.2);
    else if (env.id === 'atoll') this.ocean.setPalette([0.008, 0.045, 0.09], [0.06, 0.5, 0.5], 1.1);
    else this.ocean.setPalette([0.01, 0.06, 0.1], [0.08, 0.55, 0.52], 0.8);
    const TU = this.terrain.uniforms;
    TU.uDustColor.value.setRGB(...env.dustColor);
    TU.uBurnThresh.value = det.burnThreshold(3);
    this.terrain.crater.set(det.crater ? det.crater.radius : 0, det.crater ? det.crater.depth : 0, 0, 0);
    TU.uGlass.value.set(det.crater?.glass ? det.crater.glassRadius || det.crater.radius * 4 : 0, 0, det.crater?.glass ? 1 : 0);
    this.terrain.setRings(det.rings(), this.ringsOn);

    const jobs = [];
    if (textures || !this._texEnv || this._texEnv !== env.id) {
      this._texEnv = env.id;
      const res = this.quality.texRes;
      const t = env.textures;
      jobs.push(Promise.all([t.base, t.detail, t.rock, t.special].map((id) => this.lab.loadPBR(id, res))).then((sets) => {
        const tint = env.terrain === 'desert' ? [1.02, 0.98, 0.94] : [1, 1, 1];
        this.terrain.setTextures(sets, tint);
        const scale = env.terrain === 'arctic' ? [1 / 9, 1 / 40, 1 / 16] : [1 / 5, 1 / 7, 1 / 14];
        TU.uScale0.value = scale[0]; TU.uScale1.value = scale[1]; TU.uScale2.value = scale[2];
      }));
    }
    if (sky || !this.sky) jobs.push(this.applySky(this.skyPreset));
    jobs.push(this.props.build(this.scenario, env, det));
    await Promise.all(jobs);
    this.audio.setBed(env.id);
    this._buildAudioEvents();
    this.emit('rebuild', { det, env });
  }

  async applySky(presetId) {
    this.skyPreset = presetId;
    const id = presetId === 'scenario' ? this.env.hdri : presetId;
    const sky = await this.lab.loadHDRI(id, this.quality.hdrRes);
    if (this.skyPreset !== presetId) return;
    this.sky = sky;
    const env = this.env;
    if (this._envRT) this._envRT.dispose();
    this._envRT = this.pmrem.fromEquirectangular(sky.texture);
    this.scene.environment = this._envRT.texture;
    this.scene.background = sky.texture;
    const night = id.includes('night');
    this.scene.backgroundIntensity = env.bgIntensity * (night ? 1.6 : 1);
    this.scene.environmentIntensity = env.envIntensity * (night ? 1.8 : 1);
    const sd = sky.sunDir.clone();
    const elev = sd.y;
    this.lightInfo.sunDir.copy(sd.y < 0.03 ? new THREE.Vector3(sd.x, 0.03, sd.z).normalize() : sd);
    this.lightInfo.sunColor.copy(sky.sunColor);
    const sunStrength = night ? 0.02 : smooth(-0.05, 0.12, elev) * Math.min(3.2, 0.9 + sky.sunPeak / 400);
    this.sunStrength = sunStrength;
    this.sun.color.copy(sky.sunColor);
    this.sun.intensity = sunStrength;
    const skyL = Math.min(2, sky.skyLum) * env.bgIntensity;
    this.skyLum = skyL;
    this.lightInfo.ambTop.setRGB(0.55, 0.65, 0.85).multiplyScalar(skyL * 0.9 + 0.01);
    this.lightInfo.ambBot.setRGB(...env.dustColor).multiplyScalar(skyL * 0.35 + 0.005);
    this.lightInfo.fogCol.setRGB(...env.fog).multiplyScalar(skyL * 0.85 + 0.005);
    this.lightInfo.fogDen = env.fogDensity;
    this.scene.fog = new THREE.FogExp2(this.lightInfo.fogCol.clone(), env.fogDensity);
    // exposure: bring the ambient scene to a pleasant key
    this.baseExposure = env.exposure * Math.min(8, 0.9 / Math.max(0.06, skyL * 0.8 + sunStrength * 0.18));
    this.emit('sky', { id });
  }

  _buildAudioEvents() {
    const det = this.det;
    const events = [];
    for (let k = 10; k >= 1; k--) events.push({ id: `beep${k}`, t: -k, fire: () => this.audio.beep(k <= 3 ? 1200 : 1000, 0.12, 0.1) });
    events.push({ id: 'emp', t: 0, fire: () => this.audio.emp(1) });
    this.audioEvents = events;
    this._blastEvent = null;
  }

  // ------------------------------------------------------------------ time
  play() { if (this.t >= this.tEnd) this.t = this.tStart; this.playing = true; this.audio.init(); this.emit('play'); }
  pause() { this.playing = false; this.emit('pause'); }
  toggle() { this.playing ? this.pause() : this.play(); }
  detonate() { this.t = -3.2; this.play(); }
  reset() { this.t = this.tStart; this.playing = false; this.emit('pause'); }
  seek(t) { this.t = Math.max(this.tStart, Math.min(this.tEnd, t)); }
  setRate(r) { this.rate = r; this.emit('rate', r); }

  setRings(on) { this.ringsOn = on; this.terrain.setRings(this.det.rings(), on); }

  setPhoto(on) {
    this.photo = on;
    if (on) {
      this.pause();
      this.seek(this.scenario.photo?.t ?? 0.001);
    }
    this.emit('photo', on);
  }

  // ------------------------------------------------------------------ frame
  frame() {
    const now = performance.now();
    const dtReal = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.frameMs = this.frameMs * 0.95 + (now - this.lastFrame) * 0.05;
    this.lastFrame = now;
    this.realTime += dtReal;
    if (!this.det) return;
    if (this.playing) {
      // adaptive slow-mo right at detonation would be jarring; honour the user's rate
      this.t += dtReal * this.rate;
      if (this.t >= this.tEnd) { this.t = this.tEnd; this.pause(); }
    }
    const t = this.t;
    const det = this.det;
    this.rig.update(dtReal, t);
    const cam = this.camera;
    curvatureUniforms.uCamPos.value.copy(cam.position);
    this.terrain.update(cam);
    this.ocean.update(cam, this.realTime);
    // camera near plane adapts to altitude above ground
    const ground = this.terrain.surfaceAt(cam.position.x, cam.position.z, this.env.water);
    const agl = Math.max(0.5, cam.position.y - ground);
    const near = Math.min(50, Math.max(0.3, agl * 0.25));
    if (Math.abs(near - cam.near) > 0.05) { cam.near = near; cam.updateProjectionMatrix(); }

    this._updateEffects(t, dtReal);
    this.props.update(t, { time: this.realTime, thermalProgress: this._thermalProg, ignite: this._ignite });
    const camDist = Math.hypot(cam.position.x, cam.position.z);
    this.lightInfo.curvDrop = (camDist * camDist) / (2 * EARTH_R) + 200;
    this.volume.update(det.isUnderwater && t > 0 ? det : det, t, { ...this.env, humidity: this.params.humidity }, this.scenario, this.lightInfo, this.realTime);
    this._updateLighting(t, dtReal);

    // audio
    this._updateAudio(t, dtReal);

    this.pipeline.render(this.scene, cam, this.volume, this.fx, this.realTime);
    this.emit('frame', { t, dtReal });
  }

  _updateEffects(t, dtReal) {
    const det = this.det;
    const TU = this.terrain.uniforms;
    const hob = Math.max(0, det.hob);
    // thermal
    const prog = t > 0 ? det.thermalProgress(t) : 0;
    this._thermalProg = prog;
    this._ignite = 9 * Math.pow(det.W / 20, 0.06);
    TU.uThermal.value.set(det.thermalEnergy / (4 * Math.PI) / CAL_CM2, det.visibility, prog, hob);
    // crater forms during the first seconds
    if (det.crater) {
      const cp = smooth(det.tMax * 0.5, det.tMax * 6 + 0.3, t);
      this.terrain.crater.z = cp;
      TU.uGlass.value.y = cp;
    } else this.terrain.crater.z = 0;
    // shock on the ground
    const R = t > 0 ? det.shockRadius(t) : 0;
    const groundR = hob > 0 ? Math.sqrt(Math.max(0, R * R - hob * hob)) : R;
    const psiFront = t > 0 ? det.overpressureAtSlant(Math.max(R, 1)) / PSI : 0;
    const dustAmt = det.isUnderwater ? 0 : Math.min(1, psiFront / 4) * (det.groundType === 'snow' ? 0.7 : 1);
    TU.uShock.value.set(groundR, t > 0 && groundR > 0 ? Math.min(0.8, psiFront / 3) : 0, dustAmt * (1 - smooth(30, 200, t)), t);
    // ground glow under a surface fireball
    const glow = t > 0 && det.surfaceFactor > 0.3 && !det.isUnderwater ? det.fireballLuminance(t) * det.surfaceFactor : 0;
    const bb = blackbodyRGB(Math.max(1200, det.fireballTemperature(t)));
    const gl = Math.min(60, glow * 30 + (t > 0 ? 3 * Math.exp(-t / (5 + det.tToroid)) * det.surfaceFactor : 0));
    TU.uGroundGlow.value.set(bb[0] * gl, bb[1] * gl, bb[2] * gl, det.Rmax * 1.1);
    // ocean
    const OU = this.ocean.uniforms;
    OU.uShock.value.set(groundR, t > 0 && this.env.water ? Math.min(1, psiFront / 2) * (1 - smooth(60, 240, t)) : 0, 0, 0);
    if (det.isUnderwater) {
      const vU = this.volume.material.uniforms;
      OU.uBaker.value.set(Math.max(0, t), t > 0 ? 1 : 0, vU.uBakerB.value.x, vU.uBakerB.value.z);
    } else OU.uBaker.value.set(0, 0, 0, 0);
  }

  _updateLighting(t, dtReal) {
    const det = this.det;
    const cam = this.camera;
    const V = this.volume.state;
    const fireY = V.active ? V.fireY : Math.max(0, det.hob);
    const burst = new THREE.Vector3(0, fireY, 0);
    const D = Math.max(1, cam.position.distanceTo(burst));
    // flash irradiance at the camera (W/m²) → scene units (sun ≈ 3 per 1000 W/m²)
    const P = t > 0 ? det.thermalPower(t) : 0;
    const tau = Math.exp(-D / (det.visibility * 0.75));
    const peakPower = det.thermalEnergy / (det.tMax * 2.22);
    let irr = (peakPower * P * tau) / (4 * Math.PI * D * D);
    if (det.isUnderwater) irr = t > 0 ? (det.E * 1e-4 * Math.exp(-t / 0.05) * tau) / (4 * Math.PI * D * D) : 0;
    // late fireball glow (it glowed for many seconds, lighting the desert at night)
    const glowI = V.active ? V.glow * det.E * 2e-6 / (4 * Math.PI * D * D) * tau : 0;
    const flashUnits = Math.min(4e4, ((irr + glowI) / 1000) * 3);
    this.flashUnits = flashUnits;
    const T = t > 0 ? det.fireballTemperature(t) : 6000;
    const bb = blackbodyRGB(T < 2500 && glowI > irr ? 1900 : T);
    const col = new THREE.Color(bb[0], bb[1], bb[2]);
    // spot light (with shadows) aimed at the region around the camera
    const focus = this.rig.focusPoint();
    const Df = Math.max(1, focus.distanceTo(burst));
    this.flash.position.copy(burst);
    this.flash.target.position.copy(focus);
    this.flash.color.copy(col);
    const cover = Math.max(400, Df * 0.25);
    this.flash.angle = Math.min(1.4, Math.atan(cover / Df));
    this.flash.intensity = flashUnits * D * D;
    this.flash.shadow.camera.far = Df * 2 + 1000;
    this.flash.shadow.camera.near = Math.max(5, Df * 0.02);
    this.flash.castShadow = flashUnits > 0.05;
    this.flash.visible = flashUnits > 1e-4;
    // point fill for everything outside the spot cone (no shadows)
    this.flashFill.position.copy(burst);
    this.flashFill.color.copy(col);
    this.flashFill.intensity = flashUnits * D * D * 0.35;
    this.flashFill.visible = flashUnits > 1e-4;
    // sky scattering of the flash (the whole sky lights up)
    this.skyFlash.intensity = Math.min(200, flashUnits * 0.12);

    // sun shadow follows the camera focus
    const sd = this.lightInfo.sunDir;
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(sd, 20000);
    const ext = Math.min(3000, Math.max(250, cam.position.distanceTo(focus) * 0.7));
    const sc = this.sun.shadow.camera;
    if (Math.abs(sc.right - ext) > 1) { sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.updateProjectionMatrix(); }

    // ------ eye adaptation / exposure
    const ambient = (this.sunStrength || 0) + (this.skyLum || 0.1) * 1.2 + 0.02;
    const ratio = flashUnits / ambient;
    // luminance of the fireball as seen: big close fireballs dominate the frame
    const fbAng = V.active ? Math.min(1, (V.Rf || 0) / D) : 0;
    const fbLum = V.active ? Math.max(...V.fe) * fbAng * fbAng * 2 : 0;
    const target = this.photo ? this.baseExposure * 0.02 : this.baseExposure / (1 + ratio * 0.9 + fbLum * 0.4);
    const k = target < this.exposure ? 1 - Math.exp(-dtReal / 0.06) : 1 - Math.exp(-dtReal / 1.8);
    this.exposure += (target - this.exposure) * k;
    if (!isFinite(this.exposure)) this.exposure = this.baseExposure;
    const fx = this.fx;
    fx.exposure = this.exposure;
    // sensor/retina white-out: only the brief first pulse, only when the flash dwarfs the ambient light
    fx.white = this.photo || t <= 0 ? 0 : Math.min(0.5, ratio * 0.0004) * Math.exp(-t / (det.tMin * 3));
    fx.ca = 0.25 + Math.min(3, ratio * 0.01);
    fx.bloom = 0.045 + Math.min(0.12, fbLum * 0.0002);
    fx.bloomThreshold = 1.4 / Math.max(0.2, this.exposure);
    fx.photo = this.photo;
    fx.visibility = det.visibility;
    fx.burst.copy(burst);
    fx.flash.set(col.r, col.g, col.b).multiplyScalar(Math.min(1500, flashUnits * 0.06));
    // project burst to screen
    const p = burst.clone().project(cam);
    fx.burstUV.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    // shock refraction
    const R = t > 0 ? det.shockRadius(t) : 0;
    const psiFront = t > 0 ? det.overpressureAtSlant(Math.max(R, 1)) / PSI : 0;
    fx.shock.set(R, t > det.tMin && !this.photo ? Math.min(1, psiFront / 1.5) : 0, Math.max(4, R * 0.012), det.isUnderwater ? 0 : Math.max(0, det.hob));
    // heat shimmer
    const heat = V.active ? Math.min(1, V.glow * 0.8 + 0.3 * Math.exp(-t / 20)) : 0;
    const fbScreenR = V.active ? (V.Rf / D) / Math.tan((cam.fov * Math.PI) / 360) * 0.5 : 0;
    fx.heat.set(fx.burstUV.x, fx.burstUV.y, Math.min(0.6, fbScreenR * 1.5), p.z < 1 ? heat : 0);
    // scenario grade
    const id = this.scenario?.id;
    if (id === 'trinity') { fx.lift.set(0.01, 0.008, 0.012); fx.gain.set(1.02, 0.99, 0.96); fx.saturation = 0.92; }
    else if (id === 'tsar') { fx.lift.set(0.005, 0.01, 0.018); fx.gain.set(0.97, 1.0, 1.04); fx.saturation = 0.9; }
    else if (id === 'baker') { fx.lift.set(0.0, 0.006, 0.01); fx.gain.set(1.0, 1.0, 1.0); fx.saturation = 0.95; }
    else { fx.lift.set(0, 0, 0); fx.gain.set(1, 1, 1); fx.saturation = 1; }

    // observer report for the HUD
    const obs = this.rig.observerPoint();
    this.report = det.observerReport(obs.x, obs.y - this.terrain.surfaceAt(0, 0, this.env.water), obs.z);
    this.report.flashUnits = flashUnits;
    this.report.obs = obs;
  }

  _updateAudio(t, dtReal) {
    const rep = this.report;
    if (!rep) return;
    const det = this.det;
    const ev = this.audioEvents || [];
    const blast = { id: `blast-${Math.round(rep.arrival * 10)}`, t: rep.arrival, fire: (rate) => this.audio.blast(rep.overpressurePsi, rep.slantRange, rate, det.W) };
    // prompt radiation: clicks during the first second or so, scaled by dose
    const g = t > 0 && t < 2.5 && rep.dose > 0.5 ? Math.min(400, 8 * Math.log10(1 + rep.dose) * 25 * Math.exp(-t)) : 0;
    this.audio.geiger(this.playing ? g : 0);
    this.audio.tick(t, this.playing, this.rate, [...ev, blast], dtReal);
  }

  start() {
    const loop = () => {
      this.frame();
      this._raf = requestAnimationFrame(loop);
    };
    loop();
  }

  /** Photo-mode capture: renders a frame and returns a PNG data URL. */
  capture() {
    this.pipeline.render(this.scene, this.camera, this.volume, this.fx, this.realTime);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
