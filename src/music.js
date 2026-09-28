// music.js - one background track on a loop. It streams through an <audio> element (a 10-minute
// song is never decoded whole into memory), passes through a WebAudio gain so volume, mute and
// ducking work on every browser, fades in on first play and dips under cannon fire.
export class Music {
  constructor() {
    this.el = null; this.gain = null; this.ctx = null;
    this.base = 0.32;          // background level: the track is mastered loud
    this.fade = 0; this.duck = 1; this.duckUntil = 0; this.duckDepth = 1; this.muted = false;
  }
  url() { return window.CG_MUSIC_URL || (window.CG_NO_FILES ? null : 'assets/music/pirate-music.mp4'); }
  // Call from a user gesture (browsers only allow audio to start after one).
  start(ctx) {
    if (this.el) { if (this.el.paused) this.el.play().catch(() => {}); return; }
    const src = this.url();
    if (!src) return;
    const el = (this.el = new Audio());
    el.src = src; el.loop = true; el.preload = 'auto';
    this.ctx = ctx;
    // Opened straight from disk (file://), browsers silence audio routed through WebAudio: there the
    // element plays directly and its own volume carries the mix (fades, ducking and mute still work).
    if (ctx && location.protocol !== 'file:') {
      try {
        this.gain = ctx.createGain(); this.gain.gain.value = 0;
        ctx.createMediaElementSource(el).connect(this.gain).connect(ctx.destination);
      } catch (_) { this.gain = null; }
    }
    if (!this.gain) el.volume = 0;
    el.play().catch(() => {});
  }
  setMuted(m) { this.muted = m; }
  setBattle(on) { if (this.inBattle !== on) { this.inBattle = on; this._sceneChange = true; } }
  // Dip under loud effects so the hits land, then swell back.
  duckFor(sec, depth = 0.45) { if (this.duckOn && !this.duckOn()) return; this.duckUntil = performance.now() + sec * 1000; this.duckDepth = Math.min(this.duckDepth, depth); }
  tick() {
    if (!this.el) return;
    // Real elapsed time, so fades take the same seconds at any frame rate.
    const now = performance.now(), dt = Math.min(0.25, (now - (this._t || now)) / 1000);
    this._t = now;
    this.fade = Math.min(1, this.fade + dt / 3);
    const ducking = performance.now() < this.duckUntil;
    if (!ducking) this.duckDepth = 1;
    this.duck += ((ducking ? this.duckDepth : 1) - this.duck) * Math.min(1, dt * (ducking ? 10 : 1.2));
    const target = this.level ? this.level() : (this.muted ? 0 : this.base);
    // Glide between levels (menu -> battle fades over ~3 s); mute and slider moves follow quickly.
    const rate = this._lastTarget !== undefined && Math.abs(target - this._lastTarget) > 0.001 && !this._sceneChange ? 8 : 1.1;
    this._lastTarget = target; this._sceneChange = false;
    this.levelNow = this.levelNow === undefined ? target : this.levelNow + (target - this.levelNow) * Math.min(1, dt * rate);
    const level = this.levelNow;
    const v = level * this.fade * this.duck;
    if (this.gain) { if (Math.abs(this.gain.gain.value - v) > 0.002) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); }
    else if (Math.abs(this.el.volume - v) > 0.003) this.el.volume = Math.max(0, Math.min(1, v));
  }
}
