// main.js - boot: WebGL2 check, world + audio + game, resize handling and the frame loop.
import { World } from './world.js';
import { Audio } from './audio.js';
import { Game } from './game.js';
import { LivingPortraits } from './portraits.js';
import { CrewDirector } from './crew.js';

const gl = document.getElementById('gl');
const overlay = document.getElementById('overlay');

function noWebGL(msg) {
  document.getElementById('loading').classList.add('done');
  const d = document.createElement('div');
  d.id = 'nogl';
  d.innerHTML = `<div><h2 style="font-family:var(--display);font-size:34px">This storm needs WebGL 2</h2><p>${msg}</p><p>Use a current version of Chrome, Edge, Firefox or Safari with hardware acceleration turned on.</p></div>`;
  document.body.appendChild(d);
}

const probe = document.createElement('canvas').getContext('webgl2');
if (!probe) noWebGL('Your browser did not provide a WebGL 2 context.');
else if (!probe.getExtension('EXT_color_buffer_float')) noWebGL('Your graphics driver cannot render to floating-point textures, which the ocean simulation needs.');
else boot();

function boot() {
  const world = new World(gl);
  const audio = new Audio();
  const game = new Game(world, audio);
  const crew = new CrewDirector(world, audio);
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
  const portraits = new LivingPortraits();
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
  addEventListener('mousemove', (e) => game.onMouseMove(e));
  addEventListener('mousedown', (e) => game.onMouseDown(e));
  addEventListener('mouseup', () => { game.dragLook = false; });
  addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('blur', () => { game.keys = {}; });

  let last = performance.now(), shown = false;
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    game.update(dt);
    world.update(game.worldDt(dt), game.input());
    if (!window.__noRender) world.render();
    game.draw(ctx, dpr);
    portraits.update(now, world.sky.flash);
    if (!shown) { shown = true; setTimeout(() => document.getElementById('loading').classList.add('done'), 300); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
