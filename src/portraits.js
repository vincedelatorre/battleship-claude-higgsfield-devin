// portraits.js - "living portraits". One small WebGL2 context animates every visible captain
// portrait: breathing (chest and shoulders rise and widen, the head rides on top), a slow head
// sway around the neck with background parallax, wind in hair and feathers, rain, lightning,
// and a signature effect per captain (lantern, fuse embers, heroine's storm, ghost-light eyes).
// Each frame is drawn in the shared context and copied into the portrait's own 2D canvas.
// If WebGL isn't available, or the player prefers reduced motion, the still image is shown.
import { CAPTAINS } from './rules.js';
import { artUrl } from './ui.js';

const VS = `#version 300 es
in vec2 pos; void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uRes;          // target size in pixels
uniform vec4 uCrop;         // image uv = uCrop.zw + box uv * uCrop.xy
uniform float uTime, uFlash, uAnim, uSeed;
uniform int uCap;
uniform vec4 uHair[2];      // wind-blown regions (x0, y0, x1, y1) in image uv
uniform float uHairAmp;
out vec4 o;

float hash(float n) { return fract(sin(n) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.02 + 7.1; a *= 0.5; } return s; }
float box(vec2 p, vec4 r) {
  vec2 a = smoothstep(r.xy, r.xy + 0.08, p) * smoothstep(r.zw, r.zw - 0.08, p);
  return a.x * a.y;
}

void main() {
  vec2 b = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);   // box uv, v down
  vec2 p = uCrop.zw + b * uCrop.xy;                                           // image uv
  float t = uTime + uSeed * 17.0;

  // Breath: a 4.4 s cycle, eased so it lingers at the top and bottom like a real breath.
  float br = 0.5 + 0.5 * sin(t * 6.2831853 / 4.4);
  br = br * br * (3.0 - 2.0 * br) * 2.0 - 1.0;
  vec2 q = (p - vec2(0.5, 0.6)) * vec2(1.2, 0.9);
  float subj = smoothstep(0.66, 0.3, length(q));                 // the captain, roughly
  float chest = smoothstep(0.55, 0.95, p.y) * smoothstep(1.0, 0.93, p.y);
  float head = smoothstep(0.68, 0.42, p.y);
  vec2 d = vec2(0.0);
  d.y -= 0.0065 * br * (chest + head * 0.45) * subj;
  d.x += (p.x - 0.5) * 0.011 * br * chest * subj;

  // The head drifts and tilts slowly around the neck; the background shifts the other way.
  float sway = sin(t * 0.31) * 0.6 + sin(t * 0.53 + 1.3) * 0.4;
  float nod = sin(t * 0.41 + 0.7);
  vec2 piv = vec2(0.5, 0.66);
  float ang = 0.011 * sway * head * subj;
  vec2 r = p - piv;
  r = vec2(r.x * cos(ang) - r.y * sin(ang), r.x * sin(ang) + r.y * cos(ang));
  d += (r + piv - p);
  d += vec2(0.004 * sway, 0.0025 * nod) * head * subj;
  d -= vec2(0.003 * sway, 0.0018 * nod) * (1.0 - subj);

  // Wind through hair, dreadlocks and feathers, in gusts.
  float gust = 0.55 + 0.45 * sin(t * 0.7) * sin(t * 0.43 + 2.0);
  float hair = max(box(p, uHair[0]), box(p, uHair[1])) * uHairAmp * gust;
  d.x += hair * 0.0065 * sin(p.y * 24.0 - t * 2.8 + noise(p * 6.0 + t * 0.5) * 3.0);
  d.y += hair * 0.003 * sin(p.x * 19.0 - t * 2.2);

  d *= uAnim;
  vec3 col = texture(uTex, clamp(p - d, vec2(0.001), vec2(0.999))).rgb;
  vec2 asp = vec2(0.7534, 1.0);   // image aspect, so round things stay round

  // Lightning from the game's storm: the sky flares, the captain catches a cold rim.
  col *= 1.0 + uFlash * mix(0.7, 0.2, subj);
  col += vec3(0.16, 0.2, 0.3) * uFlash * (1.0 - subj) * 0.35;

  if (uCap == 0) {            // Blackthorn: the lantern behind him gutters in the wind
    vec2 L = (p - vec2(0.035, 0.45)) * asp;
    float fl = 0.72 + 0.28 * noise(vec2(t * 9.0, 1.0)) + 0.1 * sin(t * 23.0);
    float g = exp(-dot(L, L) / 0.012);
    col *= 1.0 + exp(-dot(L, L) / 0.06) * (fl - 0.82) * 0.9;
    col += vec3(1.0, 0.55, 0.2) * g * fl * 0.08;
  } else if (uCap == 1) {     // Morrigan: the fuse sputters and throws embers past her face
    vec2 F = vec2(0.345, 0.81);
    vec2 dF = (p - F) * asp;
    float fl = 0.55 + 0.45 * noise(vec2(t * 16.0, 3.0));
    col += vec3(1.0, 0.4, 0.1) * exp(-dot(dF, dF) / 0.0018) * fl * 0.7;
    col *= 1.0 + exp(-dot(dF, dF) / 0.035) * (fl - 0.7) * 0.7;
    for (int i = 0; i < 18; i++) {
      float fi = float(i);
      float life = fract(t * (0.22 + hash(fi) * 0.18) + hash(fi * 7.3));
      vec2 e = F + vec2((hash(fi * 3.1) - 0.5) * 0.06 + sin(life * 5.0 + fi) * 0.035 + life * 0.05, -life * (0.35 + hash(fi * 1.7) * 0.25));
      vec2 de = (p - e) * asp;
      float sz = 0.0045 * (1.0 - life) + 0.001;
      col += vec3(1.0, 0.45, 0.12) * smoothstep(sz, 0.0, length(de)) * (1.0 - life) * 2.2 * step(0.02, life);
    }
  } else if (uCap == 3) {     // Bonecrusher: ghost-light in the sockets, spectral mist drifting past
    float pulse = 0.5 + 0.5 * sin(t * 1.6) * sin(t * 0.9 + 1.0);
    for (int k = 0; k < 2; k++) {
      vec2 E = (p - vec2(k == 0 ? 0.432 : 0.608, 0.305)) * asp;
      col += vec3(0.35, 1.0, 0.8) * exp(-dot(E, E) / 0.00035) * (0.35 + pulse * 0.9);
    }
    float m = fbm(p * vec2(3.2, 2.2) + vec2(t * 0.06, -t * 0.035));
    col += vec3(0.28, 0.6, 0.55) * smoothstep(0.52, 0.9, m) * (1.0 - subj * 0.75) * 0.22;
  }

  // Rain streaks across the frame.
  float rain = 0.0;
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    vec2 rp = vec2(p.x * 110.0 + p.y * 9.0 + fk * 41.0, p.y * 2.6 + t * (2.4 + fk * 0.8));
    vec2 id = floor(rp), f = fract(rp);
    rain += step(0.94, hash2(id)) * smoothstep(0.0, 0.04, f.y) * smoothstep(0.3, 0.04, f.y) * smoothstep(0.45, 0.1, abs(f.x - 0.5));
  }
  col += vec3(0.6, 0.66, 0.78) * rain * 0.07 * (1.0 - subj * 0.5) * uAnim;
  o = vec4(col, 1.0);
}`;

