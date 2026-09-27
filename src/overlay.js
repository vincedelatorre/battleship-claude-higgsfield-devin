// overlay.js - the chart layer. Everything is drawn through a cell->screen mapping, so the
// same code draws the grid projected over the live 3D sea (the main chart) and flat charts
// (the mini map and the sea chart you open on deck).
import * as THREE from 'three';
import { N, Mark, Match, CAPTAINS, cellOf, SHIPS } from './rules.js';
import { CELL, WATERS_Z0 } from './world.js';

const BRASS = '#c9a15b', SAIL = '#e9dfc7', EMBER = '#e0602f', SEA = '#6fb0a8';

// Affine map from chart coordinates (0..10, 0..10) to screen pixels.
export function projectedMap(world, side) {
  const P = (x, y) => world.project(new THREE.Vector3(x * CELL, 0, WATERS_Z0[side] + y * CELL));
  const o = P(0, 0), ax = P(10, 0), ay = P(0, 10);
  return mapFrom(o, { x: (ax.x - o.x) / 10, y: (ax.y - o.y) / 10 }, { x: (ay.x - o.x) / 10, y: (ay.y - o.y) / 10 });
}
export function flatMap(rect) {
  const cs = rect.size / N;
  return mapFrom({ x: rect.x, y: rect.y }, { x: cs, y: 0 }, { x: 0, y: cs });
}
function mapFrom(o, ex, ey) {
  const det = ex.x * ey.y - ex.y * ey.x;
  return {
    o, ex, ey, cs: Math.hypot(ex.x, ex.y),
    pt: (x, y) => ({ x: o.x + ex.x * x + ey.x * y, y: o.y + ex.y * x + ey.y * y }),
    inv: (sx, sy) => { const dx = sx - o.x, dy = sy - o.y; return { x: (dx * ey.y - dy * ey.x) / det, y: (ex.x * dy - ex.y * dx) / det }; },
  };
}
export function cellFromScreen(map, sx, sy) {
  const p = map.inv(sx, sy);
  const x = Math.floor(p.x), y = Math.floor(p.y);
  return x >= 0 && y >= 0 && x < N && y < N ? { x, y } : null;
}

const hex = (c, a = 1) => `rgba(${(c >> 16) & 255},${(c >> 8) & 255},${c & 255},${a})`;

