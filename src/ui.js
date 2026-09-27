// ui.js - DOM helpers: captain cards, portraits, gambit icons, fleet lists and the log.
import { CAPTAINS, SHIPS, Mode } from './rules.js';

export const $ = (s) => document.querySelector(s);
const cssHex = (c) => '#' + c.toString(16).padStart(6, '0');

const ICONS = {
  broadside: '<svg viewBox="0 0 40 40" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="24" r="5"/><circle cx="21" cy="17" r="5"/><circle cx="32" cy="10" r="5"/><path d="M4 34h32" stroke-dasharray="3 3"/></svg>',
  powderKeg: '<svg viewBox="0 0 40 40" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 14q-3 9 0 18h18q3-9 0-18z"/><path d="M9 19h20M9 27h20"/><path d="M22 14q2-6 7-7"/><path d="M31 3l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" fill="currentColor"/></svg>',
  crowsNest: '<svg viewBox="0 0 40 40" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20q16-14 32 0-16 14-32 0z"/><circle cx="20" cy="20" r="5"/><circle cx="20" cy="20" r="1.5" fill="currentColor"/></svg>',
  ghostShip: '<svg viewBox="0 0 40 40" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 26h28l-4 6H10z"/><path d="M20 26V6M20 8l10 6H20M20 16l-9 6h9"/><path d="M4 36q4-3 8 0t8 0 8 0 8 0" opacity="0.7"/></svg>',
};
// Painted Gambit emblem from the concept art, falling back to the line icon.
export const gambitIcon = (g) => {
  const src = artUrl(g, 'gambits');
  return src ? `<img class="gart" alt="" src="${src}" onerror="this.outerHTML=window.CG_ICONS['${g}']">` : ICONS[g];
};
window.CG_ICONS = ICONS;

// Painted-style placeholder used until the portrait art is downloaded (see README).
let phId = 0;
function placeholder(ci) {
  const c = cssHex(CAPTAINS[ci].color), id = `pg${ci}_${phId++}`;
  return `<svg viewBox="0 0 120 100" preserveAspectRatio="xMidYMin slice" aria-hidden="true">
    <defs><radialGradient id="${id}" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="${c}" stop-opacity="0.55"/><stop offset="1" stop-color="#05090b"/></radialGradient></defs>
    <rect width="120" height="100" fill="url(#${id})"/>
    <path d="M60 30c-10 0-16 8-16 18s6 17 16 17 16-7 16-17-6-18-16-18z" fill="#0b1013" opacity="0.9"/>
    <path d="M30 34q30-22 60 0q-8-3-30-3t-30 3z" fill="#0b1013"/>
    <path d="M22 100q4-30 38-32 34 2 38 32z" fill="#0b1013" opacity="0.92"/>
    <text x="60" y="94" text-anchor="middle" font-family="IM Fell English SC, Georgia, serif" font-size="12" fill="${c}" opacity="0.9">${CAPTAINS[ci].name.replace('Captain ', '')}</text>
  </svg>`;
}
export function portrait(ci) {
  const src = artUrl(CAPTAINS[ci].portrait);
  const vid = videoUrl(CAPTAINS[ci].portrait);
  // Layers: painted placeholder < still portrait < shader animation < Higgsfield performance clip.
  // The clip only shows once it is actually playing; if it can't play, the shader stays.
  const clip = vid && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? `<video class="clip" src="${vid}" muted loop playsinline autoplay preload="auto" aria-hidden="true" onplaying="this.classList.add('on')" onerror="this.remove()"></video>` : '';
  return `<div class="portrait">${placeholder(ci)}${src ? `<img alt="Portrait of ${CAPTAINS[ci].name}" src="${src}" onerror="this.remove()"><canvas class="live" data-cap="${ci}" aria-hidden="true"></canvas>` : ''}${clip}</div>`;
}

// Animated portrait clip (Higgsfield video): embedded clips become blob URLs once, otherwise
// the dev server serves public/assets/video/<key>.mp4 if present.
const videoUrls = {};
export function videoUrl(key) {
  if (key in videoUrls) return videoUrls[key];
  let url = null;
  const b64 = window.CG_VIDEO_B64 && window.CG_VIDEO_B64[key];
  if (b64) {
    try {
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      url = URL.createObjectURL(new Blob([bytes], { type: 'video/mp4' }));
    } catch (_) { url = null; }
  } else if (!window.CG_NO_FILES && window.CG_DEV_VIDEOS && window.CG_DEV_VIDEOS.includes(key)) url = `assets/video/${key}.mp4`;
  return (videoUrls[key] = url);
}

// URL for a piece of art: embedded in the single-file build, or served from public/assets.
export function artUrl(key, folder = 'portraits') {
  if (window.CG_ASSETS && window.CG_ASSETS[key]) return window.CG_ASSETS[key];
  return window.CG_NO_FILES ? null : `assets/${folder}/${key}.jpg`;
}
// Resolves to the URL if the image actually loads, otherwise null.
export function probeArt(url) {
  return new Promise((res) => { if (!url) return res(null); const i = new Image(); i.onload = () => res(url); i.onerror = () => res(null); i.src = url; });
}

export function renderCards(sel, mode) {
  const el = $('#cards');
  el.classList.toggle('std', mode === Mode.Standard);
  el.innerHTML = CAPTAINS.map((c, i) => `
    <button class="panel card" data-cap="${i}" aria-pressed="${i === sel}" style="--cap:${cssHex(c.color)}">
      ${portrait(i)}
      <div class="body"><h3>${c.name}</h3><div class="motto">${c.motto}</div>
        <div class="gambit-line"><div class="ico" style="color:${cssHex(c.color)}">${gambitIcon(c.gambit)}</div>
          <div><b>${c.gambitName}</b><p>${c.gambitDesc}</p></div></div></div>
    </button>`).join('');
}
export function selectCard(sel) {
  document.querySelectorAll('#cards .card').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.cap) === sel)));
}

export function capMini(el, ci, status, cls = '') {
  const c = CAPTAINS[ci];
  el.style.setProperty('--cap', cssHex(c.color));
  el.innerHTML = `${portrait(ci)}<div class="info"><h3>${c.name}</h3><div class="motto">${c.motto}</div>
    ${status ? `<div class="gstat ${cls}"><span class="dot"></span>${status}</div>` : ''}</div>`;
}
export function setCapStatus(el, status, cls) {
  const g = el.querySelector('.gstat');
  if (!g) return;
  g.className = 'gstat ' + cls;
  g.innerHTML = `<span class="dot"></span>${status}`;
}

export function fleetList(el, waters, hitsShown, sunkShown) {
  el.innerHTML = SHIPS.map((s, i) => {
    const pips = Array.from({ length: s.length }, (_, k) => `<i class="${k < hitsShown[i] ? 'hit' : ''}"></i>`).join('');
    return `<div class="fleet-row ${sunkShown[i] ? 'sunk' : ''}"><span>${s.name}</span><span class="pips">${pips}</span></div>`;
  }).join('');
}

export function renderLog(el, log) {
  el.innerHTML = log.slice(-14).map((l) => `<li class="${l.cls || ''}">${l.text}</li>`).join('');
}

let bannerTimer = 0;
export function banner(title, sub = '', small = false, ms = 1600) {
  const b = $('#banner');
  $('#banner-t').textContent = title;
  $('#banner-s').textContent = sub;
  b.classList.toggle('small', small);
  b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  b.style.opacity = 1;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.style.transition = 'opacity 0.4s'; b.style.opacity = 0; }, ms);
  b.style.transition = 'none';
}
let toastTimer = 0;
export function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.opacity = 0), ms);
}
