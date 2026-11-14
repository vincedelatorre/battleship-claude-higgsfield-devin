// quality.js - render quality tiers (auto-detected per device, or forced with ?quality=low|medium|high,
// remembered in localStorage; ?quality=auto clears it) plus the GPU capability probe and a frame-time
// governor that trades render resolution (then bloom) for frame rate when the device falls behind.
const KEY = 'captains-gambit-quality';

export const TIERS = {
  // Desktop: exactly the original settings.
  high: {
    name: 'high', maxPR: 1.5, pixelBudget: Infinity, minScale: 0.6, targetFps: 50,
    shadowMap: 2048, softShadows: true, bloom: true, bloomScale: 1,
    fftN: 256, oceanGrid: 320, particles: 10000, particleDensity: 1, rain: 3500,
    crew: 5, crewAnimEvery: 1, skyClouds: true, fbmOctaves: 6, skySegments: [48, 24], anisotropy: 8, maxTexture: 4096,
  },
  // Tablets (iPad, Android tablets): full look at a bounded pixel count, cheaper shadows/bloom.
  medium: {
    name: 'medium', maxPR: 1.5, pixelBudget: 2.2e6, minScale: 0.55, targetFps: 55,
    shadowMap: 1024, softShadows: false, bloom: true, bloomScale: 0.5,
    fftN: 256, oceanGrid: 256, particles: 6000, particleDensity: 0.7, rain: 2200,
    crew: 5, crewAnimEvery: 1, skyClouds: true, fbmOctaves: 5, skySegments: [40, 20], anisotropy: 4, maxTexture: 2048,
  },
  // Phones and weak GPUs: half-size FFT, no bloom, fewer particles and pirates.
  low: {
    name: 'low', maxPR: 1.5, pixelBudget: 0.75e6, minScale: 0.5, targetFps: 30,
    shadowMap: 1024, softShadows: false, bloom: false, bloomScale: 0.5,
    fftN: 128, oceanGrid: 192, particles: 3500, particleDensity: 0.45, rain: 1200,
    crew: 3, crewAnimEvery: 2, skyClouds: false, fbmOctaves: 4, skySegments: [32, 16], anisotropy: 2, maxTexture: 2048,
  },
};

// What the browser's WebGL 2 can do, from a throwaway context.
export function probeGL() {
  let gl = null;
  try { gl = document.createElement('canvas').getContext('webgl2'); } catch (_) { /* no WebGL */ }
  if (!gl) return null;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const caps = {
    renderer: String((dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || ''),
    vendor: String((dbg && gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) || gl.getParameter(gl.VENDOR) || ''),
    floatRT: !!gl.getExtension('EXT_color_buffer_float'),
    halfRT: !!gl.getExtension('EXT_color_buffer_half_float') || !!gl.getExtension('EXT_color_buffer_float'),
    floatLinear: !!gl.getExtension('OES_texture_float_linear'),
    fragHighp: !!hp && hp.precision > 0,
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
  };
  // RGBA16F render targets: listed by EXT_color_buffer_half_float, but some WebGL 2 builds (older iOS)
  // render to them without advertising it. Check the framebuffer for real.
  if (!caps.halfRT) caps.halfRT = canRender(gl, gl.RGBA16F, gl.HALF_FLOAT);
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return caps;
}

function canRender(gl, internal, type) {
  const t = gl.createTexture(), fb = gl.createFramebuffer();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, gl.RGBA, type, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteTexture(t);
  return ok;
}

export function deviceInfo() {
  const nav = navigator, ua = nav.userAgent || '';
  const touch = (nav.maxTouchPoints || 0) > 1 || matchMedia('(pointer: coarse)').matches;
  // iPadOS Safari reports itself as a Mac; the touch points give it away.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
  const android = /Android/.test(ua);
  const short = Math.min(screen.width || innerWidth, screen.height || innerHeight);
  const mobile = touch && (ios || android || /Mobi/.test(ua) || short < 1100);
  return { touch, ios, android, mobile, phone: mobile && short < 600, tablet: mobile && short >= 600, dpr: window.devicePixelRatio || 1, short };
}

const WEAK_GPU = /SwiftShader|llvmpipe|softpipe|Software|Mali-[GT]?[1-7]\d\b|Mali-4|Adreno \(TM\) [3-5]\d\d|PowerVR|Intel.*HD Graphics [2-5]\d{2,3}\b|Intel\(R\) HD Graphics$/i;

export function chooseQuality(caps) {
  const params = new URLSearchParams(location.search);
  let forced = (params.get('quality') || '').toLowerCase();
  try {
    if (forced === 'auto') localStorage.removeItem(KEY);
    else if (TIERS[forced]) localStorage.setItem(KEY, forced);
    else forced = localStorage.getItem(KEY) || '';
  } catch (_) { if (!TIERS[forced]) forced = ''; }
  const dev = deviceInfo();
  let name = 'high', why = 'desktop';
  if (dev.phone) { name = 'low'; why = 'phone'; }
  else if (dev.tablet) { name = 'medium'; why = 'tablet'; }
  if (caps && WEAK_GPU.test(caps.renderer)) { name = 'low'; why = 'weak GPU'; }
  if (dev.mobile && ((navigator.deviceMemory && navigator.deviceMemory <= 3) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4))) { name = 'low'; why = 'low-end device'; }
  const auto = !TIERS[forced];
  if (!auto) { name = forced; why = 'override'; }
  const q = { ...TIERS[name], auto, why, device: dev };
  if (caps) q.maxTexture = Math.min(q.maxTexture, caps.maxTexture || 4096);
  return q;
}

