// world.js - the 3D battle: one continuous storm-sea scene that serves both views.
// The "chart" is this same world seen from straight above (the overlay draws the grid),
// and boarding a ship swoops the camera down onto the deck.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Ocean } from './ocean.js';
import { StormSky } from './sky.js';
import { CAPTAINS, SHIPS, cellOf, Gambit } from './rules.js';
import { makeTextures } from './textures.js';

export const CELL = 16;
export const WATERS_Z0 = [0, -420];            // my waters, enemy waters (row 0 edge)
const FLAGSHIP_POS = new THREE.Vector3(80, 0, -610);
const CHART_FOV = 14;
const tmpV = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpM = new THREE.Matrix4();
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function cellCenter(side, c) {
  return new THREE.Vector3(c.x * CELL + CELL / 2, 0, WATERS_Z0[side] + c.y * CELL + CELL / 2);
}
export function watersCenter(side) { return new THREE.Vector3(80, 0, WATERS_Z0[side] + 80); }

// ------------------------------------------------------------------ ship model
class ShipModel {
  constructor(len, captain, tex, flagship = false) {
    const ci = CAPTAINS[captain];
    this.tex = tex;
    this.len = len;
    this.Ls = len * CELL * 0.86;
    this.beam = clamp(this.Ls * 0.25, 6.5, 12.5);
    this.deck = 2.2 + len * 0.22;
    this.group = new THREE.Group();
    this.root = new THREE.Group();   // tilts with the waves; group holds world position
    this.group.add(this.root);
    const ghostly = ci.gambit === Gambit.GhostShip;
    const hullColor = ghostly ? new THREE.Color(0.14, 0.14, 0.16) : new THREE.Color(0.25, 0.2, 0.16);
    this.mats = {
      hull: new THREE.MeshStandardMaterial({ map: tex.planks, color: hullColor, roughness: 0.85, metalness: 0.0, envMapIntensity: 0 }),
      deck: new THREE.MeshStandardMaterial({ map: tex.deck, color: ghostly ? 0x45484c : 0x8a7a66, roughness: 0.88, side: THREE.DoubleSide }),
      trim: new THREE.MeshStandardMaterial({ color: new THREE.Color(ci.color).lerp(new THREE.Color(0x3a3027), 0.7).multiplyScalar(0.5), roughness: 0.8 }),
      sail: new THREE.MeshStandardMaterial({ map: tex.canvas, color: new THREE.Color(ghostly ? 0x2a2c30 : 0xd8cfb8).lerp(new THREE.Color(ci.sail), ghostly ? 0 : 0.35), roughness: 0.95, side: THREE.DoubleSide }),
      wood: new THREE.MeshStandardMaterial({ map: tex.planks, color: 0x5a3c26, roughness: 0.8 }),
      iron: new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.45, metalness: 0.7 }),
      rope: new THREE.LineBasicMaterial({ color: 0x2a2016 }),
      rope3d: new THREE.MeshStandardMaterial({ color: 0x8a7350, roughness: 1 }),
      barrel: new THREE.MeshStandardMaterial({ map: tex.planks, color: 0x8a6a4a, roughness: 0.85 }),
      crate: new THREE.MeshStandardMaterial({ map: tex.planks, color: 0x9a7a58, roughness: 0.9 }),
      deckTrim: new THREE.MeshStandardMaterial({ map: tex.planks, color: 0x4a3526, roughness: 0.8 }),
      deckUnder: new THREE.MeshStandardMaterial({ color: 0x1c140e, roughness: 1, side: THREE.DoubleSide }),
      cabinGlass: new THREE.MeshStandardMaterial({ color: 0x3a2a18, emissive: 0xffa050, emissiveIntensity: 0.9, roughness: 0.3 }),
      lamp: new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 5, 1.8) }),
      stern: new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 2.8, 1.0) }),
    };
    this._build(flagship);
    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.motion = { heave: 0, pitch: 0, roll: 0, sink: 0 };
  }
  halfWidth(t) { const u = (t - 0.4) / 0.6; return this.beam * 0.5 * Math.sqrt(Math.max(0, 1 - u * u)); }
  applyPhotoWood(deck, hull) {
    if (deck) { this.mats.deck.map = deck.map; this.mats.deck.normalMap = deck.normal; this.mats.deck.color.set(0xd8d0c4); this.mats.deck.needsUpdate = true; }
    if (hull) { for (const k of ['hull', 'wood', 'deckTrim']) { const m = this.mats[k]; m.map = hull.map; m.normalMap = hull.normal; m.color.set(k === 'hull' ? 0xbcb2a6 : 0x9a8e82); m.needsUpdate = true; } }
  }

  // ---- walkable surfaces -----------------------------------------------------------
  // Main deck at D, raised quarterdeck at QD aft of xq, reached by two staircases that run
  // up along the rails. floorY() is the one source of truth for where feet go: the player,
  // the crew and the effects all stand on it.
  _layout() {
    const Ls = this.Ls;
    this.D = this.deck;
    this.QD = this.D + 2.4;
    this.xq = (0.24 - 0.5) * Ls;
    this.stairRun = 3.6;
    this.stairW = 1.05;
    this.stairZ = Math.max(1.0, this.halfWidth(0.3) * 0.92 - 0.95);
    this.xStern = -0.5 * Ls + 0.9;
    this.xBow = 0.5 * Ls - 2.2;
    this.colliders = [];
    this.masts = [];
  }
  floorY(x, z) {
    for (const s of [-1, 1]) {
      if (Math.abs(z - s * this.stairZ) <= this.stairW / 2 && x >= this.xq && x <= this.xq + this.stairRun) {
        const k = Math.floor((this.xq + this.stairRun - x) / (this.stairRun / 12));
        return Math.min(this.QD, this.D + (k + 1) * 0.2);
      }
    }
    return x < this.xq ? this.QD : this.D;
  }
  deckY(t) { return this.floorY((t - 0.5) * this.Ls, 0); }
  sheerY(t) {
    const ss = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
    return this.D + 1.15 + (this.QD - this.D + 0.2) * (1 - ss(0.2, 0.3, t)) + 1.3 * ss(0.84, 1.0, t);
  }
  // Keeps a walker on the ship: inside the rails, off the obstacles, and only up or down
  // steps small enough to climb (so the quarterdeck is reached by the stairs, not a wall).
  walkable(x0, z0, x1, z1, radius = 0.3) {
    const t = x1 / this.Ls + 0.5;
    if (x1 < this.xStern || x1 > this.xBow) return false;
    if (Math.abs(z1) > Math.max(0.3, this.halfWidth(Math.min(0.97, Math.max(0.03, t))) * 0.86 - 0.35)) return false;
    if (Math.abs(this.floorY(x1, z1) - this.floorY(x0, z0)) > 0.45) return false;
    for (const c of this.colliders) {
      const r2 = (c.r + radius) ** 2, d1 = (x1 - c.x) ** 2 + (z1 - c.z) ** 2;
      // Already overlapping (e.g. spawned there)? Allow any move that gets you out.
      if (d1 < r2 && d1 <= (x0 - c.x) ** 2 + (z0 - c.z) ** 2) return false;
    }
    return true;
  }

  _build(flagship) {
    this._layout();
    const m = this.mats, Ls = this.Ls, root = this.root, D = this.D, QD = this.QD, xq = this.xq;
    const box = (w, h, d, mat, x, y, z, parent = root) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); b.position.set(x, y, z); parent.add(b); return b; };
    const cyl = (r0, r1, h, mat, x, y, z, seg = 10) => { const c = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg), mat); c.position.set(x, y, z); root.add(c); return c; };

    // Hull: lofted sections, the rail line sweeping up over the quarterdeck and the bow.
    const S = 30, R = 10, pos = [], uv = [], idx = [];
    for (let i = 0; i <= S; i++) {
      const t = i / S, x = (t - 0.5) * Ls, w = Math.max(this.halfWidth(t), 0.25), top = this.sheerY(t);
      for (let j = 0; j <= R; j++) {
        const a = (j / R) * Math.PI, s = Math.cos(a), c = Math.sin(a);
        pos.push(x, top - (top + 3.2) * Math.pow(c, 0.8), s * w * (0.62 + 0.38 * Math.pow(1 - c, 0.5)));
        uv.push(t * this.len * 2.2, (j / R) * 3.0);
      }
    }
    for (let i = 0; i < S; i++) for (let j = 0; j < R; j++) { const a = i * (R + 1) + j, b = a + R + 1; idx.push(a, a + 1, b, b, a + 1, b + 1); }
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    hg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    hg.setIndex(idx); hg.computeVertexNormals();
    m.hull.side = THREE.DoubleSide;
    root.add(new THREE.Mesh(hg, m.hull));
    // Cap rail along the top of the bulwarks.
    for (const side of [-1, 1]) {
      const pts = [];
      for (let i = 0; i <= S; i++) { const t = i / S; pts.push(new THREE.Vector3((t - 0.5) * Ls, this.sheerY(t) + 0.02, side * (Math.max(this.halfWidth(t), 0.25) - 0.08))); }
      root.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 60, 0.16, 6), m.wood));
      const trim = []; for (let i = 0; i <= S; i++) { const t = i / S; trim.push(new THREE.Vector3((t - 0.5) * Ls, this.sheerY(t) - 0.5, side * (Math.max(this.halfWidth(t), 0.25) + 0.03))); }
      root.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(trim), 60, 0.12, 5), m.trim));
    }

    // Deck planking: a solid slab for the main deck and one for the quarterdeck.
    // Solid planked deck: an upward-facing top surface running rail to rail, over a thick
    // underside, so there is no view down into the hull anywhere.
    const slab = (t0, t1, y, uvScale) => {
      const n = 24, p = [], u = [], id = [];
      for (let i = 0; i <= n; i++) {
        const t = t0 + ((t1 - t0) * i) / n, x = (t - 0.5) * Ls, w = Math.max(0.3, this.halfWidth(t) * 1.02);
        p.push(x, y, -w, x, y, w); u.push(x / 2.75, -w / 2.75, x / 2.75, w / 2.75);
      }
      for (let i = 0; i < n; i++) { const a = i * 2; id.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
      g.setIndex(id); g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, m.deck); mesh.receiveShadow = true; mesh.userData.floor = true; root.add(mesh);
      const under = new THREE.Mesh(g, m.deckUnder); under.position.y = -0.3; root.add(under);
      void uvScale;
    };
    m.deck.map = m.deck.map.clone(); m.deck.map.needsUpdate = true;
    m.deck.side = THREE.DoubleSide;
    m.deck.map.wrapS = m.deck.map.wrapT = THREE.RepeatWrapping;
    slab(0.23, 0.99, D, 1);
    slab(0.01, 0.245, QD, 1);

    // Quarterdeck front bulkhead with the cabin door, lit windows and panelling.
    const wq = this.halfWidth(0.24) * 0.96;
    box(0.3, QD - D, wq * 2, m.wood, xq + 0.15, (D + QD) / 2, 0);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(1.25, 2.05), new THREE.MeshStandardMaterial({ map: this.tex.door, roughness: 0.85 }));
    door.rotation.y = Math.PI / 2; door.position.set(xq + 0.36, D + 1.03, 0); root.add(door);
    box(0.08, 2.25, 1.5, m.deckTrim, xq + 0.3, D + 1.12, 0);
    for (const s of [-1, 1]) {
      const wz = s * Math.min(wq - 1.9, 1.7);
      if (Math.abs(wz) > 1.1) {
        box(0.06, 0.85, 0.7, m.cabinGlass, xq + 0.37, D + 1.35, wz);
        box(0.1, 1.05, 0.9, m.deckTrim, xq + 0.31, D + 1.35, wz);
      }
    }
    // Balustrade along the quarterdeck edge, open where the stairs arrive.
    const baluster = new THREE.LatheGeometry([[0.07, 0], [0.09, 0.05], [0.05, 0.2], [0.08, 0.45], [0.05, 0.7], [0.08, 0.82], [0.07, 0.9]].map(([r, y]) => new THREE.Vector2(r, y)), 8);
    const rail = (x0, z0, x1, z1, y0, y1) => {
      const len = Math.hypot(x1 - x0, z1 - z0, y1 - y0), n = Math.max(2, Math.round(len / 0.32));
      for (let i = 0; i <= n; i++) {
        const f = i / n, b = new THREE.Mesh(baluster, m.wood);
        b.position.set(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, z0 + (z1 - z0) * f); root.add(b);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.08, 0.14), m.wood);
      top.position.set((x0 + x1) / 2, (y0 + y1) / 2 + 0.94, (z0 + z1) / 2);
      top.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
      top.rotation.z = Math.atan2(y1 - y0, Math.hypot(x1 - x0, z1 - z0));
      root.add(top);
    };
    const gap = this.stairW / 2 + 0.08;
    rail(xq + 0.02, -this.stairZ + gap, xq + 0.02, this.stairZ - gap, QD, QD);
    for (const s of [-1, 1]) if (wq - (this.stairZ + gap) > 0.3) rail(xq + 0.02, s * (this.stairZ + gap), xq + 0.02, s * wq, QD, QD);

    // Staircases up to the quarterdeck, with stringers and a turned handrail on the inboard side.
    const rise = 0.2, run = this.stairRun / 12;
    for (const s of [-1, 1]) {
      const z = s * this.stairZ;
      for (let k = 0; k < 12; k++) {
        box(run, 0.07, this.stairW, m.deck, xq + this.stairRun - (k + 0.5) * run, D + (k + 1) * rise - 0.035, z).userData.floor = true;
        box(0.04, rise, this.stairW * 0.96, m.wood, xq + this.stairRun - k * run - 0.02, D + (k + 0.5) * rise, z);
      }
      const ang = Math.atan2(QD - D, this.stairRun), sl = Math.hypot(QD - D, this.stairRun);
      for (const e of [-1, 1]) {
        const st = box(sl, 0.28, 0.07, m.wood, xq + this.stairRun / 2, (D + QD) / 2 - 0.1, z + e * (this.stairW / 2 + 0.03));
        st.rotation.z = -ang;
      }
      rail(xq + this.stairRun - 0.1, z - s * (this.stairW / 2 + 0.05), xq + 0.1, z - s * (this.stairW / 2 + 0.05), D + 0.1, QD - 0.05);
    }

    // The helm: ship's wheel on a pedestal near the front of the quarterdeck.
    this.wheelX = xq - Math.min(2.4, (xq - this.xStern) * 0.4);
    const helm = new THREE.Group();
    helm.position.set(this.wheelX, QD, 0);
    root.add(helm);
    box(0.4, 1.05, 0.34, m.wood, 0, 0.52, 0, helm);
    box(0.5, 0.12, 0.44, m.wood, 0, 0.03, 0, helm);
    const wheel = new THREE.Group();
    wheel.position.set(-0.24, 1.32, 0);
    wheel.rotation.y = Math.PI / 2;
    helm.add(wheel);
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.045, 8, 32), m.wood));
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.04, 6, 16), m.wood));
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.16, 12), m.iron); hub.rotation.x = Math.PI / 2; wheel.add(hub);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, spoke = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.95, 6), m.wood);
      spoke.position.set(Math.cos(a) * 0.42, Math.sin(a) * 0.42, 0); spoke.rotation.z = a - Math.PI / 2; wheel.add(spoke);
      const knob = new THREE.Mesh(baluster, m.wood); knob.scale.setScalar(0.28);
      knob.position.set(Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0); knob.rotation.z = a - Math.PI / 2; wheel.add(knob);
    }
    this.helmWheel = wheel;
    this.colliders.push({ x: this.wheelX, z: 0, r: 0.45 });

    // Lanterns on posts at the corners of the quarterdeck rail.
    this.lanterns = [];
    for (const s of [-1, 1]) {
      const z = s * (wq - 0.35);
      cyl(0.06, 0.07, 1.6, m.iron, xq - 0.2, QD + 0.8, z, 8);
      box(0.34, 0.46, 0.34, m.iron, xq - 0.2, QD + 1.8, z);
      this.lanterns.push(box(0.26, 0.36, 0.26, m.lamp, xq - 0.2, QD + 1.8, z));
    }
    for (const z of [-1.4, 0, 1.4]) box(0.1, 0.7, 0.8, m.stern, -0.5 * Ls + 0.35, QD - 0.6, z);

    // Main deck furnishings.
    const t0 = xq + this.stairRun + 1.2;
    const hatchX = Math.min(this.xBow - 3, t0 + (this.xBow - t0) * 0.45);
    const hatchL = Math.min(3.2, (this.xBow - t0) * 0.3), hatchW = Math.min(2.2, this.halfWidth(0.5) * 0.7);
    box(hatchL + 0.3, 0.04, hatchW + 0.3, m.wood, hatchX, D + 0.02, 0);
    const grate = new THREE.Mesh(new THREE.BoxGeometry(hatchL, 0.06, hatchW), new THREE.MeshStandardMaterial({ map: this.tex.grating, roughness: 0.9 }));
    grate.material.map = this.tex.grating.clone(); grate.material.map.needsUpdate = true; grate.material.map.repeat.set(hatchL / 1.6, hatchW / 1.6);
    grate.position.set(hatchX, D + 0.035, 0); root.add(grate);
    const barrelGeo = new THREE.LatheGeometry([[0.0, 0], [0.3, 0], [0.36, 0.2], [0.39, 0.45], [0.36, 0.7], [0.3, 0.9], [0.0, 0.9]].map(([r, y]) => new THREE.Vector2(r, y)), 14);
    const bandGeo = new THREE.TorusGeometry(0.37, 0.018, 4, 18); bandGeo.rotateX(Math.PI / 2);
    const barrel = (x, z) => {
      const g = new THREE.Group(); g.position.set(x, D, z); g.rotation.y = Math.random() * 6; root.add(g);
      g.add(new THREE.Mesh(barrelGeo, m.barrel));
      for (const y of [0.18, 0.72]) { const b = new THREE.Mesh(bandGeo, m.iron); b.position.y = y; b.scale.setScalar(y === 0.18 || y === 0.72 ? 0.97 : 1); g.add(b); }
      this.colliders.push({ x, z, r: 0.42 });
    };
    const crate = (x, z, sz = 0.8) => { const c = box(sz, sz, sz, m.crate, x, D + sz / 2, z); c.rotation.y = Math.random() * 0.4; this.colliders.push({ x, z, r: sz * 0.62 }); };
    // Stores stacked against the bulkhead between the stairs, and along the rails.
    const bz = Math.max(0.9, this.stairZ - this.stairW / 2 - 0.5);
    if (bz > 1.0) { barrel(xq + 0.75, bz - 0.2); barrel(xq + 0.75, -(bz - 0.2)); }
    const rz = Math.max(0.8, this.halfWidth(0.6) * 0.72);
    barrel(hatchX + hatchL / 2 + 1.3, rz); barrel(hatchX + hatchL / 2 + 2.1, rz - 0.2); crate(hatchX - hatchL / 2 - 1.4, -rz + 0.1);
    if (this.len >= 3) { crate(hatchX - hatchL / 2 - 1.4, -rz + 1.0, 0.6); barrel(this.xBow - 1.4, -rz * 0.8); }
    // Coiled rope on deck.
    const coil = new THREE.TorusGeometry(0.34, 0.07, 6, 18); coil.rotateX(Math.PI / 2);
    for (const [x, z] of [[hatchX + hatchL / 2 + 0.2, -hatchW / 2 - 0.9], [t0 + 0.5, rz * 0.2]]) for (let k = 0; k < 3; k++) { const c = new THREE.Mesh(coil, m.rope3d); c.position.set(x, D + 0.07 + k * 0.1, z); c.scale.setScalar(1 - k * 0.18); root.add(c); }
    // Capstan forward of the hatch.
    if (this.len >= 3) {
      const cx = Math.min(this.xBow - 2.5, hatchX + hatchL / 2 + 3.6);
      cyl(0.42, 0.55, 1.0, m.wood, cx, D + 0.5, 0, 12);
      cyl(0.5, 0.5, 0.12, m.iron, cx, D + 0.85, 0, 12);
      for (let k = 0; k < 4; k++) { const b = box(2.0, 0.08, 0.08, m.wood, cx, D + 0.95, 0); b.rotation.y = (k / 4) * Math.PI; }
      this.colliders.push({ x: cx, z: 0, r: 1.05 });
    }

    // Cannons on wheeled carriages along both rails of the main deck.
    this.cannons = [];
    const nc = this.len + 1;
    const barrelG = new THREE.CylinderGeometry(0.2, 0.3, 2.0, 12); barrelG.rotateX(Math.PI / 2);
    const wheelG = new THREE.CylinderGeometry(0.2, 0.2, 0.1, 10); wheelG.rotateX(Math.PI / 2);
    for (let i = 0; i < nc; i++) {
      // Guns run from just forward of the staircases to the bow, keeping the stair feet clear.
      const gx0 = xq + this.stairRun + 1.4, gx1 = this.xBow - 1.8;
      const x = nc === 1 ? (gx0 + gx1) / 2 : gx0 + ((gx1 - gx0) * i) / (nc - 1), t = x / Ls + 0.5, w = this.halfWidth(t);
      for (const s of [-1, 1]) {
        const g = new THREE.Group(); g.position.set(x, D, s * (w - 1.0)); root.add(g);
        const cb = new THREE.Mesh(barrelG, m.iron); cb.position.set(0, 0.62, s * 0.35); g.add(cb);
        const car = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.32, 1.1), m.wood); car.position.set(0, 0.38, 0); g.add(car);
        for (const dx of [-0.32, 0.32]) for (const dz of [-0.35, 0.4]) { const wh = new THREE.Mesh(wheelG, m.wood); wh.position.set(dx, 0.2, dz); wh.rotation.y = Math.PI / 2; g.add(wh); }
        this.cannons.push(new THREE.Vector3(x, D + 0.62, s * (w + 1.2)));
        this.colliders.push({ x, z: s * (w - 1.0), r: 0.6 });
      }
    }

    // Masts (the mizzen rises from the quarterdeck), rope wraps, yards, sails, shrouds and ratlines.
    const nm = this.len >= 5 ? 3 : this.len >= 3 ? 2 : 1;
    const mastXs = nm === 3 ? [this.xStern + (xq - this.xStern) * 0.35, (0.5 - 0.5) * Ls, (0.76 - 0.5) * Ls] : nm === 2 ? [(0.42 - 0.5) * Ls, (0.72 - 0.5) * Ls] : [(0.55 - 0.5) * Ls];
    const H0 = (12 + this.len * 3.6) * (flagship ? 1.15 : 1);
    const ropeLines = [];
    const wrap = new THREE.TorusGeometry(0.4, 0.05, 5, 16); wrap.rotateX(Math.PI / 2);
    this.sails = [];
    mastXs.forEach((x, k) => {
      if (nm === 3 && k === 0 && Math.abs(x - this.wheelX) < 1.4) x = this.wheelX - 1.6;
      const base = this.floorY(x, 0), H = H0 * (nm === 3 && k !== 1 ? 0.86 : 1);
      this.masts.push({ x, base, H, beam: this.beam });
      cyl(0.26, 0.42, H, m.wood, x, base + H / 2, 0, 12);
      for (let r = 0; r < 7; r++) { const w2 = new THREE.Mesh(wrap, m.rope3d); w2.position.set(x, base + 0.5 + r * 0.09, 0); root.add(w2); }
      for (const y of [base + H * 0.34, base + H * 0.58]) { const w2 = new THREE.Mesh(wrap, m.rope3d); w2.position.set(x, y, 0); w2.scale.setScalar(0.8); root.add(w2); }
      this.colliders.push({ x, z: 0, r: 0.55 });
      const rig = new THREE.Group(); rig.position.set(x, 0, 0); rig.rotation.y = 0.5; root.add(rig);
      let prevY = base + 3.2;
      [0.4, 0.66, 0.88].forEach((lv, l) => {
        const y = base + H * lv, yl = this.beam * 1.3 * (1 - l * 0.24);
        const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, yl, 6), m.wood); yard.rotation.x = Math.PI / 2; yard.position.set(0.35, y, 0); rig.add(yard);
        const sail = new THREE.Mesh(this._sailGeometry(yl * 0.94, (y - prevY) * 0.92), m.sail); sail.position.set(0.5, y - 0.2, 0); rig.add(sail);
        this.sails.push(sail); prevY = y;
      });
      // Shrouds from the rails to the masthead, with ratline rungs to climb.
      const t = x / Ls + 0.5, rw = Math.max(this.halfWidth(t), 0.4), railY = this.sheerY(t), topY = base + H * 0.86;
      for (const s of [-1, 1]) {
        const feet = [-1.2, -0.4, 0.4].map((dx) => new THREE.Vector3(x + dx, railY, s * rw));
        const head = new THREE.Vector3(x, topY, s * 0.3);
        for (const f of feet) ropeLines.push(f, head);
        for (let y = railY + 0.45; y < topY - 1; y += 0.45) {
          const f = (y - railY) / (topY - railY);
          const a = feet[0].clone().lerp(head, f), b = feet[2].clone().lerp(head, f);
          ropeLines.push(a, b);
        }
      }
      if (k === (nm === 3 ? 1 : 0)) {
        const flag = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 1.3, 8, 2), m.trim.clone()); flag.material.side = THREE.DoubleSide;
        flag.position.set(x - 1.6, base + H + 0.8, 0); root.add(flag); this.flag = flag;
      }
      if (k === 0 || nm === 1) this.mastTop = new THREE.Vector3(x, base + H, 0);
      if (k === nm - 1) ropeLines.push(new THREE.Vector3(x, base + H * 0.9, 0), new THREE.Vector3(0.5 * Ls + 0.18 * Ls, this.sheerY(1) + 3, 0));
    });
    const sprit = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.28, 0.24 * Ls, 8), m.wood);
    sprit.rotation.z = -Math.PI / 2 + 0.28; sprit.position.set(0.5 * Ls + 0.08 * Ls, this.sheerY(1) + 1.2, 0); root.add(sprit);
    root.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ropeLines), m.rope));
  }

  // A square sail hanging below its yard: spans the beam (z) and height (y), billowing forward (+x).
  _sailGeometry(w, h) {
    const g = new THREE.PlaneGeometry(w, h, 8, 6);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const b = p.getX(i) / w, a = p.getY(i) / h;
      p.setZ(i, (1 - 4 * b * b) * (0.25 - a * a) * 4 * 1.2);
      p.setY(i, p.getY(i) - h / 2);
    }
    g.rotateY(Math.PI / 2);
    g.computeVertexNormals();
    return g;
  }

  setCharred(on) {
    const f = on ? 0.18 : 1;
    this.mats.hull.color.multiplyScalar(on ? 0.3 : 1);
    this.mats.sail.opacity = on ? 0 : 1;
    for (const s of this.sails) s.visible = !on;
    this.mats.stern.color.setRGB(5 * f, 2.8 * f, 1.0 * f);
    this.mats.lamp.color.setRGB(9 * f, 5 * f, 1.8 * f);
  }
}

