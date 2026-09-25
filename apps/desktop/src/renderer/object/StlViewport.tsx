import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  ArrowsOut,
  ArrowCounterClockwise,
  BoundingBox,
  Cube,
  GridFour,
} from '@phosphor-icons/react';
import { useStore } from '../store';

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Renders the exact mesh bytes of one revision: orbit, pan, zoom, projection, grid,
 * wireframe, fit, and an optional baseline overlay. Measurements come from the mesh.
 */
export function StlViewport(props: {
  stlData: ArrayBuffer | null;
  compareData?: ArrayBuffer | null;
  modelUnit: string;
}) {
  const theme = useStore((s) => s.theme);
  const mount = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const compareRef = useRef<THREE.Mesh | null>(null);
  const gridRef = useRef<THREE.GridHelper | null>(null);
  const invalidateRef = useRef<() => void>(() => {});
  const makeCamRef =
    useRef<(ortho: boolean) => THREE.PerspectiveCamera | THREE.OrthographicCamera>();
  const [wireframe, setWireframe] = useState(false);
  const [ortho, setOrtho] = useState(false);
  const [gridOn, setGridOn] = useState(true);
  const [dims, setDims] = useState<[number, number, number] | null>(null);

  const buildGrid = (scene: THREE.Scene) => {
    if (gridRef.current) {
      scene.remove(gridRef.current);
      gridRef.current.geometry.dispose();
      (gridRef.current.material as THREE.Material).dispose();
    }
    const grid = new THREE.GridHelper(
      400,
      40,
      token('--canvas-grid-major'),
      token('--canvas-grid'),
    );
    grid.rotation.x = Math.PI / 2;
    grid.visible = gridOn;
    gridRef.current = grid;
    scene.add(grid);
  };

  useEffect(() => {
    if (!mount.current) return;
    const element = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(token('--canvas-bg'));
    sceneRef.current = scene;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    element.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    const hemi = new THREE.HemisphereLight('#eef1f6', '#50565f', 2.1);
    const key = new THREE.DirectionalLight('#ffffff', 2.4);
    key.position.set(4, 8, 6);
    const rim = new THREE.DirectionalLight('#dfe8ff', 0.8);
    rim.position.set(-6, -4, 3);
    scene.add(hemi, key, rim, new THREE.AxesHelper(20));
    buildGrid(scene);

    const size = () => ({
      w: Math.max(1, element.clientWidth),
      h: Math.max(1, element.clientHeight),
    });
    const makeCam = (orthographic: boolean) => {
      const { w, h } = size();
      const c = orthographic
        ? new THREE.OrthographicCamera((-60 * w) / h, (60 * w) / h, 60, -60, 0.1, 5000)
        : new THREE.PerspectiveCamera(40, w / h, 0.1, 5000);
      c.up.set(0, 0, 1);
      c.position.set(80, 60, 80);
      c.lookAt(0, 0, 0);
      return c;
    };
    makeCamRef.current = makeCam;
    cameraRef.current = makeCam(false);
    const controls = new OrbitControls(cameraRef.current, renderer.domElement);
    controls.enableDamping = false;
    controlsRef.current = controls;

    let raf = 0;
    const invalidate = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        renderer.render(scene, cameraRef.current!);
      });
    };
    invalidateRef.current = invalidate;
    controls.addEventListener('change', invalidate);
    const setSize = () => {
      const { w, h } = size();
      renderer.setSize(w, h);
      const cam = cameraRef.current;
      if (cam instanceof THREE.PerspectiveCamera) cam.aspect = w / h;
      else if (cam) {
        const half = (cam.top - cam.bottom) / 2;
        cam.left = (-half * w) / h;
        cam.right = (half * w) / h;
      }
      cam?.updateProjectionMatrix();
      invalidate();
    };
    const ro = new ResizeObserver(setSize);
    ro.observe(element);
    setSize();
    return () => {
      invalidateRef.current = () => {};
      cancelAnimationFrame(raf);
      controls.removeEventListener('change', invalidate);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          for (const m of Array.isArray(object.material) ? object.material : [object.material])
            m.dispose();
        }
      });
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      element.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.background = new THREE.Color(token('--canvas-bg'));
    buildGrid(scene);
    if (meshRef.current)
      (meshRef.current.material as THREE.MeshStandardMaterial).color.set(token('--model-color'));
    if (compareRef.current)
      (compareRef.current.material as THREE.MeshStandardMaterial).color.set(
        token('--model-compare'),
      );
    invalidateRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    const make = makeCamRef.current;
    if (!make) return;
    const old = cameraRef.current;
    const cam = make(ortho);
    if (old) cam.position.copy(old.position);
    cameraRef.current = cam;
    if (controlsRef.current) {
      controlsRef.current.object = cam;
      controlsRef.current.update();
    }
    fit();
  }, [ortho]);

  useEffect(() => {
    if (gridRef.current) gridRef.current.visible = gridOn;
    invalidateRef.current();
  }, [gridOn]);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    for (const ref of [meshRef, compareRef]) {
      if (ref.current) {
        scene.remove(ref.current);
        ref.current.geometry.dispose();
        (ref.current.material as THREE.Material).dispose();
        ref.current = null;
      }
    }
    if (!props.stlData) {
      setDims(null);
      invalidateRef.current();
      return;
    }
    const loader = new STLLoader();
    const geo = loader.parse(props.stlData);
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: token('--model-color'),
        roughness: 0.5,
        metalness: 0.15,
        wireframe,
      }),
    );
    meshRef.current = mesh;
    scene.add(mesh);
    const bb = geo.boundingBox!;
    setDims([bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z]);
    if (props.compareData) {
      const cmesh = new THREE.Mesh(
        loader.parse(props.compareData),
        new THREE.MeshStandardMaterial({
          color: token('--model-compare'),
          transparent: true,
          opacity: 0.42,
          wireframe,
        }),
      );
      compareRef.current = cmesh;
      scene.add(cmesh);
    }
    fit();
  }, [props.stlData, props.compareData, wireframe]);

  function fit() {
    const mesh = meshRef.current;
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    const renderer = rendererRef.current;
    if (!mesh || !cam || !controls || !renderer) return;
    const bb = mesh.geometry.boundingBox ?? new THREE.Box3().setFromObject(mesh);
    const center = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3()).length();
    const aspect = renderer.domElement.clientWidth / Math.max(renderer.domElement.clientHeight, 1);
    const d = Math.max(size, 1) * (aspect < 1.2 ? 1.9 : 1.5);
    cam.position.set(center.x + d * 0.72, center.y - d * 0.62, center.z + d * 0.55);
    if (cam instanceof THREE.OrthographicCamera) {
      cam.left = -size * aspect * 0.6;
      cam.right = size * aspect * 0.6;
      cam.top = size * 0.6;
      cam.bottom = -size * 0.6;
    }
    cam.near = d / 100;
    cam.far = d * 100;
    cam.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
    invalidateRef.current();
  }

  const reset = () => {
    cameraRef.current?.position.set(80, 60, 80);
    controlsRef.current?.target.set(0, 0, 0);
    controlsRef.current?.update();
    invalidateRef.current();
  };

  return (
    <div className="viewport">
      <div
        ref={mount}
        className="viewport-canvas"
        tabIndex={0}
        role="img"
        aria-label="Interactive 3D model. Arrow keys move the view, F fits the model, 0 resets it."
        onKeyDown={(e) => {
          const cam = cameraRef.current;
          if (!cam) return;
          const step = 10;
          if (e.key === 'ArrowLeft') cam.position.x -= step;
          if (e.key === 'ArrowRight') cam.position.x += step;
          if (e.key === 'ArrowUp') cam.position.y += step;
          if (e.key === 'ArrowDown') cam.position.y -= step;
          if (e.key === 'f' || e.key === 'F') fit();
          if (e.key === '0') reset();
          controlsRef.current?.update();
          invalidateRef.current();
        }}
      />
      <div className="viewport-tools island">
        <button type="button" onClick={fit} title="Fit model (F)" aria-label="Fit model">
          <ArrowsOut size={14} />
        </button>
        <button
          type="button"
          onClick={() => setOrtho((o) => !o)}
          aria-pressed={ortho}
          title="Orthographic projection"
        >
          <Cube size={14} />
          <span>{ortho ? 'Ortho' : 'Persp'}</span>
        </button>
        <button
          type="button"
          onClick={() => setWireframe((w) => !w)}
          aria-pressed={wireframe}
          title="Wireframe"
          aria-label="Wireframe"
        >
          <BoundingBox size={14} />
        </button>
        <button
          type="button"
          onClick={() => setGridOn((g) => !g)}
          aria-pressed={gridOn}
          title="Grid"
          aria-label="Grid"
        >
          <GridFour size={14} />
        </button>
        <button type="button" onClick={reset} title="Reset view (0)" aria-label="Reset view">
          <ArrowCounterClockwise size={14} />
        </button>
      </div>
      {dims && (
        <div className="viewport-dims mono">
          {dims.map((d) => d.toFixed(2)).join(' × ')} {props.modelUnit}
        </div>
      )}
    </div>
  );
}
