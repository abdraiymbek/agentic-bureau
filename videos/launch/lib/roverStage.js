// A three.js stage for the rover with three blendable looks — a point cloud
// with depth-of-field bokeh, crisp edges, and lit solids — plus a raking light
// sweep, a scan plane that builds the model, a scatter that dissolves it, and
// an exploded view. Every input is a number from the scene's render(t).
import * as THREE from 'three';
import { buildRover, filmRenderer } from './rover.js';

const POINT_VS = `
uniform float uSize, uFocus, uAperture, uExplode, uScatter, uScanY, uScanSoft, uSweepX, uSweepW, uTime, uPx;
uniform vec3 uExplodeDir;
attribute float aRand;
varying float vAlpha;
varying float vSweep;
varying float vCoc;
void main() {
  vec3 p = position + uExplodeDir * uExplode;
  // Scatter: drift outward along a per-point direction with a little curl.
  vec3 dir = normalize(vec3(sin(aRand * 91.7), cos(aRand * 47.3) * 0.8 + 0.25, sin(aRand * 13.1 + 1.7)));
  p += dir * uScatter * (60.0 + 140.0 * fract(aRand * 7.31)) + vec3(0.0, uScatter * uScatter * 40.0, 0.0);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  float depth = -mv.z;
  // uSize is the dot's world size (mm); uAperture the blur disc (px) at infinity focus error.
  float coc = abs(depth - uFocus) / depth;
  vCoc = coc * uAperture / 12.0;
  float size = uSize * uPx / depth + coc * uAperture;
  gl_PointSize = clamp(size, 1.0, 90.0);
  // Bokeh spreads the same light over a larger disc: dim with area.
  float base = uSize * uPx / depth;
  vAlpha = clamp((base * base) / (gl_PointSize * gl_PointSize), 0.02, 1.0);
  // Build: points appear below the scan plane, with a bright band at the front.
  float s = (uScanY - position.y) / uScanSoft;
  vAlpha *= clamp(s + 1.0, 0.0, 1.0);
  float sw = (position.x + position.z * 0.35 - uSweepX) / uSweepW; // squared by hand: pow() of a negative base is undefined in GLSL
  vSweep = exp(-sw * sw) + 1.6 * exp(-s * s * 4.0) * step(-1.0, s);
  vAlpha *= 1.0 - smoothstep(0.55, 1.0, uScatter) ;
  gl_Position = projectionMatrix * mv;
}`;

const POINT_FS = `
uniform vec3 uColor, uHot;
uniform float uOpacity, uGlow;
varying float vAlpha;
varying float vSweep;
varying float vCoc;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  // In focus: a soft dot. Out of focus: a flat disc with a faint rim, like a lens.
  float soft = 1.0 - smoothstep(0.18, 0.5, r);
  float disc = (1.0 - smoothstep(0.42, 0.5, r)) * (0.75 + 0.25 * smoothstep(0.3, 0.48, r));
  float k = clamp(vCoc * 3.0, 0.0, 1.0);
  float shape = mix(soft, disc, k);
  vec3 col = mix(uColor, uHot, clamp(vSweep, 0.0, 1.0));
  float a = shape * vAlpha * uOpacity * (0.55 + uGlow * vSweep);
  gl_FragColor = vec4(col * a, a);
}`;

