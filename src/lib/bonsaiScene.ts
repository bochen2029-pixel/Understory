// Surprisal bonsai — a Three.js scene that grows a bonsai from a run's per-token
// uncertainty. The trunk smolders red (emissive + bloom) and sprouts ember
// branches exactly where the model was least certain; confident stretches stay
// woody-brown with serene green foliage pads. Geometry derives from the signal;
// only the pot and green pads are garnish. Aesthetic (AgX tone-mapping, emissive
// bloom, dark studio) borrows from the Booster-sim renderer notes.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export interface TreeToken {
  token?: string;
  surprisal: number;
  entropy: number;
  margin: number;
}

export interface HoverInfo {
  token: string;
  surprisal: number;
  x: number;
  y: number;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

function rampRGB(s: number): [number, number, number] {
  const t = Math.min(Math.max(s / 3, 0), 1);
  const g: [number, number, number] = [0.31, 0.66, 0.36];
  const a: [number, number, number] = [0.86, 0.7, 0.34];
  const r: [number, number, number] = [0.87, 0.3, 0.27];
  if (t < 0.5) {
    const u = t / 0.5;
    return [lerp(g[0], a[0], u), lerp(g[1], a[1], u), lerp(g[2], a[2], u)];
  }
  const u = (t - 0.5) / 0.5;
  return [lerp(a[0], r[0], u), lerp(a[1], r[1], u), lerp(a[2], r[2], u)];
}

/** Same surprisal → color ramp, as a CSS string (for the caption/legend). */
export function rampCss(s: number): string {
  const [r, g, b] = rampRGB(s).map((v) => Math.round(v * 255));
  return `rgb(${r},${g},${b})`;
}

const rampColor = (s: number) => new THREE.Color(...rampRGB(s));
const glow = (s: number) => Math.pow(Math.min(Math.max((s - 0.7) / 2.3, 0), 1), 1.15) * 2.4;

export class BonsaiScene {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private composer: EffectComposer;
  private tree: THREE.Group | null = null;
  private hoverables: THREE.Object3D[] = [];
  private raf = 0;
  private running = false;
  private ray = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private onHover: (info: HoverInfo | null) => void;
  private onPointer: (e: PointerEvent) => void;
  private builtLen = -1;
  private readonly POT_TOP = 0.82;

  constructor(canvas: HTMLCanvasElement, onHover: (info: HoverInfo | null) => void) {
    this.onHover = onHover;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.0;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0d0b);
    scene.fog = new THREE.Fog(0x0a0d0b, 9, 26);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(4.6, 3.0, 6.4);
    this.camera = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 2.1, 0);
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.minDistance = 3;
    controls.maxDistance = 16;
    this.controls = controls;

