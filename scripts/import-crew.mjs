// Imports the Higgsfield-generated pirates and galleon into public/assets.
//   node scripts/import-crew.mjs [folder-with-downloads] [--tris 16000] [--tex 1024]
// Files are recognised by the Higgsfield job id in their name, so they can keep the names
// they were downloaded with. Textures are resized and re-encoded as JPEG, meshes simplified
// and quantized so the whole crew fits in the single-file game.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, simplify, weld, prune, dedup, meshopt, resample } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const JOBS = {
  '923fbfe0': ['crew', 'silas'], '94175b99': ['crew', 'rourke'], '5f9ec829': ['crew', 'harrow'],
  '10d9c10d': ['crew', 'kip'], '872f44ab': ['crew', 'seraphine'], '4b62964a': ['crew', 'tobias'],
  '115ff164': ['crew', 'garrick'], '33d4c39e': ['crew', 'jonah'], '7a2d17ca': ['ship', 'galleon'],
};
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) || '/mnt/user-data/uploads';
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
const TRIS = opt('tris', 16000), TEX = opt('tex', 1024);
const SHIP_TEX = opt('shiptex', 1024);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;
io.registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
let done = 0;
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.glb')) continue;
  const job = Object.keys(JOBS).find((id) => f.includes(id));
  if (!job) continue;
  const [kind, name] = JOBS[job];
  const doc = await io.read(path.join(dir, f));
  let tris = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
  // Characters come with their colour map also wired as emissive, which makes them glow as if
  // self-lit. Drop it so the scene's sun, lanterns and fires light them properly.
  for (const m of doc.getRoot().listMaterials()) {
    if (kind === 'crew' && m.getEmissiveTexture()) { m.setEmissiveTexture(null); m.setEmissiveFactor([0, 0, 0]); }
    if (kind === 'crew') { m.setRoughnessFactor(Math.max(m.getRoughnessFactor(), 0.75)); m.setMetallicFactor(Math.min(m.getMetallicFactor(), 0.1)); }
  }
  const target = kind === 'ship' ? TRIS * 2 : TRIS;
  const ratio = Math.min(1, target / Math.max(tris, 1));
  await doc.transform(
    dedup(), weld(), resample({ tolerance: 1e-4 }),
    ...(ratio < 0.98 ? [simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.012, lockBorder: false })] : []),
    textureCompress({ encoder: sharp, targetFormat: 'jpeg', resize: kind === 'ship' ? [SHIP_TEX, SHIP_TEX] : [TEX, TEX], quality: 86 }),
    // Detail maps (normal, roughness) at half the colour map's size.
    textureCompress({ encoder: sharp, targetFormat: 'jpeg', slots: /normal|metallicRoughness|occlusion/, resize: kind === 'ship' ? [SHIP_TEX / 2, SHIP_TEX / 2] : [TEX / 2, TEX / 2], quality: 84 }),
    prune(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const out = `public/assets/${kind}/${name}.glb`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await io.write(out, doc);
  console.log(`${name.padEnd(10)} ${String(tris | 0).padStart(6)} -> ~${Math.round(tris * ratio)} tris  ${(fs.statSync(out).size / 1e6).toFixed(2)} MB  ${out}`);
  done++;
}
console.log(done ? `${done} model(s) imported.` : `No Higgsfield pirate or galleon models found in ${dir}.`);
