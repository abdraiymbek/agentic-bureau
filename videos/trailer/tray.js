// Camera tray from fixtures/rover/camera-tray.scad, rebuilt in three.js for the
// trailer's mechanical stage. Dimensions in millimetres; Y is up.
import * as THREE from 'three';

const P = {
  width: 62,
  depth: 44,
  thick: 2.5,
  wallH: 12,
  wallT: 2,
  slotW: 25,
  slotD: 9,
  holeD: 2.5,
  holeInset: 4,
};

function plateShape() {
  const { width: w, depth: d, slotW, slotD } = P;
  const s0 = (w - slotW) / 2;
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(s0, 0);
  s.lineTo(s0, slotD);
  s.lineTo(s0 + slotW, slotD);
  s.lineTo(s0 + slotW, 0);
  s.lineTo(w, 0);
  s.lineTo(w, d);
  s.lineTo(0, d);
  s.closePath();
  for (const x of [P.holeInset, w - P.holeInset])
    for (const y of [P.holeInset, d - P.holeInset]) {
      const h = new THREE.Path();
      h.absarc(x, y, P.holeD / 2, 0, Math.PI * 2, true);
      s.holes.push(h);
    }
  return s;
}

function wallShape() {
  const { width: w, depth: d, wallT: t } = P;
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(t, 0);
  s.lineTo(t, d - t);
  s.lineTo(w - t, d - t);
  s.lineTo(w - t, 0);
  s.lineTo(w, 0);
  s.lineTo(w, d);
  s.lineTo(0, d);
  s.closePath();
  return s;
}

function solid(shape, height, y0) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 28 });
  // Shape XY → world XZ (depth runs toward the viewer), extrusion → +Y.
  g.rotateX(-Math.PI / 2);
  g.translate(-P.width / 2, y0, P.depth / 2);
  return g;
}

export function createTray(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.localClippingEnabled = true;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, canvas.width / canvas.height, 1, 2000);

  const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
  const body = new THREE.MeshStandardMaterial({
    color: 0xc9ccd2,
    roughness: 0.62,
    metalness: 0.04,
    flatShading: true,
    side: THREE.DoubleSide,
    clippingPlanes: [clip],
  });
  const edge = new THREE.LineBasicMaterial({
    color: 0x3a3d44,
    transparent: true,
    opacity: 0.9,
    clippingPlanes: [clip],
  });

  const model = new THREE.Group();
  for (const g of [solid(plateShape(), P.thick, 0), solid(wallShape(), P.wallH, P.thick)]) {
    model.add(new THREE.Mesh(g, body));
    model.add(new THREE.LineSegments(new THREE.EdgesGeometry(g, 20), edge));
  }
  scene.add(model);

  const grid = new THREE.GridHelper(260, 26, 0x2a2d33, 0x1d1f23);
  grid.position.y = -0.05;
  scene.add(grid);

  // The scan plane that sweeps up while the render builds.
  const scan = new THREE.Group();
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      [
        [-36, -27],
        [36, -27],
        [36, 27],
        [-36, 27],
      ].map(([x, z]) => new THREE.Vector3(x, 0, z)),
    ),
    new THREE.LineBasicMaterial({ color: 0xcff36e, transparent: true }),
  );
  const fill = new THREE.Mesh(
    new THREE.PlaneGeometry(72, 54).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0xcff36e,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  scan.add(ring, fill);
  scene.add(scan);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x1b1c20, 1.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(70, 110, 90);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 0.7);
  rim.position.set(-90, 40, -70);
  scene.add(rim);

  const top = P.thick + P.wallH;

  return {
    /** azimuth in radians; build 0→1 sweeps the scan plane up through the part. */
    render({ azimuth, build, scanAlpha }) {
      const r = 158;
      const el = 0.52;
      camera.position.set(
        Math.sin(azimuth) * Math.cos(el) * r,
        Math.sin(el) * r + 6,
        Math.cos(azimuth) * Math.cos(el) * r,
      );
      camera.lookAt(0, 4.5, 0);
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