export function createRoverStage(canvas, { pointsPerMm2 = 0.11, fov = 26 } = {}) {
  const renderer = filmRenderer(canvas);
  renderer.localClippingEnabled = true;
  const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1000);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, canvas.width / canvas.height, 1, 8000);
  const rover = buildRover({ pointsPerMm2 });

  const root = new THREE.Group();
  scene.add(root);

  const solidMat = new THREE.MeshStandardMaterial({
    color: 0xc9ccd2,
    roughness: 0.58,
    metalness: 0.06,
    flatShading: true,
    transparent: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const parts = rover.parts.map((p, i) => {
    const group = new THREE.Group();
    const solid = new THREE.Mesh(p.geom, solidMat.clone());
    solid.material.clippingPlanes = [clip];
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xededee, transparent: true, depthWrite: false, clippingPlanes: [clip] });
    const edges = new THREE.LineSegments(p.edges, edgeMat);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.points, 3));
    const n = p.points.length / 3;
    const rand = new Float32Array(n);
    for (let k = 0; k < n; k++) rand[k] = ((k * 0.6180339887 + i * 0.137) % 1) + 0.0001;
    g.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
    const pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VS,
      fragmentShader: POINT_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: {
        uSize: { value: 0.8 },
        uPx: { value: canvas.height / 2 / Math.tan((fov * Math.PI) / 360) },
        uFocus: { value: 600 },
        uAperture: { value: 0 },
        uExplode: { value: 0 },
        uExplodeDir: { value: p.explode.clone() },
        uScatter: { value: 0 },
        uScanY: { value: 1000 },
        uScanSoft: { value: 3 },
        uSweepX: { value: -1000 },
        uSweepW: { value: 30 },
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0xa4a7ae) },
        uHot: { value: new THREE.Color(0xffffff) },
        uOpacity: { value: 1 },
        uGlow: { value: 0.9 },
      },
    });
    const points = new THREE.Points(g, pointMat);
    group.add(solid, edges, points);
    root.add(group);
    return { ...p, group, solid, edges, points };
  });

  const hemi = new THREE.HemisphereLight(0xffffff, 0x14151a, 1.1);
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  const rim = new THREE.DirectionalLight(0xffffff, 1.4);
  rim.position.set(-160, 90, -120);
  scene.add(hemi, key, rim);

  // Ground: a faint dot grid on the floor plane, drawn as points.
  const groundG = new THREE.BufferGeometry();
  const gp = [];
  for (let x = -600; x <= 600; x += 20) for (let z = -600; z <= 600; z += 20) gp.push(x, 0, z);
  groundG.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
  const groundMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.12, depthWrite: false });
  const ground = new THREE.Points(groundG, groundMat);
  scene.add(ground);

  const tmp = new THREE.Vector3();
  const hotColor = new THREE.Color();

  return {
    scene,
    camera,
    renderer,
    rover,
    parts,
    root,
    ground,
    /**
     * cam: { pos: [x,y,z], target: [x,y,z], fov? }
     * looks: { points, edges, solid } opacities 0..1
     * explode 0..1, scatter 0..1, scanY (mm, model builds below it), sweepX (mm along X+0.35Z)
     * focus (mm from camera) and aperture (0 = pinhole) for the point-cloud bokeh
     * partAlpha(id) → multiplier, partHot(id) → 0..1 tint toward `hot` colour
     * rotY: model yaw (rad), lift: model Y offset, ground: ground grid opacity
     */
    render({
      cam,
      looks = { points: 1, edges: 0, solid: 0 },
      explode = 0,
      scatter = 0,
      scanY = 1000,
      sweepX = -1000,
      sweepW = 30,
      focus = null,
      aperture = 0,
      pointSize = 0.8,
      glow = 0.9,
      partAlpha = null,
      partHot = null,
      hot = 0xffffff,
      base = 0xa4a7ae,
      rotY = 0,
      lift = 0,
      groundAlpha = 0.12,
      keyPos = [120, 180, 140],
      edgeColor = 0xededee,
    }) {
      camera.position.set(...cam.pos);
      camera.lookAt(...cam.target);
      if (cam.fov && cam.fov !== camera.fov) {
        camera.fov = cam.fov;
        camera.updateProjectionMatrix();
      }
      root.rotation.y = rotY;
      root.position.y = lift;
      key.position.set(...keyPos);
      clip.constant = scanY;
      groundMat.opacity = groundAlpha;
      ground.visible = groundAlpha > 0.002;
      const fdist = focus ?? camera.position.distanceTo(tmp.set(...cam.target));
      const px = canvas.height / 2 / Math.tan((camera.fov * Math.PI) / 360);
      for (const p of parts) {
        const a = partAlpha ? partAlpha(p.id) : 1;
        const h = partHot ? partHot(p.id) : 0;
        p.group.position.copy(p.explode).multiplyScalar(explode);
        // Points carry their own explode in the shader, so cancel the group offset for them.
        const u = p.points.material.uniforms;
        u.uExplode.value = 0;
        u.uFocus.value = fdist;
        u.uAperture.value = aperture;
        u.uScatter.value = scatter;
        u.uScanY.value = scanY - lift;
        u.uSweepX.value = sweepX;
        u.uSweepW.value = sweepW;
        u.uSize.value = pointSize;
        u.uPx.value = px;
        u.uGlow.value = glow;
        u.uOpacity.value = looks.points * a;
        u.uColor.value.set(base).lerp(hotColor.set(hot), h);
        u.uHot.value.set(h > 0 ? hot : 0xffffff);
        p.points.visible = looks.points * a > 0.002;
        p.edges.material.opacity = looks.edges * a;
        p.edges.material.color.set(h > 0 ? hot : edgeColor);
        p.edges.visible = looks.edges * a > 0.002;
        p.solid.material.opacity = looks.solid * a;
        p.solid.visible = looks.solid * a > 0.002;
        p.solid.material.depthWrite = looks.solid * a > 0.98;
      }
      renderer.render(scene, camera);
    },
  };
}