// ------------------------------------------------------------------ particles
const PART_VS = /* glsl */ `
attribute float size;
attribute vec4 pcolor;
attribute float seed;
varying vec4 vColor;
varying float vSeed;
uniform float uScale;
void main() {
  vColor = pcolor;
  vSeed = seed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(size * uScale / max(-mv.z, 0.1), 1.0, 600.0);
  gl_Position = projectionMatrix * mv;
}`;
const PART_FS = /* glsl */ `
varying vec4 vColor;
varying float vSeed;
uniform float uFlame, uTime;
float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (uFlame > 0.5) {
    // A tongue of flame: wide and hot at the base, tapering and flickering toward the tip.
    float y = 0.5 - c.y;                                     // 0 at the bottom, 1 at the top
    float wob = (n2(vec2(y * 5.0 - uTime * 7.0, vSeed * 3.0)) - 0.5) * 0.35 * y;
    float width = mix(0.42, 0.04, pow(y, 0.8));
    float body = smoothstep(width, width * 0.35, abs(c.x + wob)) * smoothstep(0.0, 0.18, y) * smoothstep(1.0, 0.55, y);
    float rag = n2(vec2(c.x * 9.0 + vSeed, y * 7.0 - uTime * 9.0));
    float a = body * smoothstep(0.15, 0.55, rag + (1.0 - y) * 0.45);
    if (a <= 0.004) discard;
    vec3 col = vColor.rgb * mix(1.35, 0.55, y) * mix(vec3(1.0, 0.95, 0.8), vec3(1.0, 0.55, 0.35), y);
    gl_FragColor = vec4(col, vColor.a * a);
    return;
  }
  float r = length(c) * 2.0;
  float n = h(floor(gl_PointCoord * 6.0) + vSeed) * 0.35;
  float a = smoothstep(1.0, 0.35 + n, r);
  if (a <= 0.003) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * a);
}`;