// Render pixel ratio: never above the screen's, capped per tier, and bounded to a pixel budget so a
// 3x phone or a 12.9" iPad doesn't shade 5+ million pixels a frame. `scale` comes from the governor.
export function pixelRatioFor(q, w, h, scale = 1) {
  const dpr = window.devicePixelRatio || 1;
  let pr = Math.min(dpr, q.maxPR, Math.sqrt(q.pixelBudget / Math.max(1, w * h)));
  pr = Math.max(Math.min(dpr, 0.75), pr) * scale;
  return Math.max(0.5, pr);
}

// Watches frame times while the 3D scene is drawn. Sustained slow frames lower the render scale in
// steps (and finally drop bloom); a long run of fast frames raises it again. Only for auto quality.
export class Governor {
  constructor(q, apply) {
    this.q = q; this.apply = apply; this.scale = 1; this.bloomOff = false;
    this.samples = []; this.good = 0; this.cool = 0;
    this.target = 1000 / q.targetFps;
  }
  reset() { this.samples.length = 0; this.cool = 30; }
  sample(ms) {
    if (!this.q.auto) return;
    if (this.cool > 0) { this.cool--; return; }       // settle after a change / resume
    if (ms > 250) return;                             // stalls (asset decode, tab switch) aren't the GPU
    this.samples.push(ms);
    if (this.samples.length < 45) return;
    const s = this.samples.sort((a, b) => a - b), med = s[s.length >> 1];
    const spread = s[Math.floor(s.length * 0.9)] - s[Math.floor(s.length * 0.1)];
    this.samples.length = 0;
    // Rock-steady 30/40 Hz is a display cap (iOS Low Power Mode, battery saver), not a slow GPU.
    if (spread < 1.5 && med < 34) return;
    if (med > this.target * 1.2) {
      this.good = 0;
      if (this.scale > this.q.minScale + 1e-3) this.scale = Math.max(this.q.minScale, this.scale * (med > this.target * 1.8 ? 0.75 : 0.88));
      else if (!this.bloomOff && this.q.bloom) this.bloomOff = true;
      else return;
      this.apply(this); this.cool = 20;
    } else if (med < this.target * 0.7 && this.scale < 1) {
      if (++this.good >= 3) { this.good = 0; this.scale = Math.min(1, this.scale / 0.9); this.apply(this); this.cool = 20; }
    } else this.good = 0;
  }
}
