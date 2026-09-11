import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Real STL viewport: parses the actual mesh bytes, orbit/pan/zoom,
 * ortho/persp toggle, axes, grid, wireframe, fit, old/new compare.
 */
export function StlViewport(props: {
  stlData: ArrayBuffer | null;
  compareData?: ArrayBuffer | null;
  modelUnit: string;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | THREE.OrthographicCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const compareRef = useRef<THREE.Mesh | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [ortho, setOrtho] = useState(false);
  const [gridOn, setGridOn] = useState(true);
  const [dims, setDims] = useState<[number, number, number] | null>(null);

  // Init scene once.
  useEffect(() => {
    if (!mount.current) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#1d2024');
    sceneRef.current = scene;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const hemi = new THREE.HemisphereLight('#8a94a0', '#17191c', 1.1);
    const dir = new THREE.DirectionalLight('#ffffff', 1.4);
    dir.position.set(4, 8, 5);
    scene.add(hemi, dir);
    const axes = new THREE.AxesHelper(25);
    scene.add(axes);
    const grid = new THREE.GridHelper(200, 40, '#343b44', '#262a30');
    scene.add(grid);
    grid.name = 'grid';

    const setSize = () => {
      if (!mount.current || !rendererRef.current) return;
      const { clientWidth: w, clientHeight: h } = mount.current;
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
    };
    const mkCam = (orthographic: boolean) => {
      const { clientWidth: w = 1, clientHeight: h = 1 } = mount.current!;
      if (orthographic) {
        const s = 60;
        const c = new THREE.OrthographicCamera((-s * w) / h, (s * w) / h, s, -s, 0.1, 5000);
        c.position.set(80, 60, 80);
        c.lookAt(0, 0, 0);
        return c;
      }
      const c = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
      c.position.set(80, 60, 80);
      c.lookAt(0, 0, 0);
      return c;
    };
    const cam = mkCam(ortho);
    cameraRef.current = cam;
    const controls = new OrbitControls(cam, renderer.domElement);
    controlsRef.current = controls;

    let raf = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, cameraRef.current!);
      raf = requestAnimationFrame(loop);
    };
    loop();
    const ro = new ResizeObserver(setSize);
    ro.observe(mount.current);
    setSize();
    (
      mount.current as HTMLDivElement & {
        _mkCam?: (o: boolean) => THREE.PerspectiveCamera | THREE.OrthographicCamera;
      }
    )._mkCam = mkCam;
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.current?.removeChild(renderer.domElement);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  }, [ortho]);

  useEffect(() => {
    const g = sceneRef.current?.getObjectByName('grid');
    if (g) g.visible = gridOn;
  }, [gridOn]);

  // Load mesh on data change.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    if (meshRef.current) {
      scene.remove(meshRef.current);
      meshRef.current.geometry.dispose();
      meshRef.current = null;
    }
    if (compareRef.current) {
      scene.remove(compareRef.current);
      compareRef.current.geometry.dispose();
      compareRef.current = null;
    }
    if (!props.stlData) {
      setDims(null);
      return;
    }
    const loader = new STLLoader();
    const geo = loader.parse(props.stlData);
    geo.computeBoundingBox();
    const mat = new THREE.MeshStandardMaterial({
      color: '#8b93a0',
      roughness: 0.75,
      metalness: 0.05,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.stlData, props.compareData, wireframe]);

  const fit = () => {
    const mesh = meshRef.current;
    const cam = cameraRef.current;
    const controls = controlsRef.current;
    if (!mesh || !cam || !controls) return;
    const bb = mesh.geometry.boundingBox ?? new THREE.Box3().setFromObject(mesh);
    const center = bb.getCenter(new THREE.Vector3());
    const size = bb.getSize(new THREE.Vector3()).length();
    const d = Math.max(size, 1) * 0.9;
    cam.position.set(center.x + d * 0.7, center.y + d * 0.55, center.z + d * 0.7);
    cam.near = d / 100;
    cam.far = d * 100;
    cam.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
  };

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 240 }}>
      <div
        ref={mount}
        style={{ position: 'absolute', inset: 0 }}
        tabIndex={0}
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
        }}
      />
      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 6 }}>
        <Btn onClick={fit}>Fit</Btn>
        <Btn onClick={() => setOrtho((o) => !o)}>{ortho ? 'Ortho' : 'Persp'}</Btn>
        <Btn onClick={() => setWireframe((w) => !w)}>{wireframe ? 'Solid' : 'Wire'}</Btn>
        <Btn onClick={() => setGridOn((g) => !g)}>Grid</Btn>
        <Btn
          onClick={() => {
            cameraRef.current?.position.set(80, 60, 80);
            controlsRef.current?.target.set(0, 0, 0);
            controlsRef.current?.update();
          }}
        >
          Reset
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
            background: 'rgba(20,22,26,0.8)',
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