// Per-captain wind regions (image uv) and strength, keyed by portrait name.
const HAIR = {
  blackthorn: { boxes: [[0.16, 0.42, 0.36, 0.98], [0.6, 0.42, 0.82, 0.98]], amp: 0.6 },
  morrigan: { boxes: [[0.02, 0.28, 0.34, 0.92], [0.64, 0.28, 0.98, 0.92]], amp: 0.9 },
  isla: { boxes: [[0.6, 0.24, 1.0, 0.86], [0.02, 0.0, 0.46, 0.2]], amp: 1.2 },
  bonecrusher: { boxes: [[0.0, 0.12, 0.28, 0.9], [0.72, 0.12, 1.0, 0.6]], amp: 0.7 },
};

export class LivingPortraits {
  constructor() {
    this.ok = false;
    this.tex = {};
    this.last = 0;
    this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    try { this._init(); } catch (e) { console.warn('Living portraits disabled:', e.message); }
  }
  _init() {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
    if (!gl) return;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(prog);
    this.u = {};
    for (const n of ['uTex', 'uRes', 'uCrop', 'uTime', 'uFlash', 'uAnim', 'uSeed', 'uCap', 'uHair', 'uHairAmp']) this.u[n] = gl.getUniformLocation(prog, n);
    this.gl = gl; this.canvas = c;
    CAPTAINS.forEach((cap, i) => {
      const url = artUrl(cap.portrait);
      if (!url) return;
      const img = new Image();
      img.onload = () => {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        this.tex[i] = { t, w: img.naturalWidth, h: img.naturalHeight };
      };
      img.src = url;
    });
    this.ok = true;
  }

  // Called every frame; redraws visible portraits at ~30 fps.
  update(now, flash = 0) {
    if (!this.ok || document.hidden) return;
    if (now - this.last < 33) return;
    this.last = now;
    const gl = this.gl, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = innerWidth, vh = innerHeight;
    for (const cv of document.querySelectorAll('canvas.live')) {
      const i = Number(cv.dataset.cap), tex = this.tex[i];
      if (!tex) continue;
      if (cv.parentNode.querySelector('video.clip.on')) continue;
      const r = cv.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || !cv.offsetParent) continue;
      const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      if (this.canvas.width < w || this.canvas.height < h) { this.canvas.width = Math.max(this.canvas.width, w); this.canvas.height = Math.max(this.canvas.height, h); }
      // "Cover" crop with the same focus point the CSS uses for the still image.
      const focus = parseFloat(getComputedStyle(cv).getPropertyValue('--focus')) || 0.12;
      const A = w / h, I = tex.w / tex.h;
      let sx = 1, sy = 1, ox = 0, oy = 0;
      if (A > I) { sy = I / A; oy = (1 - sy) * focus; } else { sx = A / I; ox = (1 - sx) * 0.5; }
      const hair = HAIR[CAPTAINS[i].portrait];
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, tex.t);
      gl.uniform1i(this.u.uTex, 0);
      gl.uniform2f(this.u.uRes, w, h);
      gl.uniform4f(this.u.uCrop, sx, sy, ox, oy);
      gl.uniform1f(this.u.uTime, now / 1000);
      gl.uniform1f(this.u.uFlash, flash);
      gl.uniform1f(this.u.uAnim, this.reduced ? 0 : 1);
      gl.uniform1f(this.u.uSeed, i * 0.37);
      gl.uniform1i(this.u.uCap, i);
      gl.uniform4fv(this.u.uHair, hair.boxes.flat());
      gl.uniform1f(this.u.uHairAmp, hair.amp);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const ctx = cv.getContext('2d');
      ctx.drawImage(this.canvas, 0, this.canvas.height - h, w, h, 0, 0, w, h);
      cv.classList.add('ready');
    }
  }
}
