// ai.js - computer captain. Uses only what a human opponent would know: its own shot
// results, announced ship names and sinkings, and its own Crow's Nest counts.
import { N, SHIP_COUNT, Mark, Gambit, Mode, Match, cellOf, inBounds, makeRng } from './rules.js';

export class AI {
  constructor(seed = 1) { this.reset(seed); }
  reset(seed) { this.rng = makeRng(seed); this.scouts = []; }
  onCrowsNest(centre, count) { this.scouts.push({ centre, count }); }
  onOpponentGhostShip() { this.scouts = []; } // old scouting is no longer reliable

  // Probability-density map over the opponent's untried squares.
  density(m, me) {
    const w = m.target(me);
    const g = Array.from({ length: N }, () => new Float64Array(N));
    const hits = Array.from({ length: SHIP_COUNT }, () => []);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (w.liveHitAt(x, y)) hits[w.shots[y][x].ship].push({ x, y });
    let targeting = hits.some((h) => h.length);

    const blocked = Array.from({ length: N }, () => new Array(N).fill(false));
    const mult = Array.from({ length: N }, () => new Array(N).fill(1));
    for (const s of this.scouts)
      for (const c of Match.scoutArea(s.centre)) {
        if (s.count === 0) blocked[c.y][c.x] = true;
        else mult[c.y][c.x] *= 1 + 0.6 * s.count;
      }

    const accumulate = (onlyTargets) => {
      let total = 0;
      for (let i = 0; i < SHIP_COUNT; i++) {
        const ship = w.ships[i];
        if (ship.isSunk()) continue;
        if (onlyTargets && !hits[i].length) continue;
        const L = ship.length;
        for (let h = 0; h < 2; h++)
          for (let y = 0; y < N; y++)
            for (let x = 0; x < N; x++) {
              const p = { x, y, horizontal: h === 1 };
              let ok = true, covered = 0;
              for (let k = 0; k < L && ok; k++) {
                const c = cellOf(p, k);
                if (!inBounds(c.x, c.y)) { ok = false; break; }
                const sm = w.shots[c.y][c.x];
                if (sm.mark === Mark.None) { if (blocked[c.y][c.x]) ok = false; }
                else if (sm.mark === Mark.Hit && !sm.stale && sm.ship === i) covered++;
                else ok = false;
              }
              if (!ok || covered !== hits[i].length) continue;
              const weight = onlyTargets ? 1 + 4 * covered : 1;
              for (let k = 0; k < L; k++) {
                const c = cellOf(p, k);
                if (w.shots[c.y][c.x].mark === Mark.None) { g[c.y][c.x] += weight * mult[c.y][c.x]; total += weight; }
              }
            }
      }
      return total;
    };
    let total = 0;
    if (targeting) total = accumulate(true);
    if (total <= 0) {
      for (const row of g) row.fill(0);
      targeting = false; // nothing consistent to chase: fall back to searching
      total = accumulate(false);
    }
    if (total <= 0) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!w.tried(x, y)) g[y][x] = 1;
    return { g, targeting };
  }

  bestCell(m, me, g) {
    const w = m.target(me);
    let best = -1;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!w.tried(x, y)) best = Math.max(best, g[y][x]);
    const ties = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!w.tried(x, y) && g[y][x] >= best - 1e-9) ties.push({ x, y });
    return ties.length ? ties[Math.floor(this.rng() * ties.length)] : { x: 0, y: 0 };
  }

  planGambit(m, me, g, targeting) {
    const w = m.target(me);
    switch (m.gambitOf(me)) {
      case Gambit.Broadside: { // once it has taken 10 turns and isn't chasing a damaged ship
        if (m.side[me].turns < 10 || targeting) return null;
        const cells = [];
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!w.tried(x, y)) cells.push([g[y][x], { x, y }]);
        if (cells.length < 3) return null;
        cells.sort((a, b) => b[0] - a[0]);
        const targets = cells.slice(0, 3).map((c) => c[1]);
        return m.canBroadside(me, targets) ? { kind: 'broadside', targets } : null;
      }
      case Gambit.PowderKeg: { // while searching, on the legal spot covering the most untried squares
        if (targeting) return null;
        let best = -1, pick = null;
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          if (!m.canPowderKeg(me, { x, y })) continue;
          const area = Match.blastArea({ x, y });
          let score = area.length * 1000;
          for (const c of area) score += g[c.y][c.x];
          if (score > best) { best = score; pick = { x, y }; }
        }
        return pick ? { kind: 'powderKeg', target: pick } : null;
      }
      case Gambit.CrowsNest: { // from turn 5 while searching, on the 3x3 with the most untried squares
        if (m.side[me].turns < 4 || targeting) return null;
        let best = -1, pick = { x: 0, y: 0 };
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          let score = 0;
          for (const c of Match.scoutArea({ x, y })) if (!w.tried(c.x, c.y)) score += 1000 + g[c.y][c.x];
          if (score > best) { best = score; pick = { x, y }; }
        }
        return m.canCrowsNest(me, pick) ? { kind: 'crowsNest', target: pick } : null;
      }
      case Gambit.GhostShip: { // once a ship has 2 hits (the Sloop at 1), move the most damaged ship
        const own = m.side[me].waters;
        let pickShip = -1, pickDmg = 0;
        for (let i = 0; i < SHIP_COUNT; i++) {
          const s = own.ships[i];
          if (s.isSunk()) continue;
          const dmg = s.damageCount(), need = s.length === 2 ? 1 : 2;
          if (dmg >= need && (dmg > pickDmg || (dmg === pickDmg && s.length > own.ships[pickShip].length))) { pickShip = i; pickDmg = dmg; }
        }
        if (pickShip < 0) return null;
        const legal = [];
        for (let h = 0; h < 2; h++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++)
          if (m.canGhostShip(me, pickShip, { x, y, horizontal: h === 1 })) legal.push({ x, y, horizontal: h === 1 });
        if (!legal.length) return null;
        return { kind: 'ghostShip', ship: pickShip, to: legal[Math.floor(this.rng() * legal.length)] };
      }
    }
    return null;
  }

  // Decide this turn's action. If it returns crowsNest, apply it, call onCrowsNest(), then decide() again.
  decide(m, me) {
    const { g, targeting } = this.density(m, me);
    if (m.mode === Mode.Gambit && m.gambitReady(me)) {
      const a = this.planGambit(m, me, g, targeting);
      if (a) return a;
    }
    return { kind: 'fire', target: this.bestCell(m, me, g) };
  }
}