    scene.add(new THREE.HemisphereLight(0x9fb6c8, 0x0a0d0b, 0.35));
    const key = new THREE.DirectionalLight(0xfff4e6, 1.5);
    key.position.set(5, 9, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fa0ff, 0.7);
    rim.position.set(-6, 4, -5);
    scene.add(rim);
    const fill = new THREE.PointLight(0xffe9c8, 0.5, 40);
    fill.position.set(0, 3, 6);
    scene.add(fill);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(40, 64),
      new THREE.MeshStandardMaterial({ color: 0x11150f, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const grid = new THREE.GridHelper(40, 40, 0x1c2a1c, 0x141d14);
    grid.position.y = 0.002;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    scene.add(grid);

    const potMat = new THREE.MeshStandardMaterial({ color: 0x21385e, roughness: 0.35, metalness: 0.1 });
    const potBody = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.25, 0.75, 48), potMat);
    potBody.position.y = 0.42;
    scene.add(potBody);
    const potRim = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.13, 16, 48), potMat);
    potRim.rotation.x = Math.PI / 2;
    potRim.position.y = 0.8;
    scene.add(potRim);
    const soil = new THREE.Mesh(
      new THREE.CircleGeometry(1.42, 48),
      new THREE.MeshStandardMaterial({ color: 0x0e0f0c, roughness: 1 }),
    );
    soil.rotation.x = -Math.PI / 2;
    soil.position.y = 0.81;
    scene.add(soil);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.62, 0.5, 0.82));
    composer.addPass(new OutputPass());
    this.composer = composer;

    this.onPointer = (e: PointerEvent) => this.pick(e);
    renderer.domElement.addEventListener('pointermove', this.onPointer);
  }

  /** Rebuild the tree from tokens (skips if the count is unchanged). */
  setTokens(tokens: TreeToken[]) {
    if (tokens.length === this.builtLen) return;
    this.builtLen = tokens.length;
    if (this.tree) {
      this.scene.remove(this.tree);
      this.tree.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      this.tree = null;
    }
    this.hoverables = [];
    if (!tokens.length) return;
    this.tree = this.build(tokens);
    this.scene.add(this.tree);
  }

  private cylinderBetween(a: THREE.Vector3, b: THREE.Vector3, rTop: number, rBot: number, mat: THREE.Material) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBot, len, 10, 1), mat);
    m.position.copy(a).addScaledVector(dir, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
    return m;
  }

  private woodMat(s: number) {
    return new THREE.MeshStandardMaterial({
      color: 0x4a3526,
      roughness: 0.85,
      emissive: new THREE.Color(0xff3a1e),
      emissiveIntensity: glow(s),
    });
  }

  private blossom(center: THREE.Vector3, radius: number, base: THREE.Color, emI: number, count: number) {
    const g = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const size = 0.1 + Math.random() * 0.13;
      const col = base.clone().offsetHSL(0, (Math.random() - 0.5) * 0.05, (Math.random() - 0.5) * 0.12);
      const mat = new THREE.MeshStandardMaterial({
        color: col,
        roughness: 0.55,
        flatShading: true,
        emissive: base,
        emissiveIntensity: emI,
      });
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0), mat);
      b.position.set(
        center.x + (Math.random() - 0.5) * radius * 2,
        center.y + (Math.random() - 0.5) * radius * 1.3,
        center.z + (Math.random() - 0.5) * radius * 2,
      );
      g.add(b);
    }
    return g;
  }

  private build(tokens: TreeToken[]) {
    const n = tokens.length;
    const group = new THREE.Group();
    const segLen = Math.min(Math.max(3.4 / n, 0.1), 0.46);
    const rBase = 0.26;
    const rTip = 0.05;

    let pos = new THREE.Vector3(0, this.POT_TOP, 0);
    let dir = new THREE.Vector3(0.16, 1, 0.05).normalize();
    const pts: THREE.Vector3[] = [pos.clone()];

    for (let i = 0; i < n; i++) {
      const tk = tokens[i];
      const bend = Math.min(tk.entropy, 1.5) * 0.42;
      const axis = new THREE.Vector3(Math.sin(i * 1.7), 0.25, Math.cos(i * 1.3)).normalize();
      dir.applyAxisAngle(axis, bend * (i % 2 ? 1 : -1));
      dir.y = Math.max(dir.y, 0.6);
      dir.normalize();
      const next = pos.clone().addScaledVector(dir, segLen);

      const rB = lerp(rBase, rTip, i / n);
      const rT = lerp(rBase, rTip, (i + 1) / n);
      const seg = this.cylinderBetween(pos, next, rT, rB, this.woodMat(tk.surprisal));
      seg.userData = { token: tk.token ?? '', surprisal: tk.surprisal };
      group.add(seg);
      this.hoverables.push(seg);

      if (tk.surprisal > 0.8) {
        const side = new THREE.Vector3(Math.cos(i * 2.3), 0, Math.sin(i * 2.3)).normalize();
        const bdir = side.clone().addScaledVector(new THREE.Vector3(0, 1, 0), 0.5).normalize();
        const blen = 0.5 + Math.min(tk.surprisal, 4) * 0.28;
        const btip = next.clone().addScaledVector(bdir, blen);
        const bmat = this.woodMat(tk.surprisal);
        bmat.emissiveIntensity = Math.max(glow(tk.surprisal), 0.8);
        const br = this.cylinderBetween(next, btip, 0.035, 0.09, bmat);
        br.userData = { token: tk.token ?? '', surprisal: tk.surprisal };
        group.add(br);
        this.hoverables.push(br);
        group.add(
          this.blossom(
            btip,
            0.28 + Math.min(tk.surprisal, 4) * 0.05,
            rampColor(Math.max(tk.surprisal, 1.6)),
            Math.max(glow(tk.surprisal), 1.0),
            14 + Math.floor(tk.surprisal * 4),
          ),
        );
      }
      pts.push(next.clone());
      pos = next;
    }

    const padColor = new THREE.Color(0xd7e6cb);
    for (const frac of [0.55, 0.75, 0.95]) {
      const idx = Math.min(pts.length - 1, Math.max(1, Math.round(frac * (pts.length - 1))));
      group.add(this.blossom(pts[idx], 0.62, padColor, 0.12, 34));
    }
    return group;
  }

  private pick(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.ray.setFromCamera(this.mouse, this.camera);
    const hit = this.ray.intersectObjects(this.hoverables, false)[0];
    if (hit && (hit.object.userData as { token?: string }).token !== undefined) {
      const u = hit.object.userData as { token: string; surprisal: number };
      this.onHover({ token: u.token, surprisal: u.surprisal, x: e.clientX, y: e.clientY });
    } else {
      this.onHover(null);
    }
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.controls.update();
      this.composer.render();
    };
    loop();
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    this.renderer.domElement.removeEventListener('pointermove', this.onPointer);
    this.setTokens([]);
    this.controls.dispose();
    this.composer.dispose?.();
    this.renderer.dispose();
  }
}
