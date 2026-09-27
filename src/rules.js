// rules.js - Captain's Gambit rules engine (Hasbro Battleship + Gambit mode).
// Pure JavaScript with no browser code, so `npm test` can run it in Node.

export const N = 10;
export const SHIP_COUNT = 5;
export const Mode = { Standard: 'standard', Gambit: 'gambit' };
export const Gambit = { Broadside: 'broadside', PowderKeg: 'powderKeg', CrowsNest: 'crowsNest', GhostShip: 'ghostShip' };
export const Mark = { None: 0, Miss: 1, Hit: 2 };

export const CAPTAINS = [
  { name: 'Captain Blackthorn', motto: 'Freedom, plunder, no masters', gambit: Gambit.Broadside, gambitName: 'Broadside',
    gambitDesc: 'Fire 3 shots at any 3 untried squares, one after another.', portrait: 'blackthorn', color: 0x3fa36b, sail: 0x2f5e3e },
  { name: 'Captain Calavera', motto: 'Fire, smoke, ruin', gambit: Gambit.PowderKeg, gambitName: 'Powder Keg',
    gambitDesc: 'A plus-shaped blast on open water: the target and its 4 neighbours.', portrait: 'morrigan', color: 0xc8372d, sail: 0x7e2520 },
  { name: 'Captain Isla Crowe', motto: 'Wind, stars, horizon', gambit: Gambit.CrowsNest, gambitName: "Crow's Nest",
    gambitDesc: 'A free scout: learn how many ship squares lie in a 3x3 area, then fire.', portrait: 'isla', color: 0x3f83d1, sail: 0x2b4f7e },
  { name: 'Captain Bonecrusher', motto: 'No grave, no mercy', gambit: Gambit.GhostShip, gambitName: 'Ghost Ship',
    gambitDesc: 'Move one of your ships to untouched water and repair one hit.', portrait: 'bonecrusher', color: 0xa7b3ae, sail: 0x1c1d1f },
];
export const SHIPS = [
  { name: "Man-o'-War", length: 5 }, { name: 'Galleon', length: 4 }, { name: 'Frigate', length: 3 },
  { name: 'Brigantine', length: 3 }, { name: 'Sloop', length: 2 },
];

export const inBounds = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
export const coordName = (c) => String.fromCharCode(65 + c.x) + (c.y + 1);
export const cellOf = (p, i) => (p.horizontal ? { x: p.x + i, y: p.y } : { x: p.x, y: p.y + i });
export const samePlacement = (a, b) => a.x === b.x && a.y === b.y && a.horizontal === b.horizontal;

// Small seeded RNG (mulberry32) so games and tests are reproducible.
export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  return next;
}

export class Ship {
  constructor(type) {
    this.type = type;
    this.pos = { x: 0, y: 0, horizontal: true };
    this.placed = false;
    this.damaged = [false, false, false, false, false];
  }
  get length() { return SHIPS[this.type].length; }
  damageCount() { let n = 0; for (let i = 0; i < this.length; i++) n += this.damaged[i] ? 1 : 0; return n; }
  isSunk() { return this.placed && this.damageCount() >= this.length; }
  segmentAt(x, y) {
    if (!this.placed) return -1;
    for (let i = 0; i < this.length; i++) { const c = cellOf(this.pos, i); if (c.x === x && c.y === y) return i; }
    return -1;
  }
  fitsAt(p) { const a = cellOf(p, 0), b = cellOf(p, this.length - 1); return inBounds(a.x, a.y) && inBounds(b.x, b.y); }
  clone() { const s = new Ship(this.type); s.pos = { ...this.pos }; s.placed = this.placed; s.damaged = [...this.damaged]; return s; }
}

