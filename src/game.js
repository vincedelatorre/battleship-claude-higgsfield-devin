// game.js - the game controller. It owns the match, reads input, drives the world's camera
// and effects, and plays each turn out as a timeline of "beats" (shot, impact, announcement,
// camera move). Results are resolved by the rules engine immediately but only revealed on the
// chart when the cannonball lands, so nothing is spoiled early.
import * as THREE from 'three';
import { Match, Mode, Mark, N, SHIPS, CAPTAINS, Gambit, SHIP_COUNT, coordName, cellOf, makeRng } from './rules.js';
import { AI } from './ai.js';
import { cellCenter, watersCenter } from './world.js';
import { projectedMap, flatMap, cellFromScreen, drawChart } from './overlay.js';
import * as ui from './ui.js';

const $ = ui.$;
const grid = (v) => Array.from({ length: N }, () => new Array(N).fill(v));

export class Game {
  constructor(world, audio) {
    this.world = world;
    this.audio = audio;
    this.screen = 'title';
    this.mode = Mode.Gambit;
    this.sel = 0;
    this.matchNo = 0;
    this.time = 0;
    this.beats = [];
    this.beat = null;
    this.log = [];
    this.scouts = [];
    this.aim = null; this.aimSide = 1;
    this.hover = null;
    this.broadsideSel = [];
    this.ghostShip = -1; this.ghostHoriz = true;
    this.dragShip = -1; this.dragHoriz = true;
    this.chartOpen = false;
    this.paused = false;
    this.hitstop = 0;
    this.lightning = 4;
    this.heart = 0;
    this.keys = {};
    this.mouse = { x: 0, y: 0, dx: 0, dy: 0 };
    this.rng = makeRng((Date.now() & 0xffff) + 1);
    this._demoMatch();
    this._bindUI();
    ui.probeArt(ui.artUrl('title', 'ui')).then((url) => { this.keyArt = url; if (url) $('#keyart').style.backgroundImage = `url("${url}")`; this._syncKeyArt(); });
    this._showScreen('title');
    world.onWaveCrash = (v) => this.audio.play('waveCrash', { vol: 0.8 * v, vary: 0.2 });
  }

  // A fleet at sea behind the title screen.
  _demoMatch() {
    const m = new Match();
    m.side[0].captain = this.sel; m.side[1].captain = (this.sel + 1) % 4;
    m.side[0].waters.randomize(this.rng); m.side[1].waters.randomize(this.rng);
    m.start(this.mode, 0);
    this.match = m;
    this.revealed = [grid(false), grid(false)];
    this.sunkShown = [[false, false, false, false, false], [false, false, false, false, false]];
    this.world.setupFleets(m);
    this.world.goTo('title', 0, 0);
  }

  // ---------------------------------------------------------------- layout
  layout(w, h) {
    this.w = w; this.h = h;
    const side = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side')) || 290;
    const top = 60, bottom = this.screen === 'battle' ? 92 : 30;
    const size = Math.max(260, Math.min(h - top - bottom - 62, w - 2 * (side + 18) - 90));
    this.world.setLayout({ cx: w / 2, cy: top + (h - top - bottom) / 2 + 8, size });
    // Side panels sit a short, fixed distance from the chart's frame instead of the screen edge.
    const frame = Math.max(18, (size / 10) * 0.42);
    const inset = Math.max(12, w / 2 - size / 2 - frame - 16 - side);
    document.documentElement.style.setProperty('--panel-inset', inset + 'px');
  }

  // ---------------------------------------------------------------- screens
  _syncKeyArt() {
    const on = !!this.keyArt && this.screen === 'title';
    const el = $('#keyart');
    if (on && !el.classList.contains('on')) this._artShownAt = performance.now();
    el.classList.toggle('on', on);
  }
  // The key art is opaque once its 1.4 s fade-in finishes: nothing behind it needs drawing.
  worldHidden() { return this.screen === 'title' && !!this.keyArt && performance.now() - (this._artShownAt || 0) > 1600; }

  _showScreen(s) {
    this.screen = s;
    this._syncKeyArt();
    for (const id of ['title', 'placement', 'battle', 'deck']) $('#' + id).classList.add('hidden');
    if (s === 'title') { $('#title').classList.remove('hidden'); ui.renderCards(this.sel, this.mode); }
    if (s === 'placement') $('#placement').classList.remove('hidden');
    if (s === 'battle' || s === 'over') $(this.world.mode === 'deck' ? '#deck' : '#battle').classList.remove('hidden');
    this.layout(innerWidth, innerHeight);
    this.refresh();
  }

