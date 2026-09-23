import * as THREE from 'three';
import { SCENARIOS, CUSTOM, ENVIRONMENTS, SKY_PRESETS } from '../physics/scenarios.js';
import { fmtTime, fmtDist, fmtYield, PSI } from '../physics/effects.js';
import { QUALITY } from '../App.js';

/** Tiny DOM helper */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

const RATES = [
  { r: 'auto', label: 'AUTO' }, { r: 0.0001, label: '1/10k' }, { r: 0.001, label: '1/1000' }, { r: 0.01, label: '1/100' },
  { r: 0.1, label: '1/10' }, { r: 1, label: '1×' }, { r: 10, label: '10×' }, { r: 60, label: '60×' },
];

export class UI {
  constructor(root, app) {
    this.root = root;
    this.app = app;
    this.rateMode = 'auto';
    this.notesShown = new Set();
    this.hudVisible = true;
    this.lastHud = 0;
  }

  // ================================================================== loader
  showLoader() {
    this.loader = h('div', { class: 'loader', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'loader-inner' },
        h('div', { class: 'brand' }, 'GROUND', h('br'), 'ZERO'),
        h('div', { class: 'sub' }, 'The Atomic Test Archive'),
        h('div', { class: 'bar' }, this.barFill = h('i')),
        this.log = h('div', { class: 'log' }, h('div', {}, 'Initialising WebGL 2 renderer…')),
      ));
    this.root.append(this.loader);
    this.app.lab.onProgress(({ pending, done, label, failed }) => {
      this.barFill.style.width = `${Math.round((done / Math.max(1, pending)) * 100)}%`;
      const isDone = done > 0 && this._lastDone !== done;
      this._lastDone = done;
      const line = h('div', {}, isDone
        ? h('span', { class: failed && this.app.lab.failed.includes(label) ? 'warn' : 'ok' }, `${this.app.lab.failed.includes(label) ? 'FALLBACK' : 'OK     '} `)
        : 'FETCH  ', `polyhaven.com · ${label}`);
      this.log.append(line);
      while (this.log.children.length > 9) this.log.firstChild.remove();
    });
  }
  logLine(text, cls) { if (!this.log) return; this.log.append(h('div', {}, cls ? h('span', { class: cls }, text) : text)); while (this.log.children.length > 9) this.log.firstChild.remove(); }
  hideLoader() {
    if (!this.loader) return;
    this.loader.classList.add('fade');
    setTimeout(() => this.loader?.remove(), 1100);
  }

  // ================================================================== intro
  showIntro(onEnter) {
    const lines = [
      'Between 1945 and 1996 the world detonated 2,056 nuclear devices.',
      'Four of them rewrote what we thought was possible.',
      'This archive lets you stand where the observers stood, and see what they saw, to the millisecond.',
    ];
    const ps = lines.map(() => h('p'));
    const enter = h('button', { class: 'btn primary', onclick: () => { this.app.audio.init(); fade(); onEnter(); } }, 'Open the archive');
    const el = h('section', { class: 'intro', 'aria-label': 'Introduction' },
      h('div', { class: 'kicker' }, 'Declassified · Interactive · Physically modelled'),
      h('h1', { class: 'brand' }, 'GROUND ZERO'),
      ...ps,
      h('div', { class: 'actions' }, enter,
        h('button', { class: 'btn', onclick: () => this.showCredits() }, 'Sources & credits')),
      h('div', { class: 'fine' },
        'Headphones recommended. Everything you see is computed from the published effects scaling laws (Glasstone & Dolan, Taylor–Sedov, Kinney–Graham). ',
        'Textures and skies are fetched live from Poly Haven (CC0). Nothing here describes how a weapon is built; this is about what one does.'),
    );
    const fade = () => { el.classList.add('fade'); setTimeout(() => el.remove(), 1300); };
    this.root.append(el);
    // typewriter
    let li = 0, ci = 0;
    const type = () => {
      if (li >= lines.length) return;
      ps.forEach((p) => p.classList.remove('caret'));
      ps[li].classList.add('caret');
      ps[li].textContent = lines[li].slice(0, ++ci);
      if (ci >= lines[li].length) { li++; ci = 0; setTimeout(type, 650); } else setTimeout(type, 24 + Math.random() * 30);
    };
    setTimeout(type, 700);
    this.intro = el;
  }

  // ================================================================== archive
  showArchive() {
    this.closeArchive();
    const cards = [...SCENARIOS, CUSTOM].map((s) => h('button', {
      class: `folder ${s.id === 'custom' ? 'custom' : ''}`,
      onclick: () => this.showDossier(s),
      'aria-label': `${s.name} dossier`,
    },
    h('div', { class: 'stamp' }, s.id === 'custom' ? 'SANDBOX' : 'DECLASSIFIED'),
    h('div', { class: 'num' }, s.numeral),
    h('div', { class: 'name' }, s.name),
    h('div', { class: 'meta' }, s.date, h('br'), s.id === 'custom' ? '10 t → 100 Mt' : fmtYield(s.yieldKt), h('br'), s.place.split(',').slice(0, 2).join(','))));
    this.archive = h('section', { class: 'archive', 'aria-label': 'Archive' },
      h('div', { class: 'archive-head' },
        h('div', {}, h('div', { class: 'kicker' }, 'Case files'), h('h2', {}, 'THE ARCHIVE')),
        h('div', { class: 'note' }, 'Choose a test. Each file opens a sandbox you control: scrub from the first microsecond to the stabilised cloud, move the observer, change the yield.'),
        this.app.scenario ? h('button', { class: 'btn', onclick: () => this.closeArchive() }, '× Back to sandbox') : null),
      h('div', { class: 'folders' }, cards));
    this.root.append(this.archive);
  }
  closeArchive() { this.archive?.remove(); this.archive = null; }

  showDossier(s) {
    const env = ENVIRONMENTS[s.env];
    const rows = [
      ['Date', `${s.date}${s.time ? ` · ${s.time}` : ''}`],
      ['Location', s.place], ['Coordinates', s.coords || '—'], ['Device', s.device],
      ['Yield', s.yieldNote], ['Burst', s.burstLabel], ['Environment', env.name],
    ];
    const wrap = h('div', { class: 'dossier-wrap', role: 'dialog', 'aria-modal': 'true', 'aria-label': `${s.name} dossier`, onclick: (e) => { if (e.target === wrap) wrap.remove(); } },
      h('article', { class: 'dossier' },
        h('div', { class: 'class' }, s.classification),
        h('div', { class: 'stamp2' }, s.id === 'custom' ? 'HYPOTHETICAL' : `FILE ${s.numeral}`),
        h('h3', {}, s.name),
        h('div', { class: 'tag' }, s.tagline),
        h('table', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v)))),
        h('div', { class: 'brief' }, s.briefing.map((p) => h('p', {}, p))),
        h('h4', {}, 'Observer positions'),
        h('div', { class: 'obs' }, s.observers.map((o) => h('div', {}, h('b', {}, o.name), o.note))),
        h('h4', {}, 'Sources'),
        h('div', { class: 'src' }, s.sources.map((x) => h('div', {}, '· ', x))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary', onclick: async () => { wrap.remove(); this.closeArchive(); await this.enterScenario(s.id); } }, 'Enter sandbox ▸'),
          h('button', { class: 'btn', onclick: () => wrap.remove() }, 'Back'))));
    this.root.append(wrap);
    wrap.querySelector('.btn.primary').focus();
  }

  async enterScenario(id) {
    const t = h('div', { class: 'toast panel' }, 'Loading scenario · fetching textures…');
    this.root.append(t);
    await this.app.loadScenario(id);
    t.remove();
    this.notesShown.clear();
    this.clearNotes();
    this.buildHUD();
  }

  // ================================================================== HUD
  buildHUD() {
    this.hud?.remove();
    const app = this.app, s = app.scenario;
    this.clockEl = h('div', { class: 'clock', 'aria-live': 'off' }, 'T−00:12');
    this.phaseEl = h('div', { class: 'phase' });
    const title = h('div', { class: 'hud-title panel' },
      h('div', { class: 'row' }, h('span', { class: 'num' }, s.numeral), h('span', { class: 'nm' }, s.name)),
      h('div', { class: 'dt' }, `${s.device} · ${s.date}`),
      this.yieldEl = h('div', { class: 'dt' }),
      this.clockEl, this.phaseEl);

    const top = h('div', { class: 'hud-top' },
      h('button', { class: 'btn', onclick: () => this.showArchive(), title: 'Archive (A)' }, '☰ Archive'),
      h('button', { class: 'btn', onclick: () => this.showDossier(s), title: 'Dossier' }, 'Dossier'),
      this.photoBtn = h('button', { class: 'btn', onclick: () => app.setPhoto(!app.photo), title: 'Rapatronic photo mode (P)' }, '◉ Rapatronic'),
      h('button', { class: 'btn', onclick: () => this.toggleHud(), title: 'Hide interface (H)' }, 'Hide UI'),
      h('button', { class: 'btn', onclick: () => this.showCredits() }, 'Credits'));

    // ---- observer readout
    this.ro = {
      who: h('div', { class: 'who' }), eta: h('div', { class: 'eta' }),
      kv: h('div', { class: 'kv' }), fx: h('ul', { class: 'effects' }),
    };
    const readout = h('div', { class: 'readout panel', 'aria-label': 'Observer readout' }, h('h5', {}, 'At the observer'), this.ro.who, this.ro.eta, this.ro.kv, this.ro.fx);

    // ---- controls
    const controls = this.buildControls();

    // ---- timeline
    const tl = this.buildTimeline();

    // ---- cameras / observers
    const cams = this.buildCams();

    this.ringLabels = h('div', { class: 'ring-labels' });
    this.notes = h('div', { class: 'notes' });
    this.photoFrame = h('div', { class: 'photo-frame hidden hud-keep' },
      h('div', { class: 'sprockets t' }), h('div', { class: 'sprockets b' }), h('div', { class: 'edge' }),
      this.photoMeta = h('div', { class: 'meta' }),
      h('div', { class: 'photo-bar' },
        h('button', { class: 'chip', onclick: () => app.seek(app.t * 0.5) }, '◂ ½ time'),
        h('button', { class: 'chip', onclick: () => app.seek(app.t * 2) }, '2× time ▸'),
        h('button', { class: 'btn primary', onclick: () => this.capture() }, 'Capture PNG'),
        h('button', { class: 'btn', onclick: () => app.setPhoto(false) }, 'Exit')));

    this.hud = h('div', { class: 'hud' }, this.ringLabels, title, top, readout, controls, cams, tl, this.notes, this.photoFrame);
    this.root.append(this.hud);
    this.bindKeys();
    app.on('photo', (on) => {
      this.photoFrame.classList.toggle('hidden', !on);
      this.photoBtn.classList.toggle('on', on);
      for (const el of [title, readout, controls, cams, tl, top, this.notes, this.ringLabels]) el.style.opacity = on ? '0' : '';
      for (const el of [readout, controls, cams, tl, top]) el.style.pointerEvents = on ? 'none' : '';
    });
    this.refreshControls();
  }

  buildControls() {
    const app = this.app;
    const P = () => app.params;
    const yieldLabel = h('b'); const hobLabel = h('b'); const humLabel = h('b');
    // yield: log slider 0.01 kt → 100 Mt
    const yMin = Math.log10(0.01), yMax = Math.log10(100000);
    this.yieldInput = h('input', { type: 'range', min: 0, max: 1000, step: 1, 'aria-label': 'Yield' });
    this.yieldInput.addEventListener('input', () => {
      const kt = Math.pow(10, yMin + (this.yieldInput.value / 1000) * (yMax - yMin));
      yieldLabel.textContent = fmtYield(kt);
    });
    this.yieldInput.addEventListener('change', () => {
      const kt = Math.pow(10, yMin + (this.yieldInput.value / 1000) * (yMax - yMin));
      this.applyParams({ yieldKt: +kt.toPrecision(3) });
    });
    // height of burst: signed, nonlinear (−60 m → 20 km)
    const hobFromS = (s) => (s < 0 ? s * 0.6 : Math.sign(s) * Math.pow(Math.abs(s) / 1000, 2.2) * 20000);
    const sFromHob = (hb) => (hb < 0 ? hb / 0.6 : Math.pow(hb / 20000, 1 / 2.2) * 1000);
    this.hobFromS = hobFromS; this.sFromHob = sFromHob;
    this.hobInput = h('input', { type: 'range', min: -100, max: 1000, step: 1, 'aria-label': 'Height of burst' });
    this.hobInput.addEventListener('input', () => { hobLabel.textContent = fmtHob(hobFromS(+this.hobInput.value)); });
    this.hobInput.addEventListener('change', () => this.applyParams({ hob: Math.round(hobFromS(+this.hobInput.value)) }));
    this.envSelect = h('select', { 'aria-label': 'Environment', onchange: (e) => this.applyParams({ env: e.target.value }) },
      Object.values(ENVIRONMENTS).map((e) => h('option', { value: e.id }, e.name)));
    this.skySelect = h('select', { 'aria-label': 'Sky', onchange: (e) => app.applySky(e.target.value) },
      SKY_PRESETS.map((s) => h('option', { value: s.id }, s.name)));
    this.humInput = h('input', { type: 'range', min: 0, max: 100, step: 1, 'aria-label': 'Humidity' });
    this.humInput.addEventListener('input', () => { humLabel.textContent = `${this.humInput.value}%`; app.params.humidity = this.humInput.value / 100; });
    this.qualSelect = h('select', { 'aria-label': 'Quality', onchange: (e) => app.setQuality(e.target.value) },
      Object.entries(QUALITY).map(([k, q]) => h('option', { value: k }, q.name)));
    this.ringsToggle = h('input', { type: 'checkbox', checked: app.ringsOn, onchange: (e) => app.setRings(e.target.checked) });
    this.labelsToggle = h('input', { type: 'checkbox', checked: true, onchange: (e) => this.ringLabels.classList.toggle('hidden', !e.target.checked) });
    this.volInput = h('input', { type: 'range', min: 0, max: 100, value: 80, 'aria-label': 'Volume', oninput: (e) => app.audio.setVolume(e.target.value / 100) });
    this.legend = h('div', { class: 'legend' });
    this.yieldLabel = yieldLabel; this.hobLabel = hobLabel; this.humLabel = humLabel;
    const presets = h('div', { class: 'row-btns' },
      [['Hiroshima', 15, 580], ['W88', 475, 1800], ['1 Mt', 1000, 2400], ['Ivy Mike', 10400, 0], ['100 Mt', 100000, 5000]].map(([n, y, hb]) =>
        h('button', { class: 'chip', onclick: () => this.applyParams({ yieldKt: y, hob: hb }) }, n)));
    this.controlsEl = h('div', { class: 'controls panel', 'aria-label': 'Parameters' },
      h('h5', {}, 'Parameters'),
      h('div', { class: 'ctl' }, h('label', {}, 'Yield', yieldLabel), this.yieldInput),
      h('div', { class: 'ctl' }, h('label', {}, 'Height of burst', hobLabel), this.hobInput),
      h('div', { class: 'ctl' }, h('label', {}, 'Comparisons'), presets),
      h('div', { class: 'ctl' }, h('label', {}, 'Environment'), this.envSelect),
      h('div', { class: 'ctl' }, h('label', {}, 'Sky (Poly Haven HDRI)'), this.skySelect),
      h('div', { class: 'ctl' }, h('label', {}, 'Humidity (Wilson cloud)', humLabel), this.humInput),
      h('label', { class: 'toggle' }, this.ringsToggle, 'Damage rings on the ground'),
      h('label', { class: 'toggle' }, this.labelsToggle, 'Ring labels'),
      this.legend,
      h('div', { class: 'ctl', style: 'margin-top:14px' }, h('label', {}, 'Render quality'), this.qualSelect),
      h('div', { class: 'ctl' }, h('label', {}, 'Sound'), this.volInput),
      h('button', { class: 'chip', onclick: () => app.loadScenario(app.scenario.id).then(() => { this.refreshControls(); this.buildHUD(); }) }, '↺ Restore historical values'),
      h('div', { class: 'help-keys', style: 'margin-top:14px' },
        h('kbd', {}, 'Space'), ' play · ', h('kbd', {}, 'D'), ' detonate · ', h('kbd', {}, 'R'), ' reset · ', h('kbd', {}, 'P'), ' photo · ',
        h('kbd', {}, 'O'), ' orbit · ', h('kbd', {}, 'V'), ' observer · ', h('kbd', {}, 'H'), ' hide UI · drag = look · wheel = zoom · double-click = re-track'),
      this.fpsEl = h('div', { class: 'fps', style: 'margin-top:8px' }));
    return this.controlsEl;
  }

  async applyParams(p) {
    const t = h('div', { class: 'toast panel' }, 'Recomputing effects…');
    this.root.append(t);
    await this.app.setParams(p);
    t.remove();
    this.refreshControls();
    this.buildTimelineMarks();
  }

  refreshControls() {
    const app = this.app, P = app.params;
    if (!this.yieldInput || !P) return;
    const yMin = Math.log10(0.01), yMax = Math.log10(100000);
    this.yieldInput.value = ((Math.log10(P.yieldKt) - yMin) / (yMax - yMin)) * 1000;
    this.yieldLabel.textContent = fmtYield(P.yieldKt);
    this.hobInput.value = this.sFromHob(P.hob);
    this.hobLabel.textContent = fmtHob(P.hob);
    this.envSelect.value = P.env;
    this.skySelect.value = app.skyPreset;
    this.humInput.value = Math.round(P.humidity * 100);
    this.humLabel.textContent = `${Math.round(P.humidity * 100)}%`;
    this.qualSelect.value = app.qualityKey;
    this.yieldEl.textContent = `${fmtYield(P.yieldKt)} · ${P.medium === 'underwater' ? `${-P.hob} m underwater` : P.hob > 3 ? `${fmtDist(P.hob)} airburst` : 'surface burst'}${P.historical ? '' : ' · modified'}`;
    const rings = app.det.rings();
    this.legend.replaceChildren(...rings.map((r) => h('span', {}, h('i', { style: `background:${r.color}` }), r.label.split(' · ')[0], h('b', {}, fmtDist(r.radius)))));
    this.rings = rings;
    this.ringEls = rings.map((r) => { const el = h('div', { class: 'ring-label', style: `color:${r.color}` }, `${r.label.split(' · ')[0]} · ${fmtDist(r.radius)}`); return el; });
    this.ringLabels.replaceChildren(...this.ringEls);
  }

  // ------------------------------------------------------------------ timeline
  buildTimeline() {
    const app = this.app;
    this.playBtn = h('button', { class: 'btn play', onclick: () => app.toggle(), 'aria-label': 'Play / pause' }, '▶');
    this.rateBtns = RATES.map((x) => h('button', { class: `chip ${x.r === this.rateMode ? 'on' : ''}`, onclick: () => this.setRate(x.r) }, x.label));
    this.track = h('div', { class: 'tl-track', role: 'slider', 'aria-label': 'Timeline', tabindex: 0 },
      h('div', { class: 'rail' }), this.tlFill = h('div', { class: 'fill' }), this.tlKnob = h('div', { class: 'knob' }));
    this.tlMarks = h('div');
    this.track.append(this.tlMarks);
    const scrub = (e) => {
      const r = this.track.getBoundingClientRect();
      const s = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      app.seek(this.sToT(s));
    };
    this.track.addEventListener('pointerdown', (e) => { this._scrub = true; this.track.setPointerCapture(e.pointerId); app.pause(); scrub(e); });
    this.track.addEventListener('pointermove', (e) => { if (this._scrub) scrub(e); });
    this.track.addEventListener('pointerup', () => { this._scrub = false; });
    this.track.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') app.seek(this.sToT(Math.min(1, this.tToS(app.t) + 0.01)));
      if (e.key === 'ArrowLeft') app.seek(this.sToT(Math.max(0, this.tToS(app.t) - 0.01)));
    });
    this.tlEl = h('div', { class: 'timeline panel' },
      h('div', { class: 'tl-top' },
        this.playBtn,
        h('button', { class: 'btn danger', onclick: () => app.detonate() }, 'Detonate'),
        h('button', { class: 'btn', onclick: () => app.reset(), title: 'Reset (R)' }, '↺'),
        h('div', { class: 'grow' }),
        h('div', { class: 'rates', role: 'group', 'aria-label': 'Time scale' }, this.rateBtns)),
      this.track);
    app.on('play', () => { this.playBtn.textContent = '❚❚'; });
    app.on('pause', () => { this.playBtn.textContent = '▶'; });
    this.buildTimelineMarks();
    return this.tlEl;
  }

  tToS(t) {
    const app = this.app;
    if (t <= 0) return 0.1 * (t - app.tStart) / -app.tStart;
    const a = -6, b = Math.log10(app.tEnd);
    return 0.1 + 0.9 * Math.min(1, Math.max(0, (Math.log10(Math.max(t, 1e-6)) - a) / (b - a)));
  }
  sToT(s) {
    const app = this.app;
    if (s <= 0.1) return app.tStart + (s / 0.1) * -app.tStart;
    const a = -6, b = Math.log10(app.tEnd);
    return Math.pow(10, a + ((s - 0.1) / 0.9) * (b - a));
  }

  buildTimelineMarks() {
    if (!this.tlMarks) return;
    const det = this.app.det;
    const marks = [
      { t: det.tMin, label: 'Breakaway' },
      { t: det.tMax, label: 'Thermal max' },
      { t: det.tToroid, label: 'Toroid' },
      { t: det.stabilizeTime, label: 'Stabilised' },
    ];
    const ticks = [1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 0.1, 1, 10, 100, 1000].filter((x) => x <= this.app.tEnd);
    this.tlMarks.replaceChildren(
      h('div', { class: 'tick', style: 'left:0%' }, 'T−12 s'),
      h('div', { class: 'tick', style: `left:${10}%` }, '0'),
      ...ticks.map((x) => h('div', { class: 'tick', style: `left:${this.tToS(x) * 100}%` }, x < 1e-3 ? `${x * 1e6}µs` : x < 1 ? `${x * 1e3}ms` : `${x}s`)),
      ...marks.map((m) => h('div', { class: 'mk', style: `left:${this.tToS(m.t) * 100}%` }, m.label)),
      this.blastMark = h('div', { class: 'mk blast' }, 'Blast here'));
  }

  setRate(r) {
    this.rateMode = r;
    this.rateBtns.forEach((b, i) => b.classList.toggle('on', RATES[i].r === r));
    if (r !== 'auto') this.app.setRate(r);
  }

  // ------------------------------------------------------------------ cameras
  buildCams() {
    const app = this.app;
    const modes = [['observer', 'Observer'], ['orbit', 'Orbit'], ['orbital', 'Overview']];
    if (app.props.aircraft) modes.splice(1, 0, ['aircraft', 'Aircraft']);
    this.modeBtns = modes.map(([m, l]) => h('button', { class: 'chip', onclick: () => { app.rig.setMode(m); } }, l));
    this.obsBtns = app.scenario.observers.map((o) => h('button', { onclick: () => { app.rig.setObserver(o); app.observerId = o.id; this.refreshCams(); } }, o.name, h('small', {}, o.note)));
    this.fovEl = h('span', { class: 'fps' });
    const el = h('div', { class: 'cams panel', 'aria-label': 'Camera' },
      h('h5', {}, 'Camera'),
      h('div', { class: 'row-btns' }, this.modeBtns, h('button', { class: 'chip', onclick: () => app.rig.startPlacing() }, '⊕ Place observer')),
      h('div', { style: 'margin-top:8px; display:flex; gap:8px; align-items:center' },
        h('span', { class: 'fps' }, 'Lens'), h('input', { type: 'range', min: 2, max: 80, value: 50, 'aria-label': 'Field of view', oninput: (e) => { app.rig.autoAim = false; app.rig.setFov(+e.target.value); } }), this.fovEl),
      h('h5', { style: 'margin-top:12px' }, 'Historical posts'),
      h('div', { class: 'obs-list' }, this.obsBtns));
    app.on('camera', () => this.refreshCams());
    app.on('observer', () => this.refreshCams());
    this.refreshCams();
    return el;
  }
  refreshCams() {
    const app = this.app, st = app.rig.state();
    if (!this.modeBtns) return;
    const modes = ['observer', ...(app.props.aircraft ? ['aircraft'] : []), 'orbit', 'orbital'];
    this.modeBtns.forEach((b, i) => b.classList.toggle('on', modes[i] === st.mode));
    this.obsBtns.forEach((b, i) => b.classList.toggle('on', app.scenario.observers[i] === st.observer));
  }

  // ------------------------------------------------------------------ keys
  bindKeys() {
    if (this._keys) return;
    this._keys = true;
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      const app = this.app;
      if (!app.scenario) return;
      if (e.code === 'Space') { e.preventDefault(); app.toggle(); }
      else if (e.key === 'd' || e.key === 'D') app.detonate();
      else if (e.key === 'r' || e.key === 'R') app.reset();
      else if (e.key === 'p' || e.key === 'P') app.setPhoto(!app.photo);
      else if (e.key === 'o' || e.key === 'O') app.rig.setMode('orbit');
      else if (e.key === 'v' || e.key === 'V') app.rig.setMode('observer');
      else if (e.key === 'h' || e.key === 'H') this.toggleHud();
      else if (e.key === 'a' || e.key === 'A') this.showArchive();
      else if (e.key === 'Escape') { document.querySelector('.dossier-wrap')?.remove(); document.querySelector('.credits')?.remove(); if (app.photo) app.setPhoto(false); }
      else if (/^[1-8]$/.test(e.key)) this.setRate(RATES[+e.key - 1].r);
    });
  }
  toggleHud() { this.hudVisible = !this.hudVisible; this.hud.classList.toggle('off', !this.hudVisible); if (!this.hudVisible) this.toast('Press H to show the interface'); }
  toast(msg) { const t = h('div', { class: 'toast panel' }, msg); this.root.append(t); setTimeout(() => t.remove(), 2200); }

  // ------------------------------------------------------------------ notes (the story, told as it happens)
  clearNotes() { this.notes?.replaceChildren(); }
  pushNote(title, text) {
    const card = h('div', { class: 'note-card', onclick: () => card.remove() }, h('small', {}, title), text);
    this.notes.append(card);
    while (this.notes.children.length > 2) this.notes.firstChild.remove();
    setTimeout(() => card.remove(), 14000);
  }

  // ------------------------------------------------------------------ capture
  capture() {
    const url = this.app.capture();
    const a = h('a', { href: url, download: `rapatronic-${this.app.scenario.id}-${fmtTime(this.app.t).replace(/[^\w.+-]/g, '')}.png` });
    document.body.append(a); a.click(); a.remove();
    this.toast('Frame saved');
  }

  // ------------------------------------------------------------------ credits
  showCredits() {
    const list = this.app.lab.creditList();
    const el = h('div', { class: 'credits', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === el) el.remove(); } },
      h('div', { class: 'panel' },
        h('h3', {}, 'Sources & credits'),
        h('p', {}, 'Physics: S. Glasstone & P. J. Dolan, The Effects of Nuclear Weapons (1977); G. I. Taylor (1950) blast-wave similarity; G. F. Kinney & K. J. Graham, Explosive Shocks in Air (1985); Rankine–Hugoniot shock relations. Historical data from DOE/NV-209, LANL, and the dossiers’ listed sources.'),
        h('p', {}, 'All HDRIs and PBR textures are CC0 from ', h('a', { href: 'https://polyhaven.com', target: '_blank', rel: 'noopener' }, 'Poly Haven'), ', fetched live through its public API:'),
        h('ul', {}, list.length ? list.map((c) => h('li', {}, h('a', { href: c.url, target: '_blank', rel: 'noopener' }, c.name), ` (${c.type}) by ${c.authors}`)) : h('li', {}, 'Loading…')),
        h('p', {}, 'Rendering: three.js. Everything else (terrain, ocean, volumetric fireball and cloud, audio) is procedural.'),
        h('button', { class: 'btn', onclick: () => el.remove() }, 'Close')));
    this.root.append(el);
  }

  // ================================================================== per-frame
  update() {
    const app = this.app;
    if (!this.hud || !app.det) return;
    const t = app.t, det = app.det;
    // auto rate: logarithmic slow-motion through the first second, real time after, speeding up for the cloud rise
    if (this.rateMode === 'auto') {
      let r = 1;
      if (t > 0) r = Math.min(1, Math.max(3e-5, t * 0.85));
      if (t > 20) r = Math.min(12, 1 + (t - 20) / 15);
      app.rate = r;
    }
    this.clockEl.textContent = fmtTime(t);
    this.phaseEl.textContent = phaseLabel(t, det) + (app.playing && app.rate !== 1 ? `  ·  ${fmtRate(app.rate)}` : '');
    const s = this.tToS(t);
    this.tlFill.style.width = `${s * 100}%`;
    this.tlKnob.style.left = `${s * 100}%`;
    const now = performance.now();
    if (now - this.lastHud > 90) {
      this.lastHud = now;
      this.updateReadout();
      this.fpsEl.textContent = `${Math.round(1000 / app.frameMs)} fps · ${app.qualityKey}`;
      this.fovEl.textContent = `${Math.round(app.camera.fov)}°`;
      if (app.photo) this.updatePhotoMeta();
    }
    this.updateRingLabels();
    this.updateNotes();
  }

  updateReadout() {
    const app = this.app, rep = app.report, t = app.t;
    if (!rep) return;
    const o = app.rig.observer;
    const posName = app.rig.mode === 'aircraft' ? 'Tu-95V (riding along)' : o?.name || 'Observer';
    this.ro.who.replaceChildren(posName, h('small', {}, `${fmtDist(rep.groundRange)} from ground zero · ${fmtDist(rep.slantRange)} slant`));
    const dtA = rep.arrival - t;
    if (t < 0) { this.ro.eta.textContent = `Blast would arrive T+${rep.arrival.toFixed(1)} s after the flash`; this.ro.eta.className = 'eta'; }
    else if (dtA > 0) { this.ro.eta.textContent = `Light is here. Blast wave arrives in ${dtA < 1 ? (dtA * 1000).toFixed(0) + ' ms' : dtA.toFixed(1) + ' s'}`; this.ro.eta.className = 'eta'; }
    else { this.ro.eta.textContent = `Blast wave arrived at T+${rep.arrival < 1 ? (rep.arrival * 1000).toFixed(0) + ' ms' : rep.arrival.toFixed(1) + ' s'}`; this.ro.eta.className = 'eta hit'; }
    const psi = rep.overpressurePsi;
    const rows = [
      ['Peak overpressure', `${psi < 0.1 ? psi.toFixed(3) : psi.toFixed(2)} psi · ${(rep.overpressurePa / 1000).toFixed(psi < 1 ? 2 : 1)} kPa`],
      ['Peak wind', `${Math.round(rep.wind * 3.6)} km/h`],
      ['Thermal fluence', `${rep.thermal < 0.01 ? rep.thermal.toExponential(1) : rep.thermal.toFixed(2)} cal/cm²`],
      ['Prompt radiation', `${rep.dose < 0.01 ? '<0.01' : rep.dose < 10 ? rep.dose.toFixed(2) : Math.round(rep.dose)} rem`],
      ['Flash vs. sunlight', `${(rep.flashUnits / 3).toFixed(rep.flashUnits < 3 ? 2 : 0)}×`],
      ['Cloud top (stabilised)', fmtDist(app.det.cloudTop)],
    ];
    this.ro.kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', {}, k), h('span', {}, v)]));
    this.ro.fx.replaceChildren(...rep.effects.map((e) => h('li', {}, e)));
    if (this.blastMark) {
      this.blastMark.style.left = `${this.tToS(rep.arrival) * 100}%`;
    }
  }

  updateRingLabels() {
    if (!this.rings || !this.ringEls || this.ringLabels.classList.contains('hidden')) return;
    const app = this.app, cam = app.camera;
    const w = window.innerWidth, hgt = window.innerHeight;
    // label position: on each ring at the bearing 90° to the right of the camera→GZ direction
    const toGZ = new THREE.Vector3(-cam.position.x, 0, -cam.position.z).normalize();
    const right = new THREE.Vector3(-toGZ.z, 0, toGZ.x);
    const on = app.ringsOn && !app.photo;
    this.rings.forEach((r, i) => {
      const el = this.ringEls[i];
      const p = right.clone().multiplyScalar(r.radius);
      p.y = app.terrain.surfaceAt(p.x, p.z, app.env.water) + 2;
      const d = p.distanceTo(cam.position);
      p.y -= (Math.pow(Math.hypot(p.x - cam.position.x, p.z - cam.position.z), 2)) / (2 * 6371000);
      const q = p.project(cam);
      const vis = on && q.z < 1 && Math.abs(q.x) < 1.1 && Math.abs(q.y) < 1.1 && d < 400000;
      el.style.display = vis ? '' : 'none';
      if (vis) { el.style.left = `${(q.x * 0.5 + 0.5) * w}px`; el.style.top = `${(-q.y * 0.5 + 0.5) * hgt}px`; }
    });
  }

  updateNotes() {
    const app = this.app, s = app.scenario, t = app.t;
    if (!app.playing || !s.aftermath?.length) return;
    const rep = app.report;
    const times = [0.5, Math.max(8, rep ? rep.arrival + 2 : 30), app.det.stabilizeTime * 0.4, app.det.stabilizeTime * 0.9];
    s.aftermath.forEach((txt, i) => {
      const key = `${s.id}-${i}`;
      if (!this.notesShown.has(key) && t > (times[i] ?? 60 + i * 60)) {
        this.notesShown.add(key);
        this.pushNote(`ARCHIVE NOTE ${s.numeral}.${i + 1}`, txt);
      }
    });
  }

  updatePhotoMeta() {
    const app = this.app;
    this.photoMeta.replaceChildren(
      h('b', {}, `EG&G RAPATRONIC · ${app.scenario.name}`), h('br'),
      `${fmtTime(app.t)} · EXPOSURE ~10 ns · ${fmtDist(app.report?.slantRange || 0)} · FOCAL ${Math.round(35 / Math.tan((app.camera.fov * Math.PI) / 360))} mm equiv.`, h('br'),
      `FIREBALL Ø ${fmtDist(2 * app.det.fireballRadius(Math.max(app.t, 1e-7)))} · T≈${Math.round(app.det.fireballTemperature(Math.max(app.t, 1e-7)))} K`, h('br'),
      app.scenario.photo?.note || '');
  }
}