// One side's sea: its own fleet plus every shot the opponent has fired into it.
export class Waters {
  constructor() {
    this.ships = SHIPS.map((_, i) => new Ship(i));
    this.clearShots();
  }
  clearShots() {
    this.shots = Array.from({ length: N }, () => Array.from({ length: N }, () => ({ mark: Mark.None, ship: -1, stale: false })));
    for (const s of this.ships) s.damaged = [false, false, false, false, false];
  }
  shipAt(x, y) { for (let i = 0; i < SHIP_COUNT; i++) if (this.ships[i].segmentAt(x, y) >= 0) return i; return -1; }
  tried(x, y) { return this.shots[y][x].mark !== Mark.None; }
  canPlace(idx, p) {
    const s = this.ships[idx];
    if (!s.fitsAt(p)) return false;
    for (let i = 0; i < s.length; i++) {
      const c = cellOf(p, i);
      for (let j = 0; j < SHIP_COUNT; j++) if (j !== idx && this.ships[j].segmentAt(c.x, c.y) >= 0) return false;
    }
    return true;
  }
  fullyPlaced() { return this.ships.every((s) => s.placed); }
  allSunk() { return this.ships.every((s) => s.isSunk()); }
  shipsAfloat() { return this.ships.filter((s) => !s.isSunk()).length; }
  randomize(rng) {
    for (const s of this.ships) s.placed = false;
    for (let i = 0; i < SHIP_COUNT; i++) {
      for (let t = 0; t < 10000; t++) {
        const p = { x: rng.int(0, N - 1), y: rng.int(0, N - 1), horizontal: rng() < 0.5 };
        if (this.canPlace(i, p)) { this.ships[i].pos = p; this.ships[i].placed = true; break; }
      }
    }
  }
  // A live hit: a hit on a ship that is still afloat and hasn't escaped with Ghost Ship.
  liveHitAt(x, y) {
    if (!inBounds(x, y)) return false;
    const m = this.shots[y][x];
    if (m.mark !== Mark.Hit || m.stale || m.ship < 0) return false;
    return !this.ships[m.ship].isSunk();
  }
}

const fail = (why, msg) => { if (why) why.msg = msg; return false; };

export class Match {
  constructor() {
    this.mode = Mode.Standard;
    this.unlockOnFirstHit = false; // Gambits are ready from turn one; true locks them until your first hit
    this.side = [0, 1].map(() => ({ waters: new Waters(), captain: 0, gambitUsed: false, gambitUnlocked: false, turns: 0, shots: 0, hits: 0 }));
    this.current = 0;
    this.winner = -1;
  }
  start(mode, first) {
    this.mode = mode;
    this.current = first;
    this.winner = -1;
    for (const s of this.side) {
      s.waters.clearShots();
      s.gambitUsed = false;
      s.gambitUnlocked = mode === Mode.Gambit && !this.unlockOnFirstHit;
      s.turns = s.shots = s.hits = 0;
    }
  }
  gameOver() { return this.winner >= 0; }
  target(p) { return this.side[1 - p].waters; }
  gambitOf(p) { return CAPTAINS[this.side[p].captain].gambit; }

  canFire(p, c, why) {
    if (this.gameOver()) return fail(why, 'The battle is over.');
    if (p !== this.current) return fail(why, 'Not your turn.');
    if (!c || !inBounds(c.x, c.y)) return fail(why, 'Off the chart.');
    if (this.target(p).tried(c.x, c.y)) return fail(why, 'Already fired on that square.');
    return true;
  }
  resolveShot(p, c) {
    const w = this.side[1 - p].waters;
    const r = { at: { ...c }, hit: false, ship: -1, sunk: false, won: false };
    this.side[p].shots++;
    const idx = w.shipAt(c.x, c.y);
    if (idx < 0) { w.shots[c.y][c.x] = { mark: Mark.Miss, ship: -1, stale: false }; return r; }
    const s = w.ships[idx];
    const wasSunk = s.isSunk();
    s.damaged[s.segmentAt(c.x, c.y)] = true;
    w.shots[c.y][c.x] = { mark: Mark.Hit, ship: idx, stale: false };
    this.side[p].hits++;
    r.hit = true; r.ship = idx; r.sunk = !wasSunk && s.isSunk();
    if (this.mode === Mode.Gambit && !this.side[p].gambitUnlocked) this.side[p].gambitUnlocked = true;
    if (w.allSunk()) { this.winner = p; r.won = true; }
    return r;
  }
  endTurn(p) { this.side[p].turns++; if (!this.gameOver()) this.current = 1 - p; }
  fire(p, c) { const r = this.resolveShot(p, c); this.endTurn(p); return r; }

  gambitReady(p, why) {
    if (this.mode !== Mode.Gambit) return fail(why, 'Standard rules: no Gambits.');
    if (this.gameOver()) return fail(why, 'The battle is over.');
    if (this.side[p].gambitUsed) return fail(why, 'Spent: one Gambit per battle.');
    if (!this.side[p].gambitUnlocked) return fail(why, 'Locked: land your first hit to unlock.');
    if (p !== this.current) return fail(why, 'Wait for your turn.');
    return true;
  }

