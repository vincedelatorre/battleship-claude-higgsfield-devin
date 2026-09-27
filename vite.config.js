import { defineConfig } from 'vite';
import fs from 'fs';

// Lists the portrait clips in public/assets/video so the page only loads ones that exist.
const videoList = () => ({
  name: 'cg-video-list',
  transformIndexHtml() {
    const dir = 'public/assets/video';
    const keys = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).map((f) => f.slice(0, -4)) : [];
    const files = [];
    for (const d of ['crew', 'ship', 'voice']) if (fs.existsSync(`public/assets/${d}`)) for (const f of fs.readdirSync(`public/assets/${d}`)) files.push(`${d}/${f}`);
    return [{ tag: 'script', children: `window.CG_DEV_VIDEOS=${JSON.stringify(keys)};window.CG_DEV_FILES=${JSON.stringify(files)};`, injectTo: 'head-prepend' }];
  },
});

export default defineConfig({ base: './', plugins: [videoList()], server: { open: true }, build: { outDir: 'dist', chunkSizeWarningLimit: 2000 } });
