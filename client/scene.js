// scene.js — the data model and all the pure math on it.
// No DOM, no WebGL: everything here works the same in the editor, in export mode and in Node.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const LOGICAL_WIDTH = 1280;   // stage coordinate system (pixels, y points down)
export const LOGICAL_HEIGHT = 720;
export const SHAPE_SIZE = 100;       // a shape at scale 1 is 100 x 100 logical pixels

export const SHAPE_TYPES = ['square', 'triangle', 'circle'];
export const PROPERTIES = ['x', 'y', 'scale', 'rotation', 'color', 'opacity'];
export const MIN_CLIP_LENGTH = 0.1;  // seconds

// Easing functions map normalized time k (0..1) to progress (0..1).
export const EASINGS = {
  'linear': (k) => k,
  'ease-in': (k) => k * k,
  'ease-out': (k) => 1 - (1 - k) * (1 - k),
  'ease-in-out': (k) => (k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k)),
};

// ---------------------------------------------------------------------------
// Creating data
// ---------------------------------------------------------------------------

const idCounters = {}; // one counter per prefix: shapes s1, s2… and clips c1, c2…
function makeId(prefix) {
  idCounters[prefix] = (idCounters[prefix] || 0) + 1;
  return `${prefix}${idCounters[prefix]}`;
}

export function createShape(type, base = {}) {
  return {
    id: makeId('s'),
    type,
    style: 'fill', // 'fill' | 'ring' (ring is only used by circles)
    base: {
      x: LOGICAL_WIDTH / 2,
      y: LOGICAL_HEIGHT / 2,
      scale: 1,
      rotation: 0,       // degrees, clockwise on screen
      color: '#2f6fde',
      opacity: 1,
      ...base,
    },
    clips: [],
  };
}

export function createClip(property, start, end, from, to, easing = 'linear') {
  return { id: makeId('c'), property, start, end, from, to, easing };
}

// The default demo: a ripple of 4 concentric rings, staggered by 0.4 s.
export function defaultScene() {
  const shapes = [];
  for (let i = 0; i < 4; i++) {
    const shape = createShape('circle', { scale: 0.1, opacity: 1 });
    shape.style = 'ring';
    const start = i * 0.4;
    shape.clips.push(createClip('scale', start, start + 2, 0.1, 3, 'ease-out'));
    shape.clips.push(createClip('opacity', start, start + 2, 1, 0, 'linear'));
    shapes.push(shape);
  }
  return { duration: 5, shapes };
}

// ---------------------------------------------------------------------------
// Colors (kept as "#rrggbb" strings in the model)
// ---------------------------------------------------------------------------

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  const toHex = (v) => Math.round(v).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function lerp(a, b, k) {
  return a + (b - a) * k;
}

function interpolate(property, from, to, k) {
  if (property === 'color') {
    const a = hexToRgb(from);
    const b = hexToRgb(to);
    return rgbToHex([lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]);
  }
  return lerp(from, to, k);
}

// ---------------------------------------------------------------------------
// Evaluation: what does a shape look like at time t?
// ---------------------------------------------------------------------------

export function evaluateProperty(shape, property, t) {
  const clips = shape.clips.filter((c) => c.property === property);
  if (clips.length === 0) return shape.base[property];

  // 1. Inside a clip? If several overlap, the one that started last wins.
  let active = null;
  for (const c of clips) {
    if (t >= c.start && t <= c.end && (!active || c.start >= active.start)) active = c;
  }
  if (active) {
    const length = active.end - active.start;
    const k = length > 0 ? (t - active.start) / length : 1;
    const ease = EASINGS[active.easing] || EASINGS.linear;
    return interpolate(property, active.from, active.to, ease(k));
  }

  // 2. After a clip has ended: hold the `to` of the clip that ended most recently.
  let finished = null;
  for (const c of clips) {
    if (c.end < t && (!finished || c.end > finished.end)) finished = c;
  }
  if (finished) return finished.to;

  // 3. Before every clip: use the `from` of the first clip.
  const first = clips.reduce((a, b) => (b.start < a.start ? b : a));
  return first.from;
}

export function evaluateShape(shape, t) {
  const result = { id: shape.id, type: shape.type, style: shape.style };
  for (const p of PROPERTIES) result[p] = evaluateProperty(shape, p, t);
  return result;
}

export function evaluateScene(scene, t) {
  return scene.shapes.map((shape) => evaluateShape(shape, t));
}

// ---------------------------------------------------------------------------
// Hit testing (stage clicks). Works in the same space the vertex shader uses.
// ---------------------------------------------------------------------------

function pointInShape(type, lx, ly) {
  // (lx, ly) is in the shape's local unit space: the shape fits in [-0.5, 0.5].
  if (type === 'square') return Math.abs(lx) <= 0.5 && Math.abs(ly) <= 0.5;
  if (type === 'circle') return lx * lx + ly * ly <= 0.25;
  // triangle: apex at top (y is down), base at the bottom
  const [ax, ay, bx, by, cx, cy] = TRIANGLE_POINTS;
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = sign(lx, ly, ax, ay, bx, by);
  const d2 = sign(lx, ly, bx, by, cx, cy);
  const d3 = sign(lx, ly, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// Triangle corners in local unit space (shared with the renderer's vertex buffer).
export const TRIANGLE_POINTS = [0, -0.5, 0.5, 0.5, -0.5, 0.5];

// Returns the id of the topmost shape under (x, y), or null.
export function hitTest(scene, t, x, y) {
  for (let i = scene.shapes.length - 1; i >= 0; i--) {
    const s = evaluateShape(scene.shapes[i], t);
    if (s.opacity <= 0 || s.scale === 0) continue;
    const size = s.scale * SHAPE_SIZE;
    const angle = (-s.rotation * Math.PI) / 180; // undo the rotation
    const dx = x - s.x;
    const dy = y - s.y;
    const lx = (dx * Math.cos(angle) - dy * Math.sin(angle)) / size;
    const ly = (dx * Math.sin(angle) + dy * Math.cos(angle)) / size;
    if (pointInShape(s.type, lx, ly)) return s.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Editing helpers
// ---------------------------------------------------------------------------

// "Circle 3" etc. for lists and timeline labels.
export function shapeLabel(shape) {
  const name = shape.type[0].toUpperCase() + shape.type.slice(1);
  return `${name} ${shape.id.slice(1)}`;
}

// Move a shape by (dx, dy). If x / y is animated, shift the whole animation path
// (every clip's from/to) instead of the base value, so dragging always has a visible effect.
export function moveShape(shape, dx, dy) {
  for (const [property, delta] of [['x', dx], ['y', dy]]) {
    const clips = shape.clips.filter((c) => c.property === property);
    if (clips.length === 0) {
      shape.base[property] += delta;
    } else {
      for (const c of clips) {
        c.from += delta;
        c.to += delta;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Timeline helper: put overlapping clips on separate rows (greedy interval packing)
// ---------------------------------------------------------------------------

export function stackClips(clips) {
  const rowOf = new Map();
  const rowEnds = []; // end time of the last clip placed in each row
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  for (const clip of sorted) {
    let row = rowEnds.findIndex((end) => end <= clip.start);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(0);
    }
    rowEnds[row] = clip.end;
    rowOf.set(clip.id, row);
  }
  return { rowOf, rowCount: Math.max(1, rowEnds.length) };
}
