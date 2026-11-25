// timeline.js — playback controls, ruler + playhead, clip tracks, clip editor.
// Clips are plain <div>s positioned with left/width percentages of the scene duration.
import { stackClips, shapeLabel, PROPERTIES, MIN_CLIP_LENGTH } from './scene.js';

const ROW_HEIGHT = 24;   // must match --row-height in style.css
const DRAG_THRESHOLD = 3; // px of movement before a press counts as a drag, not a click

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const formatValue = (v) => (typeof v === 'number' ? String(Math.round(v * 100) / 100) : v);

export function createTimeline(app) {
  const $ = (id) => document.getElementById(id);
  const ruler = $('ruler');
  const tracks = $('tracks');
  const playhead = $('playhead');
  const playBtn = $('play-btn');
  const loopToggle = $('loop-toggle');
  const durationInput = $('duration-input');
  const timeReadout = $('time-readout');
  const editor = {
    root: $('clip-editor'),
    title: $('clip-editor-title'),
    from: $('clip-from'),
    to: $('clip-to'),
    easing: $('clip-easing'),
  };

  let editing = null; // { shapeId, clipId } of the clip open in the editor

  // --- Controls ------------------------------------------------------------
  playBtn.addEventListener('click', () => {
    if (!app.playing && app.currentTime >= app.scene.duration) app.currentTime = 0;
    app.playing = !app.playing;
    updatePlayButton();
  });

  loopToggle.addEventListener('change', () => {
    app.loop = loopToggle.checked;
  });

  durationInput.addEventListener('change', () => {
    const duration = clamp(parseFloat(durationInput.value) || app.scene.duration, 1, 60);
    app.scene.duration = duration;
    // Keep every clip inside the new duration.
    for (const shape of app.scene.shapes) {
      for (const clip of shape.clips) {
        clip.end = Math.min(clip.end, duration);
        clip.start = Math.min(clip.start, clip.end - MIN_CLIP_LENGTH);
      }
    }
    app.currentTime = Math.min(app.currentTime, duration);
    app.refresh();
  });

  // --- Ruler: click or drag to move the playhead ---------------------------
  function timeAt(clientX, element) {
    const rect = element.getBoundingClientRect();
    return clamp((clientX - rect.left) / rect.width, 0, 1) * app.scene.duration;
  }

  ruler.addEventListener('pointerdown', (e) => {
    ruler.setPointerCapture(e.pointerId);
    app.currentTime = timeAt(e.clientX, ruler);
  });
  ruler.addEventListener('pointermove', (e) => {
    if (ruler.hasPointerCapture(e.pointerId)) app.currentTime = timeAt(e.clientX, ruler);
  });

  // --- Rendering -----------------------------------------------------------
  function render() {
    durationInput.value = app.scene.duration;
    loopToggle.checked = app.loop;
    renderRuler();
    renderTracks();
    updatePlayhead();
    updatePlayButton();
    if (editing && !findEditing()) closeClipEditor();
  }

  function renderRuler() {
    ruler.innerHTML = '';
    const duration = app.scene.duration;
    const step = duration <= 10 ? 0.5 : 1;
    for (let t = 0; t <= duration + 1e-6; t += step) {
      const tick = document.createElement('div');
      const whole = Math.abs(t - Math.round(t)) < 1e-6;
      tick.className = whole ? 'tick major' : 'tick';
      tick.style.left = `${(t / duration) * 100}%`;
      if (whole) tick.textContent = `${Math.round(t)}s`;
      ruler.appendChild(tick);
    }
  }

  function renderTracks() {
    tracks.innerHTML = '';
    for (const shape of app.scene.shapes) {
      // Group header row: the shape's name
      const group = makeRow(shapeLabel(shape), 'group-row');
      group.classList.toggle('selected', shape.id === app.selectedId);
      group.addEventListener('click', () => app.select(shape.id));
      tracks.appendChild(group);

      // One row per animated property; overlapping clips are stacked into sub-rows
      for (const property of PROPERTIES) {
        const clips = shape.clips.filter((c) => c.property === property);
        if (clips.length === 0) continue;
        const { rowOf, rowCount } = stackClips(clips);
        const row = makeRow(property, 'property-row');
        const lane = row.querySelector('.lane');
        lane.style.height = `${rowCount * ROW_HEIGHT}px`;
        for (const clip of clips) lane.appendChild(makeClip(shape, clip, rowOf.get(clip.id)));
        tracks.appendChild(row);
      }
    }
  }

  function makeRow(labelText, className) {
    const row = document.createElement('div');
    row.className = `track-row ${className}`;
    const label = document.createElement('div');
    label.className = 'track-label';
    label.textContent = labelText;
    const lane = document.createElement('div');
    lane.className = 'lane';
    row.append(label, lane);
    return row;
  }

  function makeClip(shape, clip, row) {
    const el = document.createElement('div');
    el.className = 'clip';
    el.classList.toggle('selected', editing?.clipId === clip.id);
    el.style.top = `${row * ROW_HEIGHT}px`;
    el.textContent = `${formatValue(clip.from)} → ${formatValue(clip.to)}`;
    el.title = `${clip.property}: ${clip.start.toFixed(2)}s – ${clip.end.toFixed(2)}s (${clip.easing})`;

    const left = document.createElement('div');
    left.className = 'clip-handle left';
    const right = document.createElement('div');
    right.className = 'clip-handle right';
    el.append(left, right);

    positionClip(el, clip);
    el.addEventListener('pointerdown', (e) => {
      const mode = e.target === left ? 'left' : e.target === right ? 'right' : 'move';
      startClipDrag(e, el, shape, clip, mode);
    });
    return el;
  }

  function positionClip(el, clip) {
    const duration = app.scene.duration;
    el.style.left = `${(clip.start / duration) * 100}%`;
    el.style.width = `${((clip.end - clip.start) / duration) * 100}%`;
  }

  // --- Clip drag: move (body) or resize (edges) ---------------------------
  // During the drag only this element's style changes; the tracks are rebuilt on release
  // (rebuilding the DOM mid-drag would destroy the element holding the pointer capture).
  function startClipDrag(e, el, shape, clip, mode) {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    const laneWidth = el.parentElement.getBoundingClientRect().width;
    const startX = e.clientX;
    const original = { start: clip.start, end: clip.end };
    const duration = app.scene.duration;
    let moved = false;

    function onMove(ev) {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < DRAG_THRESHOLD) return;
      moved = true;
      const dt = (dx / laneWidth) * duration;
      if (mode === 'move') {
        const length = original.end - original.start;
        clip.start = clamp(original.start + dt, 0, duration - length);
        clip.end = clip.start + length;
      } else if (mode === 'left') {
        clip.start = clamp(original.start + dt, 0, original.end - MIN_CLIP_LENGTH);
      } else {
        clip.end = clamp(original.end + dt, original.start + MIN_CLIP_LENGTH, duration);
      }
      positionClip(el, clip);
    }

    function onUp() {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (moved) render();
      else openClipEditor(shape.id, clip.id); // a click, not a drag
    }

    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  }

  // --- Clip editor ---------------------------------------------------------
  function findEditing() {
    if (!editing) return null;
    const shape = app.scene.shapes.find((s) => s.id === editing.shapeId);
    const clip = shape?.clips.find((c) => c.id === editing.clipId);
    return clip ? { shape, clip } : null;
  }

  function openClipEditor(shapeId, clipId) {
    editing = { shapeId, clipId };
    const { shape, clip } = findEditing();
    const isColor = clip.property === 'color';
    for (const input of [editor.from, editor.to]) {
      input.type = isColor ? 'color' : 'number';
      input.step = 'any';
    }
    editor.title.textContent = `${shapeLabel(shape)} · ${clip.property}`;
    editor.from.value = isColor ? clip.from : formatValue(clip.from);
    editor.to.value = isColor ? clip.to : formatValue(clip.to);
    editor.easing.value = clip.easing;
    editor.root.hidden = false;
    app.select(shapeId); // also re-renders, which highlights the clip
  }

  function closeClipEditor() {
    editing = null;
    editor.root.hidden = true;
    renderTracks();
  }

  function onEditorValue(input, key) {
    input.addEventListener('input', () => {
      const found = findEditing();
      if (!found) return;
      const value = found.clip.property === 'color' ? input.value : parseFloat(input.value);
      if (typeof value === 'number' && Number.isNaN(value)) return;
      found.clip[key] = value;
      renderTracks();
    });
  }
  onEditorValue(editor.from, 'from');
  onEditorValue(editor.to, 'to');

  editor.easing.addEventListener('change', () => {
    const found = findEditing();
    if (found) found.clip.easing = editor.easing.value;
    renderTracks();
  });

  $('clip-delete').addEventListener('click', () => {
    const found = findEditing();
    if (found) found.shape.clips = found.shape.clips.filter((c) => c !== found.clip);
    editing = null;
    editor.root.hidden = true;
    app.refresh();
  });

  $('clip-close').addEventListener('click', closeClipEditor);

  // --- Per-frame updates ---------------------------------------------------
  function updatePlayhead() {
    playhead.style.left = `${(app.currentTime / app.scene.duration) * 100}%`;
    timeReadout.textContent = `${app.currentTime.toFixed(2)} s`;
  }

  function updatePlayButton() {
    playBtn.textContent = app.playing ? 'Pause' : 'Play';
  }

  return { render, updatePlayhead, updatePlayButton, openClipEditor };
}
