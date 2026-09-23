/**
 * Procedural Web Audio soundscape. No samples: everything is synthesised.
 *
 * The key physical fact it honours: light arrives instantly, sound does not. The observer hears
 * nothing until the shock front physically reaches them (arrival time from the Detonation's
 * integrated shock table), then an N-wave crack, a sub-bass thump and minutes of rolling thunder
 * whose brightness is filtered by distance (air absorbs high frequencies).
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.enabled = false;
    this.volume = 0.8;
    this.bedNodes = [];
    this.lastT = -Infinity;
    this.fired = new Set();
    this.geigerRate = 0;
    this.geigerNext = 0;
  }

  async init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 12; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.4;
    this.master.connect(comp).connect(ctx.destination);
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(6.5, 2.2);
    this.reverbGain = ctx.createGain();
    this.reverbGain.gain.value = 0.55;
    this.reverb.connect(this.reverbGain).connect(this.master);
    this.bedGain = ctx.createGain();
    this.bedGain.gain.value = 0.0;
    this.bedGain.connect(this.master);
    this.noiseBuf = this._noise(4, 'white');
    this.brownBuf = this._noise(6, 'brown');
    this.enabled = true;
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05); }
  setMuted(m) { if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05); }

  _noise(seconds, type) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        if (type === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
      }
    }
    return buf;
  }
  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        // sparse early reflections (terrain echoes) + diffuse tail
        const early = (i % Math.floor(ctx.sampleRate * (0.21 + ch * 0.07)) < 40) ? 0.6 : 0;
        d[i] = ((Math.random() * 2 - 1) * Math.pow(1 - t, decay) + early * Math.pow(1 - t, 3)) * 0.5;
      }
    }
    return buf;
  }
  _src(buf, loop = true) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf; s.loop = loop;
    return s;
  }

  /** environment bed: 'desert' | 'lagoon' | 'atoll' | 'arctic' */
  setBed(kind) {
    if (!this.ctx) { this.pendingBed = kind; return; }
    for (const n of this.bedNodes) { try { n.stop ? n.stop() : n.disconnect(); } catch { /* */ } }
    this.bedNodes = [];
    const ctx = this.ctx;
    const out = this.bedGain;
    // wind
    const w = this._src(this.brownBuf);
    const bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = kind === 'arctic' ? 900 : 450; bp.Q.value = 0.6;
    const wg = ctx.createGain(); wg.gain.value = kind === 'arctic' ? 0.5 : 0.28;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.18;
    lfo.connect(lfoG).connect(wg.gain);
    w.connect(bp).connect(wg).connect(out);
    w.start(); lfo.start();
    this.bedNodes.push(w, lfo);
    if (kind === 'arctic') {
      // whistling gusts
      const w2 = this._src(this.noiseBuf);
      const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1600; f2.Q.value = 12;
      const g2 = ctx.createGain(); g2.gain.value = 0.03;
      const l2 = ctx.createOscillator(); l2.frequency.value = 0.13;
      const l2g = ctx.createGain(); l2g.gain.value = 500;
      l2.connect(l2g).connect(f2.frequency);
      w2.connect(f2).connect(g2).connect(out);
      w2.start(); l2.start();
      this.bedNodes.push(w2, l2);
    }
    if (kind === 'lagoon' || kind === 'atoll') {
      // surf on the reef
      const s = this._src(this.noiseBuf);
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
      const g = ctx.createGain(); g.gain.value = 0.1;
      const l = ctx.createOscillator(); l.frequency.value = 0.11;
      const lg = ctx.createGain(); lg.gain.value = 0.09;
      l.connect(lg).connect(g.gain);
      s.connect(f).connect(g).connect(out);
      s.start(); l.start();
      this.bedNodes.push(s, l);
    }
    if (kind === 'desert') {
      // crickets in the pre-dawn desert: amplitude-gated 4.3 kHz chirps
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 4300;
      const g = ctx.createGain(); g.gain.value = 0;
      const gate = ctx.createOscillator(); gate.type = 'square'; gate.frequency.value = 28;
      const gateG = ctx.createGain(); gateG.gain.value = 0.012;
      const env = ctx.createOscillator(); env.type = 'sine'; env.frequency.value = 0.9;
      const envG = ctx.createGain(); envG.gain.value = 0.012;
      gate.connect(gateG).connect(g.gain);
      env.connect(envG).connect(g.gain);
      o.connect(g).connect(out);
      o.start(); gate.start(); env.start();
      this.bedNodes.push(o, gate, env);
    }
    this.bedGain.gain.setTargetAtTime(0.9, ctx.currentTime, 1.5);
  }

  beep(freq = 1000, dur = 0.12, gain = 0.12) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + 0.005); g.gain.setTargetAtTime(0, t + dur, 0.02);
    // radio band-limiting
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.8;
    o.connect(bp).connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.2);
  }

  /** EMP: the radio pops and crackles at T0 */
  emp(strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = this._src(this.noiseBuf, false);
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.25 * strength, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    s.connect(f).connect(g).connect(this.master);
    s.start(t); s.stop(t + 0.5);
    this.bedGain.gain.setTargetAtTime(0.35, t, 0.3);
  }

  /**
   * The blast arrives. psi: peak overpressure, dist: slant range (m), rate: playback rate (slow-mo)
   */
  blast(psi, dist, rate = 1, W = 20) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + 0.02;
    const loud = Math.min(1.4, 0.25 + Math.log10(1 + psi * 20) * 0.45);
    // air absorption: high frequencies die with distance
    const cutoff = Math.max(180, Math.min(16000, 9e6 / Math.max(dist, 300)));
    const r = Math.max(0.2, Math.min(1, rate));
    // positive-phase duration grows as W^(1/3): multi-megaton blasts are long, slow shoves
    const dur = Math.min(2.5, 0.08 * Math.cbrt(W) * (1 + dist / 20000));

    // 1. N-wave crack
    const crack = this._src(this.noiseBuf, false);
    crack.playbackRate.value = r;
    const cf = ctx.createBiquadFilter(); cf.type = 'lowpass'; cf.frequency.value = cutoff;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0, t);
    cg.gain.linearRampToValueAtTime(1.0 * loud, t + 0.004 / r);
    cg.gain.exponentialRampToValueAtTime(0.25 * loud, t + dur * 0.5 / r);
    cg.gain.exponentialRampToValueAtTime(0.001, t + (dur + 0.6) / r);
    crack.connect(cf).connect(cg);
    cg.connect(this.master); cg.connect(this.reverb);
    crack.start(t); crack.stop(t + (dur + 1) / r);

    // 2. sub-bass thump (the pressure step itself)
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(70 * r, t); o.frequency.exponentialRampToValueAtTime(22 * r, t + (0.6 + dur) / r);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t); og.gain.linearRampToValueAtTime(1.1 * loud, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.001, t + (1.8 + dur * 2) / r);
    o.connect(og).connect(this.master);
    o.start(t); o.stop(t + 4 / r);

    // 3. rolling thunder: long brown-noise rumble with slow amplitude swells + reverb
    const rum = this._src(this.brownBuf, true);
    rum.playbackRate.value = r * 0.8;
    const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = Math.min(400, cutoff);
    const rg = ctx.createGain();
    const len = (14 + Math.log10(1 + W) * 8) / r;
    rg.gain.setValueAtTime(0, t);
    rg.gain.linearRampToValueAtTime(0.9 * loud, t + 0.3);
    for (let k = 1; k < 8; k++) rg.gain.linearRampToValueAtTime((0.3 + Math.random() * 0.7) * loud * Math.pow(1 - k / 8, 1.3), t + (len * k) / 8);
    rg.gain.linearRampToValueAtTime(0, t + len);
    rum.connect(rf).connect(rg);
    rg.connect(this.master); rg.connect(this.reverb);
    rum.start(t); rum.stop(t + len + 0.5);

    // 4. afterwind: air rushing back toward the rising fireball
    const aw = this._src(this.noiseBuf, true);
    const af = ctx.createBiquadFilter(); af.type = 'bandpass'; af.frequency.value = 500; af.Q.value = 0.5;
    const ag = ctx.createGain();
    ag.gain.setValueAtTime(0, t);
    ag.gain.linearRampToValueAtTime(Math.min(0.35, psi * 0.05), t + 3 / r);
    ag.gain.linearRampToValueAtTime(0, t + 25 / r);
    aw.connect(af).connect(ag).connect(this.master);
    aw.start(t); aw.stop(t + 26 / r);

    // debris rattle for strong shocks
    if (psi > 1) {
      for (let i = 0; i < Math.min(40, psi * 5); i++) {
        const tt = t + (0.05 + Math.random() * 1.8) / r;
        const s = this._src(this.noiseBuf, false);
        const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 800 + Math.random() * 3000; f.Q.value = 3;
        const g = ctx.createGain(); g.gain.setValueAtTime(0.12, tt); g.gain.exponentialRampToValueAtTime(0.001, tt + 0.08);
        s.connect(f).connect(g).connect(this.master);
        s.start(tt, Math.random() * 3); s.stop(tt + 0.1);
      }
    }
    this.bedGain.gain.setTargetAtTime(0.9, t + 6, 3);
  }

  geiger(ratePerSec) { this.geigerRate = ratePerSec; }

  _click() {
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 3200;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.08, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.004);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.01);
  }

  /**
   * Called every frame with the simulation clock. Fires events on forward crossings only,
   * so scrubbing does not spam sounds.
   */
  tick(t, playing, rate, events, dtReal) {
    if (!this.ctx || !this.enabled) return;
    if (this.pendingBed) { this.setBed(this.pendingBed); this.pendingBed = null; }
    const prev = this.lastT;
    this.lastT = t;
    if (!playing || t < prev || t - prev > 5) {
      if (t < prev) this.fired.clear();
      return;
    }
    for (const e of events) {
      if (prev < e.t && t >= e.t && !this.fired.has(e.id)) {
        this.fired.add(e.id);
        e.fire(rate);
      }
    }
    // Geiger clicks, Poisson process
    if (this.geigerRate > 0.05) {
      this.geigerNext -= dtReal;
      while (this.geigerNext <= 0) {
        this._click();
        this.geigerNext += -Math.log(1 - Math.random()) / Math.min(this.geigerRate, 400);
      }
    }
  }
}
