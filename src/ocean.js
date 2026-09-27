// ocean.js - 3-cascade FFT ocean (Tessendorf) on WebGL2 through three.js.
//
// Each cascade is a 256x256 inverse FFT of a storm-sea spectrum (JONSWAP wind sea plus a
// crossing swell). The three patch sizes are non-harmonic (617 m, 97.3 m, 16.1 m) so their
// repeats never line up, which is what removes visible tiling. Every frame, per cascade:
//   1. evolve  - advance the spectrum in time and build 8 frequency fields
//                (height, choppy x/z displacement and their derivatives), packed 2 per complex
//   2. FFT     - 8 horizontal + 8 vertical Stockham radix-2 passes, ping-ponged, using MRT
//   3. resolve - write displacement + slopes/foam into mipmapped half-float textures;
//                foam comes from wave folding (the Jacobian) and decays over time
// A CPU copy of the largest cascade's low frequencies drives ship motion, so ships ride the
// swells you can actually see.
import * as THREE from 'three';

const G = 9.81;
const FFT_N = 256;
const CPU_N = 64;
export const CASCADES = [
  { L: 617.0, kLo: 0.0001, kHi: (2 * Math.PI / 97.3) * 6, chop: 1.25 },
  { L: 97.3, kLo: (2 * Math.PI / 97.3) * 6, kHi: (2 * Math.PI / 16.1) * 6, chop: 1.1 },
  { L: 16.1, kLo: (2 * Math.PI / 16.1) * 6, kHi: 9999, chop: 1.0 },
];