// Top-down hull silhouette for a ship, every section centred in its own square.
function shipPath(ctx, map, pos, len) {
  const a = cellOf(pos, 0), b = cellOf(pos, len - 1);
  const hw = 0.3, pad = 0.1;
  const along = pos.horizontal ? [1, 0] : [0, 1], across = pos.horizontal ? [0, 1] : [1, 0];
  const start = { x: a.x + 0.5, y: a.y + 0.5 }, L = len;
  const P = (u, v) => { // u along the ship from the stern edge, v across from the centreline
    const x = start.x - along[0] * 0.5 + along[0] * u + across[0] * v;
    const y = start.y - along[1] * 0.5 + along[1] * u + across[1] * v;
    return map.pt(x, y);
  };
  const pts = [[pad, -hw * 0.82], [L - 0.85, -hw], [L - 0.35, -hw * 0.75], [L - 0.04, 0], [L - 0.35, hw * 0.75], [L - 0.85, hw], [pad, hw * 0.82], [pad - 0.08, 0]];
  ctx.beginPath();
  pts.forEach(([u, v], i) => { const q = P(u, v); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
  ctx.closePath();
  void b;
  return P;
}

export function drawShipSilhouette(ctx, map, pos, len, captain, style) {
  const col = CAPTAINS[captain].color;
  const P = shipPath(ctx, map, pos, len);
  if (style === 'outline') {
    ctx.strokeStyle = hex(col, 0.9); ctx.lineWidth = Math.max(1.5, map.cs * 0.035); ctx.stroke();
    return;
  }
  if (style === 'charred') {
    ctx.fillStyle = 'rgba(28,22,18,0.8)'; ctx.fill();
    ctx.strokeStyle = 'rgba(120,70,50,0.8)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    return;
  }
  if (style === 'ghost-ok' || style === 'ghost-bad') {
    ctx.fillStyle = style === 'ghost-ok' ? 'rgba(111,176,168,0.3)' : 'rgba(179,54,43,0.3)'; ctx.fill();
    ctx.strokeStyle = style === 'ghost-ok' ? SEA : '#d9534a'; ctx.lineWidth = 2.5; ctx.stroke();
    return;
  }
  // Solid (flat charts): hull, deck and a mast per section.
  ctx.fillStyle = CAPTAINS[captain].gambit === 'ghostShip' ? '#2b2d31' : '#5b3b25'; ctx.fill();
  ctx.strokeStyle = hex(col); ctx.lineWidth = Math.max(1.2, map.cs * 0.05); ctx.stroke();
  for (let i = 0; i < len; i++) {
    const q = P(i + 0.5, 0);
    ctx.fillStyle = 'rgba(233,223,199,0.85)';
    const r = map.cs * 0.1;
    ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, 7); ctx.fill();
  }
}

function frame(ctx, map, labels, dim) {
  const c = [map.pt(0, 0), map.pt(10, 0), map.pt(10, 10), map.pt(0, 10)];
  const cs = map.cs;
  if (dim) { // darken the sea outside the chart so the playing area reads as the board
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.moveTo(c[0].x, c[0].y); c.slice(1).forEach((q) => ctx.lineTo(q.x, q.y)); ctx.closePath();
    ctx.fillStyle = 'rgba(4,9,12,0.3)'; ctx.fill('evenodd');
    ctx.restore();
  }
  const fw = labels ? Math.max(18, cs * 0.42) : 5;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(38,24,14,0.92)'; ctx.lineWidth = fw;
  ctx.beginPath(); c.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
  ctx.translate(0, 0);
  const off = fw / 2;
  const o = [{ x: c[0].x - off, y: c[0].y - off }, { x: c[1].x + off, y: c[1].y - off }, { x: c[2].x + off, y: c[2].y + off }, { x: c[3].x - off, y: c[3].y + off }];
  ctx.beginPath(); o.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
  ctx.strokeStyle = BRASS; ctx.lineWidth = 1.2;
  ctx.beginPath(); c.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
  const o2 = o.map((q, i) => ({ x: q.x + (i === 0 || i === 3 ? -off : off), y: q.y + (i < 2 ? -off : off) }));
  ctx.beginPath(); o2.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke();
  if (labels && cs > 18) {
    ctx.fillStyle = SAIL;
    ctx.font = `${Math.round(Math.min(20, cs * 0.34))}px "IM Fell English SC", Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < N; i++) {
      const top = map.pt(i + 0.5, 0), left = map.pt(0, i + 0.5);
      ctx.fillText(String.fromCharCode(65 + i), top.x, top.y - fw * 0.5);
      ctx.fillText(String(i + 1), left.x - fw * 0.5, left.y);
    }
  }
  ctx.restore();
}

function grid(ctx, map) {
  ctx.strokeStyle = 'rgba(201,161,91,0.38)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 1; i < N; i++) {
    let a = map.pt(i, 0), b = map.pt(i, N); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    a = map.pt(0, i); b = map.pt(N, i); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

function marks(ctx, map, g, side, t) {
  const w = g.match.side[side].waters, cs = map.cs;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      if (!g.revealed[side][y][x]) continue;
      const m = w.shots[y][x], c = map.pt(x + 0.5, y + 0.5), seed = x * 13 + y * 7;
      if (m.mark === Mark.Miss) {
        ctx.strokeStyle = 'rgba(233,240,245,0.9)'; ctx.lineWidth = Math.max(1.5, cs * 0.035);
        ctx.beginPath(); ctx.arc(c.x, c.y, cs * 0.16, 0, 7); ctx.stroke();
        ctx.fillStyle = 'rgba(233,240,245,0.75)'; ctx.beginPath(); ctx.arc(c.x, c.y, cs * 0.045, 0, 7); ctx.fill();
        const ph = (t * 0.5 + seed * 0.1) % 1;
        ctx.strokeStyle = `rgba(233,240,245,${(1 - ph) * 0.3})`; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(c.x, c.y, cs * (0.2 + ph * 0.22), 0, 7); ctx.stroke();
      } else if (m.mark === Mark.Hit && m.stale) {
        ctx.strokeStyle = 'rgba(160,178,172,0.7)'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.arc(c.x, c.y, cs * 0.18, 0, 7); ctx.stroke(); ctx.setLineDash([]);
      } else if (m.mark === Mark.Hit) {
        const fl = 0.85 + 0.15 * Math.sin(t * 13 + seed);
        const gr = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, cs * 0.45);
        gr.addColorStop(0, `rgba(255,140,50,${0.45 * fl})`); gr.addColorStop(1, 'rgba(255,90,20,0)');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(c.x, c.y, cs * 0.45, 0, 7); ctx.fill();
        ctx.strokeStyle = EMBER; ctx.lineWidth = Math.max(2, cs * 0.05);
        ctx.beginPath(); ctx.arc(c.x, c.y, cs * 0.2, 0, 7); ctx.stroke();
        ctx.fillStyle = '#ffd08a'; ctx.beginPath(); ctx.arc(c.x, c.y, cs * 0.07 * fl, 0, 7); ctx.fill();
      }
    }
}

function scouts(ctx, map, g, side) {
  for (const s of g.scouts) {
    if (s.mine !== (side === 1)) continue;
    const x0 = Math.max(0, s.c.x - 1), y0 = Math.max(0, s.c.y - 1), x1 = Math.min(9, s.c.x + 1), y1 = Math.min(9, s.c.y + 1);
    const a = map.pt(x0, y0), b = map.pt(x1 + 1, y1 + 1);
    ctx.fillStyle = 'rgba(111,176,168,0.1)'; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
    ctx.strokeStyle = SEA; ctx.lineWidth = 2; ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    const r = map.cs * 0.24;
    ctx.fillStyle = '#10262a'; ctx.beginPath(); ctx.arc(b.x - r * 1.1, a.y + r * 1.1, r, 0, 7); ctx.fill();
    ctx.strokeStyle = SEA; ctx.stroke();
    ctx.fillStyle = SAIL; ctx.font = `${Math.round(r * 1.2)}px "IM Fell English", Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(s.count), b.x - r * 1.1, a.y + r * 1.1);
  }
}

