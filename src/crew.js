// crew.js - the living crew. Loads the rigged, textured pirates generated with Higgsfield
// (image -> 3D -> auto-rig), shares one set of animation clips across all of them by bone name,
// and directs their life on deck: wandering, gathering in small groups that talk with gestures,
// flinching when a cannonball lands, celebrating when an enemy ship goes down.
// Also swaps the procedural hulls for the generated galleon model when it is present.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export const ROSTER = [
  { key: 'silas', name: 'Old Silas', height: 1.76 },
  { key: 'rourke', name: 'Rourke', height: 1.85, temper: 'angry' },
  { key: 'harrow', name: 'Bosun Harrow', height: 1.82 },
  { key: 'kip', name: 'Kip', height: 1.74 },
  { key: 'seraphine', name: 'Seraphine', height: 1.7, temper: 'angry' },
  { key: 'tobias', name: 'Tobias', height: 1.72 },
  { key: 'garrick', name: 'Garrick', height: 1.75 },
  { key: 'jonah', name: 'Jonah Crane', height: 1.8 },
];
// Silent crew conversations: who gestures in turn (no dialogue text or audio).
const CONVOS = [[0, 3, 0], [1, 2, 1], [4, 7, 4], [5, 6, 5], [3, 2, 7]];
const CLIPS = ['walk', 'talk', 'angry', 'open', 'hit'];

// Where each asset comes from: embedded in the single-file build, or served by the dev server.
function fileUrl(path) {
  const cache = (window.__cgUrls ||= {});
  if (path in cache) return cache[path];
  const b64 = window.CG_BIN_B64 && window.CG_BIN_B64[path];
  let url = null;
  if (b64) {
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    url = URL.createObjectURL(new Blob([bytes]));
  } else if (!window.CG_NO_FILES && window.CG_DEV_FILES && window.CG_DEV_FILES.includes(path)) url = `assets/${path}`;
  return (cache[path] = url);
}
// Normalised bone name so clips transfer between rigs ("mixamorig:LeftArm" == "LeftArm").
const norm = (n) => n.toLowerCase().replace(/^.*mixamorig[:_]?/, '').replace(/[^a-z0-9]/g, '');

