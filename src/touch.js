// touch.js - on-screen controls for phones and tablets: touch-mode detection, the action rail,
// the deck joystick and ship switcher, and guards against browser gestures (pinch and
// double-tap zoom, pull-to-refresh, long-press callouts). Chart taps, aiming and deck look-drag
// live in Game's input section; this file only drives the extra controls around them.
import { SHIPS, CAPTAINS, Mode } from './rules.js';

const $ = (s) => document.querySelector(s);

export class TouchControls {
  constructor(game) {
    this.game = game;
    this.root = $('#tc');
    this.stick = { id: null, cx: 0, cy: 0, r: 1 };
    this._key = '';
    game.touch = this;
    const coarse = window.matchMedia?.('(pointer: coarse)');
    this.setTouch(!!coarse?.matches || (navigator.maxTouchPoints > 0 && !window.matchMedia?.('(any-pointer: fine)').matches));
    coarse?.addEventListener?.('change', (e) => { if (e.matches) this.setTouch(true); });
    this._bindButtons();
    this._bindStick();
    this._blockGestures();
  }

  // The last kind of pointer pressed wins: a tap shows the touch controls, a mouse click hides them.
  noteInput(e) {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') this.setTouch(true);
    else if (e.pointerType === 'mouse') this.setTouch(false);
  }
  setTouch(on) {
    if (this.game.touchUI === on) return;
    this.game.touchUI = on;
    document.documentElement.classList.toggle('touch', on);
    this.game.touchAim = null;
    this._key = '';
    this.game.refresh();
  }

