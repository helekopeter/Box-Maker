import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { KRAFT } from './artwork';
import { foldedBounds, foldMatrices } from './geometry/fold';
import type { Dieline, Vec2 } from './types';

export interface SurfaceHit {
  panel: string;
  /** Point in sheet coordinates (mm). */
  sheet: Vec2;
}

/** Interactive three.js view of the folding box. */
export class BoxPreview {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
  private controls: OrbitControls;
  private group = new THREE.Group();
  private meshes = new Map<string, THREE.Mesh>();
  private ground: THREE.Mesh;
  private texture: THREE.CanvasTexture | null = null;
  private textureSize = '';
  private outside = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0, color: 0xffffff });
  private inside = new THREE.MeshStandardMaterial({ color: KRAFT, roughness: 0.9 });
  // Panel edges sit exactly in the plane of the neighbouring panel's face at every fold.
  // Push them back in the depth buffer so the faces always win instead of flickering.
  private edge = new THREE.MeshStandardMaterial({
    color: 0xa88550,
    roughness: 1,
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  });
  private dieline: Dieline | null = null;
  private thickness = 3;
  private progress = 1;
  private lidLift = 0;
  private needsRender = true;
  private animation: { from: number; to: number; start: number; dur: number; done?: () => void } | null = null;
  onProgress: (p: number) => void = () => {};

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8a894, 1.7));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(0.6, 1, 0.8).multiplyScalar(1000);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0002;
    sun.shadow.normalBias = 0.6;
    this.scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-1, 0.4, -0.6).multiplyScalar(1000);
    this.scene.add(fill);
    this.sun = sun;

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.18 }),
    );
    this.ground.receiveShadow = true;
    this.scene.add(this.ground, this.group);

    // Registered before OrbitControls so a decal drag can claim the pointer first.
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.pointer('down', e));
    el.addEventListener('pointermove', (e) => this.pointer(this.dragging ? 'move' : 'hover', e));
    el.addEventListener('pointerup', (e) => this.pointer('up', e));
    el.addEventListener('pointercancel', (e) => this.pointer('up', e));
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener('change', () => (this.needsRender = true));

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.loop();
  }

  private sun: THREE.DirectionalLight;

  get autoRotate() {
    return this.controls.autoRotate;
  }
  set autoRotate(v: boolean) {
    this.controls.autoRotate = v;
    this.controls.autoRotateSpeed = 1.5;
  }

  private hidden = true;

  private resize() {
    const visible = this.container.clientWidth > 0 && this.container.clientHeight > 0;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // A viewer created inside a hidden tab gets its real size later: aim the camera then.
    if (visible && this.hidden) this.frame();
    this.hidden = !visible;
    this.needsRender = true;
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    if (this.animation) {
      const a = this.animation;
      const k = Math.min(1, (performance.now() - a.start) / a.dur);
      this.setProgress(a.from + (a.to - a.from) * k);
      this.onProgress(this.progress);
      if (k >= 1) {
        this.animation = null;
        a.done?.();
      }
    }
    const changed = this.controls.update();
    if (changed || this.needsRender || this.controls.autoRotate) {
      this.renderer.render(this.scene, this.camera);
      this.needsRender = false;
    }
  };

  /** Rebuilds all panel meshes for a new dieline. */
  setDieline(d: Dieline, thickness: number, reframe: boolean) {
    this.dieline = d;
    this.thickness = thickness;
    for (const m of this.meshes.values()) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.meshes.clear();
    const t = Math.max(0.3, thickness);
    for (const p of d.panels) {
      const shape = new THREE.Shape(p.poly.map(([x, y]) => new THREE.Vector2(x, -y)));
      for (const hole of p.holes ?? []) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, -y))));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
      geo.translate(0, 0, -t);
      splitCaps(geo);
      // Outside UVs map straight onto the artwork canvas covering the whole sheet.
      const pos = geo.getAttribute('position');
      const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / d.width, 1 + pos.getY(i) / d.height);
      uv.needsUpdate = true;
      const mesh = new THREE.Mesh(geo, [this.outside, this.inside, this.edge]);
      mesh.matrixAutoUpdate = false;
      mesh.userData.panel = p.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.meshes.set(p.id, mesh);
      this.group.add(mesh);
    }
    this.updatePose();
    if (reframe) this.frame();
  }

  setArtwork(canvas: HTMLCanvasElement) {
    // A GPU texture can't change size, so start a fresh one whenever the canvas is resized.
    const sized = this.texture && this.textureSize === `${canvas.width}x${canvas.height}`;
    this.textureSize = `${canvas.width}x${canvas.height}`;
    if (!this.texture || this.texture.image !== canvas || !sized) {
      this.texture?.dispose();
      this.texture = new THREE.CanvasTexture(canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      this.outside.map = this.texture;
      this.outside.needsUpdate = true;
    } else {
      this.texture.needsUpdate = true;
    }
    this.needsRender = true;
  }

  setProgress(p: number) {
    this.progress = p;
    this.updatePose();
  }

  setLidLift(mm: number) {
    this.lidLift = mm;
    this.updatePose();
  }

  animateTo(to: number, dur = 2200, done?: () => void) {
    this.animation = { from: this.progress, to, start: performance.now(), dur: dur * Math.abs(to - this.progress), done };
  }

  stopAnimation() {
    this.animation = null;
  }

  private updatePose() {
    if (!this.dieline) return;
    const mats = foldMatrices(this.dieline, this.progress, { thickness: this.thickness, lidLift: this.lidLift });
    for (const [id, m] of mats) {
      const mesh = this.meshes.get(id);
      if (mesh) mesh.matrix.copy(m);
    }
    this.needsRender = true;
  }

  /** Points the camera at the box so both the flat sheet and the assembled box fit. */
  frame() {
    if (!this.dieline) return;
    const opts = { thickness: this.thickness, lidLift: this.lidLift };
    const folded = foldedBounds(this.dieline, 1, opts);
    const flat = foldedBounds(this.dieline, 0, opts);
    const size = folded.clone().union(flat).getSize(new THREE.Vector3());
    const fs = folded.getSize(new THREE.Vector3());
    const ff = flat.getSize(new THREE.Vector3());
    // Frame the assembled box, with enough room to mostly see the flat sheet too.
    const radius = Math.max(fs.length() * 0.62, Math.max(ff.x, ff.z) * 0.38);
    const target = folded.getCenter(new THREE.Vector3());
    // Fit the tighter of the two directions (narrow viewers are limited by their width).
    const dist = (radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05 / Math.min(1, this.camera.aspect);
    const dir = new THREE.Vector3(0.75, 0.6, 1).normalize();
    this.camera.position.copy(target).addScaledVector(dir, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(target);
    this.controls.update();

    const g = Math.max(size.x, size.z) * 6;
    this.ground.scale.set(g, 1, g);
    const cam = this.sun.shadow.camera;
    const s = Math.max(size.x, size.y, size.z);
    cam.left = cam.bottom = -s;
    cam.right = cam.top = s;
    cam.near = 10;
    cam.far = 4000;
    cam.updateProjectionMatrix();
    this.needsRender = true;
  }

  /**
   * Called for pointer events over the 3D view with the point on the box's printed
   * surface (panel + sheet coordinates), if any. Return true from 'down' to start a drag:
   * the camera stops orbiting and 'move' events follow until 'up'.
   */
  onPointer: (type: 'down' | 'move' | 'up' | 'hover', hit: SurfaceHit | null) => boolean | void = () => {};
  private dragging = false;
  private raycaster = new THREE.Raycaster();

  private pointer(type: 'down' | 'move' | 'up' | 'hover', e: PointerEvent) {
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    const hit = this.pick(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    if (type === 'down') {
      if (e.button !== 0) return;
      if (this.onPointer('down', hit) === true) {
        this.dragging = true;
        this.controls.enabled = false;
        el.setPointerCapture(e.pointerId);
        el.style.cursor = 'grabbing';
      }
    } else if (type === 'up') {
      if (!this.dragging) return;
      this.dragging = false;
      this.controls.enabled = true;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.style.cursor = '';
      this.onPointer('up', hit);
    } else if (type === 'move') {
      this.onPointer('move', hit);
    } else if (e.buttons === 0) {
      el.style.cursor = this.onPointer('hover', hit) === true ? 'grab' : '';
    }
  }

  /** The printed outside surface under a point in normalised device coordinates. */
  pick(x: number, y: number): SurfaceHit | null {
    this.group.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const hits = this.raycaster.intersectObjects(this.group.children, false);
    const hit = hits[0];
    if (!hit || hit.face?.materialIndex !== 0) return null;
    const local = hit.point.clone().applyMatrix4(hit.object.matrixWorld.clone().invert());
    return { panel: hit.object.userData.panel as string, sheet: [local.x, -local.y] };
  }

  snapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}

/**
 * ExtrudeGeometry puts both caps in material group 0. Split it so the outside cap (z = 0)
 * uses material 0, the inside cap (z = -t) material 1 and the side walls material 2.
 */
function splitCaps(geo: THREE.ExtrudeGeometry) {
  const pos = geo.getAttribute('position');
  const [caps, sides] = geo.groups;
  geo.clearGroups();
  const tri = (i: number) => pos.getZ(caps.start + i * 3);
  const triCount = caps.count / 3;
  const runs: [number, number, number][] = [];
  for (let i = 0; i < triCount; i++) {
    const mat = tri(i) < -1e-6 ? 1 : 0;
    const last = runs[runs.length - 1];
    if (last && last[2] === mat) last[1] += 3;
    else runs.push([caps.start + i * 3, 3, mat]);
  }
  for (const [s, c, m] of runs) geo.addGroup(s, c, m);
  if (sides) geo.addGroup(sides.start, sides.count, 2);
}
