/**
 * The camera tray from fixtures/rover/camera-tray.scad, rebuilt in three.js for the
 * introduction's mechanical stage: it builds up under a scan plane, then turns slowly.
 * Dimensions in millimetres; Y is up. Colours come from the theme's viewport tokens.
 */
import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { easeOutExpo } from './motion';

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

function solid(shape: THREE.Shape, height: number, y0: number) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 28,
  });
  // Shape XY → world XZ (depth runs toward the viewer), extrusion → +Y.
  g.rotateX(-Math.PI / 2);
  g.translate(-P.width / 2, y0, P.depth / 2);
  return g;
}

const token = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export default function TrayScene({
  theme,
  reduced,
}: {
  theme: 'dark' | 'light';
  reduced: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      // No WebGL here: the stage keeps its dimensions and parameters without the picture.
      return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.localClippingEnabled = true;
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(26, 1, 1, 2000);
    const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
    const body = new THREE.MeshStandardMaterial({
      color: new THREE.Color(token('--model-color', '#c9ccd2')),
      roughness: 0.62,
      metalness: 0.04,
      flatShading: true,
      side: THREE.DoubleSide,
      clippingPlanes: [clip],
    });
    const edge = new THREE.LineBasicMaterial({
      color: new THREE.Color(token('--canvas-grid-major', '#2a2d33')),
      transparent: true,
      opacity: 0.9,
      clippingPlanes: [clip],
    });
    const geometries = [solid(plateShape(), P.thick, 0), solid(wallShape(), P.wallH, P.thick)];
    const model = new THREE.Group();
    const edgeGeometries: THREE.BufferGeometry[] = [];
    for (const g of geometries) {
      model.add(new THREE.Mesh(g, body));
      const e = new THREE.EdgesGeometry(g, 20);
      edgeGeometries.push(e);
      model.add(new THREE.LineSegments(e, edge));
    }
    scene.add(model);

    const grid = new THREE.GridHelper(
      260,
      26,
      new THREE.Color(token('--canvas-grid-major', '#2a2d33')),
      new THREE.Color(token('--canvas-grid', '#1d1f23')),
    );
    grid.position.y = -0.05;
    scene.add(grid);

    // The scan plane that sweeps up while the part builds.
    const signal = new THREE.Color(token('--signal-stroke', '#cff36e'));
    const scan = new THREE.Group();
    const ringGeometry = new THREE.BufferGeometry().setFromPoints(
      [
        [-36, -27],
        [36, -27],
        [36, 27],
        [-36, 27],
      ].map(([x, z]) => new THREE.Vector3(x, 0, z)),
    );
    const ringMaterial = new THREE.LineBasicMaterial({ color: signal, transparent: true });
    const fillGeometry = new THREE.PlaneGeometry(72, 54).rotateX(-Math.PI / 2);
    const fillMaterial = new THREE.MeshBasicMaterial({
      color: signal,
      transparent: true,
      opacity: 0.08,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    scan.add(
      new THREE.LineLoop(ringGeometry, ringMaterial),
      new THREE.Mesh(fillGeometry, fillMaterial),
    );
    scene.add(scan);

    scene.add(new THREE.HemisphereLight(0xffffff, theme === 'dark' ? 0x1b1c20 : 0x9a9ca3, 1.35));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(70, 110, 90);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(-90, 40, -70);
    scene.add(rim);

    const top = P.thick + P.wallH;
    const size = () => {
      const box = canvas.parentElement?.getBoundingClientRect();
      const w = Math.max(1, Math.round(box?.width ?? 1));
      const h = Math.max(1, Math.round(box?.height ?? 1));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(size);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    size();

    const start = performance.now();
    let frame = 0;
    const draw = () => {
      const t = (performance.now() - start) / 1000;
      const build = reduced ? 1 : easeOutExpo(clamp01((t - 0.25) / 1.3));
      const scanAlpha = reduced ? 0 : clamp01(t / 0.25) * (1 - clamp01((t - 1.4) / 0.45));
      const azimuth = -0.95 + (reduced ? 0.2 : t * 0.2);
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
      ringMaterial.opacity = scanAlpha;
      fillMaterial.opacity = 0.08 * scanAlpha;
      scan.visible = scanAlpha > 0.002;
      renderer.render(scene, camera);
      // Under reduced motion the part is drawn complete and still.
      if (!reduced || t < 0.3) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const g of [...geometries, ...edgeGeometries, ringGeometry, fillGeometry]) g.dispose();
      for (const m of [body, edge, ringMaterial, fillMaterial]) m.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
    };
  }, [theme, reduced]);
  return (
    <canvas
      ref={ref}
      className="intro-tray"
      role="img"
      aria-label="Camera tray, 62 by 44 millimetres, 14.5 millimetres tall, with a camera slot and four mounting holes"
    />
  );
}