// ------------------------------------------------------------------ spectrum
function gaussianPair(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  v = rng();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

// Directional storm spectrum S(kx, kz) in m^4 (energy per wavenumber area).
function stormSpectrum(kx, kz, p) {
  const k = Math.hypot(kx, kz);
  if (k < 1e-6) return 0;
  const w = Math.sqrt(G * k);
  const dwdk = G / (2 * w);
  const theta = Math.atan2(kz, kx);
  const jonswap = (U, F, dirAngle, spreadPow, gain) => {
    const wp = 22 * Math.cbrt((G * G) / (U * F));
    const alpha = 0.076 * Math.pow((U * U) / (F * G), 0.22);
    const sigma = w <= wp ? 0.07 : 0.09;
    const r = Math.exp(-((w - wp) ** 2) / (2 * sigma * sigma * wp * wp));
    const Sw = ((alpha * G * G) / Math.pow(w, 5)) * Math.exp(-1.25 * Math.pow(wp / w, 4)) * Math.pow(3.3, r);
    let d = Math.cos(theta - dirAngle);
    // Mostly downwind with a little energy in every direction: storms are confused seas.
    const D = d > 0 ? Math.pow(d, spreadPow) * 0.9 + 0.1 : 0.1 * Math.pow(Math.max(0, -d), 2) + 0.02;
    return gain * Sw * D * dwdk / k;
  };
  let S = jonswap(p.wind, p.fetch, p.windDir, 2.0, 1.0);
  S += jonswap(p.wind * 0.75, p.fetch * 2.5, p.windDir + 1.15, 6.0, 0.45); // crossing swell
  // Damp capillary-scale waves.
  S *= Math.exp(-(k * k) * 0.0004);
  return S;
}

// ------------------------------------------------------------------ GLSL
const QUAD_VS = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const EVOLVE_FS = /* glsl */ `
precision highp float;
uniform sampler2D h0;
uniform float time, L, N;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
vec2 pack2(vec2 a, vec2 b) { return vec2(a.x - b.y, a.y + b.x); } // A + iB
void main() {
  vec2 n = floor(gl_FragCoord.xy);
  vec2 idx = vec2(n.x < N * 0.5 ? n.x : n.x - N, n.y < N * 0.5 ? n.y : n.y - N);
  vec2 kv = 6.28318530718 * idx / L;
  float k = length(kv);
  vec4 s = texelFetch(h0, ivec2(n), 0);
  float w = sqrt(9.81 * k);
  vec2 e = vec2(cos(w * time), sin(w * time));
  vec2 h = cmul(s.xy, e) + cmul(s.zw, vec2(e.x, -e.y));
  float ik = k > 1e-6 ? 1.0 / k : 0.0;
  vec2 dx = vec2(h.y, -h.x) * kv.x * ik;           // -i kx/k h
  vec2 dz = vec2(h.y, -h.x) * kv.y * ik;           // -i kz/k h
  vec2 hx = vec2(-h.y, h.x) * kv.x;                // i kx h
  vec2 hz = vec2(-h.y, h.x) * kv.y;                // i kz h
  vec2 dxx = h * kv.x * kv.x * ik;
  vec2 dzz = h * kv.y * kv.y * ik;
  vec2 dxz = h * kv.x * kv.y * ik;
  o0 = vec4(pack2(h, dx), pack2(dz, hx));
  o1 = vec4(pack2(hz, dxx), pack2(dzz, dxz));
}`;

const FFT_FS = /* glsl */ `
precision highp float;
uniform sampler2D in0, in1;
uniform float N, size, horizontal;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main() {
  vec2 p = floor(gl_FragCoord.xy);
  float i = horizontal > 0.5 ? p.x : p.y;
  float ev = floor(i / size) * (size * 0.5) + mod(i, size * 0.5);
  ivec2 a = horizontal > 0.5 ? ivec2(int(ev), int(p.y)) : ivec2(int(p.x), int(ev));
  ivec2 b = horizontal > 0.5 ? ivec2(int(ev + N * 0.5), int(p.y)) : ivec2(int(p.x), int(ev + N * 0.5));
  float ang = 6.28318530718 * i / size;
  vec2 tw = vec2(cos(ang), sin(ang));
  vec4 e0 = texelFetch(in0, a, 0), q0 = texelFetch(in0, b, 0);
  vec4 e1 = texelFetch(in1, a, 0), q1 = texelFetch(in1, b, 0);
  o0 = vec4(e0.xy + cmul(tw, q0.xy), e0.zw + cmul(tw, q0.zw));
  o1 = vec4(e1.xy + cmul(tw, q1.xy), e1.zw + cmul(tw, q1.zw));
}`;

const RESOLVE_FS = /* glsl */ `
precision highp float;
uniform sampler2D f0, f1, prevDisp;
uniform float chop, dt, foamBias, foamGain, foamDecay;
layout(location = 0) out vec4 disp;
layout(location = 1) out vec4 deriv;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(f0, p, 0);   // h, Dx, Dz, dh/dx
  vec4 b = texelFetch(f1, p, 0);   // dh/dz, dDx/dx, dDz/dz, dDx/dz
  float jxx = 1.0 + chop * b.y, jzz = 1.0 + chop * b.z, jxz = chop * b.w;
  float J = jxx * jzz - jxz * jxz;
  float prev = texelFetch(prevDisp, p, 0).w;
  float foam = max(prev * exp(-foamDecay * dt), clamp((foamBias - J) * foamGain, 0.0, 1.0));
  disp = vec4(chop * a.y, a.x, chop * a.z, foam);
  deriv = vec4(a.w / max(jxx, 0.2), b.x / max(jzz, 0.2), J, 0.0);
}`;

// Shared helpers for the storm sky, reused by the ocean for reflections.
export const SKY_GLSL = /* glsl */ `
uniform float uTime, uFlash;
uniform vec3 uFlashDir, uSunDir;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; } return s; }

// How far a direction lies in the sunset clearing (1) rather than the storm (0). The boundary
// is ragged and drifts, so the two halves of the sky blend through torn cloud, never a line.
float sunSide(vec3 dir) {
  vec2 a = normalize(dir.xz + vec2(1e-4)), s = normalize(uSunDir.xz);
  float c = dot(a, s);
  float az = atan(dir.z, dir.x);
  float n = fbm(vec2(az * 1.6 + uTime * 0.004, dir.y * 2.5)) - 0.5;
  return smoothstep(-0.45, 0.6, c + n * 0.7);
}
vec3 sunColor() { return vec3(1.5, 0.72, 0.3); }
vec3 horizonColor(vec3 dir) {
  float s = sunSide(dir);
  float g = max(dot(normalize(vec3(dir.x, 0.0, dir.z) + vec3(1e-4)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0);
  vec3 storm = vec3(0.075, 0.1, 0.135);
  vec3 dusk = mix(vec3(0.36, 0.15, 0.24), vec3(0.95, 0.43, 0.17), pow(g, 5.0));   // rose-magenta to gold toward the sun
  return mix(storm * (1.0 + uFlash * 1.6), dusk, s);
}
vec3 stormSky(vec3 dir, bool detailed) {
  float y = max(dir.y, 0.0);
  float s = sunSide(dir);
  float g = max(dot(dir, uSunDir), 0.0);
  vec3 zenith = mix(vec3(0.025, 0.035, 0.055), vec3(0.13, 0.1, 0.22), s);
  vec3 col = mix(horizonColor(dir), zenith, pow(y, 0.55));
  float dens = 0.0;
  if (dir.y > 0.0) {
    vec2 uv = dir.xz / (y + 0.06);
    float t = uTime;
    vec2 wind = vec2(0.020, 0.012);
    float c1, c2;
    if (detailed) {
      vec2 w = vec2(fbm(uv * 0.9 + t * wind * 2.0), fbm(uv * 0.9 - t * wind * 1.4 + 5.2));
      c1 = fbm(uv * 1.3 + w * 1.6 + t * wind * 4.0);
      c2 = fbm(uv * 3.1 - t * wind * 9.0 + w * 0.8);
    } else {
      c1 = fbm(uv * 1.3 + t * wind * 4.0);
      c2 = 0.5;
    }
    // Overcast over the storm, broken cloud over the sunset.
    float lo = mix(0.28, 0.5, s), hi = mix(0.72, 0.95, s);
    dens = smoothstep(lo, hi, c1 * 0.75 + c2 * 0.35);
    vec3 stormCloud = mix(vec3(0.15, 0.18, 0.23), vec3(0.035, 0.045, 0.06), dens);
    vec3 lit = mix(vec3(0.5, 0.2, 0.28), vec3(1.0, 0.46, 0.2), pow(g, 3.0));   // undersides lit by the low sun
    vec3 sunCloud = mix(lit, vec3(0.16, 0.08, 0.14), dens * 0.85);
    vec3 cloud = mix(stormCloud, sunCloud, s);
    cloud += sunColor() * pow(g, 7.0) * dens * (1.0 - dens) * 3.0 * s;          // silver (gold) linings
    // Lightning lights the storm deck from inside.
    float fl = max(dot(dir, uFlashDir), 0.0);
    cloud += vec3(0.45, 0.5, 0.75) * uFlash * (pow(fl, 18.0) * 2.5 + pow(fl, 4.0) * 0.35) * (0.4 + dens) * (1.0 - s * 0.8);
    col = mix(col, cloud, smoothstep(0.0, 0.12, y) * mix(0.75, 1.0, dens));
    // Crepuscular rays fanning out from the sun through the gaps.
    float az = atan(dir.y - uSunDir.y, dot(normalize(dir.xz), normalize(vec2(-uSunDir.z, uSunDir.x))));
    float rays = smoothstep(0.45, 0.85, fbm(vec2(az * 9.0, t * 0.03)));
    col += sunColor() * 0.1 * rays * pow(g, 6.0) * (1.0 - dens * 0.7) * s;
  }
  // The sun and its glow, veiled where cloud crosses it.
  col += vec3(3.0, 1.7, 0.75) * smoothstep(0.9990, 0.9995, g) * (1.0 - dens * 0.85);
  col += sunColor() * (pow(g, 60.0) * 0.5 + pow(g, 12.0) * 0.12) * (1.0 - dens * 0.5) * s;
  // Grey rain curtains hanging under the storm near the horizon.
  float az2 = atan(dir.z, dir.x);
  float curtain = (1.0 - s) * smoothstep(0.24, 0.0, dir.y) * smoothstep(0.35, 0.75, fbm(vec2(az2 * 7.0, 0.3) + vec2(uTime * 0.01, 0.0)));
  float streak = 0.7 + 0.3 * vnoise(vec2(az2 * 260.0, dir.y * 6.0 - uTime * 3.0));
  col = mix(col, vec3(0.1, 0.12, 0.15) * streak, curtain * 0.65);
  col += vec3(0.25, 0.28, 0.4) * uFlash * 0.06 * (1.0 - s);
  return col;
}`;

const OCEAN_VS = /* glsl */ `
uniform sampler2D disp0, disp1, disp2;
uniform vec3 Ls;
uniform float uDetail, uCalm;
varying vec3 vWorld;
varying float vDist;
float lodFor(float spacing, float L) { return max(0.0, log2(spacing * 256.0 / L)); }
void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  float dist = length(wp.xz - cameraPosition.xz);
  float spacing = 0.25 + dist * 0.012;
  vec3 d = textureLod(disp0, wp.xz / Ls.x, lodFor(spacing, Ls.x)).xyz;
  d += textureLod(disp1, wp.xz / Ls.y, lodFor(spacing, Ls.y)).xyz * (1.0 - smoothstep(600.0, 1400.0, dist));
  d += textureLod(disp2, wp.xz / Ls.z, lodFor(spacing, Ls.z)).xyz * uDetail * (1.0 - smoothstep(80.0, 260.0, dist));
  d *= mix(1.0, 0.35, uCalm);
  wp += d * (1.0 - smoothstep(3500.0, 6000.0, dist));
  vWorld = wp;
  vDist = dist;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;

const OCEAN_FS = /* glsl */ `
uniform sampler2D disp0, disp1, disp2, der0, der1, der2;
uniform vec3 Ls;
uniform float uDetail, uCalm, uHs, uFoamScale;
uniform mat4 uShipInv[6];
uniform vec3 uShipDim[6];     // half length, half beam, enabled
uniform vec4 uLights[4];      // xyz position, w intensity
uniform vec3 uLightCols[4];
uniform vec3 uFogColor;
uniform float uFogDensity;
varying vec3 vWorld;
varying float vDist;
${SKY_GLSL}
void main() {
  // Keep the sea out of the hulls: skip water inside each ship's footprint below its rail.
  for (int i = 0; i < 6; i++) {
    if (uShipDim[i].z < 0.5) continue;
    vec3 lp = (uShipInv[i] * vec4(vWorld, 1.0)).xyz;
    float t = lp.x / (2.0 * uShipDim[i].x) + 0.5;
    float u = (t - 0.4) / 0.6;
    float hw = uShipDim[i].y * sqrt(max(0.0, 1.0 - u * u));
    if (t > 0.0 && t < 1.0 && abs(lp.z) < hw * 0.97 && lp.y < 4.5) discard;
  }
  vec2 xz = vWorld.xz;
  vec4 a0 = texture(der0, xz / Ls.x), a1 = texture(der1, xz / Ls.y), a2 = texture(der2, xz / Ls.z);
  float f1 = 1.0 - smoothstep(600.0, 1400.0, vDist);
  float f2 = uDetail * (1.0 - smoothstep(150.0, 500.0, vDist));
  vec2 slope = a0.xy + a1.xy * f1 + a2.xy * f2;
  slope *= mix(1.0, 0.4, uCalm);
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = max(dot(n, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, n);
  R.y = abs(R.y);
  vec3 refl = stormSky(R, false);

  // Body colour: deep slate water with teal subsurface light in the thin wave crests.
  float h = vWorld.y;
  vec3 deep = vec3(0.012, 0.036, 0.05);
  vec3 sss = vec3(0.02, 0.1, 0.095) * smoothstep(-0.1 * uHs, 0.55 * uHs, h) * (0.5 + 0.5 * pow(1.0 - ndv, 2.0));
  vec3 amb = vec3(0.07, 0.08, 0.1) * (1.0 + uFlash * 2.5);
  vec3 col = deep + sss * (1.0 + uFlash * 1.5);
  col = mix(col, refl, F);
  // Lightning and moon glints.
  vec3 Hf = normalize(uFlashDir + V);
  col += vec3(0.8, 0.85, 1.0) * uFlash * pow(max(dot(n, Hf), 0.0), 220.0) * 2.0;
  // Sunlight breaks through in drifting pools, favouring the sunset side of the sea.
  vec2 toP = normalize(vWorld.xz - cameraPosition.xz + vec2(1e-3));
  float side = dot(toP, normalize(uSunDir.xz));
  float sunlit = smoothstep(0.3, 0.85, fbm(vWorld.xz / 300.0 + vec2(uTime * 0.006, 0.0)) + side * 0.3 + 0.04);
  vec3 Hs = normalize(uSunDir + V);
  float nh = max(dot(n, Hs), 0.0);
  float crest = smoothstep(-0.2 * uHs, 0.6 * uHs, h);
  col += sunColor() * pow(nh, 600.0) * 2.2 * sunlit;                                          // golden glitter
  col = mix(col, col * vec3(1.35, 1.08, 0.84), sunlit * 0.75);                                // warm wash where the sun breaks through
  col += sunColor() * (0.018 + 0.05 * crest) * sunlit * max(dot(n, uSunDir) + 0.3, 0.0);     // sun-facing wave faces catch the light
  col *= mix(0.88, 1.0, sunlit);

  // Foam: from wave folding in each cascade, broken up with noise so it streaks and tears.
  float foam = texture(disp0, xz / Ls.x).w * 0.8 + texture(disp1, xz / Ls.y).w * f1 * (0.15 + 0.85 * uDetail) + texture(disp2, xz / Ls.z).w * f2 * 0.6;
  float breakup = fbm(xz * 0.35 + vec2(uTime * 0.05, 0.0)) * 0.6 + fbm(xz * 1.7) * 0.4;
  foam *= uFoamScale;
  foam += smoothstep(0.55 * uHs, 0.95 * uHs, h) * 0.35 * uFoamScale * uDetail;
  foam = clamp(foam, 0.0, 1.0) * smoothstep(0.3, 0.8, breakup + foam * 0.45);
  vec3 foamCol = vec3(0.6, 0.66, 0.72) * (amb * 4.0 + 0.1) + sunColor() * 0.16 * sunlit;
  col = mix(col, foamCol, foam * 0.85);

  // Fires, lanterns and muzzle flashes reflected on the sea.
  for (int i = 0; i < 4; i++) {
    vec3 lp = uLights[i].xyz - vWorld;
    float d2 = dot(lp, lp);
    vec3 L = lp * inversesqrt(d2);
    float atten = uLights[i].w / (1.0 + d2 * 0.004);
    vec3 Hl = normalize(L + V);
    col += uLightCols[i] * atten * (pow(max(dot(n, Hl), 0.0), 60.0) * 3.0 + max(dot(n, L), 0.0) * 0.04 + foam * max(dot(n, L), 0.0) * 0.2);
  }

  float fog = 1.0 - exp(-vDist * uFogDensity);
  col = mix(col, horizonColor(normalize(vec3(-V.x, 0.0, -V.z) + vec3(1e-4))), clamp(fog, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------ CPU FFT (for ship motion)
function fft1d(re, im, n, inverse) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
function ifft2d(re, im, n) {
  const rr = new Float64Array(n), ri = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) { rr[x] = re[y * n + x]; ri[x] = im[y * n + x]; }
    fft1d(rr, ri, n, true);
    for (let x = 0; x < n; x++) { re[y * n + x] = rr[x]; im[y * n + x] = ri[x]; }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { rr[y] = re[y * n + x]; ri[y] = im[y * n + x]; }
    fft1d(rr, ri, n, true);
    for (let y = 0; y < n; y++) { re[y * n + x] = rr[y]; im[y * n + x] = ri[y]; }
  }
}

// ------------------------------------------------------------------ Ocean
export class Ocean {
  constructor(renderer, { seed = 7, wind = 22, fetch = 60000, windDir = -0.6, hs = 5.2 } = {}) {
    this.renderer = renderer;
    this.hs = hs;
    this.time = 0;
    this.params = { wind, fetch, windDir };
    this.detail = 1;
    this.calm = 0;

    // Seeded RNG so the sea is the same every run.
    let s = seed >>> 0;
    const rng = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

    // Initial spectra h0(k) and conj(h0(-k)), and the variance to normalise wave height.
    let variance = 0;
    const raw = CASCADES.map((c) => {
      const N = FFT_N, dk = (2 * Math.PI) / c.L;
      const amp = new Float32Array(N * N * 2);
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const ix = x < N / 2 ? x : x - N, iy = y < N / 2 ? y : y - N;
          const kx = ix * dk, kz = iy * dk, k = Math.hypot(kx, kz);
          const [g1, g2] = gaussianPair(rng);
          if (k < c.kLo || k >= c.kHi) continue;
          const S = stormSpectrum(kx, kz, this.params);
          const a = Math.sqrt(S * dk * dk * 0.5);
          amp[(y * N + x) * 2] = g1 * a;
          amp[(y * N + x) * 2 + 1] = g2 * a;
          variance += S * dk * dk;
        }
      return amp;
    });
    this.scale = hs / 4 / Math.sqrt(Math.max(variance, 1e-9));

    this.cascades = CASCADES.map((c, ci) => {
      const N = FFT_N;
      const data = new Float32Array(N * N * 4);
      const amp = raw[ci];
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) {
          const i = (y * N + x) * 2, o = (y * N + x) * 4;
          const mx = (N - x) % N, my = (N - y) % N, j = (my * N + mx) * 2;
          data[o] = amp[i] * this.scale; data[o + 1] = amp[i + 1] * this.scale;
          data[o + 2] = amp[j] * this.scale; data[o + 3] = -amp[j + 1] * this.scale;
        }
      const h0 = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.FloatType);
      h0.minFilter = h0.magFilter = THREE.NearestFilter;
      h0.needsUpdate = true;
      const fftRT = () => new THREE.WebGLRenderTarget(N, N, {
        count: 2, type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      });
      const outRT = () => {
        const rt = new THREE.WebGLRenderTarget(N, N, {
          count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearMipmapLinearFilter,
          magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: true, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
        });
        for (const t of rt.textures) {
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.magFilter = THREE.LinearFilter;
          t.generateMipmaps = true;
          t.anisotropy = 4;
        }
        return rt;
      };
      return { ...c, h0, ping: fftRT(), pong: fftRT(), out: [outRT(), outRT()], cur: 0, cpu: c === CASCADES[0] ? this._cpuSpectrum(amp) : null };
    });

    const mat = (fs, uniforms) => new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: QUAD_VS, fragmentShader: fs, uniforms, depthTest: false, depthWrite: false });
    this.evolveMat = mat(EVOLVE_FS, { h0: { value: null }, time: { value: 0 }, L: { value: 1 }, N: { value: FFT_N } });
    this.fftMat = mat(FFT_FS, { in0: { value: null }, in1: { value: null }, N: { value: FFT_N }, size: { value: 2 }, horizontal: { value: 1 } });
    this.resolveMat = mat(RESOLVE_FS, {
      f0: { value: null }, f1: { value: null }, prevDisp: { value: null }, chop: { value: 1 }, dt: { value: 0.016 },
      foamBias: { value: 0.58 }, foamGain: { value: 3.0 }, foamDecay: { value: 0.7 },
    });
    this.quadScene = new THREE.Scene();
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.evolveMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._buildSurface();
    this._cpu = { re: [new Float64Array(CPU_N * CPU_N), new Float64Array(CPU_N * CPU_N), new Float64Array(CPU_N * CPU_N)], im: [new Float64Array(CPU_N * CPU_N), new Float64Array(CPU_N * CPU_N), new Float64Array(CPU_N * CPU_N)] };
    this.update(0.016);
  }

  // Low-frequency subset of cascade 0 for the CPU copy (indices -32..31 in each axis).
  _cpuSpectrum(amp) {
    const N = FFT_N, n = CPU_N, out = [];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const ix = x < n / 2 ? x : x - n, iy = y < n / 2 ? y : y - n;
        const X = (ix + N) % N, Y = (iy + N) % N, i = (Y * N + X) * 2;
        const mX = (N - X) % N, mY = (N - Y) % N, j = (mY * N + mX) * 2;
        out.push({ ix, iy, r: amp[i] * this.scale, i: amp[i + 1] * this.scale, mr: amp[j] * this.scale, mi: -amp[j + 1] * this.scale });
      }
    return out;
  }

  _buildSurface() {
    // A camera-centred grid that is dense near the middle and stretches to the horizon.
    const R = 6000, S = 320;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array((S + 1) * (S + 1) * 3);
    const warp = (u) => Math.sign(u) * Math.pow(Math.abs(u), 2.6) * R;
    let o = 0;
    for (let j = 0; j <= S; j++)
      for (let i = 0; i <= S; i++) {
        pos[o++] = warp((i / S) * 2 - 1); pos[o++] = 0; pos[o++] = warp((j / S) * 2 - 1);
      }
    const idx = new Uint32Array(S * S * 6);
    o = 0;
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, d = c + 1;
        idx[o++] = a; idx[o++] = c; idx[o++] = b; idx[o++] = b; idx[o++] = c; idx[o++] = d;
      }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const lights = [0, 1, 2, 3].map(() => new THREE.Vector4(0, -1000, 0, 0));
    const lightCols = [0, 1, 2, 3].map(() => new THREE.Color(1, 0.6, 0.3));
    this.uniforms = {
      disp0: { value: null }, disp1: { value: null }, disp2: { value: null },
      der0: { value: null }, der1: { value: null }, der2: { value: null },
      Ls: { value: new THREE.Vector3(CASCADES[0].L, CASCADES[1].L, CASCADES[2].L) },
      uDetail: { value: 1 }, uCalm: { value: 0 }, uHs: { value: this.hs }, uFoamScale: { value: 1 },
      uShipInv: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Matrix4()) }, uShipDim: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector3()) },
      uTime: { value: 0 }, uFlash: { value: 0 }, uFlashDir: { value: new THREE.Vector3(0, 0.5, -1).normalize() },
      uSunDir: { value: new THREE.Vector3(-0.78, 0.13, -0.62).normalize() },
      uLights: { value: lights }, uLightCols: { value: lightCols },
      uFogColor: { value: new THREE.Color(0.06, 0.085, 0.11) }, uFogDensity: { value: 0.00045 },
    };
    this.material = new THREE.ShaderMaterial({ vertexShader: OCEAN_VS, fragmentShader: OCEAN_FS, uniforms: this.uniforms });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  update(dt) {
    this.time += dt;
    if (this.frozen) { this.uniforms.uTime.value = this.time; this._updateCpu(); return; }
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = false;
    for (const c of this.cascades) {
      this.evolveMat.uniforms.h0.value = c.h0;
      this.evolveMat.uniforms.time.value = this.time;
      this.evolveMat.uniforms.L.value = c.L;
      this._pass(this.evolveMat, c.ping);
      let src = c.ping, dst = c.pong;
      for (const horizontal of [1, 0])
        for (let size = 2; size <= FFT_N; size *= 2) {
          const u = this.fftMat.uniforms;
          u.in0.value = src.textures[0]; u.in1.value = src.textures[1];
          u.size.value = size; u.horizontal.value = horizontal;
          this._pass(this.fftMat, dst);
          [src, dst] = [dst, src];
        }
      const prev = c.out[c.cur], next = c.out[1 - c.cur];
      const u = this.resolveMat.uniforms;
      u.f0.value = src.textures[0]; u.f1.value = src.textures[1];
      u.prevDisp.value = prev.textures[0];
      u.chop.value = c.chop; u.dt.value = Math.min(dt, 0.1);
      this._pass(this.resolveMat, next);
      c.cur = 1 - c.cur;
    }
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
    const U = this.uniforms;
    this.cascades.forEach((c, i) => { U['disp' + i].value = c.out[c.cur].textures[0]; U['der' + i].value = c.out[c.cur].textures[1]; });
    U.uTime.value = this.time;
    U.uDetail.value = this.detail;
    U.uCalm.value = this.calm;
    this._updateCpu();
  }

  // Evolve the low-frequency swell on the CPU (height and choppy displacement).
  _updateCpu() {
    const n = CPU_N, L = CASCADES[0].L, chop = CASCADES[0].chop, t = this.time;
    const [hr, dxr, dzr] = this._cpu.re, [hi, dxi, dzi] = this._cpu.im;
    const spec = this.cascades[0].cpu;
    for (let q = 0; q < spec.length; q++) {
      const s = spec[q];
      const kx = (2 * Math.PI * s.ix) / L, kz = (2 * Math.PI * s.iy) / L, k = Math.hypot(kx, kz);
      const w = Math.sqrt(G * k), c = Math.cos(w * t), sn = Math.sin(w * t);
      const re = s.r * c - s.i * sn + s.mr * c + s.mi * sn;
      const im = s.r * sn + s.i * c - s.mr * sn + s.mi * c;
      hr[q] = re; hi[q] = im;
      const ik = k > 1e-6 ? 1 / k : 0;
      dxr[q] = im * kx * ik; dxi[q] = -re * kx * ik;
      dzr[q] = im * kz * ik; dzi[q] = -re * kz * ik;
    }
    ifft2d(hr, hi, n); ifft2d(dxr, dxi, n); ifft2d(dzr, dzi, n);
    this._cpuChop = chop;
  }

  _sampleField(f, x, z) {
    const n = CPU_N, L = CASCADES[0].L;
    let u = ((x / L) % 1 + 1) % 1 * n, v = ((z / L) % 1 + 1) % 1 * n;
    const x0 = Math.floor(u), z0 = Math.floor(v), fx = u - x0, fz = v - z0;
    const x1 = (x0 + 1) % n, z1 = (z0 + 1) % n;
    const a = f[z0 * n + x0], b = f[z0 * n + x1], c = f[z1 * n + x0], d = f[z1 * n + x1];
    return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
  }

  // Height of the visible swell at a world position (accounts for choppy displacement).
  heightAt(x, z) {
    const [hr, dxr, dzr] = this._cpu.re;
    let px = x, pz = z;
    for (let i = 0; i < 2; i++) {
      px = x - this._sampleField(dxr, px, pz) * this._cpuChop;
      pz = z - this._sampleField(dzr, px, pz) * this._cpuChop;
    }
    return this._sampleField(hr, px, pz) * (1 - this.calm * 0.65);
  }

  followCamera(cam) {
    const snap = 4;
    this.mesh.position.set(Math.round(cam.position.x / snap) * snap, 0, Math.round(cam.position.z / snap) * snap);
  }
}
