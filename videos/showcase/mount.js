// Sensor head mount for the survey quadcopter, the part the agent drafts in the
// showcase: a base plate with four M3 holes and a cable slot, and two yokes that
// carry the sensor head's pivot. Dimensions in millimetres; Y is up.
import * as THREE from 'three';

export const MOUNT = {
  plateW: 92,
  plateD: 64,
  plateT: 3,
  corner: 6,
  holeD: 3.2,
  holeX: 40,
  holeZ: 26,
  slotW: 30,
  slotD: 14,
  yokeT: 4,
  yokeW: 34,
  yokeH: 38,
  pivotD: 8,
};
const P = MOUNT;

function roundedRect(path, x, y, w, h, r) {
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  path.lineTo(x + w, y + h - r);
  path.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
  path.lineTo(x + r, y + h);
  path.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
  path.lineTo(x, y + r);
  path.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return path;
}

/** The plate in its own XY plane, centred on the origin. */
function plateShape() {
  const s = roundedRect(new THREE.Shape(), -P.plateW / 2, -P.plateD / 2, P.plateW, P.plateD, P.corner);
  for (const x of [-P.holeX, P.holeX])
    for (const y of [-P.holeZ, P.holeZ]) {
      const h = new THREE.Path();
      h.absarc(x, y, P.holeD / 2, 0, Math.PI * 2, true);
      s.holes.push(h);
    }
  s.holes.push(roundedRect(new THREE.Path(), -P.slotW / 2, -P.slotD / 2, P.slotW, P.slotD, P.slotD / 2));
  return s;
}

/** A yoke in its own XY plane: X across the plate depth, Y up from the plate. */
function yokeShape() {
  const r = P.yokeW / 2;
  const c = P.yokeH - r;
  const s = new THREE.Shape();
  s.moveTo(-r, 0);
  s.lineTo(r, 0);
  s.lineTo(r, c);
  s.absarc(0, c, r, 0, Math.PI, false);
  s.lineTo(-r, 0);
  const h = new THREE.Path();
  h.absarc(0, c, P.pivotD / 2, 0, Math.PI * 2, true);
  s.holes.push(h);
  return s;
}

function plateGeometry() {
  const g = new THREE.ExtrudeGeometry(plateShape(), { depth: P.plateT, bevelEnabled: false, curveSegments: 24 });
  g.rotateX(-Math.PI / 2); // shape XY → world XZ, extrusion → +Y
  return g;
}

function yokeGeometry(side) {
  const g = new THREE.ExtrudeGeometry(yokeShape(), { depth: P.yokeT, bevelEnabled: false, curveSegments: 32 });
  g.rotateY(Math.PI / 2); // shape X → world -Z, extrusion → +X
  const x = side > 0 ? P.plateW / 2 - P.yokeT : -P.plateW / 2;
  g.translate(x, P.plateT, 0);
  return g;
}

export function createMount(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.localClippingEnabled = true;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(24, canvas.width / canvas.height, 1, 3000);

  const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  const body = new THREE.MeshStandardMaterial({
    color: 0xc9ccd2,
    roughness: 0.62,
    metalness: 0.04,
    flatShading: true,
    side: THREE.DoubleSide,
    clippingPlanes: [clip],
  });
  const edge = new THREE.LineBasicMaterial({ color: 0x34373e, transparent: true, opacity: 0.9, clippingPlanes: [clip] });

  const model = new THREE.Group();
  for (const g of [plateGeometry(), yokeGeometry(1), yokeGeometry(-1)]) {
    model.add(new THREE.Mesh(g, body));
    model.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 20), edge));
  }
  scene.add(model);

  const grid = new THREE.GridHelper(400, 40, 0x2a2d33, 0x1d1f23);
  grid.position.y = -0.05;
  scene.add(grid);

  // The scan plane that rises through the part while its render builds.
  const scan = new THREE.Group();
  const hw = P.plateW / 2 + 6;
  const hd = P.plateD / 2 + 6;
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      [
        [-hw, -hd],
        [hw, -hd],
        [hw, hd],
        [-hw, hd],
      ].map(([x, z]) => new THREE.Vector3(x, 0, z)),
    ),
    new THREE.LineBasicMaterial({ color: 0xcff36e, transparent: true }),
  );
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(hw * 2, hd * 2).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xcff36e, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false }),
  );
  scan.add(ring, fill);
  scene.add(scan);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x1b1c20, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(90, 140, 110);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.7);
  rim.position.set(-110, 50, -90);
  scene.add(rim);

  const top = P.plateT + P.yokeH;

  return {
    /** azimuth in radians; build 0→1 sweeps the scan plane up through the part. */
    render({ azimuth, build, scanAlpha, distance = 255 }) {
      const el = 0.5;
      camera.position.set(
        Math.sin(azimuth) * Math.cos(el) * distance,
        Math.sin(el) * distance + 4,
        Math.cos(azimuth) * Math.cos(el) * distance,
      );
      camera.lookAt(0, 12, 0);
      const h = -0.2 + build * (top + 0.4);
      clip.constant = h;
      scan.position.y = h;
      ring.material.opacity = scanAlpha;
      fill.material.opacity = 0.08 * scanAlpha;
      scan.visible = scanAlpha > 0.002;
      renderer.render(scene, camera);
    },
  };
}
