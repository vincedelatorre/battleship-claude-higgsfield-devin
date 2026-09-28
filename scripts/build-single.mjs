// Builds one self-contained HTML file (the whole game, three.js included) for hosting
// anywhere or opening straight from disk. Portraits in public/assets/portraits are embedded.
import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

const out = 'dist-single/captains-gambit.html';
const res = await build({ entryPoints: ['src/main.js'], bundle: true, format: 'esm', minify: true, write: false, target: 'es2020', legalComments: 'none' });
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const assets = {};
const types = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
for (const dir of ['public/assets/portraits', 'public/assets/ui', 'public/assets/gambits', 'public/assets/wood']) {
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    const ext = path.extname(f).toLowerCase();
    if (types[ext]) assets[path.basename(f, ext)] = `data:${types[ext]};base64,` + fs.readFileSync(path.join(dir, f)).toString('base64');
  }
}
// Higgsfield performance clips, embedded as base64 (turned into blob URLs at runtime).
const videos = {};
const vdir = 'public/assets/video';
if (fs.existsSync(vdir)) for (const f of fs.readdirSync(vdir)) if (f.endsWith('.mp4')) videos[path.basename(f, '.mp4')] = fs.readFileSync(path.join(vdir, f)).toString('base64');
// Crew models, animation clips, the galleon and voice lines (public/assets/{crew,ship,voice}).
const bins = {};
for (const d of ['crew', 'ship', 'voice']) {
  const dir = `public/assets/${d}`;
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/\.(glb|ogg|mp3|wav)$/.test(f)) bins[`${d}/${f}`] = fs.readFileSync(path.join(dir, f)).toString('base64');
}
let html = fs.readFileSync('index.html', 'utf8');
const tag = '<script type="module" src="/src/main.js"></script>';
if (!html.includes(tag)) throw new Error('entry script tag not found in index.html');
html = html.replace(tag, () => `<script>window.CG_MUSIC_URL=${JSON.stringify(process.env.CG_MUSIC_URL || null)};window.CG_ASSETS=${JSON.stringify(assets)};window.CG_NO_FILES=true;window.CG_VIDEO_B64=${JSON.stringify(videos)};window.CG_BIN_B64=${JSON.stringify(bins)};</script>\n<script type="module">${js}</script>`);
fs.mkdirSync('dist-single', { recursive: true });
fs.writeFileSync(out, html);
console.log(`${out}: ${(html.length / 1e6).toFixed(2)} MB, ${Object.keys(assets).length} art files and ${Object.keys(videos).length} portrait clips and ${Object.keys(bins).length} crew/ship/voice files embedded`);
