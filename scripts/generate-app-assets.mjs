// Generates every app icon and splash screen from the Higgsfield key art (public/assets/ui/title.jpg):
//   public/icons/                      PWA icons, apple-touch-icon, favicon (web + GitHub Pages)
//   ios/App/App/Assets.xcassets/       iOS app icon (1024, no alpha) and launch image
//   android/app/src/main/res/          launcher icons (legacy, round, adaptive foreground) and splash screens
// Run after changing the art: npm run assets
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const SRC = 'public/assets/ui/title.jpg';
const BG = '#04080a';
// The right-hand galleon under the lightning: the icon crop (in title.jpg pixels).
const ICON_CROP = { left: 724, top: 60, width: 620, height: 620 };

const out = (f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); return f; };
const iconBase = () => sharp(SRC).extract(ICON_CROP);
const square = (size) => iconBase().resize(size, size, { kernel: 'lanczos3' }).flatten({ background: BG }).removeAlpha();
const round = async (size) => {
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/></svg>`);
  return iconBase().resize(size, size).composite([{ input: mask, blend: 'dest-in' }]).png();
};
// Key art on a w x h canvas of the storm colour, top and bottom feathered into it. Landscape: the whole
// scene fitted to the width. Portrait: taller, cropped around the right-hand galleon under the lightning.
async function splash(w, h, file) {
  const land = w >= h;
  const aw = land ? w : Math.round(h * 0.62 * 1344 / 752), ah = land ? Math.round(w * 752 / 1344) : Math.round(h * 0.62);
  const cw = Math.min(aw, w), left = land ? 0 : Math.max(0, Math.min(aw - cw, Math.round(aw * 0.80 - cw / 2)));
  const fade = Buffer.from(`<svg width="${cw}" height="${ah}"><defs>
    <linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.14" stop-color="#fff"/><stop offset="0.86" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#v)"/></svg>`);
  const art = await sharp(SRC).resize(aw, ah).extract({ left, top: 0, width: cw, height: ah }).ensureAlpha()
    .composite([{ input: fade, blend: 'dest-in' }]).png().toBuffer();
  await sharp({ create: { width: w, height: h, channels: 3, background: BG } })
    .composite([{ input: art, left: Math.round((w - cw) / 2), top: Math.max(0, Math.round((h - ah) / 2)) }])
    .png({ palette: true, quality: 90, effort: 10, dither: 1 }).toFile(out(file));
}

// Web / PWA
await square(512).png().toFile(out('public/icons/icon-512.png'));
await square(192).png().toFile(out('public/icons/icon-192.png'));
await square(512).png().toFile(out('public/icons/icon-maskable-512.png'));
await square(180).png().toFile(out('public/icons/apple-touch-icon.png'));
await square(48).png().toFile(out('public/icons/favicon-48.png'));

// iOS
if (fs.existsSync('ios/App/App/Assets.xcassets')) {
  await square(1024).png().toFile('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
  const dir = 'ios/App/App/Assets.xcassets/Splash.imageset';
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.png')) fs.rmSync(path.join(dir, f));
  await splash(2732, 1536, `${dir}/splash.png`);
  fs.writeFileSync(`${dir}/Contents.json`, JSON.stringify({
    images: [{ idiom: 'universal', filename: 'splash.png', scale: '1x' }, { idiom: 'universal', scale: '2x' }, { idiom: 'universal', scale: '3x' }],
    info: { version: 1, author: 'xcode' },
  }, null, 2) + '\n');
}

// Android
const res = 'android/app/src/main/res';
if (fs.existsSync(res)) {
  const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
  for (const [d, k] of Object.entries(dens)) {
    await square(48 * k).png().toFile(`${res}/mipmap-${d}/ic_launcher.png`);
    await (await round(48 * k)).toFile(`${res}/mipmap-${d}/ic_launcher_round.png`);
    await square(108 * k).png().toFile(`${res}/mipmap-${d}/ic_launcher_foreground.png`);
  }
  const port = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
  for (const [d, [w, h]] of Object.entries(port)) {
    await splash(w, h, `${res}/drawable-port-${d}/splash.png`);
    await splash(h, w, `${res}/drawable-land-${d}/splash.png`);
  }
  await splash(480, 320, `${res}/drawable/splash.png`);
}
console.log('App icons and splash screens generated from', SRC);
