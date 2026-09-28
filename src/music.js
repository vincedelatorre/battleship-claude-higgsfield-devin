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
    if (ctx) {
      try {
        this.gain = ctx.createGain(); this.gain.gain.value = 0;
        ctx.createMediaElementSource(el).connect(this.gain).connect(ctx.destination);
      } catch (_) { this.gain = null; }
    }
    if (!this.gain) el.volume = 0;
    el.play().catch(() => {});
  }
  setMuted(m) { this.muted = m; }
  // Dip under loud effects so the hits land, then swell back.
  duckFor(sec, depth = 0.45) { if (this.duckOn && !this.duckOn()) return; this.duckUntil = performance.now() + sec * 1000; this.duckDepth = Math.min(this.duckDepth, depth); }
  tick(dt) {
    if (!this.el) return;
    this.fade = Math.min(1, this.fade + dt / 3);
    const ducking = performance.now() < this.duckUntil;
    if (!ducking) this.duckDepth = 1;
    this.duck += ((ducking ? this.duckDepth : 1) - this.duck) * Math.min(1, dt * (ducking ? 10 : 1.2));
    const level = this.level ? this.level() : (this.muted ? 0 : this.base);
    const v = level * this.fade * this.duck;
    if (this.gain) { if (Math.abs(this.gain.gain.value - v) > 0.002) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); }
    else if (Math.abs(this.el.volume - v) > 0.003) this.el.volume = Math.max(0, Math.min(1, v));
  }
}