function fmtHob(hb) {
  if (hb < 0) return `${-hb} m underwater`;
  if (hb <= 3) return 'Surface';
  return hb < 1000 ? `${hb.toFixed(0)} m` : `${(hb / 1000).toFixed(2)} km`;
}
function fmtRate(r) {
  if (r >= 1) return `${r.toFixed(r < 10 ? 1 : 0)}×`;
  return `1/${Math.round(1 / r).toLocaleString()}×`;
}
export function phaseLabel(t, det) {
  if (t < 0) return 'Countdown';
  if (det.isUnderwater) {
    if (t < 0.05) return 'Underwater gas bubble · spray dome forming';
    if (t < 1.5) return 'Spray dome · Wilson condensation cloud';
    if (t < 12) return 'Hollow water column rising · 2 million tons of water';
    if (t < 60) return 'Column collapses · base surge begins';
    return 'Radioactive base surge rolls over the fleet';
  }
  if (t < det.tMin * 0.15) return 'X-ray fireball · radiative growth';
  if (t < det.tMin) return 'Hydrodynamic phase · shock front opaque';
  if (t < det.tMax * 0.8) return 'Breakaway · thermal pulse rising';
  if (t < det.tMax * 3) return 'Principal thermal maximum';
  if (t < det.tToroid) return 'Fireball cools · buoyant rise begins';
  if (t < det.stabilizeTime * 0.4) return 'Toroidal circulation · mushroom forming';
  if (t < det.stabilizeTime) return 'Cloud rise · afterwinds draw up the stem';
  return 'Stabilised cloud · drifting downwind';
}
