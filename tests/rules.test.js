// Unit tests + balance report for the rules engine and AI. Runs in Node: `npm test`, `npm run balance`.
import { Match, Mode, Mark, N, SHIP_COUNT, CAPTAINS } from '../src/rules.js';
import { simulateGame } from '../src/ai.js';

let pass = 0, failed = 0;
const check = (cond, label) => { if (cond) pass++; else { failed++; console.log('  FAIL', label); } };
const BLACKTHORN = 0, MORRIGAN = 1, ISLA = 2, BONECRUSHER = 3;

function makeMatch(mode, c0, c1, unlock = false) {
  const m = new Match();
  m.unlockOnFirstHit = unlock;
  m.side[0].captain = c0; m.side[1].captain = c1;
  for (const s of m.side) s.waters.ships.forEach((sh, i) => { sh.pos = { x: 0, y: i * 2, horizontal: true }; sh.placed = true; });
  m.start(mode, 0);
  return m;
}

function testStandard() {
  console.log('standard rules');
  const m = makeMatch(Mode.Standard, BLACKTHORN, MORRIGAN);
  let r = m.fire(0, { x: 9, y: 9 });
  check(!r.hit && m.current === 1, 'miss passes turn');
  check(m.canFire(1, { x: 9, y: 9 }), 'other board untried');
  check(!m.canFire(0, { x: 0, y: 0 }), 'not your turn');
  m.fire(1, { x: 9, y: 9 });
  check(!m.canFire(0, { x: 9, y: 9 }), 'already tried');
  r = m.fire(0, { x: 0, y: 8 });
  check(r.hit && r.ship === 4 && !r.sunk, 'hit names the ship');
  m.fire(1, { x: 8, y: 9 });
  r = m.fire(0, { x: 1, y: 8 });
  check(r.hit && r.sunk && r.ship === 4 && !r.won, 'sloop sunk');
  check(!m.gambitReady(0), 'no gambits in standard');
  for (let guard = 0; guard < 400 && !m.gameOver(); guard++) {
    const p = m.current;
    let pick = null;
    for (let y = 0; y < N && !pick; y++) for (let x = 0; x < N; x++) {
      const ship = m.target(p).shipAt(x, y) >= 0;
      if (m.canFire(p, { x, y }) && ship === (p === 0)) { pick = { x, y }; break; }
    }
    m.fire(p, pick);
  }
  check(m.winner === 0, 'player 0 wins');
}

function testUnlock() {
  console.log('gambit unlock options');
  const m = makeMatch(Mode.Gambit, BLACKTHORN, MORRIGAN, true);
  check(!m.gambitReady(0), 'locked before first hit');
  m.fire(0, { x: 9, y: 9 }); m.fire(1, { x: 9, y: 9 });
  check(!m.gambitReady(0), 'still locked after a miss');
  m.fire(0, { x: 0, y: 0 }); m.fire(1, { x: 9, y: 8 });
  check(m.gambitReady(0), 'unlocked after a hit');
  check(new Match().unlockOnFirstHit === false, 'default: ready from turn one');
  check(makeMatch(Mode.Gambit, BLACKTHORN, MORRIGAN).gambitReady(0), 'ready on turn one');
}

function testBroadside() {
  console.log('broadside');
  const m = makeMatch(Mode.Gambit, BLACKTHORN, MORRIGAN);
  check(!m.canBroadside(0, [{ x: 9, y: 9 }, { x: 9, y: 9 }, { x: 8, y: 9 }]), 'duplicate rejected');
  check(!m.canBroadside(0, [{ x: 9, y: 9 }, { x: 8, y: 9 }]), 'two rejected');
  const res = m.broadside(0, [{ x: 0, y: 8 }, { x: 1, y: 8 }, { x: 9, y: 9 }]);
  check(res.length === 3 && res[0].hit && res[1].sunk && !res[2].hit, 'three shots resolved');
  check(m.current === 1 && m.side[0].gambitUsed, 'turn ends, gambit spent');
  m.fire(1, { x: 9, y: 9 });
  check(!m.gambitReady(0), 'once per game');
}