// Re-bind a clip to another rig by bone name, keeping rotations and an in-place hip bob.
export function retarget(clip, root) {
  const bones = {};
  let hips = null;
  root.traverse((o) => { if (o.isBone) { bones[norm(o.name)] = o; if (!hips && /hips|pelvis/.test(norm(o.name))) hips = o; } });
  const tracks = [];
  for (const t of clip.tracks) {
    const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(t.name);
    const bone = bones[norm(nodeName)];
    if (!bone || propertyName === 'scale') continue;
    if (propertyName === 'position') {
      if (bone !== hips) continue;
      // Keep only the vertical bob relative to the first frame; the director moves the body.
      const v = t.values.slice(), y0 = v[1], rest = bone.position;
      for (let i = 0; i < v.length; i += 3) { v[i] = rest.x; v[i + 2] = rest.z; v[i + 1] = rest.y + (v[i + 1] - y0); }
      tracks.push(new THREE.VectorKeyframeTrack(`${bone.name}.position`, t.times, v));
      continue;
    }
    const nt = t.clone();
    nt.name = `${bone.name}.${propertyName}`;
    tracks.push(nt);
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

class CrewMember {
  constructor(id, src, shared, ship) {
    this.id = id;
    this.info = ROSTER[id];
    this.ship = ship;
    const model = SkeletonUtils.clone(src.scene);
    // Measure the posed, skinned figure with its transforms applied; rigs often carry
    // unit scales (centimetres) on the armature, so fall back to the skeleton's height.
    model.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(model, true);
    let size = box.getSize(new THREE.Vector3());
    if (!(size.y > 0.2 && size.y < 50)) {
      box = new THREE.Box3();
      const v = new THREE.Vector3();
      model.traverse((o) => { if (o.isBone) box.expandByPoint(o.getWorldPosition(v)); });
      box.max.y += (box.max.y - box.min.y) * 0.08;   // head top above the head bone
      size = box.getSize(new THREE.Vector3());
    }
    const s = THREE.MathUtils.clamp(this.info.height / Math.max(size.y, 0.01), 0.001, 1000);
    model.scale.setScalar(s);
    model.position.y = -box.min.y * s;
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false;
        if (o.material) { o.material = o.material.clone(); o.material.envMapIntensity = 0.8; }
      }
    });
    this.obj = new THREE.Group();
    this.obj.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = {};
    const idle = src.animations[0];
    if (idle) this.actions.idle = this.mixer.clipAction(idle);
    for (const k of CLIPS) if (shared[k]) this.actions[k] = this.mixer.clipAction(retarget(shared[k], model));
    if (!this.actions.idle && this.actions.walk) this.actions.idle = this.actions.walk; // last resort
    if (this.actions.hit) { this.actions.hit.setLoop(THREE.LoopOnce); this.actions.hit.clampWhenFinished = true; }
    this.current = null;
    this.play('idle', 0);
    if (this.current) this.current.time = Math.random() * 3;
    // Foot bones, to keep the soles on the planks whatever the animation does.
    this.model = model;
    this.feet = [];
    model.traverse((o) => { if (o.isBone && /toebase|toe$/.test(norm(o.name))) this.feet.push(o); });
    if (!this.feet.length) model.traverse((o) => { if (o.isBone && /foot$/.test(norm(o.name))) this.feet.push(o); });
    this._v = new THREE.Vector3();
    // Contact points: the boot vertices that are ever the lowest point in any pose of any clip.
    // Found once per character (cached on the source model, shared by every copy), then checked
    // each frame so the soles rest exactly on the planks at a fraction of the cost.
    this.soles = [];
    const meshes = [];
    model.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
    if (!src._contact) src._contact = this._findContacts(model, meshes);
    for (const [mi, i] of src._contact) if (meshes[mi]) this.soles.push([meshes[mi], i]);
    this.x = 0; this.z = 0; this.face = 0; this.target = null; this.speed = 1.2;
    this.state = 'idle'; this.timer = 1 + Math.random() * 4;
  }
  _findContacts(model, meshes) {
    const v = new THREE.Vector3(), inv = new THREE.Matrix4();
    model.updateMatrixWorld(true);
    // Candidates: boots up to the ankle in the rest pose.
    const cand = [];
    meshes.forEach((o, mi) => {
      const pos = o.geometry.attributes.position, ys = [];
      for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); ys.push([v.y, i]); }
      ys.sort((p, q) => p[0] - q[0]);
      const cut = ys[0][0] + (ys[ys.length - 1][0] - ys[0][0]) * 0.12;
      for (const [y, i] of ys) { if (y > cut) break; cand.push([mi, i]); }
    });
    // Pose the rig through every clip and keep whichever candidates come within 1.5 cm of the lowest point.
    const hits = new Map(), mixer = new THREE.AnimationMixer(model);
    const clips = Object.values(this.actions).map((a) => a.getClip()).filter((c, k, arr) => arr.indexOf(c) === k);
    for (const clip of clips) {
      const act = mixer.clipAction(clip); act.play();
      for (let f = 0; f < 16; f++) {
        act.time = (clip.duration * f) / 16; mixer.update(0);
        model.updateMatrixWorld(true); inv.copy(model.matrixWorld).invert();
        const ys = cand.map(([mi, i]) => { const o = meshes[mi]; v.fromBufferAttribute(o.geometry.attributes.position, i); o.applyBoneTransform(i, v); return v.applyMatrix4(o.matrixWorld).applyMatrix4(inv).y; });
        const lo = Math.min(...ys);
        ys.forEach((y, k) => { if (y < lo + 0.015) hits.set(k, (hits.get(k) || 0) + 1); });
      }
      act.stop();
    }
    mixer.stopAllAction(); mixer.uncacheRoot(model);
    const keep = [...hits.entries()].sort((p, q) => q[1] - p[1]).slice(0, 160).map(([k]) => cand[k]);
    return keep.length ? keep : cand.filter((_, k) => k % Math.max(1, Math.floor(cand.length / 120)) === 0);
  }

  play(name, fade = 0.35, timeScale = 1) {
    const a = this.actions[name] || this.actions.idle;
    if (!a) return;
    a.timeScale = timeScale;
    if (a === this.current) return;
    a.reset().play();
    if (this.current) this.current.crossFadeTo(a, fade, false);
    this.current = a;
  }
  walkTo(x, z, run = false) { this.target = { x, z }; this.speed = run ? 3.4 : 1.25; this.play('walk', 0.3, run ? 1.7 : 1); }
  update(dt) {
    if (this.target) {
      const dx = this.target.x - this.x, dz = this.target.z - this.z, d = Math.hypot(dx, dz);
      if (d < 0.15) { this.target = null; this.vel = 0; this.play('idle'); }
      else {
        const s = this.ship;
        // Turn toward the target at a human rate, speed up gradually, slow down on arrival.
        const want = Math.atan2(dz, dx);
        const turn = Math.atan2(Math.sin(want - this.face), Math.cos(want - this.face));
        this.face += Math.sign(turn) * Math.min(Math.abs(turn), dt * 4.5);
        const aligned = Math.max(0, Math.cos(turn));
        const targetV = this.speed * aligned * Math.min(1, d / 0.8);
        this.vel = (this.vel || 0) + (targetV - (this.vel || 0)) * (1 - Math.exp(-dt * 4));
        const st = Math.min(d, this.vel * dt);
        const nx = this.x + Math.cos(this.face) * st, nz = this.z + Math.sin(this.face) * st;
        if (this.current === this.actions.walk && this.actions.walk) this.actions.walk.timeScale = THREE.MathUtils.clamp(this.vel / 1.25, 0.35, 1.8);
        const ok = (x, z) => !s.walkable || s.walkable(this.x, this.z, x, z, 0.28);
        if (ok(nx, nz)) { this.x = nx; this.z = nz; }
        else if (ok(nx, this.z)) this.x = nx;
        else if (ok(this.x, nz)) this.z = nz;
        else { this.target = null; this.vel = 0; this.play('idle'); }
      }
    }
    const s = this.ship, t = THREE.MathUtils.clamp(this.x / s.Ls + 0.5, 0.05, 0.95);
    this.obj.position.set(this.x, s.floorY ? s.floorY(this.x, this.z) : s.deckY(t), this.z);
    this.obj.rotation.y = Math.PI / 2 - this.face;   // glTF characters face +Z
    this.mixer.update(dt);
    // Plant the feet on the planks, measured on the deformed boot soles (or foot bones as a fallback).
    this.obj.updateMatrixWorld(true);
    let minY = Infinity, target = 0.004;
    if (this.soles.length) {
      for (const [mesh, i] of this.soles) {
        this._v.fromBufferAttribute(mesh.geometry.attributes.position, i);
        mesh.applyBoneTransform(i, this._v);
        this._v.applyMatrix4(mesh.matrixWorld);
        this.obj.worldToLocal(this._v);
        if (this._v.y < minY) minY = this._v.y;
      }
    } else if (this.feet.length) {
      for (const b of this.feet) { b.getWorldPosition(this._v); this.obj.worldToLocal(this._v); minY = Math.min(minY, this._v.y); }
      target = 0.07;
    }
    // Any penetration is corrected in the same frame, before it is drawn; lifting settles gently.
    if (Number.isFinite(minY)) { const err = target - minY; this.model.position.y += err > 0 || !this._grounded ? err : err * 0.4; }
    this._grounded = true;
  }
  lookAt(x, z) { this.face = Math.atan2(z - this.z, x - this.x); }
}