  canBroadside(p, t, why) {
    if (!this.gambitReady(p, why)) return false;
    if (this.gambitOf(p) !== Gambit.Broadside) return fail(why, "That is not your captain's Gambit.");
    if (t.length !== 3) return fail(why, 'Choose exactly 3 squares.');
    for (let i = 0; i < t.length; i++) {
      if (!inBounds(t[i].x, t[i].y)) return fail(why, 'Off the chart.');
      if (this.target(p).tried(t[i].x, t[i].y)) return fail(why, 'All 3 squares must be untried.');
      for (let j = 0; j < i; j++) if (t[i].x === t[j].x && t[i].y === t[j].y) return fail(why, 'Choose 3 different squares.');
    }
    return true;
  }
  broadside(p, t) {
    const out = [];
    if (!this.canBroadside(p, t)) return out;
    this.side[p].gambitUsed = true;
    for (const c of t) { out.push(this.resolveShot(p, c)); if (this.gameOver()) break; }
    this.endTurn(p);
    return out;
  }

  static blastArea(c) {
    return [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: c.x + dx, y: c.y + dy })).filter((q) => inBounds(q.x, q.y));
  }
  canPowderKeg(p, c, why) {
    if (!this.gambitReady(p, why)) return false;
    if (this.gambitOf(p) !== Gambit.PowderKeg) return fail(why, "That is not your captain's Gambit.");
    if (!inBounds(c.x, c.y)) return fail(why, 'Off the chart.');
    const w = this.target(p);
    for (const b of Match.blastArea(c)) {
      if (w.tried(b.x, b.y)) return fail(why, 'Open water only: every blast square must be untried.');
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]])
        if (w.liveHitAt(b.x + dx, b.y + dy)) return fail(why, "Open water only: the blast can't touch a ship you've already found.");
    }
    return true;
  }
  powderKeg(p, c) {
    const out = [];
    if (!this.canPowderKeg(p, c)) return out;
    this.side[p].gambitUsed = true;
    for (const b of Match.blastArea(c)) { out.push(this.resolveShot(p, b)); if (this.gameOver()) break; }
    this.endTurn(p);
    return out;
  }

  static scoutArea(c) {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (inBounds(c.x + dx, c.y + dy)) out.push({ x: c.x + dx, y: c.y + dy });
    return out;
  }
  canCrowsNest(p, c, why) {
    if (!this.gambitReady(p, why)) return false;
    if (this.gambitOf(p) !== Gambit.CrowsNest) return fail(why, "That is not your captain's Gambit.");
    if (!inBounds(c.x, c.y)) return fail(why, 'Off the chart.');
    return true;
  }
  // Free action: returns the count and the turn continues.
  crowsNest(p, c) {
    if (!this.canCrowsNest(p, c)) return -1;
    this.side[p].gambitUsed = true;
    const w = this.target(p);
    let n = 0;
    for (const a of Match.scoutArea(c)) if (w.shipAt(a.x, a.y) >= 0) n++;
    return n;
  }

  canGhostShip(p, idx, to, why) {
    if (!this.gambitReady(p, why)) return false;
    if (this.gambitOf(p) !== Gambit.GhostShip) return fail(why, "That is not your captain's Gambit.");
    if (idx < 0 || idx >= SHIP_COUNT) return fail(why, 'Choose one of your ships.');
    const own = this.side[p].waters, s = own.ships[idx];
    if (s.isSunk()) return fail(why, "A sunk ship can't sail.");
    if (samePlacement(s.pos, to)) return fail(why, 'Choose a new position.');
    if (!own.canPlace(idx, to)) return fail(why, 'It must fit on the chart without overlapping another ship.');
    for (let i = 0; i < s.length; i++) { const c = cellOf(to, i); if (own.tried(c.x, c.y)) return fail(why, "It can't cover any square the enemy has fired at."); }
    return true;
  }
  ghostShip(p, idx, to) {
    if (!this.canGhostShip(p, idx, to)) return false;
    this.side[p].gambitUsed = true;
    const own = this.side[p].waters, s = own.ships[idx];
    for (const row of own.shots) for (const m of row) if (m.mark === Mark.Hit && m.ship === idx) m.stale = true;
    const k = s.damaged.findIndex((d, i) => d && i < s.length);
    if (k >= 0) s.damaged[k] = false;
    s.pos = { ...to };
    this.endTurn(p);
    return true;
  }
}
