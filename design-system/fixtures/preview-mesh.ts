/** Illustrative geometry for UI review only. No manufacturing or analysis claim. */
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
export function makePreviewMesh(): string {
  const group = new THREE.Group();
  const shape = new THREE.Shape();
  // Open camera slot and four mounting holes; Z is vertical in the fixture source.
  shape.moveTo(0, 0);
  shape.lineTo(18.5, 0);
  shape.lineTo(18.5, 9);
  shape.lineTo(43.5, 9);
  shape.lineTo(43.5, 0);
  shape.lineTo(62, 0);
  shape.lineTo(62, 44);
  shape.lineTo(0, 44);
  shape.closePath();
  for (const x of [4, 58])
    for (const y of [4, 40]) {
      const hole = new THREE.Path();
      hole.absarc(x, y, 1.25, 0, Math.PI * 2, true);
      shape.holes.push(hole);
    }
  group.add(
    new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, { depth: 2.5, bevelEnabled: false, curveSegments: 24 }),
    ),
  );
  for (const [width, depth, x, y] of [
    [2, 44, 1, 22],
    [2, 44, 61, 22],
    [58, 2, 31, 43],
  ]) {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(width, depth, 12));
    wall.position.set(x!, y!, 8.5);
    group.add(wall);
  }
  // Present Z-up geometry in the viewer's Y-up coordinate system.
  group.rotation.x = -Math.PI / 2;
  group.updateMatrixWorld(true);
  const result = new STLExporter().parse(group);
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    }
  });
  return result;
}