export class CrewDirector {
  constructor(world, audio) {
    this.world = world;
    this.audio = audio;
    this.ready = false;
    this.src = {};          // key -> gltf
    this.shared = {};       // clip name -> AnimationClip
    this.buffers = {};
    this.crew = [];
    this.convo = null;
    this.nextConvo = 8;
    this.ship = null;
  }

  // Loads whatever crew, animation and ship files are present. Returns true if any pirates loaded.
  async load() {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const get = (p) => new Promise((res) => { const u = fileUrl(p); if (!u) return res(null); loader.load(u, res, undefined, () => res(null)); });
    const [chars, anims, ship] = await Promise.all([
      Promise.all(ROSTER.map((r) => get(`crew/${r.key}.glb`))),
      Promise.all(CLIPS.map((c) => get(`crew/anim-${c}.glb`))),
      get('ship/galleon.glb'),
    ]);
    chars.forEach((g, i) => { if (g) this.src[i] = g; });
    anims.forEach((g, i) => { if (g && g.animations[0]) this.shared[CLIPS[i]] = g.animations[0]; });
    this.shipGltf = ship;
    this.ready = Object.keys(this.src).length > 0;
    return this.ready;
  }

  // Five of the eight pirates crew each ship, drawn at random every battle.
  newBattle() { this.crewing = {}; }
  attach(ship, shipIndex) {
    for (const c of this.crew) c.obj.parent?.remove(c.obj);
    this.crew = [];
    this.ship = ship;
    this.convo = null;
    if (!this.ready) return;
    // A random five of the eight for this ship, fixed for the rest of the battle.
    this.crewing ||= {};
    if (!this.crewing[shipIndex]) {
      const ids = Object.keys(this.src).map(Number);
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
      this.crewing[shipIndex] = ids.slice(0, Math.min(5, ids.length));
    }
    const picks = this.crewing[shipIndex];
    picks.forEach((id, n) => {
      const c = new CrewMember(id, this.src[id], this.shared, ship);
      const p = this._spot(0.3 + 0.12 * n, n % 2 ? 1 : -1);
      c.x = p.x; c.z = p.z; c.face = Math.random() * 6;
      ship.root.add(c.obj);
      this.crew.push(c);
    });
  }
  // A free spot on the main deck (clear of the stairs, cargo and guns).
  _spot(t, side = Math.random() < 0.5 ? -1 : 1) {
    const s = this.ship;
    const x0 = s.xq !== undefined ? s.xq + s.stairRun + 0.9 : (0.3 - 0.5) * s.Ls, x1 = s.xBow !== undefined ? s.xBow - 1 : (0.8 - 0.5) * s.Ls;
    for (let tries = 0; tries < 16; tries++) {
      const x = t !== undefined && tries === 0 ? THREE.MathUtils.clamp((t - 0.5) * s.Ls, x0, x1) : x0 + Math.random() * (x1 - x0);
      const tt = x / s.Ls + 0.5, z = side * Math.random() * Math.max(0.3, s.halfWidth(tt) * 0.5);
      if (!s.walkable || s.walkable(x, z, x, z, 0.35)) return { x, z };
    }
    return { x: (x0 + x1) / 2, z: 0 };
  }

