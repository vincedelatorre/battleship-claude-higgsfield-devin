import { Music } from './music.js';
// audio.js - every sound is synthesized with WebAudio (no audio files), each on first use:
// cannons, whistles, splashes, explosions, bells, thunder, creaks, and looping rain/wind/sea.
export class Audio {
  constructor() { this.ctx = null; this.muted = false; this.buffers = {}; this.loops = {}; this.music = new Music(); }

  // Browsers only allow audio after a user gesture, so this runs on the first click or key.
  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); this.music.start(this.ctx); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    const comp = this.ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(this.ctx.destination);
    this._synthAll();
    this.music.start(this.ctx);
    // Build the ambience loops just after the gesture that started audio, so that press stays instant.
    setTimeout(() => this._startLoops(), 30);
  }
  _startLoops() {
    for (const k of ['rain', 'wind', 'sea']) {
      const src = this.ctx.createBufferSource();
      src.buffer = this._get(k); src.loop = true;
      const g = this.ctx.createGain(); g.gain.value = 0;
      src.connect(g).connect(this.master); src.start();
      this.loops[k] = g;
    }
  }
  setMuted(m) { this.muted = m; this.music.setMuted(m); if (this.master) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.05); }
  loop(name, vol) { const g = this.loops[name]; if (g) g.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.4); }

  play(name, { vol = 1, rate = 1, pan = 0, delay = 0, vary = 0 } = {}) {
    if (name === 'cannon' || name === 'explosion' || name === 'bigExplosion') this.music.duckFor(name === 'bigExplosion' ? 2.2 : 1.1, name === 'cannon' ? 0.55 : 0.4);
    if (!this.ctx || !this.buffers[name]) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this._get(name);
    src.playbackRate.value = rate * (1 + (Math.random() * 2 - 1) * vary);
    const g = this.ctx.createGain(); g.gain.value = vol * (1 + (Math.random() * 2 - 1) * vary * 0.5);
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; src.connect(g).connect(p).connect(this.master); } else src.connect(g).connect(this.master);
    src.start(this.ctx.currentTime + delay);
  }

  // Effects are built the first time they play (a few ms each) instead of all at startup.
  _buf(sec, fn) { return () => this._make(sec, fn); }
  _get(name) {
    const b = this.buffers[name];
    return typeof b === 'function' ? (this.buffers[name] = b()) : b;
  }
  _make(sec, fn) {
    const sr = this.ctx.sampleRate, n = Math.floor(sec * sr);
    const b = this.ctx.createBuffer(2, n, sr);
    const L = b.getChannelData(0), R = b.getChannelData(1);
    const st = { lp: 0, lp2: 0, bp: 0, ph: 0, r: 0 };
    for (let i = 0; i < n; i++) { const [l, r] = fn(i / sr, i, st); L[i] = l; R[i] = r === undefined ? l : r; }
    return b;
  }
  _synthAll() {
    const B = this.buffers, rnd = () => Math.random() * 2 - 1;
    const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));
    B.cannon = this._buf(2.2, (t, i, s) => {
      s.lp += (rnd() - s.lp) * (0.05 + 0.4 * Math.exp(-t * 20));
      const boom = Math.sin(2 * Math.PI * (48 * t + 30 * (1 - Math.exp(-t * 18)) / 18)) * Math.exp(-t * 5);
      const v = (s.lp * 1.6 + boom * 0.9) * env(t, 0.004, 0.45);
      return [v * 0.9, v];
    });
    B.whistle = this._buf(0.9, (t, i, s) => { s.ph += 2 * Math.PI * (1500 - 900 * t) / this.ctx.sampleRate; return [Math.sin(s.ph) * 0.12 * Math.sin(Math.PI * t / 0.9) + rnd() * 0.03 * Math.sin(Math.PI * t / 0.9)]; });
    B.splash = this._buf(1.6, (t, i, s) => { s.lp += (rnd() - s.lp) * 0.25; s.lp2 += (s.lp - s.lp2) * 0.08; const v = (s.lp - s.lp2 * 0.5) * env(t, 0.02, 0.35) + rnd() * 0.15 * env(t, 0.1, 0.6); return [v, v * 0.95]; });
    B.explosion = this._buf(3.0, (t, i, s) => {
      s.lp += (rnd() - s.lp) * (0.03 + 0.5 * Math.exp(-t * 12));
      const crackle = Math.random() < 0.004 * Math.exp(-t) ? rnd() * 2 : 0;
      const v = (s.lp * 2.0 + Math.sin(2 * Math.PI * 38 * t) * Math.exp(-t * 3) + crackle) * env(t, 0.005, 0.7);
      return [v, v * 0.92];
    });
    B.bigExplosion = this._buf(4.5, (t, i, s) => {
      s.lp += (rnd() - s.lp) * (0.02 + 0.4 * Math.exp(-t * 8));
      const rumble = Math.sin(2 * Math.PI * 30 * t) * Math.exp(-t * 1.2);
      const v = (s.lp * 2.4 + rumble + (Math.random() < 0.006 * Math.exp(-t * 0.7) ? rnd() * 2 : 0)) * env(t, 0.008, 1.2);
      return [v, v * 0.9];
    });
    B.thunder = this._buf(6.0, (t, i, s) => {
      s.lp += (rnd() - s.lp) * 0.015; s.lp2 += (rnd() - s.lp2) * 0.004;
      const roll = 0.6 + 0.4 * Math.sin(t * 5.3) * Math.sin(t * 2.1);
      const v = (s.lp * 3.5 * env(t, 0.03, 0.6) + s.lp2 * 9 * roll * env(t, 0.25, 2.2));
      return [v, v * 0.9];
    });
    const tone = (sec, freqs, decay, amp = 0.25) => this._buf(sec, (t) => { let v = 0; freqs.forEach(([f, a], k) => { v += Math.sin(2 * Math.PI * f * t) * a * Math.exp(-t / (decay * (1 - k * 0.12))); }); return [v * amp]; });
    B.bell = tone(2.5, [[880, 1], [1760, 0.5], [2640, 0.25], [1180, 0.3]], 0.9, 0.18);
    B.gong = tone(4.0, [[110, 1], [165, 0.6], [231, 0.5], [340, 0.3]], 1.6, 0.35);
    B.chime = tone(1.8, [[1318, 1], [1760, 0.6], [2637, 0.3]], 0.5, 0.2);
    B.click = this._buf(0.06, (t) => [Math.sin(2 * Math.PI * 1900 * t) * Math.exp(-t * 90) * 0.25]);
    B.thud = this._buf(0.3, (t, i, s) => { s.lp += (rnd() - s.lp) * 0.08; return [(Math.sin(2 * Math.PI * 90 * t) * 0.5 + s.lp) * Math.exp(-t * 18) * 0.6]; });
    B.ghost = this._buf(3.0, (t, i, s) => { const f = 220 + 60 * Math.sin(t * 3); s.ph += 2 * Math.PI * f / this.ctx.sampleRate; s.lp += (rnd() - s.lp) * 0.02; const v = (Math.sin(s.ph) * 0.2 + Math.sin(s.ph * 1.5) * 0.1 + s.lp * 0.8) * Math.sin(Math.PI * t / 3); return [v, v * 0.8]; });
    B.creak = this._buf(1.2, (t, i, s) => { const f = 70 + 30 * Math.sin(t * 9); s.ph += 2 * Math.PI * f / this.ctx.sampleRate; const saw = (s.ph / Math.PI) % 2 - 1; return [saw * 0.25 * Math.sin(Math.PI * t / 1.2) * (0.5 + 0.5 * Math.sin(t * 40))]; });
    B.waveCrash = this._buf(2.5, (t, i, s) => { s.lp += (rnd() - s.lp) * 0.3; s.lp2 += (s.lp - s.lp2) * 0.05; const v = (s.lp - s.lp2) * env(t, 0.15, 0.7) * 1.5; return [v, v * 0.9]; });
    B.heartbeat = this._buf(0.8, (t) => { const k = (x) => Math.sin(2 * Math.PI * 55 * x) * Math.exp(-x * 25) * (x > 0 ? 1 : 0); return [(k(t) + 0.7 * k(t - 0.22)) * 0.8]; });
    const chord = (sec, notes, up) => this._buf(sec, (t) => { let v = 0; notes.forEach((f, k) => { const st = k * (up ? 0.18 : 0.3); if (t > st) v += Math.sin(2 * Math.PI * f * (t - st)) * Math.exp(-(t - st) * 1.2) * 0.12; }); return [v]; });
    B.victory = chord(3.5, [392, 494, 587, 784, 988], true);
    B.defeat = chord(4, [330, 311, 262, 196], false);
    B.rain = this._buf(4, (t, i, s) => { s.lp += (rnd() - s.lp) * 0.6; const drop = Math.random() < 0.002 ? rnd() * 0.6 : 0; return [s.lp * 0.35 + drop, s.lp * 0.35 - drop * 0.5]; });
    B.wind = this._buf(6, (t, i, s) => { s.lp += (rnd() - s.lp) * 0.02; const gust = 0.6 + 0.4 * Math.sin(2 * Math.PI * t / 6) * Math.sin(2 * Math.PI * t / 3); return [s.lp * 3 * gust, s.lp * 2.6 * gust]; });
    B.sea = this._buf(8, (t, i, s) => { s.lp += (rnd() - s.lp) * 0.05; const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * t / 8 * 2); return [s.lp * 1.6 * swell, s.lp * 1.6 * (1 - swell * 0.5)]; });
  }
}