  _bindUI() {
    // Captain cards respond on press (not release) and only move the highlight: instant feedback.
    document.body.addEventListener('pointerdown', (e) => {
      const cap = e.target.closest('[data-cap]')?.dataset.cap;
      if (cap === undefined || e.button > 0) return;
      this.audio.start();
      if (Number(cap) !== this.sel) { this.sel = Number(cap); ui.selectCard(this.sel); this.audio.play('click'); }
    });
    document.body.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const cap = e.detail === 0 ? e.target.closest('[data-cap]')?.dataset.cap : undefined;   // keyboard activation
      const mode = e.target.closest('[data-mode]')?.dataset.mode;
      this.audio.start();
      if (cap !== undefined) { this.sel = Number(cap); ui.selectCard(this.sel); this.audio.play('click'); }
      if (mode) { this.mode = mode; document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode))); ui.renderCards(this.sel, this.mode); this.audio.play('click'); }
      if (e.target.closest('#setsail')) this.startPlacement();
      const dock = e.target.closest('[data-dock]');
      if (dock) this._pickUp(Number(dock.dataset.dock));
      if (e.target.closest('#gambit')) this.useGambit();
      if (act) this._act(act);
    });
  }
  _act(act) {
    this.audio.play('click');
    switch (act) {
      case 'random': this.match.side[0].waters.randomize(this.rng); this.dragShip = -1; this.refresh(); break;
      case 'ready': this.startBattle(); break;
      case 'back': this.world.goTo('title', 0, 1.8); this._showScreen('title'); break;
      case 'board': this.toggleView(); break;
      case 'rematch': $('#over').classList.add('hidden'); this.startPlacement(true); break;
      case 'newcap': $('#over').classList.add('hidden'); this.world.goTo('title', 0, 2); this._demoMatch(); this._showScreen('title'); break;
      case 'resume': this.setPaused(false); break;
      case 'help': $('#pause').classList.add('hidden'); $('#help').classList.remove('hidden'); break;
      case 'closehelp': $('#help').classList.add('hidden'); if (this.paused) this.setPaused(false); break;
      case 'abandon': this.setPaused(false); this.beats = []; this.beat = null; this.world.goTo('title', 0, 2); this._demoMatch(); this._showScreen('title'); break;
    }
  }

  // ---------------------------------------------------------------- placement
  startPlacement(rematch = false) {
    this.audio.start();
    const m = new Match();
    m.side[0].captain = this.sel;
    if (!rematch) { const others = [0, 1, 2, 3].filter((c) => c !== this.sel); this.aiCap = others[Math.floor(this.rng() * 3)]; }
    m.side[1].captain = this.aiCap;
    if (rematch && this.match) { // keep the same deployment for a quick rematch
      const prev = this.match.side[0].waters.ships;
      m.side[0].waters.ships.forEach((s, i) => { s.pos = { ...prev[i].pos }; s.placed = prev[i].placed; });
    }
    this.match = m;
    this.revealed = [grid(false), grid(false)];
    this.sunkShown = [[false, false, false, false, false], [false, false, false, false, false]];
    this.shownUsed = [false, false];
    this.scouts = []; this.log = []; this.feed = [];
    this.dragShip = -1; this.aim = null;
    this.world.setupFleets(m);
    if (this.world.mode === 'deck') this.world.goTo('chart', 0, 1.2);
    else this.world.goTo('chart', 0, this.screen === 'title' ? 2.4 : 1.0);
    this.audio.play('bell', { vol: 0.6 });
    this._showScreen('placement');
  }
  clampFit(p, len) {
    const q = { ...p };
    if (q.horizontal) q.x = Math.min(q.x, N - len); else q.y = Math.min(q.y, N - len);
    q.x = Math.max(0, q.x); q.y = Math.max(0, q.y);
    return q;
  }
  dragPlacement() { return this.clampFit({ x: this.hover.x, y: this.hover.y, horizontal: this.dragHoriz }, SHIPS[this.dragShip].length); }
  _pickUp(i) {
    this.dragShip = this.dragShip === i ? -1 : i;
    const s = this.match.side[0].waters.ships[i];
    this.dragHoriz = s.placed ? s.pos.horizontal : true;
    this.audio.play('thud', { vol: 0.5 });
    this.refresh();
  }
  _placementClick(c) {
    const w = this.match.side[0].waters;
    if (this.dragShip >= 0) {
      const p = this.dragPlacement();
      if (w.canPlace(this.dragShip, p)) {
        w.ships[this.dragShip].pos = p; w.ships[this.dragShip].placed = true;
        this.audio.play('thud', { vol: 0.8 });
        this.audio.play('splash', { vol: 0.25, rate: 1.4 });
        const next = w.ships.findIndex((s) => !s.placed);
        this.dragShip = next;
        if (next >= 0) this.dragHoriz = true;
      } else ui.toast("That ship won't fit there.");
    } else {
      const i = w.shipAt(c.x, c.y);
      if (i >= 0) { this.dragShip = i; this.dragHoriz = w.ships[i].pos.horizontal; w.ships[i].placed = false; this.audio.play('thud', { vol: 0.5 }); }
    }
    this.refresh();
  }

  // ---------------------------------------------------------------- battle
  startBattle() {
    const m = this.match;
    if (!m.side[0].waters.fullyPlaced()) { ui.toast('Place all five ships first.'); return; }
    if (this.dragShip >= 0) this.dragShip = -1;
    m.side[1].waters.randomize(this.rng);
    const first = this.matchNo % 2 === 0 ? 0 : 1;
    this.matchNo++;
    m.start(this.mode, first);
    this.ai = new AI((Date.now() & 0xffffff) + 3);
    this.shownUsed = [false, false];
    this._showScreen('battle');
    this.audio.play('gong', { vol: 0.8 });
    this.addLog(first === 0 ? 'The battle begins. You have the first shot.' : 'The battle begins. The enemy fires first.');
    // The battle opens once the versus intro has finished (both captains' clips played through).
    this._versus(m, () => {
      ui.banner('Battle stations', first === 0 ? 'You have the first shot' : 'The enemy fires first', false, 1800);
      this.audio.play('bell', { vol: 0.5 });
      if (first === 0) { this.queue(0.2, () => this.pan(1, 1.2)); this.queue(1.3, () => {}, () => this.beginPlayerTurn()); }
      else { this.queue(1.8, () => {}, () => this.beginAITurn()); }
    });
  }

  // Captain versus captain intro while the fleets close in.
  _versus(m, done) {
    const v = $('#versus'), hex = (c) => '#' + c.toString(16).padStart(6, '0');
    const fill = (who, p) => {
      const c = CAPTAINS[m.side[p].captain];
      $(`#vs-${who}-img`).innerHTML = ui.portrait(m.side[p].captain);
      $(`#vs-${who}-img`).parentNode.style.setProperty('--cap', hex(c.color));
      $(`#vs-${who}-name`).textContent = c.name;
      $(`#vs-${who}-g`).textContent = m.mode === Mode.Gambit ? `Gambit: ${c.gambitName}` : c.motto;
    };
    fill('me', 0); fill('foe', 1);
    v.classList.remove('hidden', 'out');
    clearTimeout(this._vsTimer); clearTimeout(this._vsGuard);
    const vids = [...v.querySelectorAll('video.clip')];
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(this._vsTimer); clearTimeout(this._vsGuard);
      v.removeEventListener('pointerdown', finish);
      this._vsSkip = null;
      v.classList.add('out');
      setTimeout(() => v.classList.add('hidden'), 600);
      done?.();
    };
    // No clips (reduced motion, or none available): the short intro, and the battle starts straight away.
    if (!vids.length) { this._vsTimer = setTimeout(() => { v.classList.add('out'); setTimeout(() => v.classList.add('hidden'), 600); }, 2500); done?.(); return; }
    this._vsSkip = finish;
    v.addEventListener('pointerdown', finish);
    // Play each captain's clip once from the start; close after the longer one ends.
    let left = vids.length;
    const oneDone = () => { if (--left <= 0) setTimeout(finish, 350); };
    for (const vid of vids) {
      vid.loop = false;
      try { vid.currentTime = 0; } catch (_) { /* not loaded yet: it starts at 0 anyway */ }
      vid.play?.().catch(() => {});
      vid.addEventListener('ended', oneDone, { once: true });
      vid.addEventListener('error', oneDone, { once: true });
    }
    // Safety nets: fall back to the short intro if the clips can't start, and never exceed 11 s.
    this._vsGuard = setTimeout(() => { if (vids.every((x) => x.paused || x.readyState < 2)) finish(); }, 2500);
    this._vsTimer = setTimeout(finish, 11000);
  }

  beginPlayerTurn() {
    this.aim = 'fire'; this.aimSide = 1; this.broadsideSel = [];
    if (this.world.mode === 'chart' && this.world.chartSide !== 1) this.pan(1, 1.0);
    this.refresh();
  }
  beginAITurn() {
    this.aim = null;
    this.refresh();
    if (this.world.mode === 'chart') this.pan(0, 1.0);
    this.queue(1.1, () => {}, () => this._aiAct());
  }

  pan(side, dur) { if (this.world.mode === 'chart') this.world.goTo('chart', side, dur); }

  // Timeline -----------------------------------------------------------
  queue(dur, start = () => {}, end = () => {}) { this.beats.push({ dur, start, end, t: 0 }); }
  busy() { return !!this.beat || this.beats.length > 0; }
  _runBeats(dt) {
    let guard = 0;
    while (guard++ < 20) {
      if (!this.beat) {
        if (!this.beats.length) return;
        this.beat = this.beats.shift();
        this.beat.start();
      }
      this.beat.t += dt;
      if (this.beat.t < this.beat.dur) return;
      const b = this.beat;
      this.beat = null;
      b.end();
      dt = 0;
    }
  }

  // Queue a cannon shot from `shooter` at cell c, revealing `res` on impact.
  _queueShot(shooter, c, res, { flight = 1.25, stagger = 0, silent = false, after = 0.55, big = 1 } = {}) {
    const side = 1 - shooter, w = this.world;
    const target = cellCenter(side, c);
    this.queue(stagger, () => {
      target.y = w.ocean.heightAt(target.x, target.z);
      let from;
      if (shooter === 0) { const g = w.myGunFor(target); from = g.pos; w.muzzleFlash(from, g.dir); }
      else { from = w.enemyGun(); w.muzzleFlash(from, target.clone().sub(from).setY(0).normalize()); }
      const deck = w.mode === 'deck';
      if (!silent) {
        this.audio.play('cannon', { vol: shooter === 0 ? (deck ? 1 : 0.7) : (deck ? 0.45 : 0.35), vary: 0.15, rate: shooter === 0 ? 1 : 0.85 });
        this.audio.play('whistle', { vol: shooter === 1 ? 0.5 : 0.25, delay: flight * 0.35, rate: 0.9 + this.rng() * 0.2 });
      }
      w.fireBall(from, target, flight);
      if (shooter === 0 && deck) w.shake = Math.min(1.2, w.shake + 0.35);
    });
    this.queue(flight, () => {}, () => this._impact(shooter, c, res, big));
    if (after > 0) this.queue(after);
  }

  _impact(shooter, c, res, big = 1) {
    const side = 1 - shooter, w = this.world, m = this.match;
    this.revealed[side][c.y][c.x] = true;
    const at = cellCenter(side, c);
    at.y = w.ocean.heightAt(at.x, at.z);
    const near = w.mode === 'deck' ? (side === 0 ? 1 : 0.35) : (w.chartSide === side ? 1 : 0.4);
    const who = shooter === 0 ? 'You fire' : 'The enemy fires';
    if (!res.hit) {
      w.splash(at, big);
      this.audio.play('splash', { vol: 0.8 * near, vary: 0.2 });
      this.addLog(`${who} at ${coordName(c)}: a miss.`);
      return;
    }
    const ship = SHIPS[res.ship].name;
    if (side === 0) {
      const segIdx = m.side[0].waters.ships[res.ship].segmentAt(c.x, c.y);
      const p = segIdx >= 0 ? w.segmentPoint(0, res.ship, segIdx) : at;
      w.explosion(p, 1.2 * big);
      if (segIdx >= 0) w.addFireOnShip(0, res.ship, segIdx);
      // The crew of the ship you're aboard react; others still shout across the water.
      const cd = w.crewDirector;
      if (cd?.ready) {
        const sm = w.fleets[0][res.ship];
        if (res.ship === w.pov) cd.onHit({ x: ((segIdx + 0.5) / sm.len - 0.5) * sm.Ls, z: 0 });
        else if (Math.random() < 0.5) cd.onHit(null);
      }
      this.addLog(`Your ${ship} is hit at ${coordName(c)}!`, 'hit');
      const me = $('#bt-me');
      me.classList.remove('shake', 'hurt'); void me.offsetWidth; me.classList.add('shake', 'hurt');
    } else {
      w.explosion(at.clone().setY(at.y + 1.5), 1.1 * big);
      w.addFireOnWater(at);
      this.addLog(`You hit their ${ship} at ${coordName(c)}!`, 'hit');
    }
    this.audio.play('explosion', { vol: near, vary: 0.2 });
    this.hitstop = Math.max(this.hitstop, 0.08);
    w.shake = Math.min(1.6, w.shake + (side === 0 && w.mode === 'deck' ? 0.9 : 0.55) * big);
    if (res.sunk) this._sink(side, res.ship);
    this.refresh();
  }

  _sink(side, i) {
    const w = this.world, m = this.match;
    this.sunkShown[side][i] = true;
    const sm = w.fleets[side][i];
    const s = m.side[side].waters.ships[i];
    if (side === 1) {
      sm.revealed = true; sm.wreckPos = { ...s.pos };
      // The burning flotsam in its squares becomes the burning wreck itself.
      w.fires = w.fires.filter((f) => !f.pos || s.segmentAt(Math.floor(f.pos.x / 16), Math.floor((f.pos.z + 420) / 16)) < 0);
    }
    for (let k = 0; k < s.length; k++) w.addFireOnShip(side, i, k);
    sm.setCharred(true);
    sm.sinking = true;
    const c = w.placementPose(side, s.pos, s.length).center;
    c.y = 2;
    w.explosion(c, 2.2);
    this.audio.play('bigExplosion', { vol: 1 });
    this.audio.play('creak', { vol: 0.6, delay: 0.8 });
    this.hitstop = 0.16;
    w.shake = Math.min(2, w.shake + 1.2);
    this.addLog(side === 1 ? `You sank their ${SHIPS[i].name}!` : `Your ${SHIPS[i].name} has been sunk!`, 'sunk');
    if (side === 1) w.crewDirector?.onCheer();
    this.queue(0.1, () => ui.banner(side === 1 ? `${SHIPS[i].name} sunk!` : `Your ${SHIPS[i].name} is lost`, side === 1 ? 'Down she goes' : 'Man the boats', false, 1500));
    this.queue(1.2);
    if (side === 0 && w.pov === i) {
      const next = m.side[0].waters.ships.findIndex((q) => !q.isSunk());
      if (next >= 0) this.queue(0.1, () => { w.selectShip(next); if (w.mode === 'deck') w.goTo('deck', 0, 1.2); ui.toast(`You cross to the ${SHIPS[next].name}.`); });
    }
  }

  // Player actions -------------------------------------------------------
  playerFire(c) {
    const m = this.match;
    const why = {};
    if (this.busy() || !m.canFire(0, c, why)) { if (why.msg && !this.busy()) ui.toast(why.msg); return; }
    this.aim = null;
    const r = m.fire(0, c);
    this._queueShot(0, c, r, { after: 1.1 });
    this._afterAction(0);
  }

  useGambit() {
    if (this.screen !== 'battle') return;
    const m = this.match, why = {};
    if (this.aim && this.aim !== 'fire') { this.cancelAim(); return; }
    if (this.busy() || !m.gambitReady(0, why)) { if (why.msg) ui.toast(why.msg); return; }
    this.audio.play('chime', { vol: 0.5 });
    const g = m.gambitOf(0);
    this.broadsideSel = [];
    if (g === Gambit.Broadside) { this.aim = 'broadside'; this.aimSide = 1; ui.toast('Broadside: choose 3 untried squares.'); }
    if (g === Gambit.PowderKeg) { this.aim = 'powderKeg'; this.aimSide = 1; ui.toast('Powder Keg: choose the centre of the blast, on open water.'); }
    if (g === Gambit.CrowsNest) { this.aim = 'crowsNest'; this.aimSide = 1; ui.toast("Crow's Nest: choose the centre of a 3 by 3 area to scout."); }
    if (g === Gambit.GhostShip) { this.aim = 'ghostPick'; this.aimSide = 0; this.pan(0, 0.9); ui.toast('Ghost Ship: choose one of your ships.'); }
    if (this.world.mode === 'deck') this.setChartOpen(true);
    this.refresh();
  }
  cancelAim() {
    if (!this.aim || this.aim === 'fire') return false;
    const wasGhost = this.aim.startsWith('ghost');
    this.aim = 'fire'; this.aimSide = 1; this.broadsideSel = []; this.ghostShip = -1;
    if (wasGhost) this.pan(1, 0.9);
    this.refresh();
    return true;
  }

  _aimClick(c, side) {
    const m = this.match, why = {};
    switch (this.aim) {
      case 'fire': if (side === 1) this.playerFire(c); break;
      case 'broadside': {
        if (side !== 1) return;
        const k = this.broadsideSel.findIndex((q) => q.x === c.x && q.y === c.y);
        if (k >= 0) { this.broadsideSel.splice(k, 1); break; }
        if (m.target(0).tried(c.x, c.y)) { ui.toast('All 3 squares must be untried.'); return; }
        this.broadsideSel.push(c);
        this.audio.play('click');
        if (this.broadsideSel.length === 3) {
          const t = this.broadsideSel;
          if (!m.canBroadside(0, t, why)) { ui.toast(why.msg); return; }
          this.aim = null;
          const res = m.broadside(0, t);
          this.broadsideSel = [];
          this.shownUsed[0] = true;
          this.addLog('Broadside! Three guns speak at once.', 'gambit');
          ui.banner('Broadside!', CAPTAINS[m.side[0].captain].name, true, 1100);
          res.forEach((r, i) => this._queueShot(0, t[i], r, { stagger: i === 0 ? 0.5 : 0.28, after: i === res.length - 1 ? 0.6 : 0, flight: 1.1 }));
          this._afterAction(0);
        }
        break;
      }
      case 'powderKeg': {
        if (side !== 1) return;
        if (!m.canPowderKeg(0, c, why)) { ui.toast(why.msg); return; }
        this.aim = null;
        const area = Match.blastArea(c);
        const res = m.powderKeg(0, c);
        this.shownUsed[0] = true;
        this.addLog(`Powder Keg! The blast lands on ${coordName(c)}.`, 'gambit');
        ui.banner('Powder Keg!', CAPTAINS[m.side[0].captain].name, true, 1100);
        this._queueShot(0, c, res[0], { stagger: 0.5, after: 0, flight: 1.4, big: 1.6 });
        this.queue(0.01, () => res.slice(1).forEach((r, i) => this._impact(0, area[i + 1], r)));
        this.queue(0.9);
        this._afterAction(0);
        break;
      }
      case 'crowsNest': {
        if (side !== 1) return;
        if (!m.canCrowsNest(0, c, why)) { ui.toast(why.msg); return; }
        const n = m.crowsNest(0, c);
        this.shownUsed[0] = true;
        this.aim = null;
        this.audio.play('bell', { vol: 0.5 });
        this.queue(0.9, () => { ui.banner("Crow's Nest", 'The lookout scans the swell…', true, 900); }, () => {
          this.scouts.push({ c, count: n, mine: true });
          this.addLog(`Crow's Nest: ${n} ship ${n === 1 ? 'square' : 'squares'} around ${coordName(c)}.`, 'gambit');
          ui.banner(`${n} ${n === 1 ? 'square' : 'squares'} spotted`, 'Now take your shot', true, 1400);
          this.audio.play('chime', { vol: 0.6 });
          this.aim = 'fire';
          this.refresh();
        });
        this.refresh();
        break;
      }
      case 'ghostPick': {
        if (side !== 0) return;
        const i = m.side[0].waters.shipAt(c.x, c.y);
        if (i < 0) return;
        if (m.side[0].waters.ships[i].isSunk()) { ui.toast("A sunk ship can't sail."); return; }
        this.ghostShip = i; this.ghostHoriz = m.side[0].waters.ships[i].pos.horizontal;
        this.aim = 'ghostPlace';
        ui.toast(`Choose new water for your ${SHIPS[i].name}. R turns it.`);
        break;
      }
      case 'ghostPlace': {
        if (side !== 0) return;
        const to = this.clampFit({ x: c.x, y: c.y, horizontal: this.ghostHoriz }, SHIPS[this.ghostShip].length);
        if (!m.canGhostShip(0, this.ghostShip, to, why)) { ui.toast(why.msg); return; }
        const i = this.ghostShip;
        this.aim = null; this.ghostShip = -1;
        this._ghostFx(0, i, () => m.ghostShip(0, i, to));
        this.ai.onOpponentGhostShip();
        this.shownUsed[0] = true;
        this.addLog(`Ghost Ship! Your ${SHIPS[i].name} slips away and patches a hole.`, 'gambit');
        this._afterAction(0);
        break;
      }
    }
    this.refresh();
  }

  // Fog swallows the ship, it reappears elsewhere, and old hits on it go stale.
  _ghostFx(side, i, apply) {
    const w = this.world;
    this.queue(1.2, () => {
      ui.banner('Ghost Ship!', side === 0 ? 'Your ship vanishes into the fog' : 'An enemy ship vanishes into the fog', true, 1300);
      this.audio.play('ghost', { vol: 0.8 });
      if (side === 0) {
        const p = w.placementPose(0, this.match.side[0].waters.ships[i].pos, SHIPS[i].length).center;
        for (let k = 0; k < 160; k++) w.alphaParts.emit({ p: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 50, Math.random() * 12, (Math.random() - 0.5) * 50)), v: new THREE.Vector3(Math.random() - 0.5, 1, Math.random() - 0.5), life: 2.5, max: 2.5, s: 8, grow: 6, c0: [0.5, 0.55, 0.6, 0.5], c1: [0.4, 0.45, 0.5, 0] });
      }
    }, () => {
      apply();
      if (side === 0) {
        w.clearShipFires(0, i);
        const s = this.match.side[0].waters.ships[i];
        for (let k = 0; k < s.length; k++) if (s.damaged[k]) w.addFireOnShip(0, i, k);
        const p = w.placementPose(0, s.pos, s.length).center;
        for (let k = 0; k < 120; k++) w.alphaParts.emit({ p: p.clone().add(new THREE.Vector3((Math.random() - 0.5) * 50, Math.random() * 12, (Math.random() - 0.5) * 50)), v: new THREE.Vector3(Math.random() - 0.5, 0.6, Math.random() - 0.5), life: 2.2, max: 2.2, s: 8, grow: 5, c0: [0.5, 0.55, 0.6, 0.45], c1: [0.4, 0.45, 0.5, 0] });
      }
      this.refresh();
    });
    this.queue(0.7);
  }

  // After an action: end of game or hand the turn over.
  _afterAction(p) {
    this.queue(0.01, () => {}, () => {
      const m = this.match;
      if (m.gameOver()) { this._finish(); return; }
      if (p === 0) this.beginAITurn(); else this.beginPlayerTurn();
    });
    this.refresh();
  }

  _aiAct() {
    const m = this.match, ai = this.ai;
    if (m.gameOver() || m.current !== 1) return;
    let a = ai.decide(m, 1);
    const capName = CAPTAINS[m.side[1].captain].name;
    const gambitBanner = (t) => { ui.banner(t, capName, true, 1200); this.shownUsed[1] = true; this.audio.play('chime', { vol: 0.5 }); };
    if (a.kind === 'crowsNest' && m.canCrowsNest(1, a.target)) {
      const n = m.crowsNest(1, a.target);
      ai.onCrowsNest(a.target, n);
      this.queue(1.3, () => { gambitBanner("Enemy Crow's Nest"); this.scouts.push({ c: a.target, count: n, mine: false }); this.addLog(`The enemy lookout scouts around ${coordName(a.target)}.`, 'gambit'); this.refresh(); });
      a = ai.decide(m, 1);
    }
    if (a.kind === 'broadside' && m.canBroadside(1, a.targets)) {
      const res = m.broadside(1, a.targets);
      this.queue(1.0, () => { gambitBanner('Enemy Broadside!'); this.addLog('The enemy looses a broadside!', 'gambit'); });
      res.forEach((r, i) => this._queueShot(1, a.targets[i], r, { stagger: i === 0 ? 0 : 0.3, after: i === res.length - 1 ? 0.6 : 0, flight: 1.2 }));
    } else if (a.kind === 'powderKeg' && m.canPowderKeg(1, a.target)) {
      const area = Match.blastArea(a.target);
      const res = m.powderKeg(1, a.target);
      this.queue(1.0, () => { gambitBanner('Enemy Powder Keg!'); this.addLog(`The enemy's powder keg lands on ${coordName(a.target)}!`, 'gambit'); });
      this._queueShot(1, a.target, res[0], { after: 0, flight: 1.4, big: 1.6 });
      this.queue(0.01, () => res.slice(1).forEach((r, i) => this._impact(1, area[i + 1], r)));
      this.queue(0.9);
    } else if (a.kind === 'ghostShip' && m.canGhostShip(1, a.ship, a.to)) {
      this._ghostFx(1, a.ship, () => m.ghostShip(1, a.ship, a.to));
      this.shownUsed[1] = true;
      this.addLog('Ghost Ship! An enemy ship slips away into the fog. Your old hits on it are stale.', 'gambit');
    } else {
      let c = a.kind === 'fire' ? a.target : null;
      if (!m.canFire(1, c)) outer: for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (m.canFire(1, { x, y })) { c = { x, y }; break outer; }
      const r = m.fire(1, c);
      this._queueShot(1, c, r);
    }
    this._afterAction(1);
  }

  _finish() {
    const m = this.match, won = m.winner === 0, w = this.world;
    this.aim = null;
    this.screen = 'over';
    // Reveal the enemy fleet that survived.
    m.side[1].waters.ships.forEach((s, i) => { const sm = w.fleets[1][i]; if (!sm.revealed) { sm.revealed = true; sm.wreckPos = { ...s.pos }; } });
    this.audio.play(won ? 'victory' : 'defeat', { vol: 0.8 });
    ui.banner(won ? 'Victory' : 'Defeat', won ? 'The enemy fleet rests on the seabed' : 'Your fleet is lost to the deep', false, 2600);
    this.queue(2.6, () => { if (w.mode === 'chart') this.pan(1, 1.5); }, () => {
      const winCap = m.side[won ? 0 : 1].captain;
      $('#over-img').innerHTML = ui.portrait(winCap);
      $('#over-img').style.setProperty('--cap', '#' + CAPTAINS[winCap].color.toString(16).padStart(6, '0'));
      $('#over-t').textContent = won ? 'Victory!' : 'Defeat';
      $('#over-t').className = won ? 'win' : 'lose';
      $('#over-s').textContent = won ? `${CAPTAINS[m.side[0].captain].name} rules the storm.` : `${CAPTAINS[m.side[1].captain].name} takes the day.`;
      const stat = (p) => { const s = m.side[p]; return `Shots fired: ${s.shots}<br>Hits: ${s.hits} (${s.shots ? Math.round((100 * s.hits) / s.shots) : 0}%)<br>Ships afloat: ${m.side[p].waters.shipsAfloat()} of 5${m.mode === Mode.Gambit ? `<br>Gambit: ${s.gambitUsed ? 'used' : 'unused'}` : ''}`; };
      $('#over-stats').innerHTML = `<div><h3>You</h3><p>${stat(0)}</p></div><div><h3>${CAPTAINS[m.side[1].captain].name}</h3><p>${stat(1)}</p></div>`;
      $('#over').classList.remove('hidden');
      $('#over [data-act="rematch"]').focus();
    });
    this.refresh();
  }

  // ---------------------------------------------------------------- views
  toggleView() {
    if (this.screen !== 'battle' && this.screen !== 'over') return;
    const w = this.world;
    if (w.trans) return;
    if (w.mode === 'deck') {
      document.exitPointerLock?.();
      this.setChartOpen(false);
      const side = this.aim && this.aim.startsWith('ghost') ? 0 : this.match.current === 0 ? 1 : 0;
      w.goTo('chart', side, 2.0);
      this.audio.play('creak', { vol: 0.4 });
    } else {
      if (this.match.side[0].waters.ships[w.pov].isSunk()) w.selectShip(this.match.side[0].waters.ships.findIndex((s) => !s.isSunk()));
      w.goTo('deck', 0, 2.0);
      this.audio.play('creak', { vol: 0.5 });
    }
    this._showScreen(this.screen);
  }
  setChartOpen(open) {
    this.chartOpen = open;
    $('#seachart').classList.toggle('hidden', !open);
    if (open) document.exitPointerLock?.();
  }
  setPaused(p) {
    this.paused = p;
    $('#pause').classList.toggle('hidden', !p);
    if (p) { document.exitPointerLock?.(); $('#pause [data-act="resume"]').focus(); }
  }

  addLog(text, cls = '') {
    this.log.push({ text, cls });
    this.feed = [text, ...(this.feed || [])].slice(0, 3);
    this.refresh();
  }

  // ---------------------------------------------------------------- input
  onKey(e, down) {
    const k = e.key;
    this.keys[k.toLowerCase()] = down;
    if (!down) return;
    if (this._vsSkip) { e.preventDefault(); this._vsSkip(); return; }   // any key skips the versus intro
    this.audio.start();
    if (k === 'Tab') { e.preventDefault(); this.toggleView(); return; }
    if (k === 'F1') { e.preventDefault(); $('#help').classList.remove('hidden'); return; }
    if (k === 'Escape') {
      if (!$('#help').classList.contains('hidden')) { $('#help').classList.add('hidden'); return; }
      if (this.cancelAim()) return;
      if (this.chartOpen) { this.setChartOpen(false); return; }
      if (this.screen === 'placement' && this.dragShip >= 0) { this.dragShip = -1; this.refresh(); return; }
      if (this.screen === 'battle') this.setPaused(!this.paused);
      return;
    }
    const lk = k.toLowerCase();
    if (lk === 'm') { this.audio.setMuted(!this.audio.muted); ui.toast(this.audio.muted ? 'Sound off' : 'Sound on'); }
    if (lk === 'k') { this.world.comfort = !this.world.comfort; ui.toast(this.world.comfort ? 'Comfort mode on: less shake, steady horizon' : 'Comfort mode off'); }
    if (lk === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); }
    if (this.screen === 'title') {
      if (k === 'ArrowRight' || k === 'ArrowLeft') { this.sel = (this.sel + (k === 'ArrowRight' ? 1 : 3)) % 4; ui.selectCard(this.sel); this.audio.play('click'); }
      if (k === 'Enter') this.startPlacement();
    }
    if (this.screen === 'placement') {
      if (lk === 'r') this._rotateHeld();
      if (k === 'Enter') this.startBattle();
    }
    if (this.screen === 'battle') {
      if (lk === 'g') this.useGambit();
      if (lk === 'r' && this.aim === 'ghostPlace') this.ghostHoriz = !this.ghostHoriz;
      if (lk === 'q' && this.world.mode === 'deck') this.setChartOpen(!this.chartOpen);
      if (this.world.mode === 'deck' && k >= '1' && k <= '5') {
        const i = Number(k) - 1;
        if (i !== this.world.pov && this.world.selectShip(i)) { this.world.goTo('deck', 0, 1.1); this.refresh(); }
        else if (this.match.side[0].waters.ships[i].isSunk()) ui.toast(`Your ${SHIPS[i].name} lies on the seabed.`);
      }
    }
  }
  _rotateHeld() {
    if (this.dragShip >= 0) { this.dragHoriz = !this.dragHoriz; this.audio.play('click'); }
  }

  onMouseMove(e) {
    this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    // Pointer lock when the browser allows it; otherwise drag with the mouse held down to look.
    if (document.pointerLockElement || this.dragLook) { this.mouse.dx += e.movementX; this.mouse.dy += e.movementY; }
  }
  onMouseDown(e) {
    this.audio.start();
    if (e.target.closest && e.target.closest('.panel, .btn, button')) {
      if (e.target.id === 'seacanvas' && e.button === 0) this._seaChartClick(e);
      else if (e.target.id === 'seacanvas' && e.button === 2) this.cancelAim();
      return;
    }
    if (e.target.id !== 'gl' && e.target.id !== 'overlay' && !e.target.classList?.contains('layer')) return;
    if (e.button === 2) {
      if (this.screen === 'placement') this._rotateHeld();
      else if (this.aim === 'ghostPlace') this.ghostHoriz = !this.ghostHoriz;
      else this.cancelAim();
      return;
    }
    if (this.world.mode === 'deck' && (this.screen === 'battle' || this.screen === 'over')) {
      if (!document.pointerLockElement && !this.paused) { try { this.world.canvas.requestPointerLock?.()?.catch?.(() => {}); } catch (_) { /* blocked in some embeds */ } this.dragLook = true; }
      return;
    }
    if (!this.world.inChartView()) return;
    const c = this._hoverCell();
    if (!c) return;
    if (this.screen === 'placement') this._placementClick(c.cell);
    else if (this.screen === 'battle' && this.match.current === 0 && !this.busy() && this.aim) this._aimClick(c.cell, c.side);
  }
  _seaChartClick(e) {
    if (this.screen !== 'battle' || this.match.current !== 0 || this.busy() || !this.aim) return;
    const cv = $('#seacanvas'), r = cv.getBoundingClientRect();
    const side = this.aimSide;
    const cell = cellFromScreen(this._seaMap(r), e.clientX - r.left, e.clientY - r.top);
    if (cell) this._aimClick(cell, side);
  }
  _seaMap(r) { const pad = r.width * 0.07; return flatMap({ x: pad, y: pad, size: r.width - pad * 2 }); }

  _hoverCell() {
    const w = this.world;
    const p = w.pick(this.mouse.x, this.mouse.y);
    if (!p) return null;
    const side = w.chartSide;
    const x = Math.floor(p.x / 16), y = Math.floor((p.z - (side === 0 ? 0 : -420)) / 16);
    if (x < 0 || y < 0 || x >= N || y >= N) return null;
    return { cell: { x, y }, side };
  }

  // ---------------------------------------------------------------- DOM refresh
  refresh() {
    const m = this.match;
    if (!m) return;
    const modeName = m.mode === Mode.Gambit || this.mode === Mode.Gambit ? 'Gambit rules' : 'Standard rules';
    if (this.screen === 'placement') {
      $('#pl-mode').textContent = this.mode === Mode.Gambit ? 'Gambit rules' : 'Standard rules';
      ui.capMini($('#pl-cap'), m.side[0].captain, this.mode === Mode.Gambit ? `Gambit: ${CAPTAINS[m.side[0].captain].gambitName}` : '', 'ready');
      const opp = CAPTAINS[m.side[1].captain];
      $('#pl-opp').innerHTML = `<b style="font-family:var(--display);font-weight:normal;font-size:18px">${opp.name}</b><div style="font-size:14px;color:var(--sail-dim)">${this.mode === Mode.Gambit ? `Gambit: ${opp.gambitName}. ${opp.gambitDesc}` : opp.motto}</div>`;
      const w = m.side[0].waters, col = '#' + CAPTAINS[m.side[0].captain].color.toString(16).padStart(6, '0');
      $('#dock').innerHTML = SHIPS.map((s, i) => `<button class="dock-item ${w.ships[i].placed ? 'placed' : ''} ${this.dragShip === i ? 'held' : ''}" data-dock="${i}" style="--cap:${col}">
        <div><b>${s.name}</b><span>${this.dragShip === i ? 'In hand: click a square' : w.ships[i].placed ? 'At sea' : 'In the dock'}</span></div>
        <div class="len">${'<i></i>'.repeat(s.length)}</div></button>`).join('');
      $('#ready').disabled = !w.fullyPlaced();
    }
    if (this.screen === 'battle' || this.screen === 'over') {
      $('#bt-mode').textContent = modeName;
      const mine = m.current === 0 && !m.gameOver();
      const turnText = m.gameOver() ? (m.winner === 0 ? 'Victory' : 'Defeat') : mine ? (this.aim && this.aim !== 'fire' ? 'Aim your Gambit' : 'Your turn: fire at will') : "The enemy's turn";
      for (const id of ['#bt-turn', '#dk-turn']) { $(id).textContent = turnText; $(id).className = 'turn ' + (mine ? 'mine' : 'enemy'); }
      const gl = (p) => {
        if (m.mode !== Mode.Gambit) return ['', ''];
        const used = p === 0 ? m.side[0].gambitUsed : this.shownUsed[1];
        const name = CAPTAINS[m.side[p].captain].gambitName;
        return used ? [`${name}: spent`, 'spent'] : [`${name}: ready`, 'ready'];
      };
      const [s0, c0] = gl(0), [s1, c1] = gl(1);
      if (!$('#bt-me').dataset.cap || Number($('#bt-me').dataset.cap) !== m.side[0].captain) { ui.capMini($('#bt-me'), m.side[0].captain, s0, c0); $('#bt-me').dataset.cap = m.side[0].captain; }
      else ui.setCapStatus($('#bt-me'), s0, c0);
      if (!$('#bt-foe').dataset.cap || Number($('#bt-foe').dataset.cap) !== m.side[1].captain) { ui.capMini($('#bt-foe'), m.side[1].captain, s1, c1); $('#bt-foe').dataset.cap = m.side[1].captain; }
      else ui.setCapStatus($('#bt-foe'), s1, c1);
      const hitsShown = (side) => m.side[side].waters.ships.map((s, i) => { let n = 0; for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const q = m.side[side].waters.shots[y][x]; if (this.revealed[side][y][x] && q.mark === Mark.Hit && q.ship === i && !q.stale) n++; } return this.sunkShown[side][i] ? s.length : Math.min(n, s.length); });
      ui.fleetList($('#bt-fleet'), m.side[1].waters, hitsShown(1), this.sunkShown[1]);
      ui.renderLog($('#bt-log'), this.log);
      const me = m.side[0], acc = me.shots ? Math.round((100 * me.hits) / me.shots) : 0;
      const afloat = 5 - this.sunkShown[0].filter(Boolean).length, foe = 5 - this.sunkShown[1].filter(Boolean).length;
      $('#bt-stats').innerHTML = `Shots ${me.shots}, hits ${me.hits} (${acc}%)<br>Your ships afloat: ${afloat} of 5<br>Enemy ships afloat: ${foe} of 5`;
      const gb = $('#gambit');
      const cap = CAPTAINS[me.captain];
      gb.style.setProperty('--cap', '#' + cap.color.toString(16).padStart(6, '0'));
      if (m.mode !== Mode.Gambit) { gb.className = 'panel gambit-bar std'; gb.innerHTML = '<span>Standard rules: one shot per turn, no Gambits.</span>'; }
      else {
        let state = me.gambitUsed ? 'spent' : this.aim && this.aim !== 'fire' ? 'aiming' : 'ready';
        const sub = state === 'spent' ? 'Spent for this battle' : state === 'aiming' ? 'Aiming. Right-click or Esc to cancel.' : mine ? 'Ready. Press G or click to use it.' : 'Ready on your turn';
        gb.className = `panel gambit-bar ${state === 'ready' && !mine ? '' : state}`;
        gb.innerHTML = `<div class="ico" style="color:var(--cap)">${ui.gambitIcon(cap.gambit)}</div><div><b>${cap.gambitName}</b><span>${sub}</span></div><kbd>G</kbd>`;
      }
      const pov = this.world.pov;
      $('#dk-ship').textContent = `Aboard the ${SHIPS[pov].name}`;
      const dmg = me.waters.ships[pov].damageCount();
      $('#dk-sub').textContent = dmg ? `${dmg} of ${SHIPS[pov].length} sections holed` : 'Sound and seaworthy';
      $('#dk-feed').innerHTML = (this.feed || []).map((f) => `<li>${f}</li>`).join('');
    }
  }

  // ---------------------------------------------------------------- frame
  update(dt) {
    this.time += dt;
    const w = this.world;
    if (!this.paused) {
      this._runBeats(dt);
      // Lightning and thunder.
      this.lightning -= dt;
      if (this.lightning <= 0) {
        this.lightning = 7 + this.rng() * 10;
        const cam = w.camera.position;
        const sd = w.ocean.uniforms.uSunDir.value;
        const a = Math.atan2(-sd.z, -sd.x) + (this.rng() - 0.5) * 2.2, d = 1200 + this.rng() * 1600;
        const at = new THREE.Vector3(cam.x + Math.cos(a) * d, 0, cam.z + Math.sin(a) * d);
        if (w.mode !== 'title' || this.rng() < 0.7) w.sky.strike(at, this.rng);
        this.audio.play('thunder', { vol: 0.6 + 0.4 * (1 - (d - 1200) / 1600), delay: 0.3 + d / 2400, rate: 0.9 + this.rng() * 0.2 });
      }
      // Heartbeat when the battle hangs by a thread.
      if (this.screen === 'battle' && this.match.mode) {
        const mineLeft = 5 - this.sunkShown[0].filter(Boolean).length, foeLeft = 5 - this.sunkShown[1].filter(Boolean).length;
        if (mineLeft === 1 || foeLeft === 1) { this.heart -= dt; if (this.heart <= 0) { this.heart = 1.25; this.audio.play('heartbeat', { vol: 0.5 }); } }
      }
    }
    // Ambience depends on where you stand.
    if (this.audio.ctx) {
      const deck = w.mode === 'deck';
      this.audio.loop('rain', deck ? 0.32 : 0.16);
      this.audio.loop('wind', deck ? 0.3 : 0.2);
      this.audio.loop('sea', deck ? 0.4 : 0.22);
    }
    // Hover cell in the chart view.
    if (w.inChartView() && (this.screen === 'placement' || this.screen === 'battle')) {
      const h = this._hoverCell();
      this.hover = h && (this.screen === 'placement' ? h.side === 0 : h.side === this.aimSide) ? h.cell : null;
    } else if (this.chartOpen && this.screen === 'battle') {
      const cv = $('#seacanvas'), r = cv.getBoundingClientRect();
      this.hover = cellFromScreen(this._seaMap(r), this.mouse.x - r.left, this.mouse.y - r.top);
    } else this.hover = null;
    // Swap HUDs once a swoop completes.
    const wantDeck = w.mode === 'deck';
    if ((this.screen === 'battle' || this.screen === 'over') && wantDeck !== !$('#deck').classList.contains('hidden')) {
      $('#deck').classList.toggle('hidden', !wantDeck);
      $('#battle').classList.toggle('hidden', wantDeck);
      if (wantDeck) this.refresh();
    }
    $('#clicktolook').classList.toggle('hidden', !!document.pointerLockElement || this.chartOpen);
  }

  worldDt(dt) {
    if (this.paused) return 0;
    if (this.hitstop > 0) { this.hitstop -= dt; return dt * 0.08; }
    return dt;
  }

  input() {
    const k = this.keys, locked = !!document.pointerLockElement;
    const i = { fwd: k.w || k.arrowup, back: k.s || k.arrowdown, left: k.a || k.arrowleft, right: k.d || k.arrowright, run: k.shift, look: locked || this.dragLook, dx: this.mouse.dx, dy: this.mouse.dy };
    this.mouse.dx = this.mouse.dy = 0;
    if (this.chartOpen || this.paused) { i.fwd = i.back = i.left = i.right = false; }
    return i;
  }

  // Screen-space rain over the key art.
  _drawRain(ctx) {
    if (!this._rain) this._rain = Array.from({ length: 260 }, () => ({ x: Math.random(), y: Math.random(), s: 0.6 + Math.random() * 0.8 }));
    ctx.strokeStyle = 'rgba(200,210,225,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const d of this._rain) {
      d.y += 0.02 * d.s; d.x += 0.004 * d.s;
      if (d.y > 1) { d.y -= 1; d.x = Math.random(); }
      const x = (d.x % 1) * this.w, y = d.y * this.h;
      ctx.moveTo(x, y); ctx.lineTo(x - 5 * d.s, y - 26 * d.s);
    }
    ctx.stroke();
  }

  // Chart overlays for this frame.
  draw(ctx, dpr) {
    const w = this.world;
    // Title rain is redrawn at 30 fps: plenty for streaks, half the full-screen canvas uploads.
    if (this.screen === 'title' && this.keyArt && (this._rainTick = (this._rainTick || 0) + 1) % 2) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    if (this.screen === 'title' && this.keyArt) {
      const f = w.sky.flash > 0.004 ? `brightness(${(1 + w.sky.flash * 0.9).toFixed(2)}) contrast(${(1 + w.sky.flash * 0.15).toFixed(2)})` : '';
      if (f !== this._artFilter) { this._artFilter = f; $('#keyart').style.filter = f; }
      this._drawRain(ctx);
    }
    const chartScreens = this.screen === 'placement' || this.screen === 'battle' || this.screen === 'over';
    if (chartScreens && w.mode === 'chart') {
      // Fade the chart in as the camera settles from a swoop.
      const settle = w.trans ? Math.max(0, (w.trans.t - 0.65) / 0.35) : 1;
      if (settle > 0) {
        ctx.globalAlpha = settle;
        const side = w.chartSide;
        const map = projectedMap(w, side);
        const interactive = this.screen === 'battle' && this.match.current === 0 && !this.busy() && side === this.aimSide;
        drawChart(ctx, map, this, side, { labels: true, dim: true, interactive: interactive || this.screen === 'placement' });
        ctx.globalAlpha = 1;
      }
    }
    // Mini chart of your own waters.
    if ((this.screen === 'battle' || this.screen === 'over') && w.mode === 'chart') {
      const cv = $('#minimap');
      const r = cv.getBoundingClientRect();
      if (r.width > 10) {
        if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.width * dpr); }
        const c2 = cv.getContext('2d');
        c2.setTransform(dpr, 0, 0, dpr, 0, 0);
        c2.clearRect(0, 0, r.width, r.width);
        c2.fillStyle = '#0a1a20'; c2.fillRect(0, 0, r.width, r.width);
        const pad = 6;
        drawChart(c2, flatMap({ x: pad, y: pad, size: r.width - pad * 2 }), this, w.chartSide === 0 ? 1 : 0, { labels: false, solidShips: true });
        $('#mini-title').textContent = w.chartSide === 0 ? 'Enemy waters' : 'Your waters';
      }
    }
    // Sea chart on deck.
    if (this.chartOpen) {
      const cv = $('#seacanvas'), r = cv.getBoundingClientRect();
      if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.width * dpr); }
      const c2 = cv.getContext('2d');
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2.clearRect(0, 0, r.width, r.width);
      const g = c2.createRadialGradient(r.width / 2, r.width / 2, 10, r.width / 2, r.width / 2, r.width * 0.7);
      g.addColorStop(0, '#16303a'); g.addColorStop(1, '#0a161c');
      c2.fillStyle = g; c2.fillRect(0, 0, r.width, r.width);
      const side = this.aimSide;
      $('#seachart h2').textContent = side === 1 ? 'Sea chart: enemy waters' : 'Sea chart: your waters';
      drawChart(c2, this._seaMap(r), this, side, { labels: true, interactive: this.match.current === 0 && !this.busy(), solidShips: true });
    }
  }
}