  // One silent beat of a conversation: the speaker gestures for a few seconds.
  _beat(who) {
    const speaker = this.crew.find((c) => c.id === who);
    return { who, dur: 2.2 + Math.random() * 2, speaker };
  }

  // A cannonball struck the ship we stand on: crew flinch, run to the fire and someone yells.
  onHit(localPoint) {
    if (!this.crew.length) return;
    this.convo = null;
    for (const c of this.crew) {
      const d = localPoint ? Math.hypot(c.x - localPoint.x, c.z - localPoint.z) : 99;
      if (d < 9 && c.actions.hit) { c.target = null; c.play('hit', 0.1); c.state = 'stagger'; c.timer = 1.1; }
      else { c.state = 'rush'; c.timer = 0.2 + Math.random() * 0.6; }
      c.fire = localPoint;
    }

  }
  onCheer() {
    if (!this.crew.length || this.convo) return;
    for (const c of this.crew) if (c.actions.open) { c.play('open'); c.state = 'idle'; c.timer = 2.5; }
  }

  update(dt, talkative) {
    // Nothing to animate while the crew are hidden (map views).
    if (!this.crew.length || !this.crew[0].obj.visible) return;
    if (!this.crew.length) return;
    const s = this.ship;
    // Conversations: gather the speakers, face each other, then speak line by line.
    this.nextConvo -= dt;
    if (!this.convo && talkative && this.nextConvo <= 0) this._startConvo();
    if (this.convo) this._runConvo(dt);
    for (const c of this.crew) {
      if (!this.convo || !this.convo.members.includes(c)) {
        c.timer -= dt;
        if (c.state === 'stagger' && c.timer <= 0) { c.state = 'rush'; c.timer = 0; }
        if (c.state === 'rush' && c.timer <= 0) {
          const f = c.fire && s.xq !== undefined && c.fire.x > s.xq + s.stairRun ? c.fire : this._spot();
          const tt = THREE.MathUtils.clamp(f.x / s.Ls + 0.5, 0.15, 0.9);
          c.walkTo(f.x + (Math.random() - 0.5) * 3, THREE.MathUtils.clamp(f.z + (Math.random() - 0.5) * 3, -s.halfWidth(tt) * 0.6, s.halfWidth(tt) * 0.6), true);
          c.state = 'fighting'; c.timer = 6 + Math.random() * 4;
        }
        if (c.state === 'fighting' && !c.target && c.timer <= 0) { c.state = 'idle'; c.timer = 2; c.fire = null; }
        if (c.state === 'idle' && !c.target && c.timer <= 0) {
          if (Math.random() < 0.6) { const p = this._spot(); c.walkTo(p.x, p.z); }
          c.timer = 4 + Math.random() * 7;
        }
      }
      c.update(dt);
    }
    // Solid bodies: nobody overlaps a shipmate or the player (who stands at world.walk).
    const w = this.world, bodies = [...this.crew];
    const player = w.mode === 'deck' && w.fleets[0][w.pov] === s ? { x: w.walk.x, z: w.walk.z, fixed: true } : null;
    if (player) bodies.push(player);
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j], dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz), min = 0.6;
        if (d >= min || d < 1e-4) continue;
        const push = (min - d) / 2, ux = dx / d, uz = dz / d;
        const move = (o, k) => { if (o.fixed) return; const nx = o.x + ux * k, nz = o.z + uz * k; if (!s.walkable || s.walkable(o.x, o.z, nx, nz, 0.2)) { o.x = nx; o.z = nz; } };
        move(a, a.fixed || b.fixed ? 0 : -push); move(b, a.fixed ? push * 2 : push);
        if (a.fixed || b.fixed) move(a, -push * 2);
      }
  }

  _startConvo() {
    const here = new Set(this.crew.map((c) => c.id));
    const options = CONVOS.filter((cv) => cv.every((id) => here.has(id)));
    this.nextConvo = 14 + Math.random() * 12;
    if (!options.length) return;
    const lines = options[Math.floor(Math.random() * options.length)];
    const members = [...new Set(lines)].map((id) => this.crew.find((c) => c.id === id));
    const centre = this._spot(0.35 + Math.random() * 0.35, 0);
    centre.z *= 0.3;
    members.forEach((c, k) => {
      const a = (k / members.length) * Math.PI * 2 + Math.random();
      c.walkTo(centre.x + Math.cos(a) * 0.9, centre.z + Math.sin(a) * 0.9);
      c.state = 'talking';
    });
    this.convo = { lines, members, centre, step: -1, wait: 8, gathering: true };
  }
  _runConvo(dt) {
    const cv = this.convo;
    cv.wait -= dt;
    if (cv.gathering) {
      if (cv.members.every((c) => !c.target) || cv.wait <= 0) {
        cv.gathering = false; cv.wait = 0.4;
        for (const c of cv.members) { c.target = null; c.lookAt(cv.centre.x, cv.centre.z); c.play('idle'); }
      }
      return;
    }
    if (cv.wait > 0) return;
    cv.step++;
    if (cv.step >= cv.lines.length) {
      for (const c of cv.members) { c.state = 'idle'; c.timer = 1 + Math.random() * 3; c.play('idle'); }
      this.convo = null;
      return;
    }
    const { speaker, dur } = this._beat(cv.lines[cv.step]);
    for (const c of cv.members) {
      if (c === speaker) c.play(c.info.temper === 'angry' ? 'angry' : Math.random() < 0.5 ? 'talk' : 'open', 0.3);
      else { c.play('idle', 0.4); c.lookAt(speaker.x, speaker.z); }
    }
    cv.wait = dur + 0.25;
  }

  // Replace a procedural hull with the generated galleon, fitted to the ship's length, and
  // measure its deck so crew and effects stand on the real planks.
  dressShip(ship) {
    if (!this.shipGltf || ship.dressed) return;
    const model = this.shipGltf.scene.clone(true);
    let box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
    if (size.z > size.x) { model.rotation.y = Math.PI / 2; model.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(model); size = box.getSize(new THREE.Vector3()); }
    const s = (ship.Ls * 1.1) / size.x;
    const wrap = new THREE.Group();
    wrap.add(model);
    wrap.scale.setScalar(s);
    const c = box.getCenter(new THREE.Vector3());
    model.position.set(-c.x, -box.min.y, -c.z);
    wrap.position.y = -2.6;                         // sit the keel below the waterline
    wrap.updateMatrixWorld(true);
    // Galleons are seen at a distance: no shadow casting (the costliest part of the shadow pass).
    model.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    // Deck height along the keel: the lowest upward-facing surface seen from above.
    const ray = new THREE.Raycaster(), deck = [];
    for (let i = 0; i <= 24; i++) {
      const x = (i / 24 - 0.5) * ship.Ls;
      ray.set(new THREE.Vector3(x, 400, 0), new THREE.Vector3(0, -1, 0));
      const hits = ray.intersectObject(wrap, true).filter((h) => h.face && h.face.normal.clone().transformDirection(h.object.matrixWorld).y > 0.6);
      deck.push(hits.length ? hits[hits.length - 1].point.y : null);
    }
    if (deck.filter((v) => v !== null).length < 8) return; // model didn't measure cleanly: keep the procedural ship
    for (let i = 0; i < deck.length; i++) if (deck[i] === null) deck[i] = deck[i - 1] ?? deck.find((v) => v !== null);
    // Keep both looks and switch between them: the generated galleon for ships seen from a
    // distance, the built deck (planks, rails, guns, rigging) for the one you walk around on.
    ship._procParts = [...ship.root.children].filter((ch) => !ch.userData.keep);
    ship._deckYProc = ship.deckY; ship._beamProc = ship.beam;
    ship._deckYModel = (t) => { const f = THREE.MathUtils.clamp(t, 0, 1) * 24, i = Math.min(23, Math.floor(f)); return THREE.MathUtils.lerp(deck[i], deck[i + 1], f - i) + 0.02; };
    ship._beamModel = size.z * s;
    ship._model = wrap;
    // Map view: cap the width at ~3/4 of a square so every ship shows slim sails.
    ship._mapScaleZ = Math.min(s, 12 / Math.max(size.z, 0.01));
    ship._fullScale = s;
    ship.root.add(wrap);
    ship.dressed = true;
    this.setDressed(ship, true);
  }
  setDressed(ship, on) {
    if (!ship._model) return;
    ship._model.visible = on;
    for (const ch of ship._procParts) ch.visible = !on;
    ship.deckY = on ? ship._deckYModel : ship._deckYProc;
    ship.beam = on ? ship._beamModel : ship._beamProc;
  }
}
