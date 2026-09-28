// Builds the shareable website for GitHub Pages (or any static host) into site/:
//   site/index.html            the whole game in one file (three.js, art, models, clips)
//   site/music/pirate-music.mp4  the background music, streamed next to it
// Everything is relative, so it works at https://<user>.github.io/<repo>/ or any other address.
import { execSync } from 'child_process';
import fs from 'fs';

const music = 'public/assets/music/pirate-music.mp4';
execSync('node scripts/build-single.mjs', {
  stdio: 'inherit',
  env: { ...process.env, CG_MUSIC_URL: fs.existsSync(music) ? 'music/pirate-music.mp4' : '' },
});
fs.rmSync('site', { recursive: true, force: true });
fs.mkdirSync('site/music', { recursive: true });
fs.copyFileSync('dist-single/captains-gambit.html', 'site/index.html');
if (fs.existsSync(music)) fs.copyFileSync(music, 'site/music/pirate-music.mp4');
fs.writeFileSync('site/.nojekyll', '');   // serve files as-is (no Jekyll processing)
const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(2);
console.log(`site/ ready: index.html ${mb('site/index.html')} MB${fs.existsSync(music) ? `, music ${mb('site/music/pirate-music.mp4')} MB` : ' (no music file found)'}`);
