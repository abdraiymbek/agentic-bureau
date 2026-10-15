/**
 * The three.js side of the viewport: one scene, rendered on demand, that outlives mesh,
 * overlay and tool changes so the camera never moves unless the person moves it.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeshBounds, ParsedMesh } from '../../lib/stl-parse';
import {
  STANDARD_VIEWS,
  boundsCenter,
  boundsRadius,
  drawnExtent,
  fitDistance,
  fitHalfHeight,
  gridHalfExtent,
  gridSpacing,
  keptBySection,
  orbitOffset,
  sectionCoordinate,
  sectionPlane,
  sideBySideShift,
  snapToVertex,
  unitsPerPixel,
  type PickedPoint,
  type SectionSetting,
  type StandardView,
  type Vec3,
} from '../../lib/viewport-math';

export interface SceneTheme {
  background: string;
  grid: string;
  gridMajor: string;
  axes: string;
  model: string;
  compare: string;
  edge: string;
  sectionFill: string;
  outline: string;
  measure: string;
}

export type CompareMode = 'overlay' | 'side-by-side';

export interface ScreenPoint {
  x: number;
  y: number;
  /** In front of the camera and inside the viewport. */
  visible: boolean;
}

const FOV = 40;
const FIT_MARGIN = 1.12;
const SNAP_PIXELS = 12;
/** A tilt too small to see that keeps "up" defined when looking straight along Z. */
const POLE_TILT = 1e-4;
const NO_SECTION = new THREE.Plane(new THREE.Vector3(0, 0, -1), Number.MAX_SAFE_INTEGER);

function geometryOf(mesh: ParsedMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const { min, max } = mesh.bounds;
  geometry.boundingBox = new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(...boundsCenter(mesh.bounds)),
    boundsRadius(mesh.bounds),
  );
  return geometry;
}

function boxOutline(bounds: MeshBounds): Float32Array {
  const [x0, y0, z0] = bounds.min;
  const [x1, y1, z1] = bounds.max;
  const c: Vec3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const pairs = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
  return Float32Array.from(pairs.flatMap((i) => c[i]!));
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const drawable = child as THREE.Mesh | THREE.LineSegments;
    drawable.geometry?.dispose();
    const material = drawable.material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) m.dispose();
  });
}