function aim(ctx, map, g, t) {
  const cs = map.cs;
  for (let i = 0; i < g.broadsideSel.length; i++) {
    const c = map.pt(g.broadsideSel[i].x + 0.5, g.broadsideSel[i].y + 0.5);
    ctx.fillStyle = 'rgba(224,96,47,0.9)'; ctx.beginPath(); ctx.arc(c.x, c.y, cs * 0.28, 0, 7); ctx.fill();
    ctx.fillStyle = '#1a0d06'; ctx.font = `${Math.round(cs * 0.36)}px "IM Fell English SC", Georgia, serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(i + 1), c.x, c.y + 1);
  }
  const h = g.hover;
  if (!h) return;
  const c = map.pt(h.x + 0.5, h.y + 0.5), pulse = 0.88 + 0.12 * Math.sin(t * 7);
  const enemy = g.match.side[1].waters;
  const cellPoly = (x, y) => { const a = map.pt(x, y), b = map.pt(x + 1, y + 1); return [a.x, a.y, b.x - a.x, b.y - a.y]; };
  switch (g.aim) {
    case 'fire':
    case 'broadside': {
      if (g.aimSide !== 1) return;
      if (enemy.tried(h.x, h.y)) {
        ctx.strokeStyle = 'rgba(217,83,74,0.85)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(c.x - cs * 0.2, c.y - cs * 0.2); ctx.lineTo(c.x + cs * 0.2, c.y + cs * 0.2);
        ctx.moveTo(c.x + cs * 0.2, c.y - cs * 0.2); ctx.lineTo(c.x - cs * 0.2, c.y + cs * 0.2); ctx.stroke();
        return;
      }
      const row = [map.pt(0, h.y), map.pt(10, h.y + 1)], col = [map.pt(h.x, 0), map.pt(h.x + 1, 10)];
      ctx.fillStyle = 'rgba(201,161,91,0.05)';
      ctx.fillRect(row[0].x, row[0].y, row[1].x - row[0].x, row[1].y - row[0].y);
      ctx.fillRect(col[0].x, col[0].y, col[1].x - col[0].x, col[1].y - col[0].y);
      ctx.fillStyle = 'rgba(201,161,91,0.12)'; ctx.fillRect(...cellPoly(h.x, h.y));
      const r = cs * 0.34 * pulse;
      ctx.strokeStyle = '#f0c46e'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, 7); ctx.stroke();
      ctx.beginPath();
      for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; ctx.moveTo(c.x + Math.cos(a) * r * 0.55, c.y + Math.sin(a) * r * 0.55); ctx.lineTo(c.x + Math.cos(a) * r * 1.3, c.y + Math.sin(a) * r * 1.3); }
      ctx.stroke();
      break;
    }
    case 'powderKeg': {
      const ok = g.match.canPowderKeg(0, h);
      for (const b of Match.blastArea(h)) {
        ctx.fillStyle = ok ? `rgba(224,96,47,${0.28 * pulse})` : 'rgba(179,54,43,0.3)'; ctx.fillRect(...cellPoly(b.x, b.y));
        ctx.strokeStyle = ok ? EMBER : '#d9534a'; ctx.lineWidth = 2; ctx.strokeRect(...cellPoly(b.x, b.y));
      }
      break;
    }
    case 'crowsNest': {
      const x0 = Math.max(0, h.x - 1), y0 = Math.max(0, h.y - 1), x1 = Math.min(9, h.x + 1), y1 = Math.min(9, h.y + 1);
      const a = map.pt(x0, y0), b = map.pt(x1 + 1, y1 + 1);
      ctx.fillStyle = `rgba(111,176,168,${0.15 * pulse})`; ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeStyle = SEA; ctx.lineWidth = 2.5; ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      break;
    }
    case 'ghostPick': {
      const own = g.match.side[0].waters, idx = own.shipAt(h.x, h.y);
      if (idx >= 0) { shipPath(ctx, map, own.ships[idx].pos, own.ships[idx].length); ctx.strokeStyle = own.ships[idx].isSunk() ? '#d9534a' : SEA; ctx.lineWidth = 3; ctx.stroke(); }
      break;
    }
    case 'ghostPlace': {
      if (g.ghostShip < 0) break;
      const len = SHIPS[g.ghostShip].length;
      const pos = g.clampFit({ x: h.x, y: h.y, horizontal: g.ghostHoriz }, len);
      drawShipSilhouette(ctx, map, pos, len, g.match.side[0].captain, g.match.canGhostShip(0, g.ghostShip, pos) ? 'ghost-ok' : 'ghost-bad');
      break;
    }
  }
}

// side: whose waters. opts: { labels, dim, interactive, solidShips }
export function drawChart(ctx, map, g, side, opts = {}) {
  const t = g.time;
  const inBattle = g.screen === 'battle' || g.screen === 'over';
  frame(ctx, map, opts.labels, opts.dim);
  grid(ctx, map);
  const w = g.match.side[side].waters, cap = g.match.side[side].captain;
  if (inBattle) scouts(ctx, map, g, side);
  for (let i = 0; i < w.ships.length; i++) {
    const s = w.ships[i];
    if (!s.placed) continue;
    if (g.screen === 'placement' && g.dragShip === i) continue;
    if (side === 0) {
      const sunk = inBattle && g.sunkShown[0][i];
      if (opts.solidShips) drawShipSilhouette(ctx, map, s.pos, s.length, cap, sunk ? 'charred' : 'solid');
      else if (sunk) drawShipSilhouette(ctx, map, s.pos, s.length, cap, 'charred');
      else drawShipSilhouette(ctx, map, s.pos, s.length, cap, 'outline');
    } else if (inBattle && g.sunkShown[1][i]) drawShipSilhouette(ctx, map, s.pos, s.length, cap, 'charred');
    else if (g.screen === 'over') { ctx.globalAlpha = 0.55; drawShipSilhouette(ctx, map, s.pos, s.length, cap, 'solid'); ctx.globalAlpha = 1; }
  }
  if (inBattle) marks(ctx, map, g, side, t);
  if (g.screen === 'placement' && side === 0 && g.dragShip >= 0 && g.hover) {
    const len = SHIPS[g.dragShip].length;
    const pos = g.dragPlacement();
    drawShipSilhouette(ctx, map, pos, len, cap, w.canPlace(g.dragShip, pos) ? 'ghost-ok' : 'ghost-bad');
  }
  if (opts.interactive) aim(ctx, map, g, t);
}
