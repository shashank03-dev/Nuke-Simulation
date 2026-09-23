import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Camera modes
 *  observer : stand at an observer post (eye height), free-look by dragging, wheel = binocular zoom.
 *             Auto-tracks the cloud until you look around yourself (double-click re-arms it).
 *  orbit    : free orbit around ground zero
 *  aircraft : ride with the scenario aircraft (Tsar Bomba's Tu-95V), looking back at the burst
 *  orbital  : high oblique overview
 *  place    : next click on the ground drops a new observer there
 */
export class CameraRig {
  constructor(camera, dom, app) {
    this.camera = camera;
    this.dom = dom;
    this.app = app;
    this.mode = 'observer';
    this.observer = null;
    this.obsPos = new THREE.Vector3(0, 2, 9000);
    this.yaw = Math.PI; this.pitch = 0.05;
    this.autoAim = true;
    this.fov = 50;
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.enabled = false;
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.maxPolarAngle = Math.PI * 0.495;
    this.orbit.zoomSpeed = 1.2;
    this._drag = null;
    this.placing = false;
    this._bind();
  }

  _bind() {
    const d = this.dom;
    // touch: one finger looks around, two fingers pinch the lens (binocular zoom)
    this._touches = new Map();
    const pinchDist = () => { const p = [...this._touches.values()]; return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); };
    d.addEventListener('pointerdown', (e) => {
      if (this.placing) { this._place(e); return; }
      if (this.mode !== 'observer' && this.mode !== 'aircraft') return;
      this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._touches.size === 2) { this._drag = null; this._pinch = { d: pinchDist(), fov: this.fov }; return; }
      this._drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch };
      d.setPointerCapture(e.pointerId);
    });
    d.addEventListener('pointermove', (e) => {
      if (this._touches.has(e.pointerId)) this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinch && this._touches.size === 2) {
        this.fov = Math.max(2, Math.min(80, this._pinch.fov * (this._pinch.d / Math.max(10, pinchDist()))));
        this.autoAim = false;
        return;
      }
      if (!this._drag) return;
      const s = (this.fov / 50) * 0.0035;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.autoAim = false;
      this.yaw = this._drag.yaw - dx * s;
      this.pitch = Math.max(-1.4, Math.min(1.5, this._drag.pitch + dy * s));
    });
    const end = (e) => {
      this._touches.delete(e.pointerId);
      if (this._touches.size < 2) { if (this._pinch) this.app.emit('camera', this.state()); this._pinch = null; }
      this._drag = null;
    };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
    d.addEventListener('dblclick', () => { this.autoAim = true; this.app.emit('camera', this.state()); });
    d.addEventListener('wheel', (e) => {
      if (this.mode !== 'observer' && this.mode !== 'aircraft') return;
      e.preventDefault();
      this.fov = Math.max(2, Math.min(80, this.fov * Math.exp(e.deltaY * 0.001)));
      this.app.emit('camera', this.state());
    }, { passive: false });
  }

  state() { return { mode: this.mode, fov: this.fov, autoAim: this.autoAim, observer: this.observer, placing: this.placing }; }

  setFov(f) { this.fov = f; this.app.emit('camera', this.state()); }

  setObserver(o) {
    if (!o) return;
    this.observer = o;
    const [x, z] = o.pos;
    const g = this.app.terrain.surfaceAt(x, z, this.app.env?.water);
    this.obsPos.set(x, o.air ? o.eye : g + o.eye, z);
    this.autoAim = true;
    this.fov = o.air ? 45 : 50;
    this._snap = true; // jump straight to the new view instead of easing
    this.setMode(o.id === 'tu95' ? 'aircraft' : 'observer');
  }

  setMode(m) {
    this.mode = m;
    this.orbit.enabled = m === 'orbit' || m === 'orbital';
    if (m === 'orbit' || m === 'orbital') {
      const det = this.app.det;
      const top = det ? det.cloudTop : 5000;
      const R = det ? Math.max(det.capRadius, det.Rmax * 3) : 3000;
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
      if (m === 'orbital') {
        this.camera.position.set(R * 2.2, top * 2.2, R * 3.5);
      } else {
        this.camera.position.set(R * 1.6, top * 0.35, R * 2.4);
      }
      this.orbit.target.set(0, top * 0.4, 0);
      this.orbit.minDistance = 20;
      this.orbit.maxDistance = 400000;
      this.orbit.update();
    }
    this.app.emit('camera', this.state());
  }

  startPlacing() { this.placing = true; this.dom.style.cursor = 'crosshair'; this.app.emit('camera', this.state()); }

  _place(e) {
    this.placing = false;
    this.dom.style.cursor = '';
    const rect = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = this._marchHeightfield(ray.ray);
    if (hit) {
      const r = Math.hypot(hit.x, hit.z);
      this.setObserver({ id: 'custom', name: 'Your position', note: `${(r / 1000).toFixed(2)} km from ground zero`, pos: [hit.x, hit.z], eye: 1.7 });
      this.app.emit('observer', this.observer);
    }
    this.app.emit('camera', this.state());
  }

  _marchHeightfield(r) {
    const T = this.app.terrain, water = this.app.env?.water;
    let t = 1, prev = null;
    for (let i = 0; i < 400; i++) {
      const p = r.origin.clone().addScaledVector(r.direction, t);
      const h = T.surfaceAt(p.x, p.z, water);
      if (p.y < h) {
        if (!prev) return p;
        // bisection refine
        let a = t / 1.04 - 1, b = t;
        for (let k = 0; k < 20; k++) {
          const m = (a + b) / 2;
          const q = r.origin.clone().addScaledVector(r.direction, m);
          if (q.y < T.surfaceAt(q.x, q.z, water)) b = m; else a = m;
        }
        return r.origin.clone().addScaledVector(r.direction, b);
      }
      prev = p;
      t = t * 1.04 + 1;
      if (t > 400000) break;
    }
    return null;
  }

  /** Where the camera is "looking at" near the ground — used to aim shadow cameras. */
  focusPoint() {
    const c = this.camera;
    const f = new THREE.Vector3();
    c.getWorldDirection(f);
    const dist = Math.min(600, Math.max(40, (c.position.y - this.app.terrain.surfaceAt(c.position.x, c.position.z, this.app.env?.water)) * 3 + 120));
    const p = c.position.clone().addScaledVector(f, dist);
    p.y = this.app.terrain.surfaceAt(p.x, p.z, this.app.env?.water);
    return p;
  }

  observerPoint() {
    if (this.mode === 'aircraft' && this.app.props.aircraft) return this.app.props.aircraft.position.clone();
    return this.obsPos.clone();
  }

  /** Aim point: the brightest / most interesting part of the event right now. */
  _aim(t) {
    const app = this.app;
    const det = app.det;
    if (!det) return new THREE.Vector3(0, 0, 0);
    if (t <= 0) return new THREE.Vector3(0, Math.max(0, det.hob) + (app.scenario?.id === 'trinity' ? 15 : 0), 0);
    const V = app.volume.state;
    if (app.photo && V.active) return new THREE.Vector3(0, V.fireY + V.Rf * 0.25, 0);
    let y = V.active ? V.fireY : Math.max(0, det.hob);
    if (det.isUnderwater) y = Math.min(1200, 300 + t * 120);
    // look slightly below the cap centre so the stem is in frame
    const target = new THREE.Vector3(0, y * (this.camera.aspect < 0.9 ? 0.85 : 0.72), 0);
    return target;
  }

  update(dt, t) {
    const cam = this.camera;
    if (this.mode === 'orbit' || this.mode === 'orbital') {
      this.orbit.update();
      return;
    }
    let pos = this.obsPos;
    if (this.mode === 'aircraft' && this.app.props.aircraft) {
      const a = this.app.props.aircraft;
      // behind and above the tail looking back toward the burst
      pos = a.position.clone().add(new THREE.Vector3(60, 14, 0));
    }
    cam.position.copy(pos);
    if (this.autoAim) {
      const aim = this._aim(t);
      const d = aim.sub(pos);
      const yaw = Math.atan2(d.x, d.z);
      const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      // keep the whole cloud in view: auto-fov when far away
      const det = this.app.det;
      const V = this.app.volume.state;
      const dist = Math.hypot(pos.x, pos.z);
      const size = V.active ? Math.max(V.top || 0, (V.rad || 0) * 0.6) : Math.max(60, Math.max(0, det?.hob || 0) * 1.5);
      let wantFov = Math.max(6, Math.min(62, (Math.atan2(size * 1.25, dist) * 2 * 180) / Math.PI));
      // before the shot: a natural field of view that shows the landscape and the tower on the horizon
      if (t <= 0) wantFov = 40;
      // portrait phones: frame wider and push the subject below the title bar
      if (this.camera.aspect < 0.9) wantFov = Math.min(75, wantFov * 1.3);
      // Rapatronic: long lens, fireball fills a third of the frame
      if (this.app.photo && V.active) {
        const R = Math.max(1, V.Rf);
        wantFov = Math.max(0.3, Math.min(50, (Math.atan2(R * 3.2, pos.distanceTo(new THREE.Vector3(0, V.fireY, 0))) * 2 * 180) / Math.PI));
      }
      const k = this._snap ? 1 : 1 - Math.exp(-dt * 2.5);
      this.yaw = lerpAngle(this.yaw, yaw, k);
      this.pitch += (Math.max(-0.5, Math.min(1.2, pitch)) - this.pitch) * k;
      this.fov += (wantFov - this.fov) * (this._snap ? 1 : 1 - Math.exp(-dt * 1.2));
      this._snap = false;
    }
    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    cam.lookAt(cam.position.clone().add(dir));
    // camera shake when the shock hits the observer
    const rep = this.app.report;
    if (rep && t > rep.arrival && t < rep.arrival + 6) {
      const s = Math.min(0.03, rep.overpressurePsi * 0.01) * Math.exp(-(t - rep.arrival) * 1.2);
      cam.rotation.x += (Math.random() - 0.5) * s;
      cam.rotation.y += (Math.random() - 0.5) * s;
    }
    if (Math.abs(cam.fov - this.fov) > 0.01) { cam.fov = this.fov; cam.updateProjectionMatrix(); }
  }
}

function lerpAngle(a, b, k) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