function testPowderKeg() {
  console.log('powder keg');
  const m = makeMatch(Mode.Gambit, MORRIGAN, BLACKTHORN);
  check(Match.blastArea({ x: 0, y: 0 }).length === 3, 'clipped at corner');
  check(Match.blastArea({ x: 5, y: 5 }).length === 5, 'full plus');
  m.fire(0, { x: 0, y: 2 }); m.fire(1, { x: 9, y: 9 });
  check(!m.canPowderKeg(0, { x: 1, y: 3 }), 'touches a found ship');
  check(!m.canPowderKeg(0, { x: 0, y: 2 }), 'centre already tried');
  check(m.canPowderKeg(0, { x: 6, y: 7 }), 'open water ok');
  const res = m.powderKeg(0, { x: 6, y: 7 });
  check(res.length === 5 && m.current === 1, 'five shots, turn ends');
}

function testCrowsNest() {
  console.log("crow's nest");
  const m = makeMatch(Mode.Gambit, ISLA, BLACKTHORN);
  check(Match.scoutArea({ x: 0, y: 0 }).length === 4, 'clipped scout area');
  check(m.crowsNest(0, { x: 1, y: 1 }) === 6, 'counts ship squares');
  check(m.current === 0 && !m.gambitReady(0), 'free action, then spent');
  m.fire(0, { x: 5, y: 5 });
  check(m.current === 1, 'fire ends the turn');
}

function testGhostShip() {
  console.log('ghost ship');
  const m = makeMatch(Mode.Gambit, BLACKTHORN, BONECRUSHER);
  m.fire(0, { x: 0, y: 2 });
  check(m.side[1].waters.ships[1].damageCount() === 1, 'galleon hit');
  check(!m.canGhostShip(1, 1, { x: 0, y: 2, horizontal: true }), 'same spot rejected');
  check(m.canGhostShip(1, 1, { x: 0, y: 1, horizontal: true }), 'open row ok');
  check(m.canGhostShip(1, 1, { x: 6, y: 9, horizontal: true }), 'far corner ok');
  check(!m.canGhostShip(1, 1, { x: 0, y: 1, horizontal: false }), 'fired-at square rejected');
  m.ghostShip(1, 1, { x: 6, y: 9, horizontal: true });
  const w = m.side[1].waters;
  check(w.ships[1].damageCount() === 0, 'repaired one hit');
  check(w.shots[2][0].mark === Mark.Hit && w.shots[2][0].stale && !w.liveHitAt(0, 2), 'old hit goes stale');
  check(m.current === 0, 'turn ends');
}

function testAIGames() {
  console.log('AI games (all captain pairings, both modes)');
  let games = 0;
  for (const mode of [Mode.Standard, Mode.Gambit])
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let s = 0; s < 10; s++) {
      const w = simulateGame(mode, a, b, s & 1, 1000 + s * 31 + a * 7 + b);
      check(w === 0 || w === 1, `game ${a} vs ${b} finishes`);
      games++;
    }
  console.log(`  ${games} games completed`);
}

function balance(per, unlock) {
  console.log(`Balance: ${per} games per ordered captain pairing, Gambit mode, unlockOnFirstHit=${unlock}`);
  const wins = [0, 0, 0, 0], played = [0, 0, 0, 0];
  let seed = 77;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
    if (a === b) continue;
    for (let g = 0; g < per; g++) {
      const w = simulateGame(Mode.Gambit, a, b, g & 1, seed++, unlock);
      played[a]++; played[b]++; wins[w === 0 ? a : b]++;
    }
  }
  CAPTAINS.forEach((c, i) => console.log(`  ${c.name.padEnd(22)} (${c.gambitName.padEnd(11)}) ${(100 * wins[i] / played[i]).toFixed(1)}%`));
}

const args = process.argv.slice(2);
if (args[0] === '--balance') {
  const per = Number(args[1] || 200);
  balance(per, false);
  balance(per, true);
} else {
  testStandard(); testUnlock(); testBroadside(); testPowderKeg(); testCrowsNest(); testGhostShip(); testAIGames();
  console.log(`\n${pass} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