class Particles {
  constructor(cap, additive) {
    this.cap = cap;
    this.list = [];
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(cap * 3); this.col = new Float32Array(cap * 4); this.size = new Float32Array(cap); this.seed = new Float32Array(cap);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('seed', new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage));
    this.uniforms = { uScale: { value: 500 }, uFlame: { value: additive ? 1 : 0 }, uTime: { value: 0 } };
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      vertexShader: PART_VS, fragmentShader: PART_FS, uniforms: this.uniforms, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 5 : 4;
  }
  emit(p) { if (this.list.length < this.cap) this.list.push(p); }
  update(dt, ocean) {
    this.uniforms.uTime.value += dt;
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i];
      p.life -= dt;
      if (p.life <= 0) { L[i] = L[L.length - 1]; L.pop(); continue; }
      p.v.y += (p.g || 0) * dt;
      if (p.drag) p.v.multiplyScalar(Math.max(0, 1 - p.drag * dt));
      p.p.addScaledVector(p.v, dt);
      if (p.float && ocean) p.p.y = ocean.heightAt(p.p.x, p.p.z) + 0.4;
    }
    const n = L.length;
    for (let i = 0; i < n; i++) {
      const p = L[i], age = 1 - p.life / p.max;
      this.pos[i * 3] = p.p.x; this.pos[i * 3 + 1] = p.p.y; this.pos[i * 3 + 2] = p.p.z;
      const fadeIn = Math.min(1, (p.max - p.life) * 12);
      this.col[i * 4] = p.c0[0] + (p.c1[0] - p.c0[0]) * age;
      this.col[i * 4 + 1] = p.c0[1] + (p.c1[1] - p.c0[1]) * age;
      this.col[i * 4 + 2] = p.c0[2] + (p.c1[2] - p.c0[2]) * age;
      this.col[i * 4 + 3] = (p.c0[3] + (p.c1[3] - p.c0[3]) * age) * fadeIn;
      this.size[i] = Math.max(0.05, p.s + (p.grow || 0) * (p.max - p.life));
      this.seed[i] = p.seed ?? (p.seed = Math.random() * 10);
    }
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    for (const k of ['position', 'pcolor', 'size', 'seed']) g.attributes[k].needsUpdate = true;
  }
}