  _bindButtons() {
    const g = this.game;
    const ships = $('#tc-ships');
    ships.innerHTML = SHIPS.map((s, i) => `<button class="tc-btn tc-ship" type="button" data-tc="ship" data-ship="${i}" aria-label="Go aboard the ${s.name}"><b>${i + 1}</b><span>${s.name}</span></button>`).join('');
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tc]');
      if (!b || b.disabled) return;
      g.audio.start();
      switch (b.dataset.tc) {
        case 'menu': g.setPaused(true); break;
        case 'help': $('#help').classList.remove('hidden'); break;
        case 'confirm': g.touchConfirm(); break;
        case 'rotate': g.touchRotate(); break;
        case 'cancel': g.touchCancel(); break;
        case 'chart': g.setChartOpen(!g.chartOpen); break;
        case 'gambit': g.useGambit(); break;
        case 'board': g.toggleView(); break;
        case 'ship': g.boardShip(Number(b.dataset.ship)); break;
      }
    });
    // Comfort mode and full screen were keyboard-only (K, F): touch players get them in the pause menu.
    document.body.addEventListener('click', (e) => {
      const act = e.target.closest('[data-tc-act]')?.dataset.tcAct;
      if (act === 'comfort') g.toggleComfort();
      if (act === 'fullscreen') g.toggleFullscreen();
      if (act) this._key = '';
    });
  }

  // Virtual joystick: booleans for the walk keys (the deck walker normalises them), run at full tilt.
  _bindStick() {
    const zone = $('#tc-stick'), knob = zone.querySelector('.tc-knob'), st = this.stick;
    const set = (x, y) => {
      const dx = x - st.cx, dy = y - st.cy, d = Math.hypot(dx, dy), k = d > st.r ? st.r / d : 1;
      const nx = (dx * k) / st.r, ny = (dy * k) / st.r, mag = Math.min(1, d / st.r);
      knob.style.transform = `translate(${nx * st.r * 0.6}px, ${ny * st.r * 0.6}px)`;
      const dead = 0.3;
      this.game.touchMove = { fwd: ny < -dead, back: ny > dead, left: nx < -dead, right: nx > dead, run: mag > 0.92 };
      zone.classList.toggle('run', mag > 0.92);
    };
    const end = (e) => {
      if (e.pointerId !== st.id) return;
      st.id = null; this.game.touchMove = null;
      knob.style.transform = ''; zone.classList.remove('on', 'run');
    };
    zone.addEventListener('pointerdown', (e) => {
      if (st.id !== null) return;
      e.preventDefault();
      const r = zone.querySelector('.tc-base').getBoundingClientRect();
      st.id = e.pointerId; st.cx = r.left + r.width / 2; st.cy = r.top + r.height / 2; st.r = r.width / 2;
      zone.setPointerCapture?.(e.pointerId);
      zone.classList.add('on');
      set(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === st.id) set(e.clientX, e.clientY); });
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    zone.addEventListener('lostpointercapture', end);
  }

  // Keep the page still: no pinch or double-tap zoom, no rubber-band or pull-to-refresh, no long-press
  // menus. Scrollable panels (help, audio) keep their own vertical pan via CSS touch-action.
  _blockGestures() {
    const stop = (e) => e.preventDefault();
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, stop, { passive: false });
    document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
    document.addEventListener('dblclick', (e) => { if (!e.target.closest?.('input, textarea')) e.preventDefault(); });
    document.addEventListener('selectstart', (e) => { if (this.game.touchUI && !e.target.closest?.('input, textarea')) e.preventDefault(); });
  }

  // Show the controls that fit the moment. Runs every frame but only touches the DOM on change.
  sync() {
    const g = this.game, w = g.world, m = g.match;
    if (!g.touchUI || !m) { if (this._key !== 'off') { this._key = 'off'; this.root.dataset.on = ''; } return; }
    const modal = !!document.querySelector('.modal:not(.hidden)') || !$('#versus').classList.contains('hidden');
    const inBattle = g.screen === 'battle' || g.screen === 'over';
    const deck = inBattle && w.mode === 'deck' && !w.trans;
    const mine = g.screen === 'battle' && m.current === 0 && !g.busy() && !m.gameOver();
    const holding = g.screen === 'placement' && g.dragShip >= 0;
    const aiming = mine && g.aim && g.aim !== 'fire';
    const ta = g.touchAim && g.screen === 'battle' ? g.touchAim : null;
    const gambit = g.screen === 'battle' && m.mode === Mode.Gambit;
    const gUsed = gambit && m.side[0].gambitUsed;
    const sunk = m.side[0].waters.ships.map((s) => (inBattle ? s.isSunk() : false));
    const key = [g.screen, deck, mine, holding, g.aim, aiming, ta ? `${ta.cell.x},${ta.cell.y}` : '', g.chartOpen, g.paused, modal, w.trans ? 1 : 0, w.pov, gUsed, sunk.join(), g.broadsideSel.length, w.comfort].join('|');
    if (key === this._key) return;
    this._key = key;
    const show = (sel, on) => $(sel).classList.toggle('tc-off', !on);
    this.root.dataset.on = modal ? '' : '1';
    this.root.dataset.view = deck ? 'deck' : 'chart';
    this.root.classList.toggle('sea', deck && g.chartOpen);
    show('#tc-menu', g.screen === 'battle' && !g.paused);
    show('#tc-help', g.screen === 'title' || g.screen === 'placement');
    // Action rail: confirm, rotate, cancel; deck actions below them.
    const confirmLabel = { fire: 'Fire', broadside: 'Fire broadside', powderKeg: 'Light the keg', crowsNest: 'Scout here', ghostPlace: 'Sail here' }[g.aim] || 'Fire';
    show('#tc-confirm', !!ta && mine);
    $('#tc-confirm').textContent = confirmLabel;
    show('#tc-rotate', holding || (mine && g.aim === 'ghostPlace'));
    // A Gambit in progress is cancelled from the Gambit button, which then reads "Cancel Gambit".
    show('#tc-cancel', holding || (!!ta && mine) || (aiming && !gambit));
    $('#tc-cancel').textContent = holding ? 'Put back' : ta ? 'Clear aim' : 'Cancel';
    show('#tc-chart', deck);
    $('#tc-chart').textContent = g.chartOpen ? 'Close chart' : 'Sea chart';
    show('#tc-gambit', gambit && g.screen === 'battle');
    $('#tc-gambit').disabled = !!gUsed || !mine;
    $('#tc-gambit').textContent = gUsed ? 'Gambit spent' : aiming ? 'Cancel Gambit' : CAPTAINS[m.side[0].captain].gambitName;
    show('#tc-board', deck);
    // Deck: joystick and ship switcher.
    show('#tc-stick', deck && !g.chartOpen && !g.paused);
    show('#tc-ships', deck);
    this.root.querySelectorAll('.tc-ship').forEach((b, i) => { b.disabled = sunk[i]; b.classList.toggle('on', i === w.pov); });
    const cb = $('[data-tc-act="comfort"]');
    if (cb) cb.textContent = `Comfort mode: ${w.comfort ? 'on' : 'off'}`;
    const fs = $('[data-tc-act="fullscreen"]');
    if (fs) fs.classList.toggle('hidden', !(document.fullscreenEnabled || document.webkitFullscreenEnabled));
  }
}
