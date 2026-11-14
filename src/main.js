// main.js - boot: WebGL2 check, world + audio + game, resize handling and the frame loop.
import { World } from './world.js';
import { Audio } from './audio.js';
import { Game } from './game.js';
import { CrewDirector } from './crew.js';
import { TouchControls } from './touch.js';
import { probeGL, chooseQuality, Governor } from './quality.js';

const gl = document.getElementById('gl');
const overlay = document.getElementById('overlay');

function noWebGL(msg) {
  document.getElementById('loading').classList.add('done');
  const d = document.createElement('div');
  d.id = 'nogl';
  d.innerHTML = `<div><h2 style="font-family:var(--display);font-size:34px">This storm needs WebGL 2</h2><p>${msg}</p><p>Use a current version of Chrome, Edge, Firefox or Safari with hardware acceleration turned on.</p></div>`;
  document.body.appendChild(d);
}

// Full-float render targets are preferred but not required: the ocean falls back to half floats
// (EXT_color_buffer_half_float, common on phones) or, failing that, a small CPU simulation.
const caps = probeGL();
// Testing aid: ?ocean=half or ?ocean=cpu forces the fallback paths on a desktop GPU.
const forceOcean = new URLSearchParams(location.search).get('ocean');
if (caps && forceOcean === 'half') caps.floatRT = false;
if (caps && forceOcean === 'cpu') caps.floatRT = caps.halfRT = false;
if (!caps) noWebGL('Your browser did not provide a WebGL 2 context.');
else boot(caps);

function boot(caps) {
  const quality = chooseQuality(caps);
  window.__quality = { tier: quality.name, auto: quality.auto, why: quality.why, caps, scale: 1 };
  console.info(`Quality: ${quality.name} (${quality.why})`, caps.renderer, caps.floatRT ? 'float32 RT' : caps.halfRT ? 'float16 RT' : 'CPU ocean');
  const world = new World(gl, quality, caps);
  const audio = new Audio();
  const game = new Game(world, audio);
  const crew = new CrewDirector(world, audio, quality);
  world.crewDirector = crew;
  crew.load().then((ok) => { if (ok || crew.shipGltf) world.onCrewReady(); }).catch((e) => console.warn('Crew assets not loaded:', e));
  window.__game = game; // handy for debugging from the console
  // Debug: fast-forward game time without rendering (used by the headless test scripts).
  window.__advance = (sec, dt = 0.05) => {
    world.ocean.frozen = true;
    for (let t = 0; t < sec; t += dt) { game.update(dt); world.update(game.worldDt(dt), game.input()); }
    world.ocean.frozen = false;
    return game.screen;
  };
  const ctx = overlay.getContext('2d');
  let dpr = 1;

  function resize() {
    const w = innerWidth, h = innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
    world.resize(w, h);
    game.layout(w, h);
  }
  addEventListener('resize', resize);
  resize();

  addEventListener('keydown', (e) => { if (e.repeat && e.key === 'Tab') { e.preventDefault(); return; } game.onKey(e, true); });
  addEventListener('keyup', (e) => game.onKey(e, false));
  // Pointer Events: mouse, touch and Apple Pencil share one path; mouse keeps its old behaviour.
  const touch = new TouchControls(game);
  const isMouse = (e) => !e.pointerType || e.pointerType === 'mouse';
  const BIT = [1, 4, 2, 8, 16];   // e.button -> e.buttons bit
  let held = 0;
  addEventListener('pointerdown', (e) => {
    touch.noteInput(e);
    if (isMouse(e)) { held = e.buttons; game.onMouseDown(e); } else game.onTouchDown(e);
  });
  addEventListener('pointermove', (e) => {
    if (!isMouse(e)) { game.onTouchMove(e); return; }
    // A second button pressed or released while another is held arrives as a pointermove.
    if (e.buttons !== held && e.button >= 0) { held = e.buttons; if (e.buttons & BIT[e.button]) game.onMouseDown(e); else game.dragLook = false; }
    game.onMouseMove(e);
  });
  addEventListener('pointerup', (e) => {
    if (isMouse(e)) { held = e.buttons; game.dragLook = false; } else { game.audio.start(); game.onTouchUp(e); }
  });
  addEventListener('pointercancel', (e) => { if (isMouse(e)) { held = 0; game.dragLook = false; } else game.onTouchUp(e); });
  addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('blur', () => { game.keys = {}; });

  // Auto quality: trade render resolution (then bloom) for frame rate if the device can't keep up.
  const governor = new Governor(quality, (g) => {
    world.setRenderScale(g.scale, g.bloomOff);
    window.__quality.scale = +g.scale.toFixed(2); window.__quality.bloomOff = g.bloomOff;
  });

  // Backgrounded (tab hidden, app switched, screen locked): stop the loop entirely and pick up
  // where we left off on return, without a time jump.
  let paused = document.hidden, rafId = 0;
  const pause = () => { paused = true; cancelAnimationFrame(rafId); rafId = 0; game.keys = {}; };
  const resumeLoop = () => {
    if (document.hidden || !paused) return;
    paused = false; last = performance.now(); governor.reset();
    if (!rafId) rafId = requestAnimationFrame(frame);
  };
  document.addEventListener('visibilitychange', () => (document.hidden ? pause() : resumeLoop()));
  addEventListener('pagehide', pause);
  addEventListener('pageshow', resumeLoop);

  let last = performance.now(), shown = false, hiddenTick = 0, hiddenDt = 0, glHidden = false;
  function frame(now) {
    rafId = 0;
    if (paused) return;
    const ms = now - last;
    const dt = Math.min(0.05, ms / 1000);
    last = now;
    game.update(dt);
    // Behind the opaque title art the 3D world is invisible: update it at a quarter rate, draw nothing.
    const hidden = game.worldHidden();
    hiddenDt += game.worldDt(dt);
    if (!hidden || ++hiddenTick % 4 === 0) { world.update(hidden ? Math.min(hiddenDt, 0.1) : game.worldDt(dt), game.input()); hiddenDt = 0; }
    if (!window.__noRender && !hidden) { world.render(); governor.sample(ms); }
    // A covered full-screen WebGL canvas still costs compositing: take it out of the page while hidden.
    if (hidden !== glHidden) { glHidden = hidden; world.canvas.style.visibility = hidden ? 'hidden' : ''; }
    game.draw(ctx, dpr);
    if (!shown) { shown = true; setTimeout(() => document.getElementById('loading').classList.add('done'), 300); }
    rafId = requestAnimationFrame(frame);
  }
  if (paused) { paused = false; pause(); } else rafId = requestAnimationFrame(frame);
}