// ------------------------------------------------------------------ rain
const RAIN_VS = /* glsl */ `
uniform float uTime;
uniform vec3 uCam, uVel;
attribute float end;
varying float vA;
varying vec3 vP;
void main() {
  vec3 box = vec3(60.0, 40.0, 60.0);
  vec3 p = mod(position + uVel * uTime - uCam + box * 0.5, box) - box * 0.5 + uCam;
  p -= uVel * 0.045 * end;
  vA = 1.0 - end * 0.7;
  vP = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const RAIN_FS = /* glsl */ `
uniform float uAlpha;
uniform vec3 uCam, uSun;
varying float vA;
varying vec3 vP;
void main() {
  float g = pow(max(dot(normalize(vP - uCam), uSun), 0.0), 5.0);     // backlit by the low sun
  vec3 c = mix(vec3(0.6, 0.64, 0.72), vec3(1.6, 0.95, 0.5), g);
  gl_FragColor = vec4(c, uAlpha * vA * (1.0 + g * 1.5));
}`;

// ------------------------------------------------------------------ World
export class World {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.4;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.3, 20000);
    this.tex = makeTextures();
    ShipModel.tex = this.tex;
    // When the Higgsfield wood textures are present, swap them onto every ship's deck and hull.
    this.tex.loadPhotoWood((map, normal) => {
      map.repeat.set(1, 1); normal.repeat.set(1, 1);
      this.photoDeck = { map, normal };
      for (const f of this.fleets) for (const s of f) s.applyPhotoWood?.(this.photoDeck, this.photoHull);
    }, (map, normal) => {
      this.photoHull = { map, normal };
      for (const f of this.fleets) for (const s of f) s.applyPhotoWood?.(this.photoDeck, this.photoHull);
    });
    this.ocean = new Ocean(this.renderer);
    this.sky = new StormSky(this.ocean.uniforms);
    this.scene.add(this.sky.mesh, this.ocean.mesh, this.sky.group);
    // Image-based lighting: capture the storm-and-sunset sky once and let every PBR surface
    // (the pirates' skin, leather and cloth, the ships' wood) reflect and be lit by it.
    try {
      const pm = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      envScene.add(new THREE.Mesh(this.sky.mesh.geometry, this.sky.mesh.material));
      this.scene.environment = pm.fromScene(envScene, 0, 1, 20000).texture;
      this.scene.environmentIntensity = 0.55;
      pm.dispose();
    } catch (e) { console.warn('Environment lighting unavailable:', e.message); }

    this.hemi = new THREE.HemisphereLight(0x9a90c0, 0x2a3a40, 1.7);
    // The low sunset sun is the key light: warm, raking, and it casts long real shadows.
    this.moon = new THREE.DirectionalLight(0xffa864, 3.4);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(2048, 2048);
    this.moon.shadow.bias = -0.0004;
    this.moon.shadow.normalBias = 0.04;
    this.scene.add(this.moon.target);
    this.flashLight = new THREE.DirectionalLight(0xc8d4ff, 0);
    this.scene.add(this.hemi, this.moon, this.flashLight);
    this.points = [0, 1, 2].map(() => { const l = new THREE.PointLight(0xffa050, 0, 60, 1.6); this.scene.add(l); return l; });
    this.deckLamp = new THREE.PointLight(0xffa860, 0, 34, 1.4);
    this.deckLampMesh = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.5, 0.35), new THREE.MeshBasicMaterial({ color: new THREE.Color(10, 6, 2.2) }));
    this.deckLampMesh.add(this.deckLamp);
    this.deckLampMesh.userData.keep = true;

    this.alphaParts = new Particles(10000, false);
    this.addParts = new Particles(10000, true);
    this.scene.add(this.alphaParts.points, this.addParts.points);
    this._buildRain();
    this.rainU.uSun.value = this.ocean.uniforms.uSunDir.value;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.42, 0.5, 1.0);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uFlash: { value: 0 }, uVignette: { value: 1 }, uHurt: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform float uTime, uFlash, uVignette, uHurt; varying vec2 vUv;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uTime) * 43758.5453); }
        void main(){
          vec3 c = clamp(texture2D(tDiffuse, vUv).rgb, 0.0, 1.0);  // display-referred (after ACES)
          vec3 s = c * c * (3.0 - 2.0 * c);               // S-curve: deeper shadows, brighter highlights
          c = mix(c, s, 0.45);
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(vec3(l), c, 1.08);                      // a touch more colour
          c += mix(vec3(-0.012, 0.004, 0.02), vec3(0.03, 0.012, -0.018), smoothstep(0.15, 0.75, l)); // teal shadows, warm highlights
          vec2 d = vUv - 0.5;
          c *= mix(1.0, 1.0 - dot(d,d) * 1.5, uVignette);
          c += vec3(0.6,0.1,0.05) * uHurt * dot(d,d) * 2.0;
          c += (h(vUv * 800.0) - 0.5) * 0.012;           // film grain
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.grade);

    this.fleets = [[], []];       // ShipModel per ship index for each side
    this.flagship = null;
    this.fires = [];              // {side, ship, seg} for my hits, {pos} for enemy-water fires
    this.balls = [];
    this.time = 0;
    this.shake = 0;
    this.mode = 'title';
    this.chartSide = 1;
    this.pov = 0;
    this.look = { yaw: 0, pitch: -0.05 };
    this.walk = { x: 0, z: 0, bob: 0 };
    this.comfort = false;
    this.layout = { cx: 0, cy: 0, size: 600 };
    this.trans = null;
    this.muzzle = { pos: new THREE.Vector3(), t: 0 };
    this.waveCooldown = 3;
    this.rng = Math.random;
    this.onWaveCrash = null;
    this.visibleWaters = null;
  }

  _buildRain() {
    const n = 3500, pos = new Float32Array(n * 6), end = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = Math.random() * 60, y = Math.random() * 40, z = Math.random() * 60;
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2] = 0; end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('end', new THREE.BufferAttribute(end, 1));
    this.rainU = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uVel: { value: new THREE.Vector3(4, -26, 2) }, uAlpha: { value: 0.24 }, uSun: { value: null } };
    this.rain = new THREE.LineSegments(g, new THREE.ShaderMaterial({ vertexShader: RAIN_VS, fragmentShader: RAIN_FS, uniforms: this.rainU, transparent: true, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.scene.add(this.rain);
  }

  resize(w, h) {
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.alphaParts.uniforms.uScale.value = this.addParts.uniforms.uScale.value = (h * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }

  // ---------------------------------------------------------------- fleets
  setupFleets(match, me = 0) {
    for (const f of this.fleets) for (const s of f) this.scene.remove(s.group);
    if (this.flagship) this.scene.remove(this.flagship.group);
    this.fleets = [0, 1].map((side) => SHIPS.map((info, i) => {
      const s = new ShipModel(info.length, match.side[side].captain, this.tex);
      s.index = i; s.side = side; s.visibleWanted = side === 0;
      s.applyPhotoWood(this.photoDeck, this.photoHull);
      s.group.visible = false;
      this.scene.add(s.group);
      return s;
    }));
    this.flagship = new ShipModel(6, match.side[1].captain, this.tex, true);
    this.flagship.index = 7;
    this._dressAll();
    this.crewDirector?.newBattle();
    if (this.crewDirector) for (const s2 of this.fleets[0]) this.crewDirector.setDressed(s2, s2.index !== this.pov);
    this.flagship.group.position.copy(FLAGSHIP_POS);
    this.flagship.group.rotation.y = Math.PI * 0.1;
    this.scene.add(this.flagship.group);
    this.fires = [];
    this.alphaParts.list.length = 0;
    this.addParts.list.length = 0;
    this.match = match;
    this.selectShip(0, true);
  }

  // Generated galleon model and Higgsfield crew, once the crew director has loaded them.
  _dressAll() {
    const d = this.crewDirector;
    if (!d || !d.shipGltf) return;
    for (const f of this.fleets) for (const s of f) d.dressShip(s);
    if (this.flagship) d.dressShip(this.flagship);
  }
  onCrewReady() {
    this._dressAll();
    for (const s of this.fleets[0]) this.crewDirector.setDressed(s, s.index !== this.pov);
    this._buildCrew();
  }

  // Where a ship sits for a placement (world centre + yaw).
  placementPose(side, pos, len) {
    const a = cellCenter(side, cellOf(pos, 0)), b = cellCenter(side, cellOf(pos, len - 1));
    return { center: a.add(b).multiplyScalar(0.5), yaw: pos.horizontal ? 0 : -Math.PI / 2 };
  }

  selectShip(i, force = false) {
    const s = this.match?.side[0].waters.ships[i];
    if (!force && (!s || s.isSunk())) return false;
    this.pov = i;
    const m = this.fleets[0][i];
    // Start at the helm, hands on the wheel, looking forward over the ship.
    this.walk.x = m.wheelX !== undefined ? m.wheelX - 1.1 : (0.2 - 0.5) * m.Ls;
    this.walk.z = 0;
    this.look.yaw = 0; this.look.pitch = -0.1;
    this._buildCrew();
    // The ship you're aboard shows its walkable built deck; the rest show the generated galleon.
    if (this.crewDirector) for (const s of this.fleets[0]) this.crewDirector.setDressed(s, s.index !== i);
    // Hang the deck lantern on the mast nearest amidships, just above head height.
    const lx = m.mastTop ? (m.colliders.find((c) => c.r === 0.55 && Math.abs(c.x) < m.Ls * 0.2)?.x ?? 0) : 0;
    this.deckLampMesh.position.set(lx + 0.5, (m.D ?? m.deckY(0.5)) + 3.1, 0.35);
    m.root.add(this.deckLampMesh);
    return true;
  }

  _buildCrew() {
    const ship = this.fleets[0][this.pov];
    if (ship && this.crewDirector?.ready) this.crewDirector.attach(ship, this.pov);
  }

  // ---------------------------------------------------------------- ship motion
  _moveShip(s, pose, dt, visualScale) {
    const o = this.ocean, c = pose.center;
    const fwd = new THREE.Vector3(Math.cos(pose.yaw), 0, -Math.sin(pose.yaw));
    const side = new THREE.Vector3(Math.sin(pose.yaw), 0, Math.cos(pose.yaw));
    const H = (v) => o.heightAt(v.x, v.z);
    const bow = c.clone().addScaledVector(fwd, s.Ls * 0.42), stern = c.clone().addScaledVector(fwd, -s.Ls * 0.42);
    const port = c.clone().addScaledVector(side, -s.beam * 0.5), stbd = c.clone().addScaledVector(side, s.beam * 0.5);
    const hb = H(bow), hs = H(stern), hp = H(port), hq = H(stbd), hc = H(c);
    let heave = (hb + hs + hp + hq + 2 * hc) / 6 * 0.9;
    let pitch = Math.atan2(hb - hs, s.Ls * 0.84) * 1.1;
    let roll = -Math.atan2(hq - hp, s.beam) * 1.15 + 0.05 * Math.sin(this.time * 0.8 + s.index * 1.7);
    pitch *= visualScale; roll *= visualScale;
    const m = s.motion;
    if (s.sinking) {
      m.sink = Math.min(1, m.sink + dt * 0.09);
      heave -= m.sink * m.sink * 16; roll += m.sink * 0.5; pitch -= m.sink * 0.2;
    }
    const k = 1 - Math.exp(-dt * 3.5);
    m.heave += (heave - m.heave) * k; m.pitch += (pitch - m.pitch) * k; m.roll += (roll - m.roll) * k;
    s.group.position.set(c.x, m.heave + 0.4, c.z);
    s.group.rotation.set(0, pose.yaw, 0);
    s.root.rotation.set(m.roll, 0, m.pitch, 'YZX');
    if (s.flag) s.flag.rotation.y = Math.sin(this.time * 7 + s.index) * 0.35;
    s.group.updateMatrixWorld();
  }

  shipPoint(side, i, local) {
    const s = this.fleets[side][i];
    return local.clone().applyMatrix4(s.root.matrixWorld);
  }
  segmentPoint(side, i, seg) {
    const s = this.fleets[side][i];
    const t = (seg + 0.5) / s.len;
    return this.shipPoint(side, i, new THREE.Vector3((t - 0.5) * s.Ls, s.deckY(t) + 0.8, 0));
  }

  // ---------------------------------------------------------------- effects
  splash(at, s = 1) {
    for (let i = 0; i < 90 * s; i++) this.alphaParts.emit({ p: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3 * s, 0, (Math.random() - 0.5) * 3 * s)), v: new THREE.Vector3((Math.random() - 0.5) * 6, (10 + Math.random() * 14) * s, (Math.random() - 0.5) * 6), life: 1.4 + Math.random(), max: 2.4, s: 1.4 * s, grow: 1.5, g: -12, drag: 0.3, c0: [0.75, 0.8, 0.84, 0.85], c1: [0.55, 0.6, 0.65, 0] });
    for (let i = 0; i < 12; i++) this.alphaParts.emit({ p: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, 1, (Math.random() - 0.5) * 4)), v: new THREE.Vector3(3 + Math.random() * 2, 2, 1), life: 3, max: 3, s: 5 * s, grow: 5, c0: [0.6, 0.65, 0.7, 0.3], c1: [0.5, 0.55, 0.6, 0] });
    for (let k = 0; k < 18; k++) { const a = (k / 18) * Math.PI * 2; this.alphaParts.emit({ p: at.clone(), v: new THREE.Vector3(Math.cos(a) * 6, 0, Math.sin(a) * 6), life: 2.2, max: 2.2, s: 2.5, grow: 2, float: true, drag: 1, c0: [0.7, 0.75, 0.78, 0.6], c1: [0.6, 0.65, 0.7, 0] }); }
  }
  explosion(at, s = 1) {
    for (let i = 0; i < 40 * s; i++) this.addParts.emit({ p: at.clone(), v: new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).multiplyScalar(18 * s).add(new THREE.Vector3(0, 5, 0)), life: 0.4 + Math.random() * 0.6, max: 1, s: 3 * s, grow: 4, drag: 2, c0: [3.5, 1.6, 0.4, 1], c1: [1.2, 0.2, 0.02, 0] });
    for (let i = 0; i < 30 * s; i++) this.alphaParts.emit({ p: at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3)), v: new THREE.Vector3((Math.random() - 0.5) * 6 + 3, 4 + Math.random() * 5, (Math.random() - 0.5) * 6 + 1.5), life: 3 + Math.random() * 3, max: 6, s: 4 * s, grow: 6, drag: 0.7, c0: [0.08, 0.07, 0.06, 0.85], c1: [0.18, 0.18, 0.19, 0] });
    for (let i = 0; i < 30; i++) this.alphaParts.emit({ p: at.clone(), v: new THREE.Vector3((Math.random() - 0.5) * 30, 8 + Math.random() * 20, (Math.random() - 0.5) * 30), life: 2, max: 2, s: 0.5, g: -14, c0: [0.12, 0.08, 0.05, 1], c1: [0.1, 0.07, 0.04, 1] });
    this.addParts.emit({ p: at.clone().add(new THREE.Vector3(0, 2, 0)), v: new THREE.Vector3(), life: 0.25, max: 0.25, s: 18 * s, grow: 40, c0: [6, 4, 2, 1], c1: [3, 1, 0.2, 0] });
    this.muzzle.pos.copy(at).y += 4; this.muzzle.t = 1.4;
  }
  muzzleFlash(at, dir) {
    this.addParts.emit({ p: at.clone(), v: new THREE.Vector3(), life: 0.14, max: 0.14, s: 4, grow: 12, c0: [7, 5, 2.5, 1], c1: [3, 1, 0.2, 0] });
    for (let i = 0; i < 14; i++) this.alphaParts.emit({ p: at.clone(), v: dir.clone().multiplyScalar(8 + Math.random() * 8).add(new THREE.Vector3(Math.random() - 0.5, Math.random() * 2, Math.random() - 0.5)), life: 2.5 + Math.random() * 2, max: 4.5, s: 2.2, grow: 3.5, drag: 1.1, c0: [0.5, 0.49, 0.47, 0.6], c1: [0.4, 0.4, 0.4, 0] });
    this.muzzle.pos.copy(at); this.muzzle.t = 1;
  }
  addFireOnShip(side, ship, seg) { this.fires.push({ side, ship, seg, acc: 0 }); }
  addFireOnWater(pos) { this.fires.push({ pos: pos.clone(), acc: 0 }); }
  clearShipFires(side, ship) { this.fires = this.fires.filter((f) => !(f.side === side && f.ship === ship)); }

  // A cannonball arcing from a to b over `dur` seconds.
  fireBall(from, to, dur) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), new THREE.MeshBasicMaterial({ color: 0x0c0c0c }));
    this.scene.add(mesh);
    this.balls.push({ mesh, from: from.clone(), to: to.clone(), t: 0, dur, apex: 18 + from.distanceTo(to) * 0.12 });
  }
  // Muzzle position for a broadside from my POV ship (or any afloat ship) toward a target.
  myGunFor(target) {
    const ships = this.fleets[0];
    let s = ships[this.pov];
    if (!s || s.sinking) s = ships.find((q) => !q.sinking) || ships[0];
    const c = s.cannons[Math.floor(Math.random() * s.cannons.length)];
    const p = this.shipPoint(0, s.index, c);
    return { pos: p, dir: target.clone().sub(p).setY(0).normalize() };
  }
  enemyGun() {
    const f = this.flagship;
    const c = f.cannons[Math.floor(Math.random() * f.cannons.length)];
    return c.clone().applyMatrix4(f.root.matrixWorld);
  }

  // ---------------------------------------------------------------- camera
  setLayout(l) { this.layout = l; }
  chartPose(side) {
    const vh = CELL * 10 * (this.h / this.layout.size);
    const H = vh / (2 * Math.tan(THREE.MathUtils.degToRad(CHART_FOV) / 2));
    const c = watersCenter(side);
    return { pos: new THREE.Vector3(c.x, H, c.z + 0.001), look: c, up: new THREE.Vector3(0, 0, -1), fov: CHART_FOV, off: [this.w / 2 - this.layout.cx, this.h / 2 - this.layout.cy] };
  }
  deckPose() {
    const s = this.fleets[0][this.pov];
    if (!s) return this.chartPose(0);
    const bob = Math.sin(this.walk.bob) * 0.05;
    // Smooth the eye height so climbing the stairs glides instead of snapping step to step.
    const floor = s.floorY ? s.floorY(this.walk.x, this.walk.z) : s.deckY(clamp(this.walk.x / s.Ls + 0.5, 0.15, 0.92));
    this._eyeFloor = this._eyeFloor === undefined || Math.abs(this._eyeFloor - floor) > 3 ? floor : this._eyeFloor + (floor - this._eyeFloor) * 0.25;
    const eyeL = new THREE.Vector3(this.walk.x, this._eyeFloor + 1.72 + bob, this.walk.z);
    const eye = eyeL.clone().applyMatrix4(s.root.matrixWorld);
    const f = new THREE.Vector3(Math.cos(this.look.yaw) * Math.cos(this.look.pitch), Math.sin(this.look.pitch), Math.sin(this.look.yaw) * Math.cos(this.look.pitch));
    s.root.matrixWorld.decompose(tmpV, tmpQ, new THREE.Vector3());
    const fw = f.applyQuaternion(tmpQ);
    let up = new THREE.Vector3(0, 1, 0).applyQuaternion(tmpQ);
    if (this.comfort) up.lerp(new THREE.Vector3(0, 1, 0), 0.8).normalize();
    return { pos: eye, look: eye.clone().add(fw), up, fov: 70, off: [0, 0] };
  }
  titlePose() {
    const a = this.time * 0.03 + 0.6;
    const c = FLAGSHIP_POS.clone().add(new THREE.Vector3(40, 0, 150));
    return { pos: new THREE.Vector3(c.x + Math.cos(a) * 110, 16 + Math.sin(this.time * 0.2) * 2, c.z + Math.sin(a) * 110), look: FLAGSHIP_POS.clone().add(new THREE.Vector3(0, 14, 0)), up: new THREE.Vector3(0, 1, 0), fov: 50, off: [0, 0] };
  }
  currentTargetPose() {
    if (this.mode === 'deck') return this.deckPose();
    if (this.mode === 'title') return this.titlePose();
    return this.chartPose(this.chartSide);
  }
  // Animated moves between views: 'swoop' (chart <-> deck) or 'pan' (chart side to side).
  goTo(mode, side = this.chartSide, dur = 1.6) {
    const from = this._snapshot();
    this.mode = mode;
    if (mode === 'chart') this.chartSide = side;
    this.trans = { from, t: 0, dur, kind: dur < 0.01 ? 'cut' : 'swoop' };
    if (dur < 0.01) this.trans = null;
  }
  _snapshot() {
    const cam = this.camera;
    const look = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion).multiplyScalar(this._lookDist || 100).add(cam.position);
    return { pos: cam.position.clone(), look, up: cam.up.clone(), fov: cam.fov, off: this._off ? [...this._off] : [0, 0] };
  }
  _applyPose(p) {
    const cam = this.camera;
    cam.position.copy(p.pos);
    cam.up.copy(p.up);
    cam.lookAt(p.look);
    this._lookDist = p.pos.distanceTo(p.look);
    if (cam.fov !== p.fov) { cam.fov = p.fov; }
    this._off = p.off;
    if (p.off[0] || p.off[1]) cam.setViewOffset(this.w, this.h, p.off[0], p.off[1], this.w, this.h);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
    const pr = this.renderer.getPixelRatio();
    this.alphaParts.uniforms.uScale.value = this.addParts.uniforms.uScale.value = (this.h * pr) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
  }
  _updateCamera(dt) {
    let target = this.currentTargetPose();
    if (this.trans) {
      const tr = this.trans;
      tr.t += dt / tr.dur;
      const k = ease(Math.min(1, tr.t));
      const a = tr.from, b = target;
      // Swoop along an arc: rise first when leaving the deck, dive when boarding.
      const pos = a.pos.clone().lerp(b.pos, k);
      const lift = Math.sin(Math.PI * k) * Math.min(300, a.pos.distanceTo(b.pos) * 0.15);
      pos.y += lift;
      // Blend orientation through quaternions rather than look-at points (no flips).
      const qa = new THREE.Quaternion().setFromRotationMatrix(tmpM.lookAt(a.pos, a.look, a.up));
      const qb = new THREE.Quaternion().setFromRotationMatrix(tmpM.lookAt(b.pos, b.look, b.up));
      const q = qa.slerp(qb, k);
      const fov = a.fov + (b.fov - a.fov) * k;
      const off = [a.off[0] + (b.off[0] - a.off[0]) * k, a.off[1] + (b.off[1] - a.off[1]) * k];
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q), up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      target = { pos, look: pos.clone().add(fwd.multiplyScalar(100)), up, fov, off };
      if (tr.t >= 1) this.trans = null;
    }
    // Trauma shake: offset in metres, scaled for how far the camera is from the action.
    if (this.shake > 0.001) {
      const s = this.shake * this.shake * (this.mode === 'deck' ? 0.35 : 3.0) * (this.comfort ? 0.35 : 1);
      const j = new THREE.Vector3(Math.sin(this.time * 71) + Math.sin(this.time * 131) * 0.5, Math.sin(this.time * 89) * 0.5, Math.sin(this.time * 97 + 1) + Math.sin(this.time * 113) * 0.5).multiplyScalar(s);
      target = { ...target, pos: target.pos.clone().add(j), look: target.look.clone().add(j) };
    }
    this._applyPose(target);
  }

  // Screen position (CSS px) of a world point, for the chart overlay.
  project(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * this.w, y: (-p.y * 0.5 + 0.5) * this.h, z: p.z };
  }
  // Mouse (CSS px) to the sea plane.
  pick(mx, my) {
    const ndc = new THREE.Vector2((mx / this.w) * 2 - 1, -(my / this.h) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const t = -ray.ray.origin.y / ray.ray.direction.y;
    if (!(t > 0)) return null;
    return ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
  }
  inChartView() { return this.mode === 'chart' && !this.trans; }

  // ---------------------------------------------------------------- frame
  update(dt, input = {}) {
    this.time += dt;
    const o = this.ocean;
    o.detail = this.mode === 'deck' || this.mode === 'title' || this.trans ? 1 : 0;
    o.update(dt);
    this.sky.update(dt, this.camera.position);
    this.shake = Math.max(0, this.shake - dt * 1.3);

    // Ships ride the swell; in the chart view their motion is damped so they sit squarely in their squares.
    const chartish = this.mode !== 'deck' || !!this.trans;
    const vis = chartish ? (this.mode === 'deck' ? 0.6 : 0.3) : 1;
    const m = this.match;
    if (m) {
      for (let side = 0; side < 2; side++)
        for (const s of this.fleets[side]) {
          const data = m.side[side].waters.ships[s.index];
          const show = side === 0 ? data.placed : s.revealed;
          // Strictly boolean: three.js only skips objects whose visible is exactly false.
          s.group.visible = !!show && !(s.sinking && s.motion.sink >= 1);
          if (!s.group.visible && !s.sinking) continue;
          const pos = s.revealed && s.wreckPos ? s.wreckPos : data.pos;
          this._moveShip(s, this.placementPose(side, pos, s.len), dt, vis);
        }
      this._moveShip(this.flagship, { center: FLAGSHIP_POS, yaw: 0.35 }, dt, 1);
    }

    // Walking and crew on the deck you stand on.
    if (this.mode === 'deck' && !this.trans) {
      const s = this.fleets[0][this.pov];
      if (input.look) { this.look.yaw += input.dx * 0.0022; this.look.pitch = clamp(this.look.pitch - input.dy * 0.0022, -1.3, 1.3); }
      const f = new THREE.Vector2(Math.cos(this.look.yaw), Math.sin(this.look.yaw)), r = new THREE.Vector2(-Math.sin(this.look.yaw), Math.cos(this.look.yaw));
      const mv = f.multiplyScalar((input.fwd ? 1 : 0) - (input.back ? 1 : 0)).add(r.multiplyScalar((input.right ? 1 : 0) - (input.left ? 1 : 0)));
      // Momentum: speed builds up and bleeds off rather than starting and stopping instantly.
      const want = mv.lengthSq() > 0.01 ? mv.normalize().multiplyScalar(input.run ? 5.2 : 2.8) : new THREE.Vector2();
      this.walk.vel = (this.walk.vel || new THREE.Vector2()).lerp(want, 1 - Math.exp(-dt * (want.lengthSq() ? 6 : 9)));
      mv.copy(this.walk.vel).multiplyScalar(dt);
      if (mv.lengthSq() > 1e-7 && s) {
        const crew = this.crewDirector?.crew || [];
        const w = this.walk, ok = (x, z) => (s.walkable ? s.walkable(w.x, w.z, x, z, 0.3) : true)
          && crew.every((c) => (c.x - x) ** 2 + (c.z - z) ** 2 >= 0.55 ** 2 || (c.x - x) ** 2 + (c.z - z) ** 2 > (c.x - w.x) ** 2 + (c.z - w.z) ** 2);
        // Move, or slide along whatever blocks the way (rail, wall, mast, barrel).
        if (ok(w.x + mv.x, w.z + mv.y)) { w.x += mv.x; w.z += mv.y; }
        else if (ok(w.x + mv.x, w.z)) w.x += mv.x;
        else if (ok(w.x, w.z + mv.y)) w.z += mv.y;
        w.bob += dt * 7 * Math.min(1, this.walk.vel.length() / 2.8);
      }
      this._greenWater(dt);
    }
    if (this.crewDirector?.ready) this.crewDirector.update(dt, this.mode === 'deck' && !this.trans);

    // Fires: burning hits on my ships and flotsam burning where enemy ships were struck.
    for (const fr of this.fires) {
      let p;
      if (fr.pos) { p = fr.pos.clone(); p.y = o.heightAt(p.x, p.z) + 0.8; }
      else {
        const sm = this.fleets[fr.side][fr.ship];
        if (!sm.group.visible) continue;
        this._burnSection(fr, sm, dt);
        continue;
      }
      fr.last = p;
      fr.age = (fr.age || 0) + dt;
      fr.acc += dt * 26 * (fr.pos ? Math.max(0.2, 1 - fr.age / 40) : 1);
      while (fr.acc >= 1) {
        fr.acc -= 1;
        this.addParts.emit({ p: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.6, 0, (Math.random() - 0.5) * 1.6)), v: new THREE.Vector3(1.2, 3 + Math.random() * 3, 0.6), life: 0.5 + Math.random() * 0.4, max: 0.9, s: 1.6 + Math.random(), grow: -1.2, c0: [4, 1.8, 0.45, 1], c1: [1.2, 0.2, 0.03, 0] });
        if (Math.random() < 0.35) this.alphaParts.emit({ p: p.clone().add(new THREE.Vector3(0, 2, 0)), v: new THREE.Vector3(3.5, 3 + Math.random() * 2, 1.5), life: 4 + Math.random() * 2, max: 6, s: 2.5, grow: 4, drag: 0.2, c0: [0.06, 0.055, 0.05, 0.6], c1: [0.2, 0.2, 0.21, 0] });
      }
    }

    // Cannonballs.
    for (const b of this.balls) {
      b.t += dt / b.dur;
      const k = Math.min(1, b.t);
      const p = b.from.clone().lerp(b.to, k);
      p.y += Math.sin(Math.PI * k) * b.apex;
      b.mesh.position.copy(p);
      b.mesh.scale.setScalar(this.mode === 'deck' ? 1 : 4);
      const tr = this.mode === 'deck' ? 1.4 : 4.5;
      this.addParts.emit({ p: p.clone(), v: new THREE.Vector3(), life: 0.35, max: 0.35, s: tr, grow: -tr * 2, c0: [2.6, 1.2, 0.35, 0.9], c1: [0.8, 0.2, 0.05, 0] });
      if (Math.random() < 0.5) this.alphaParts.emit({ p: p.clone(), v: new THREE.Vector3(), life: 1.2, max: 1.2, s: 1.2, grow: 2, c0: [0.5, 0.5, 0.5, 0.35], c1: [0.4, 0.4, 0.4, 0] });
    }
    for (const b of this.balls.filter((q) => q.t >= 1)) { this.scene.remove(b.mesh); b.mesh.geometry.dispose(); }
    this.balls = this.balls.filter((q) => q.t < 1);

    this.alphaParts.update(dt, o);
    this.addParts.update(dt, o);

    // Rain is only drawn around the deck camera.
    this.rain.visible = this.mode === 'deck' || (!!this.trans && this.camera.position.y < 300);
    this.rainU.uTime.value = this.time;
    this.rainU.uCam.value.copy(this.camera.position);

    this._updateMapLook();
    this._updateHullMasks();
    this._updateLights(dt);
    this._updateCamera(dt);
    o.followCamera(this.camera);
    o.uniforms.uFogDensity.value = this.mode === 'deck' || this.mode === 'title' ? 0.00055 : 0.00012;
    this.grade.uniforms.uTime.value = this.time;
    this.grade.uniforms.uVignette.value = this.mode === 'chart' && !this.trans ? 0.6 : 1;
  }

  // A hit sets its section of the ship ablaze: flames spread over the deck and rails, and if a
  // mast stands in that section they climb it to the masthead and run out along the yards.
  _burnSection(fr, sm, dt) {
    fr.age = (fr.age || 0) + dt;
    const grow = Math.min(1, 0.3 + fr.age / 3);
    const x0 = (fr.seg / sm.len - 0.5) * sm.Ls, x1 = ((fr.seg + 1) / sm.len - 0.5) * sm.Ls;
    const mat = sm.root.matrixWorld;
    const P = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(mat);
    const onModel = sm.dressed && sm._model && sm._model.visible;
    const floor = (x, z) => (onModel || !sm.floorY ? sm.deckY(x / sm.Ls + 0.5) : sm.floorY(x, z));
    const mast = (sm.masts || []).find((q) => q.x >= x0 - 1.5 && q.x <= x1 + 1.5);
    const wind = new THREE.Vector3(1.6, 0, 0.9);
    const climb = Math.min(1, 0.25 + fr.age / 4);     // how far up the mast the fire has reached
    fr.acc += dt * 90 * grow;
    while (fr.acc >= 1) {
      fr.acc -= 1;
      let p, size, onMast = false;
      if (mast && Math.random() < 0.6) {
        onMast = true;
        const h = Math.pow(Math.random(), 0.7) * mast.H * 0.95 * climb;
        if (fr.age > 2 && Math.random() < 0.35) {
          // Out along a burning yard.
          const lv = [0.4, 0.66, 0.88][Math.floor(Math.random() * 3)];
          if (lv * mast.H <= mast.H * 0.95 * climb) {
            const yl = mast.beam * 1.3 * (1 - [0.4, 0.66, 0.88].indexOf(lv) * 0.24), sp = (Math.random() - 0.5) * yl;
            p = P(mast.x + 0.35 * Math.cos(0.5) + sp * Math.sin(0.5), mast.base + mast.H * lv, -0.35 * Math.sin(0.5) + sp * Math.cos(0.5));
          }
        }
        if (!p) p = P(mast.x + (Math.random() - 0.5) * 0.9, mast.base + h, (Math.random() - 0.5) * 0.9);
        size = 2.2 + Math.random() * 1.8;
      } else {
        const x = x0 + Math.random() * (x1 - x0), t = x / sm.Ls + 0.5, hw = sm.halfWidth(Math.min(0.97, Math.max(0.03, t)));
        const rail = Math.random() < 0.3, z = rail ? Math.sign(Math.random() - 0.5) * hw * 0.93 : (Math.random() - 0.5) * 1.6 * hw * 0.8;
        p = P(x, (rail && sm.sheerY ? sm.sheerY(t) - 0.4 : floor(x, z)) + 0.15, z);
        size = 3 + Math.random() * 2.2;
      }
      const up = new THREE.Vector3(0, 3.5 + Math.random() * 3.5, 0).add(wind.clone().multiplyScalar(0.5 + Math.random() * 0.6));
      this.addParts.emit({ p, v: up, life: 0.55 + Math.random() * 0.45, max: 1, s: size * (0.8 + grow * 0.35), grow: -size * 0.6, c0: [2.9, 1.25, 0.32, 1], c1: [1.1, 0.18, 0.02, 0] });
      if (Math.random() < 0.28) this.alphaParts.emit({ p: p.clone().add(new THREE.Vector3(0, 1.5, 0)), v: up.clone().multiplyScalar(0.7).add(wind), life: 5 + Math.random() * 3, max: 8, s: 3.5 + Math.random() * 2.5, grow: 5, drag: 0.15, c0: [0.07, 0.06, 0.055, 0.7], c1: [0.22, 0.22, 0.23, 0] });
      if (Math.random() < 0.12) this.addParts.emit({ p: p.clone(), v: new THREE.Vector3((Math.random() - 0.5) * 3, 6 + Math.random() * 6, (Math.random() - 0.5) * 3).add(wind), life: 1.2 + Math.random(), max: 2.2, s: 0.28, grow: -0.1, g: -1, c0: [6, 3, 0.8, 1], c1: [2, 0.4, 0.05, 0] });
      if (onMast && !fr.last) fr.last = null;
    }
    fr.last = mast ? P(mast.x, mast.base + mast.H * 0.3 * climb + 2, 0) : P((x0 + x1) / 2, floor((x0 + x1) / 2, 0) + 1.5, 0);
    fr.bright = 22 * grow;
  }

  // Physics check: ray-cast straight down onto the visible floor surfaces of the ship you're on
  // at random walkable spots, and compare with the height the walking physics uses.
  verifyFloor(n = 500) {
    const s = this.fleets[0][this.pov];
    s.root.updateMatrixWorld(true);
    const floors = [];
    s.root.traverse((o) => { if (o.userData.floor && o.visible !== false) floors.push(o); });
    const ray = new THREE.Raycaster(), inv = s.root.matrixWorld.clone().invert();
    let tested = 0, maxErr = 0, misses = 0, stairs = 0, quarter = 0;
    for (let i = 0; i < n * 4 && tested < n; i++) {
      const x = s.xStern + Math.random() * (s.xBow - s.xStern), z = (Math.random() - 0.5) * 2 * s.halfWidth(x / s.Ls + 0.5) * 0.8;
      if (!s.walkable(x, z, x, z, 0.3)) continue;
      const top = new THREE.Vector3(x, s.floorY(x, z) + 0.5, z).applyMatrix4(s.root.matrixWorld);
      const down = new THREE.Vector3(0, -1, 0).transformDirection(s.root.matrixWorld);
      ray.set(top, down);
      const hit = ray.intersectObjects(floors, false)[0];
      tested++;
      if (!hit) { misses++; continue; }
      const local = hit.point.clone().applyMatrix4(inv);
      maxErr = Math.max(maxErr, Math.abs(local.y - s.floorY(x, z)));
      if (s.floorY(x, z) > s.D + 0.01 && s.floorY(x, z) < s.QD - 0.01) stairs++;
      if (x < s.xq) quarter++;
    }
    return { tested, misses, maxErrCm: +(maxErr * 100).toFixed(2), onStairs: stairs, onQuarterdeck: quarter, floorSurfaces: floors.length };
  }

  _greenWater(dt) {
    const s = this.fleets[0][this.pov];
    if (!s) return;
    this.waveCooldown -= dt;
    const bow = this.shipPoint(0, this.pov, new THREE.Vector3(s.Ls * 0.45, s.deckY(0.95) - 1.2, 0));
    const h = this.ocean.heightAt(bow.x, bow.z);
    if (this.waveCooldown <= 0 && (h > bow.y - 2.4 || this.waveCooldown < -12)) {
      this.waveCooldown = 2.8;
      const back = new THREE.Vector3(-1, 0.9, 0).applyQuaternion(s.root.getWorldQuaternion(tmpQ)).normalize();
      for (let i = 0; i < 140; i++) this.alphaParts.emit({ p: bow.clone().add(new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 1.5, (Math.random() - 0.5) * 4)), v: back.clone().multiplyScalar(5 + Math.random() * 7).add(new THREE.Vector3((Math.random() - 0.5) * 6, 2 + Math.random() * 6, (Math.random() - 0.5) * 6)), life: 0.9 + Math.random(), max: 1.9, s: 0.7 + Math.random() * 0.8, grow: 1.4, g: -11, drag: 0.4, c0: [0.62, 0.68, 0.72, 0.85], c1: [0.5, 0.55, 0.6, 0] });
      this.shake = Math.min(1.5, this.shake + 0.3);
      this.onWaveCrash?.(Math.max(0.2, Math.min(1, 30 / Math.max(10, bow.distanceTo(this.camera.position)))));
    }
  }

  // Overhead map (placement and chart): every ship shows as the same wooden galleon. In first
  // person the ship you're aboard switches to its walkable deck with its crew.
  _updateMapLook() {
    const d = this.crewDirector;
    if (!d || !d.shipGltf) return;
    const deckView = this.mode === 'deck' || (this.trans && this.camera.position.y < 200);
    for (const s of this.fleets[0] || []) {
      const want = !(deckView && s.index === this.pov);
      if (s._model && s._model.visible !== want) d.setDressed(s, want);
      if (s._model) s._model.scale.z = deckView ? s._fullScale : s._mapScaleZ;
    }
    for (const c of d.crew) c.obj.visible = deckView;
    // Depth precision for the high overhead camera: a near plane of 30 cm at 1 km up makes
    // nearby surfaces fight for the same pixels, so push it out when looking down from above.
    // Looking straight down from 1 km: the sky is out of view and shadows are invisible.
    const overhead = this.camera.position.y > 300;
    this.sky.mesh.visible = !overhead;
    // Toggle shadows without changing the light setup (that would force a shader recompile).
    this.renderer.shadowMap.autoUpdate = !overhead;
    this.moon.shadow.intensity = overhead ? 0 : 1;
    const near = overhead ? 20 : 0.3;
    if (this.camera.near !== near) { this.camera.near = near; this.camera.updateProjectionMatrix(); }
  }

  _updateHullMasks() {
    const U = this.ocean.uniforms;
    const ships = [...(this.fleets[0] || []), this.flagship].filter(Boolean);
    for (let i = 0; i < 6; i++) {
      const s = ships[i];
      const onDeck = this.mode === 'deck' || (this.trans && this.camera.position.y < 200);
      if (!s || !s.group.visible || s.sinking || !onDeck || s !== this.fleets[0][this.pov] || (s._model && s._model.visible)) { U.uShipDim.value[i].set(0, 0, 0); continue; }
      U.uShipInv.value[i].copy(s.root.matrixWorld).invert();
      U.uShipDim.value[i].set(s.Ls / 2, s.beam / 2, 1);
    }
    U.uFoamScale.value = this.mode === 'chart' && !this.trans ? 0.6 : 1;
  }

  _updateLights(dt) {
    const flash = this.sky.flash;
    this.flashLight.intensity = flash * 6;
    this.flashLight.position.copy(this.sky.uniforms.uFlashDir.value).multiplyScalar(1000);
    this.hemi.intensity = 1.7 + flash * 2.5;
    this.deckLamp.intensity = this.mode === 'deck' || this.trans ? 38 * (0.92 + 0.08 * Math.sin(this.time * 11) * Math.sin(this.time * 7.3)) : 0;
    // Keep the moon's shadow camera over whatever the player is looking at.
    const focus = this.mode === 'deck' || this.mode === 'title' ? this.camera.position.clone().setY(0) : watersCenter(this.chartSide);
    const md = this.ocean.uniforms.uSunDir.value;
    const ext = this.mode === 'deck' ? 60 : 130;
    const sc = this.moon.shadow.camera;
    if (sc.right !== ext) { sc.left = -ext; sc.right = ext; sc.top = ext; sc.bottom = -ext; sc.near = 10; sc.far = 900; sc.updateProjectionMatrix(); }
    this.moon.target.position.copy(focus);
    this.moon.position.copy(focus).addScaledVector(md, 420);
    this.muzzle.t = Math.max(0, this.muzzle.t - dt * 5);
    this.grade.uniforms.uFlash.value = flash;
    // Candidate lights near the camera: muzzle flash, fires, lanterns on my POV ship.
    const cands = [];
    if (this.muzzle.t > 0.02) cands.push({ p: this.muzzle.pos, i: 60 * this.muzzle.t, c: [1, 0.75, 0.45] });
    for (const f of this.fires) if (f.last) cands.push({ p: f.last, i: (f.bright || 9) + Math.random() * 4, c: [1, 0.5, 0.2] });
    const pov = this.fleets[0][this.pov];
    if (pov && pov.group.visible) for (const l of pov.lanterns) cands.push({ p: l.getWorldPosition(new THREE.Vector3()), i: 4, c: [1, 0.62, 0.3] });
    const cp = this.camera.position;
    cands.sort((a, b) => a.p.distanceToSquared(cp) - b.p.distanceToSquared(cp));
    this.points.forEach((l, i) => {
      const c = cands[i];
      if (!c) { l.intensity = 0; return; }
      l.position.copy(c.p); l.intensity = c.i * 10; l.color.setRGB(c.c[0], c.c[1], c.c[2]); l.distance = 80;
    });
    const U = this.ocean.uniforms;
    for (let i = 0; i < 4; i++) {
      const c = cands[i];
      if (c) { U.uLights.value[i].set(c.p.x, c.p.y, c.p.z, c.i * 0.05); U.uLightCols.value[i].setRGB(c.c[0], c.c[1], c.c[2]); }
      else U.uLights.value[i].set(0, -1000, 0, 0);
    }
  }

  render() { this.composer.render(); }
}