export class ViewportScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly perspective = new THREE.PerspectiveCamera(FOV, 1, 0.1, 5000);
  private readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.perspective;
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly raycaster = new THREE.Raycaster();
  private readonly section = NO_SECTION.clone();
  private sectionSetting: SectionSetting | null = null;
  private frame = 0;
  private theme: SceneTheme;
  private width = 1;
  private height = 1;
  private orthoHalfHeight = 1;

  private part: ParsedMesh | null = null;
  private partMesh: THREE.Mesh | null = null;
  private partFill: THREE.Mesh | null = null;
  private partEdges: THREE.LineSegments | null = null;
  private compare: ParsedMesh | null = null;
  private compareMesh: THREE.Mesh | null = null;
  private compareMode: CompareMode = 'overlay';
  private grid: THREE.GridHelper | null = null;
  private axes: THREE.AxesHelper | null = null;
  private boundsBox: THREE.LineSegments | null = null;
  private sectionOutline: THREE.LineLoop | null = null;
  private measureLine: THREE.Line | null = null;
  private show = { grid: true, edges: true, wireframe: false, bounds: false };

  // Scratch values reused by every frame and every pick.
  private readonly v = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly pointer = new THREE.Vector2();

  constructor(
    private readonly container: HTMLElement,
    theme: SceneTheme,
    private readonly events: {
      /** Called after each rendered frame, so overlays can follow the camera. */
      onFrame: () => void;
      onContextLost: () => void;
    },
  ) {
    this.theme = theme;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost);
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(theme.background);

    // Neutral light from fixed directions: the part's colour is the theme's, never the lamp's.
    const white = new THREE.Color(1, 1, 1);
    const key = new THREE.DirectionalLight(white, 2.4);
    key.position.set(4, -6, 8);
    const rim = new THREE.DirectionalLight(white, 0.8);
    rim.position.set(-6, 4, -3);
    const sky = new THREE.HemisphereLight(white, new THREE.Color(0.33, 0.33, 0.33), 2.1);
    this.scene.add(sky, key, rim);

    for (const camera of [this.perspective, this.orthographic]) {
      camera.up.set(0, 0, 1);
      camera.position.set(80, -80, 80);
      camera.lookAt(0, 0, 0);
    }
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.enableZoom = false;
    this.controls.addEventListener('change', this.cameraMoved);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.frame = -1;
    this.resizeObserver.disconnect();
    this.controls.removeEventListener('change', this.cameraMoved);
    this.controls.dispose();
    disposeObject(this.scene);
    this.renderer.domElement.removeEventListener('webglcontextlost', this.contextLost);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }

  private contextLost = (event: Event) => {
    event.preventDefault();
    this.events.onContextLost();
  };

  private cameraMoved = () => {
    this.updateClip();
    this.invalidate();
  };

  /** Draw one frame soon. Any number of calls before it is drawn cost one frame. */
  invalidate() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw() {
    this.renderer.render(this.scene, this.camera);
    this.events.onFrame();
  }

  private resize() {
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(this.width, this.height);
    this.applyProjection();
    // Resizing clears the canvas; drawing in the same turn keeps it from flashing empty.
    this.draw();
  }

  private applyProjection() {
    const aspect = this.width / this.height;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    this.orthographic.left = -this.orthoHalfHeight * aspect;
    this.orthographic.right = this.orthoHalfHeight * aspect;
    this.orthographic.top = this.orthoHalfHeight;
    this.orthographic.bottom = -this.orthoHalfHeight;
    this.orthographic.updateProjectionMatrix();
  }

  /* ------------------------------ content ------------------------------ */

  /** Everything that is drawn, as one envelope. Null while there is no part. */
  private extent(): MeshBounds | null {
    return this.part
      ? drawnExtent(
          this.part.bounds,
          this.compare?.bounds ?? null,
          this.compareMode === 'side-by-side',
        )
      : null;
  }

  private compareOffset(): number {
    return this.part && this.compare ? sideBySideShift(this.part.bounds, this.compare.bounds) : 0;
  }

  /**
   * Show a part. The first one is framed; replacing it keeps the camera where the person
   * left it, so two revisions can be compared from the same angle.
   */
  setMesh(mesh: ParsedMesh | null) {
    if (mesh === this.part) return;
    const first = !this.part;
    for (const object of [this.partMesh, this.partFill, this.partEdges, this.boundsBox]) {
      if (!object) continue;
      this.scene.remove(object);
      disposeObject(object);
    }
    this.partMesh = this.partFill = this.partEdges = this.boundsBox = null;
    this.part = mesh;
    if (mesh) {
      const geometry = geometryOf(mesh);
      this.partMesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color: this.theme.model,
          roughness: 0.55,
          metalness: 0.1,
          flatShading: true,
          wireframe: this.show.wireframe,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
          clippingPlanes: [this.section],
        }),
      );
      // Inside faces are only ever seen through a section: they read as the cut surface.
      this.partFill = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          color: this.theme.sectionFill,
          side: THREE.BackSide,
          clippingPlanes: [this.section],
        }),
      );
      this.partFill.visible = !!this.sectionSetting;
      const edges = new THREE.BufferGeometry();
      edges.setAttribute('position', new THREE.BufferAttribute(mesh.edges, 3));
      this.partEdges = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: this.theme.edge, clippingPlanes: [this.section] }),
      );
      this.partEdges.visible = this.show.edges;
      const box = new THREE.BufferGeometry();
      box.setAttribute('position', new THREE.BufferAttribute(boxOutline(mesh.bounds), 3));
      this.boundsBox = new THREE.LineSegments(
        box,
        new THREE.LineBasicMaterial({ color: this.theme.outline }),
      );
      this.boundsBox.visible = this.show.bounds;
      this.scene.add(this.partMesh, this.partFill, this.partEdges, this.boundsBox);
    }
    this.setMeasure([]);
    this.placeCompare();
    this.rebuildGround();
    this.applySection();
    if (mesh && first) this.setView('iso');
    else this.updateClip();
    this.invalidate();
  }

  setCompare(mesh: ParsedMesh | null, mode: CompareMode) {
    if (mesh !== this.compare) {
      if (this.compareMesh) {
        this.scene.remove(this.compareMesh);
        disposeObject(this.compareMesh);
        this.compareMesh = null;
      }
      this.compare = mesh;
      if (mesh) {
        this.compareMesh = new THREE.Mesh(
          geometryOf(mesh),
          new THREE.MeshStandardMaterial({
            color: this.theme.compare,
            roughness: 0.6,
            metalness: 0.05,
            flatShading: true,
            clippingPlanes: [this.section],
          }),
        );
        this.scene.add(this.compareMesh);
      }
    }
    this.compareMode = mode;
    this.placeCompare();
    this.rebuildGround();
    this.updateClip();
    this.invalidate();
  }

  private placeCompare() {
    if (!this.compareMesh) return;
    const overlay = this.compareMode === 'overlay';
    const material = this.compareMesh.material as THREE.MeshStandardMaterial;
    // Overlaid, the comparison is a ghost that never hides the part it is laid over.
    material.transparent = overlay;
    material.opacity = overlay ? 0.4 : 1;
    material.depthWrite = !overlay;
    material.polygonOffset = overlay;
    material.polygonOffsetFactor = 2;
    material.polygonOffsetUnits = 2;
    material.needsUpdate = true;
    this.compareMesh.renderOrder = overlay ? 1 : 0;
    this.compareMesh.position.set(overlay ? 0 : this.compareOffset(), 0, 0);
  }

  /** Grid and axes sized to what is shown, on the model's own XY plane through the origin. */
  private rebuildGround() {
    for (const object of [this.grid, this.axes]) {
      if (!object) continue;
      this.scene.remove(object);
      disposeObject(object);
    }
    this.grid = this.axes = null;
    const extent = this.extent();
    if (!extent) return;
    const step = gridSpacing(extent);
    const half = gridHalfExtent(extent, step);
    this.grid = new THREE.GridHelper(
      half * 2,
      Math.min(400, Math.round((half * 2) / step)),
      this.theme.gridMajor,
      this.theme.grid,
    );
    this.grid.rotation.x = Math.PI / 2;
    this.grid.visible = this.show.grid;
    this.axes = new THREE.AxesHelper(Math.max(step, boundsRadius(extent) * 0.35));
    this.axes.setColors(this.theme.axes, this.theme.axes, this.theme.axes);
    this.axes.visible = this.show.grid;
    this.scene.add(this.grid, this.axes);
  }

  setTheme(theme: SceneTheme) {
    this.theme = theme;
    this.scene.background = new THREE.Color(theme.background);
    (this.partMesh?.material as THREE.MeshStandardMaterial | undefined)?.color.set(theme.model);
    (this.partFill?.material as THREE.MeshBasicMaterial | undefined)?.color.set(theme.sectionFill);
    (this.partEdges?.material as THREE.LineBasicMaterial | undefined)?.color.set(theme.edge);
    (this.boundsBox?.material as THREE.LineBasicMaterial | undefined)?.color.set(theme.outline);
    (this.compareMesh?.material as THREE.MeshStandardMaterial | undefined)?.color.set(
      theme.compare,
    );
    (this.sectionOutline?.material as THREE.LineBasicMaterial | undefined)?.color.set(
      theme.outline,
    );
    (this.measureLine?.material as THREE.LineBasicMaterial | undefined)?.color.set(theme.measure);
    this.rebuildGround();
    this.invalidate();
  }

  setDisplay(show: { grid: boolean; edges: boolean; wireframe: boolean; bounds: boolean }) {
    this.show = show;
    if (this.grid) this.grid.visible = show.grid;
    if (this.axes) this.axes.visible = show.grid;
    if (this.partEdges) this.partEdges.visible = show.edges;
    if (this.boundsBox) this.boundsBox.visible = show.bounds;
    if (this.partMesh)
      (this.partMesh.material as THREE.MeshStandardMaterial).wireframe = show.wireframe;
    this.invalidate();
  }

  /* ------------------------------ section ------------------------------ */

  setSection(setting: SectionSetting | null) {
    this.sectionSetting = setting;
    this.applySection();
    this.invalidate();
  }

  private applySection() {
    if (this.sectionOutline) {
      this.scene.remove(this.sectionOutline);
      disposeObject(this.sectionOutline);
      this.sectionOutline = null;
    }
    const setting = this.sectionSetting;
    if (this.partFill) this.partFill.visible = !!setting;
    if (!setting || !this.part) {
      this.section.copy(NO_SECTION);
      return;
    }
    const plane = sectionPlane(this.part.bounds, setting);
    this.section.normal.set(...plane.normal);
    this.section.constant = plane.constant;
    // A frame around the envelope at the cut shows where the plane is, even in empty space.
    const { min, max } = this.part.bounds;
    const at = sectionCoordinate(this.part.bounds, setting);
    const corners: Vec3[] =
      setting.axis === 'x'
        ? [
            [at, min[1], min[2]],
            [at, max[1], min[2]],
            [at, max[1], max[2]],
            [at, min[1], max[2]],
          ]
        : setting.axis === 'y'
          ? [
              [min[0], at, min[2]],
              [max[0], at, min[2]],
              [max[0], at, max[2]],
              [min[0], at, max[2]],
            ]
          : [
              [min[0], min[1], at],
              [max[0], min[1], at],
              [max[0], max[1], at],
              [min[0], max[1], at],
            ];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(Float32Array.from(corners.flat()), 3),
    );
    this.sectionOutline = new THREE.LineLoop(
      geometry,
      new THREE.LineBasicMaterial({ color: this.theme.outline }),
    );
    this.scene.add(this.sectionOutline);
  }

  /* ------------------------------ measure ------------------------------ */

  setMeasure(points: Vec3[]) {
    if (this.measureLine) {
      this.scene.remove(this.measureLine);
      disposeObject(this.measureLine);
      this.measureLine = null;
    }
    if (points.length === 2) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(Float32Array.from(points.flat()), 3),
      );
      this.measureLine = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: this.theme.measure, depthTest: false }),
      );
      this.measureLine.renderOrder = 2;
      this.scene.add(this.measureLine);
    }
    this.invalidate();
  }

  /**
   * The point on the part under a pointer position, snapped to a mesh corner when one is
   * within a few pixels. Material hidden by the section cannot be picked.
   */
  pick(clientX: number, clientY: number): PickedPoint | null {
    if (!this.partMesh || !this.part) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const plane = this.sectionSetting ? sectionPlane(this.part.bounds, this.sectionSetting) : null;
    const hit = this.raycaster
      .intersectObject(this.partMesh, false)
      .find((h) => !plane || keptBySection([h.point.x, h.point.y, h.point.z], plane));
    if (!hit?.face) return null;
    const corner = (index: number): Vec3 => [
      this.part!.positions[index * 3]!,
      this.part!.positions[index * 3 + 1]!,
      this.part!.positions[index * 3 + 2]!,
    ];
    const tolerance =
      SNAP_PIXELS *
      unitsPerPixel({
        orthographic: this.camera === this.orthographic,
        fov: FOV,
        viewHeight: (this.orthoHalfHeight * 2) / this.orthographic.zoom,
        distance: hit.distance,
        viewportHeightPx: this.height,
      });
    return snapToVertex(
      [hit.point.x, hit.point.y, hit.point.z],
      [corner(hit.face.a), corner(hit.face.b), corner(hit.face.c)],
      tolerance,
    );
  }

  /* ------------------------------- camera ------------------------------ */

  get isOrthographic(): boolean {
    return this.camera === this.orthographic;
  }

  /** Scroll and pinch zoom are off until the person shows they mean the viewport. */
  setZoomEnabled(enabled: boolean) {
    this.controls.enableZoom = enabled;
  }

  /** Switch projection without moving the eye: the part keeps its apparent size. */
  setProjection(orthographic: boolean) {
    if (orthographic === this.isOrthographic) return;
    const from = this.camera;
    const distance = from.position.distanceTo(this.controls.target);
    const to = orthographic ? this.orthographic : this.perspective;
    to.quaternion.copy(from.quaternion);
    if (orthographic) {
      this.orthoHalfHeight = distance * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      this.orthographic.zoom = 1;
      to.position.copy(from.position);
    } else {
      const visibleHalf = this.orthoHalfHeight / this.orthographic.zoom;
      const eye = visibleHalf / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      this.v.copy(from.position).sub(this.controls.target).setLength(eye);
      to.position.copy(this.controls.target).add(this.v);
    }
    this.camera = to;
    this.controls.object = to;
    this.applyProjection();
    this.controls.update();
    this.updateClip();
    this.invalidate();
  }

  /** Frame everything that is drawn, looking from where the camera already is. */
  fit() {
    const extent = this.extent();
    if (!extent) return;
    this.v.copy(this.camera.position).sub(this.controls.target);
    if (this.v.lengthSq() === 0) this.v.set(1, -1, 1);
    this.frameFrom(extent, this.v.normalize());
  }

  setView(view: StandardView) {
    const extent = this.extent();
    if (!extent) return;
    const { from, up } = STANDARD_VIEWS[view];
    this.v.set(...from);
    if (Math.abs(from[2]) === 1) {
      this.v2.set(...up).multiplyScalar(-from[2] * POLE_TILT);
      this.v.add(this.v2).normalize();
    }
    this.frameFrom(extent, this.v);
  }

  private frameFrom(extent: MeshBounds, direction: THREE.Vector3) {
    const radius = Math.max(boundsRadius(extent), 1e-6) * FIT_MARGIN;
    const aspect = this.width / this.height;
    const distance = fitDistance(radius, FOV, aspect);
    this.controls.target.set(...boundsCenter(extent));
    this.camera.position.copy(this.controls.target).addScaledVector(direction, distance);
    this.orthoHalfHeight = fitHalfHeight(radius, aspect);
    this.orthographic.zoom = 1;
    this.applyProjection();
    this.controls.update();
    this.updateClip();
    this.invalidate();
  }

  /** Near and far planes follow the eye, so depth precision is spent on the part. */
  private updateClip() {
    const extent = this.extent();
    const reach = extent ? Math.max(boundsRadius(extent) * 4, 1) : 1000;
    const distance = this.camera.position.distanceTo(this.controls.target);
    if (this.camera === this.perspective) {
      this.perspective.near = Math.max(distance - reach, distance / 500, 1e-3);
      this.perspective.far = distance + reach;
    } else {
      this.orthographic.near = distance - reach;
      this.orthographic.far = distance + reach;
    }
    this.camera.updateProjectionMatrix();
  }

  /** Turn about the vertical axis and tilt, in radians. */
  orbit(azimuth: number, polar: number) {
    this.v.copy(this.camera.position).sub(this.controls.target);
    const next = orbitOffset([this.v.x, this.v.y, this.v.z], azimuth, polar);
    this.camera.position.copy(this.controls.target).add(this.v.set(...next));
    this.controls.update();
    this.cameraMoved();
  }

  /** Move the eye right and up by fractions of the view's own height. */
  pan(right: number, up: number) {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const viewHeight = this.isOrthographic
      ? (this.orthoHalfHeight * 2) / this.orthographic.zoom
      : 2 * distance * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    this.v.setFromMatrixColumn(this.camera.matrix, 0).multiplyScalar(right * viewHeight);
    this.v2.setFromMatrixColumn(this.camera.matrix, 1).multiplyScalar(up * viewHeight);
    this.v.add(this.v2);
    this.camera.position.add(this.v);
    this.controls.target.add(this.v);
    this.controls.update();
    this.cameraMoved();
  }

  /** Above 1 moves in, below 1 moves out. */
  zoom(factor: number) {
    if (this.isOrthographic) {
      this.orthographic.zoom = Math.max(1e-3, this.orthographic.zoom * factor);
      this.orthographic.updateProjectionMatrix();
    } else {
      this.v.copy(this.camera.position).sub(this.controls.target).divideScalar(factor);
      this.camera.position.copy(this.controls.target).add(this.v);
    }
    this.controls.update();
    this.cameraMoved();
  }

  /* ------------------------------ overlays ----------------------------- */

  /** A model point in CSS pixels from the viewport's top-left corner. */
  project(x: number, y: number, z: number, out: ScreenPoint): ScreenPoint {
    this.v.set(x, y, z).project(this.camera);
    out.x = ((this.v.x + 1) / 2) * this.width;
    out.y = ((1 - this.v.y) / 2) * this.height;
    out.visible =
      this.v.z > -1 && this.v.z < 1 && Math.abs(this.v.x) <= 1 && Math.abs(this.v.y) <= 1;
    return out;
  }

  /**
   * Where the name of the part or of the comparison belongs while they stand side by side:
   * above the middle of its top face. Null in any other layout.
   */
  projectName(which: 'part' | 'compare', out: ScreenPoint): ScreenPoint | null {
    if (!this.part || !this.compare || this.compareMode !== 'side-by-side') return null;
    const bounds = which === 'part' ? this.part.bounds : this.compare.bounds;
    const shift = which === 'part' ? 0 : this.compareOffset();
    return this.project(
      (bounds.min[0] + bounds.max[0]) / 2 + shift,
      (bounds.min[1] + bounds.max[1]) / 2,
      bounds.max[2],
      out,
    );
  }

  /** A model axis as a direction on screen (x right, y down), for the orientation triad. */
  axisOnScreen(axis: 0 | 1 | 2, out: { x: number; y: number; toward: number }) {
    this.v.set(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
    this.v.transformDirection(this.camera.matrixWorldInverse);
    out.x = this.v.x;
    out.y = -this.v.y;
    out.toward = this.v.z;
    return out;
  }
}
