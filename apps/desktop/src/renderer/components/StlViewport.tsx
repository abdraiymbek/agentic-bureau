import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { useStore } from '../store';
import {
  ArrowsOut,
  Cube,
  GridFour,
  ArrowCounterClockwise,
  BoundingBox,
} from '@phosphor-icons/react';

/**
 * Real STL viewport: parses the actual mesh bytes, orbit/pan/zoom,
 * ortho/persp toggle, axes, grid, wireframe, fit, old/new compare.
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
  const invalidateRef = useRef<() => void>(() => {});
  const [wireframe, setWireframe] = useState(false);
  const [ortho, setOrtho] = useState(false);
  const [gridOn, setGridOn] = useState(true);
  const [dims, setDims] = useState<[number, number, number] | null>(null);

  // Init scene once.
  useEffect(() => {
    if (!mount.current) return;
    const element = mount.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(
      getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim(),
    );
    sceneRef.current = scene;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const hemi = new THREE.HemisphereLight('#e1e8f7', '#596171', 2.2);
    const dir = new THREE.DirectionalLight('#ffffff', 2.5);
    dir.position.set(4, 8, 5);
    scene.add(hemi, dir);
    const axes = new THREE.AxesHelper(25);
    scene.add(axes);
    const grid = new THREE.GridHelper(200, 40, '#343b44', '#262a30');
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);
    grid.name = 'grid';

    const setSize = () => {
      if (!mount.current || !rendererRef.current) return;
      const w = Math.max(1, mount.current.clientWidth),
        h = Math.max(1, mount.current.clientHeight);
      rendererRef.current.setSize(w, h);
      const cam = cameraRef.current;
      if (cam instanceof THREE.PerspectiveCamera) {
        cam.aspect = w / h;
        cam.updateProjectionMatrix();
      } else if (cam) {
        const s = 60;
        (cam as THREE.OrthographicCamera).left = (-s * w) / h;
        (cam as THREE.OrthographicCamera).right = (s * w) / h;
        (cam as THREE.OrthographicCamera).top = s;
        (cam as THREE.OrthographicCamera).bottom = -s;
        cam.updateProjectionMatrix();
      }
      invalidateRef.current();
    };
    const mkCam = (orthographic: boolean) => {
      const { clientWidth: w = 1, clientHeight: h = 1 } = mount.current!;
      if (orthographic) {
        const s = 60;
        const c = new THREE.OrthographicCamera((-s * w) / h, (s * w) / h, s, -s, 0.1, 5000);
        c.up.set(0, 0, 1);
        c.position.set(80, 60, 80);
        c.lookAt(0, 0, 0);
        return c;
      }
      const c = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
      c.up.set(0, 0, 1);
      c.position.set(80, 60, 80);
      c.lookAt(0, 0, 0);
      return c;
    };
    const cam = mkCam(ortho);
    cameraRef.current = cam;
    const controls = new OrbitControls(cam, renderer.domElement);
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
    invalidate();
    const ro = new ResizeObserver(setSize);
    ro.observe(mount.current);
    setSize();
    (
      mount.current as HTMLDivElement & {
        _mkCam?: (o: boolean) => THREE.PerspectiveCamera | THREE.OrthographicCamera;
      }
    )._mkCam = mkCam;
    return () => {
      invalidateRef.current = () => {};
      cancelAnimationFrame(raf);
      controls.removeEventListener('change', invalidate);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          for (const material of Array.isArray(object.material)
            ? object.material
            : [object.material])
            material.dispose();
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
    const css = getComputedStyle(document.documentElement);
    if (sceneRef.current)
      sceneRef.current.background = new THREE.Color(css.getPropertyValue('--canvas-bg').trim());
    if (meshRef.current)
      (meshRef.current.material as THREE.MeshStandardMaterial).color.set(
        css.getPropertyValue('--model-color').trim(),
      );
    invalidateRef.current();
  }, [theme]);

  // Swap camera on ortho toggle.
  useEffect(() => {
    const mk = (
      mount.current as
        | (HTMLDivElement & {
            _mkCam?: (o: boolean) => THREE.PerspectiveCamera | THREE.OrthographicCamera;
          })
        | null
    )?._mkCam;
    if (!mk) return;
    const old = cameraRef.current;
    const cam = mk(ortho);
    if (old) {
      cam.position.copy(old.position);
      cam.lookAt(0, 0, 0);
    }
    cameraRef.current = cam;
    if (controlsRef.current) {
      controlsRef.current.object = cam;
      controlsRef.current.update();
    }
    invalidateRef.current();
  }, [ortho]);

  useEffect(() => {
    const g = sceneRef.current?.getObjectByName('grid');
    if (g) g.visible = gridOn;
    invalidateRef.current();
  }, [gridOn]);

  // Load mesh on data change.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (meshRef.current) {
      scene.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      (meshRef.current.material as THREE.Material).dispose();
      meshRef.current = null;
    }
    if (compareRef.current) {
      scene.remove(compareRef.current);
      compareRef.current.geometry.dispose();
      (compareRef.current.material as THREE.Material).dispose();
      compareRef.current = null;
    }
    if (!props.stlData) {
      setDims(null);
      invalidateRef.current();
      return;
    }
    const loader = new STLLoader();
    const geo = loader.parse(props.stlData);
    geo.computeBoundingBox();
    const mat = new THREE.MeshStandardMaterial({
      color: getComputedStyle(document.documentElement).getPropertyValue('--model-color').trim(),
      roughness: 0.45,
      metalness: 0.2,
      wireframe,
    });
    const mesh = new THREE.Mesh(geo, mat);
    meshRef.current = mesh;
    scene.add(mesh);
    const bb = geo.boundingBox!;
    setDims([bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z]);
    if (props.compareData) {
      const cg = loader.parse(props.compareData);
      const cm = new THREE.MeshStandardMaterial({
        color: '#87afc7',
        transparent: true,
        opacity: 0.45,
        wireframe,
      });
      const cmesh = new THREE.Mesh(cg, cm);
      compareRef.current = cmesh;
      scene.add(cmesh);
    }
    fit();
  }, [props.stlData, props.compareData, wireframe]);

  const fit = () => {
    const mesh = meshRef.current;
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!mesh || !cam || !controls) return;
    const bb = mesh.geometry.boundingBox ?? new THREE.Box3().setFromObject(mesh);
    const center = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3()).length();
    const aspect = rendererRef.current
      ? rendererRef.current.domElement.clientWidth /
        Math.max(rendererRef.current.domElement.clientHeight, 1)
      : 1;
    const d = Math.max(size, 1) * (aspect < 1.2 ? 1.3 : 1.05);
    cam.position.set(center.x + d * 0.7, center.y + d * 0.55, center.z + d * 0.7);
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
  };

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 240 }}>
      <div
        ref={mount}
        style={{ position: 'absolute', inset: 0 }}
        tabIndex={0}
        role="img"
        aria-label="Interactive 3D model. Arrow keys move the view, F fits the model, and 0 resets it."
        onKeyDown={(e) => {
          // Keyboard 3D nav alternative.
          const cam = cameraRef.current;
          if (!cam) return;
          const step = 10;
          if (e.key === 'ArrowLeft') cam.position.x -= step;
          if (e.key === 'ArrowRight') cam.position.x += step;
          if (e.key === 'ArrowUp') cam.position.y += step;
          if (e.key === 'ArrowDown') cam.position.y -= step;
          if (e.key === 'f' || e.key === 'F') fit();
          if (e.key === '0') {
            cam.position.set(80, 60, 80);
            controlsRef.current?.target.set(0, 0, 0);
          }
          controlsRef.current?.update();
          invalidateRef.current();
        }}
      />
      <div className="viewport-tools">
        <Btn onClick={fit} title="Fit model (F)">
          <ArrowsOut size={14} />
          Fit
        </Btn>
        <Btn
          onClick={() => setOrtho((o) => !o)}
          aria-pressed={ortho}
          title="Toggle orthographic projection"
        >
          <Cube size={14} />
          {ortho ? 'Ortho' : 'Persp'}
        </Btn>
        <Btn
          onClick={() => setWireframe((w) => !w)}
          aria-pressed={wireframe}
          title="Toggle wireframe"
        >
          <BoundingBox size={14} />
        </Btn>
        <Btn onClick={() => setGridOn((g) => !g)} aria-pressed={gridOn} title="Toggle grid">
          <GridFour size={14} />
        </Btn>
        <Btn
          title="Reset view"
          onClick={() => {
            cameraRef.current?.position.set(80, 60, 80);
            controlsRef.current?.target.set(0, 0, 0);
            controlsRef.current?.update();
            invalidateRef.current();
          }}
        >
          <ArrowCounterClockwise size={14} />
        </Btn>
      </div>
      {dims && (
        <div
          className="mono dim"
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            fontSize: 12,
            background: 'var(--bg-main)',
            padding: '2px 8px',
            borderRadius: 4,
          }}
        >
          {dims.map((d) => d.toFixed(2)).join(' × ')} {props.modelUnit}
        </div>
      )}
    </div>
  );
}

function Btn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} style={{ height: 24, fontSize: 12, padding: '0 8px' }} />;
}
