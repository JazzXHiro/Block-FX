// renderer.js — draws a scene at time t with Three.js (WebGL2).
// It only knows about the <canvas> it is given; it never touches the editor UI.

import * as THREE from 'three';
import {
  evaluateScene, hexToRgb, LOGICAL_WIDTH, LOGICAL_HEIGHT, SHAPE_SIZE, TRIANGLE_POINTS,
} from './scene.js';

const RING_WIDTH = 4; // ring outline thickness in logical pixels

// ---------------------------------------------------------------------------
// Shaders (one program for every shape)
// ---------------------------------------------------------------------------

// The vertex shader places a unit-sized shape on the 1280x720 stage itself,
// so we do not use Three's camera/projection matrices at all.
const VERTEX_SHADER = /* glsl */ `
  precision highp float;

  in vec3 position;          // local unit space, shape fits in [-0.5, 0.5]

  uniform vec2 uTranslate;   // shape centre in logical pixels (y down)
  uniform float uScale;
  uniform float uRotation;   // radians, clockwise on screen
  uniform vec2 uResolution;  // logical stage size (1280, 720) -> carries the 16:9 aspect ratio
  uniform float uSize;       // pixels per unit at scale 1

  out vec2 vLocal;

  void main() {
    vLocal = position.xy;

    vec2 p = position.xy * uSize * uScale;                 // scale
    float c = cos(uRotation);
    float s = sin(uRotation);
    p = vec2(p.x * c - p.y * s, p.x * s + p.y * c);         // rotate
    p += uTranslate;                                        // translate

    vec2 ndc = p / uResolution * 2.0 - 1.0;                 // pixels -> [-1, 1]
    gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);            // flip y: stage y goes down
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;

  uniform vec3 uColor;       // sRGB 0..1
  uniform float uOpacity;
  uniform int uShape;        // 0 = polygon (square/triangle), 1 = circle (SDF)
  uniform float uRing;       // ring thickness in local units, 0 = filled

  in vec2 vLocal;
  out vec4 outColor;

  void main() {
    float alpha = 1.0;

    if (uShape == 1) {
      float d = length(vLocal) - 0.5;        // signed distance to the circle edge (<0 inside)
      float aa = fwidth(d);                   // size of one pixel in these units -> smooth edge
      alpha = 1.0 - smoothstep(-aa, aa, d);
      if (uRing > 0.0) {
        alpha *= smoothstep(-uRing - aa, -uRing + aa, d);  // cut out the inside
      }
    }

    if (alpha <= 0.0) discard;
    outColor = vec4(uColor, uOpacity * alpha);
  }
`;

// ---------------------------------------------------------------------------
// Geometry (built once, shared by all meshes of the same type)
// ---------------------------------------------------------------------------

function makeGeometry(points2d) {
  const positions = [];
  for (let i = 0; i < points2d.length; i += 2) positions.push(points2d[i], points2d[i + 1], 0);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

// Two triangles make a unit quad.
const QUAD = [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5];

const GEOMETRIES = {
  square: makeGeometry(QUAD),
  triangle: makeGeometry(TRIANGLE_POINTS),
  circle: makeGeometry(QUAD), // the circle itself is cut out by the fragment shader
};

function createMesh(type) {
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uTranslate: { value: new THREE.Vector2() },
      uScale: { value: 1 },
      uRotation: { value: 0 },
      uResolution: { value: new THREE.Vector2(LOGICAL_WIDTH, LOGICAL_HEIGHT) },
      uSize: { value: SHAPE_SIZE },
      uColor: { value: new THREE.Vector3() },
      uOpacity: { value: 1 },
      uShape: { value: type === 'circle' ? 1 : 0 },
      uRing: { value: 0 },
    },
    transparent: true,           // alpha blending: SRC_ALPHA, ONE_MINUS_SRC_ALPHA
    depthTest: false,            // pure 2D: draw order decides what is on top
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(GEOMETRIES[type], material);
  mesh.frustumCulled = false;    // our shader ignores the camera, so culling would be wrong
  mesh.userData.type = type;
  return mesh;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let renderer = null;
let threeScene = null;
let camera = null;
const meshes = new Map(); // shape id -> THREE.Mesh

export function initRenderer(canvas, width = LOGICAL_WIDTH, height = LOGICAL_HEIGHT) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false); // false = leave the CSS size to style.css
  renderer.setClearColor(0xffffff, 1);
  threeScene = new THREE.Scene();
  camera = new THREE.Camera(); // required by renderer.render(), unused by our shaders
}

// Draw `scene` as it looks at time `t` (seconds).
// The output depends only on (scene, t), so the editor and the exporter produce identical frames.
export function renderAt(scene, t) {
  const states = evaluateScene(scene, t);
  const alive = new Set();

  states.forEach((s, index) => {
    let mesh = meshes.get(s.id);
    if (mesh && mesh.userData.type !== s.type) {
      removeMesh(s.id);
      mesh = null;
    }
    if (!mesh) {
      mesh = createMesh(s.type);
      meshes.set(s.id, mesh);
      threeScene.add(mesh);
    }
    alive.add(s.id);

    const u = mesh.material.uniforms;
    const [r, g, b] = hexToRgb(s.color);
    u.uTranslate.value.set(s.x, s.y);
    u.uScale.value = s.scale;
    u.uRotation.value = (s.rotation * Math.PI) / 180;
    u.uColor.value.set(r / 255, g / 255, b / 255);
    u.uOpacity.value = Math.min(1, Math.max(0, s.opacity));
    const sizePx = Math.max(Math.abs(s.scale) * SHAPE_SIZE, 1e-4);
    u.uRing.value = s.type === 'circle' && s.style === 'ring' ? RING_WIDTH / sizePx : 0;
    mesh.renderOrder = index; // list order: later shapes are drawn on top
  });

  for (const id of [...meshes.keys()]) {
    if (!alive.has(id)) removeMesh(id);
  }

  renderer.render(threeScene, camera);
}

function removeMesh(id) {
  const mesh = meshes.get(id);
  threeScene.remove(mesh);
  mesh.material.dispose(); // geometries are shared, so only the material is freed
  meshes.delete(id);
}
