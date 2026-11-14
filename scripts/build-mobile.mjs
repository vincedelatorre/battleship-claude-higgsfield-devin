// Builds the web bundle the native iOS / Android apps load (Capacitor webDir: dist/).
// Uses the Vite build rather than the single-file site: assets stay separate files in the app
// bundle, so the WebView streams the music and clips and loads models without decoding ~20 MB of
// base64 at start. The Google Fonts link is swapped for the bundled copies so the app works offline.
import { execSync } from 'child_process';
import fs from 'fs';

execSync('npx vite build', { stdio: 'inherit' });
const file = 'dist/index.html';
let html = fs.readFileSync(file, 'utf8');
const before = html;
html = html
  .replace(/<link rel="preconnect" href="https:\/\/fonts\.(googleapis|gstatic)\.com"[^>]*>\s*/g, '')
  .replace(/<link href="https:\/\/fonts\.googleapis\.com\/css2[^"]*" rel="stylesheet">/, '<link href="fonts/fonts.css" rel="stylesheet">');
if (html === before || html.includes('fonts.googleapis.com')) console.warn('build-mobile: Google Fonts link not found; fonts load from the network');
fs.writeFileSync(file, html);
for (const f of ['assets/music/pirate-music.mp4', 'fonts/fonts.css', 'manifest.webmanifest']) {
  if (!fs.existsSync(`dist/${f}`)) console.warn(`build-mobile: dist/${f} missing`);
}
console.log('dist/ ready for the native apps (npx cap sync copies it into ios/ and android/)');
