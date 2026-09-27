// textures.js - procedural canvas textures (wood planks, deck, sailcloth) so the game ships
// without image files.
import * as THREE from 'three';

function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}
const rnd = (() => { let s = 12345; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

function planks(ctx, w, h, base, rows) {
  const ph = h / rows;
  for (let r = 0; r < rows; r++) {
    const shade = 0.82 + rnd() * 0.3;
    ctx.fillStyle = `rgb(${base[0] * shade | 0},${base[1] * shade | 0},${base[2] * shade | 0})`;
    ctx.fillRect(0, r * ph, w, ph);
    for (let g = 0; g < 26; g++) {                       // grain
      ctx.strokeStyle = `rgba(0,0,0,${0.05 + rnd() * 0.08})`;
      ctx.lineWidth = 1;
      const y = r * ph + rnd() * ph;
      ctx.beginPath(); ctx.moveTo(0, y);
      for (let x = 0; x <= w; x += 32) ctx.lineTo(x, y + Math.sin(x * 0.02 + g) * 1.5);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.55)';                 // seam
    ctx.fillRect(0, r * ph, w, 2);
    const off = rnd() * w;                               // butt joints and trenails
    for (let x = off % 170; x < w; x += 170) {
      ctx.fillRect(x, r * ph, 2, ph);
      ctx.fillStyle = 'rgba(20,12,6,0.7)';
      ctx.beginPath(); ctx.arc(x + 8, r * ph + ph * 0.3, 2, 0, 7); ctx.arc(x + 8, r * ph + ph * 0.7, 2, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
    }
  }
  const g = ctx.createLinearGradient(0, 0, 0, h);        // weathering
  g.addColorStop(0, 'rgba(255,255,255,0.04)'); g.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}

// Photo textures (Higgsfield) for the deck and hull when present in public/assets/wood/.
// A normal map is derived from each so plank seams and grain respond to the light.
function photoTexture(key, onReady) {
  const url = (window.CG_ASSETS && window.CG_ASSETS[key]) || (window.CG_NO_FILES ? null : `assets/wood/${key}.jpg`);
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    const w = img.naturalWidth, h = img.naturalHeight, c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
    const src = ctx.getImageData(0, 0, w, h).data, out = ctx.createImageData(w, h), o = out.data;
    const L = (x, y) => { x = (x + w) % w; y = (y + h) % h; const i = (y * w + x) * 4; return (src[i] * 0.3 + src[i + 1] * 0.59 + src[i + 2] * 0.11) / 255; };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (L(x + 1, y) - L(x - 1, y)) * 2.2, dy = (L(x, y + 1) - L(x, y - 1)) * 2.2, len = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
      o[i] = (-dx / len * 0.5 + 0.5) * 255; o[i + 1] = (-dy / len * 0.5 + 0.5) * 255; o[i + 2] = (1 / len * 0.5 + 0.5) * 255; o[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    const map = new THREE.Texture(img), normal = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    for (const t of [map, normal]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.needsUpdate = true; }
    onReady(map, normal);
  };
  img.src = url;
}

export function makeTextures() {
  const tex = {
    // Cabin door: vertical boards, iron studs and hinges, a small leaded window.
    door: canvasTex(256, 384, (c, w, h) => {
      planks(c, h, w, [128, 86, 54], 5);
      c.save(); c.translate(w, 0); c.rotate(Math.PI / 2); c.restore();
      for (let x = 0; x < w; x += w / 5) { c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(x, 0, 3, h); }
      c.fillStyle = '#2a2622';
      for (const y of [h * 0.18, h * 0.78]) { c.fillRect(0, y, w, 14); for (let x = 12; x < w; x += 36) { c.beginPath(); c.arc(x, y + 7, 4, 0, 7); c.fillStyle = '#4a443e'; c.fill(); c.fillStyle = '#2a2622'; } }
      c.fillStyle = '#e0a860'; c.fillRect(w * 0.3, h * 0.3, w * 0.4, h * 0.22);
      c.strokeStyle = '#2a2018'; c.lineWidth = 5;
      for (let i = 0; i <= 3; i++) { const x = w * 0.3 + (w * 0.4 * i) / 3; c.beginPath(); c.moveTo(x, h * 0.3); c.lineTo(x, h * 0.52); c.stroke(); }
      for (let i = 0; i <= 2; i++) { const y = h * 0.3 + (h * 0.22 * i) / 2; c.beginPath(); c.moveTo(w * 0.3, y); c.lineTo(w * 0.7, y); c.stroke(); }
      c.fillStyle = '#b08a3a'; c.beginPath(); c.arc(w * 0.78, h * 0.62, 9, 0, 7); c.fill();
    }, false),
    // Cargo hatch grating: a lattice of oak bars over a dark hold.
    grating: canvasTex(256, 256, (c, w, h) => {
      c.fillStyle = '#0c0907'; c.fillRect(0, 0, w, h);
      c.fillStyle = '#8a6440';
      for (let i = 0; i <= 10; i++) { c.fillRect((i * w) / 10 - 5, 0, 10, h); c.fillRect(0, (i * h) / 10 - 5, w, 10); }
      c.fillStyle = 'rgba(255,230,190,0.12)';
      for (let i = 0; i <= 10; i++) c.fillRect((i * w) / 10 - 5, 0, 3, h);
    }, true),
    planks: canvasTex(512, 512, (c, w, h) => planks(c, w, h, [150, 100, 64], 10)),
    deck: canvasTex(512, 512, (c, w, h) => planks(c, w, h, [176, 140, 98], 12)),
    canvas: canvasTex(256, 256, (c, w, h) => {
      c.fillStyle = '#e6dcc6'; c.fillRect(0, 0, w, h);
      for (let i = 0; i < 4000; i++) { c.fillStyle = `rgba(80,60,40,${rnd() * 0.06})`; c.fillRect(rnd() * w, rnd() * h, 2, 1); }
      c.strokeStyle = 'rgba(90,70,50,0.35)'; c.lineWidth = 2;
      for (let x = 0; x < w; x += 42) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }  // panel seams
      const g = c.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, w * 0.7);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(60,40,20,0.35)');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
    }, false),
  };
  tex.loadPhotoWood = (onDeck, onHull) => { photoTexture('deck-planks', onDeck); photoTexture('hull-planks', onHull); };
  return tex;
}
