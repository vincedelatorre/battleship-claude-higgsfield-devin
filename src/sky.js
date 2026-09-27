// sky.js - storm sky dome (wind-driven cloud decks lit from inside by lightning) and
// branching lightning bolts rendered as glowing tubes that the bloom pass picks up.
import * as THREE from 'three';
import { SKY_GLSL } from './ocean.js';

const SKY_VS = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
  vec4 p = projectionMatrix * viewMatrix * vec4((modelMatrix * vec4(position, 1.0)).xyz, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FS = /* glsl */ `
varying vec3 vDir;
${SKY_GLSL}
void main() {
  vec3 d = normalize(vDir);
  vec3 c = d.y < 0.0 ? horizonColor(d) : stormSky(d, true);
  gl_FragColor = vec4(c, 1.0);
}`;

export class StormSky {
  constructor(sharedUniforms) {
    this.uniforms = {
      uTime: sharedUniforms.uTime, uFlash: sharedUniforms.uFlash,
      uFlashDir: sharedUniforms.uFlashDir, uSunDir: sharedUniforms.uSunDir,
    };
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(8000, 48, 24),
      new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false }),
    );
    this.mesh.renderOrder = -10;
    this.mesh.frustumCulled = false;
    this.bolts = [];
    this.group = new THREE.Group();
    this.boltMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 7, 12), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    this.flash = 0;
    this.flicker = [];
  }

  // A jagged bolt from the cloud base to the sea, with a few forked branches.
  strike(origin, rng = Math.random) {
    const pts = [];
    const top = origin.clone().setY(1300 + rng() * 300);
    const bottom = origin.clone().add(new THREE.Vector3((rng() - 0.5) * 400, 0, (rng() - 0.5) * 400)).setY(0);
    const segs = 26;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = top.clone().lerp(bottom, t);
      const j = (1 - Math.abs(t - 0.5) * 1.2) * 80;
      if (i > 0 && i < segs) p.add(new THREE.Vector3((rng() - 0.5) * j, (rng() - 0.5) * 30, (rng() - 0.5) * j));
      pts.push(p);
    }
    const meshes = [];
    const addTube = (points, radius) => {
      const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.0);
      const m = new THREE.Mesh(new THREE.TubeGeometry(curve, points.length * 3, radius, 5, false), this.boltMat);
      m.frustumCulled = false;
      this.group.add(m);
      meshes.push(m);
    };
    addTube(pts, 3.2);
    for (let b = 0; b < 4; b++) {
      const start = 3 + Math.floor(rng() * (segs - 10));
      const branch = [pts[start].clone()];
      const dir = new THREE.Vector3((rng() - 0.5) * 2, -1.2, (rng() - 0.5) * 2).normalize();
      for (let k = 1; k < 8; k++) branch.push(branch[k - 1].clone().add(dir.clone().multiplyScalar(40 + rng() * 40)).add(new THREE.Vector3((rng() - 0.5) * 40, 0, (rng() - 0.5) * 40)));
      addTube(branch, 1.4);
    }
    this.bolts.push({ meshes, life: 0.32 });
    this.flash = 1;
    this.flicker = [0.08, 0.17];
    this.uniforms.uFlashDir.value.copy(origin.clone().setY(900)).normalize();
  }

  update(dt, cameraPos) {
    this.mesh.position.copy(cameraPos);
    for (const b of this.bolts) b.life -= dt;
    for (const b of this.bolts.filter((q) => q.life <= 0)) for (const m of b.meshes) { this.group.remove(m); m.geometry.dispose(); }
    this.bolts = this.bolts.filter((q) => q.life > 0);
    this.boltMat.opacity = this.bolts.length ? 0.6 + 0.4 * Math.sin(performance.now() * 0.09) : 0;
    this.flicker = this.flicker.map((f) => f - dt);
    if (this.flicker.length && this.flicker[0] <= 0) { this.flicker.shift(); this.flash = Math.max(this.flash, 0.7); }
    this.flash = Math.max(0, this.flash - dt * 5);
    this.uniforms.uFlash.value = this.flash;
  }
}