// Plays one full AI-vs-AI game (used by tests and the balance report). Returns the winner.
export function simulateGame(mode, c0, c1, first, seed, unlockOnFirstHit = false) {
  const rng = makeRng(seed);
  const m = new Match();
  m.unlockOnFirstHit = unlockOnFirstHit;
  m.side[0].captain = c0;
  m.side[1].captain = c1;
  m.side[0].waters.randomize(rng);
  m.side[1].waters.randomize(rng);
  m.start(mode, first);
  const ai = [new AI(seed * 2654435761 + 1), new AI(seed * 2246822519 + 7)];
  for (let step = 0; step < 1000 && !m.gameOver(); step++) {
    const p = m.current;
    const a = ai[p].decide(m, p);
    let acted = false;
    if (a.kind === 'broadside' && m.canBroadside(p, a.targets)) { m.broadside(p, a.targets); acted = true; }
    else if (a.kind === 'powderKeg' && m.canPowderKeg(p, a.target)) { m.powderKeg(p, a.target); acted = true; }
    else if (a.kind === 'crowsNest' && m.canCrowsNest(p, a.target)) { ai[p].onCrowsNest(a.target, m.crowsNest(p, a.target)); continue; }
    else if (a.kind === 'ghostShip' && m.canGhostShip(p, a.ship, a.to)) { m.ghostShip(p, a.ship, a.to); ai[1 - p].onOpponentGhostShip(); acted = true; }
    if (!acted) {
      let c = a.kind === 'fire' ? a.target : null;
      if (!m.canFire(p, c)) outer: for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (m.canFire(p, { x, y })) { c = { x, y }; break outer; }
      m.fire(p, c);
    }
  }
  return m.winner;
}
