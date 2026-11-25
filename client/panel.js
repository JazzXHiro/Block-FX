// panel.js — the left panel: add shapes, shape list, property editor, "Animate" buttons.
import { createShape, createClip, evaluateShape, shapeLabel, MIN_CLIP_LENGTH } from './scene.js';

export function createPanel(app) {
  const list = document.getElementById('shape-list');
  const propsSection = document.getElementById('props');
  const inputs = [...document.querySelectorAll('[data-prop]')];
  const ringRow = document.getElementById('ring-row');
  const ringInput = document.getElementById('prop-ring');

  const isAnimated = (shape, property) => shape.clips.some((c) => c.property === property);

  // --- Add shape buttons ---------------------------------------------------
  for (const button of document.querySelectorAll('[data-add]')) {
    button.addEventListener('click', () => {
      const shape = createShape(button.dataset.add);
      app.scene.shapes.push(shape);
      app.select(shape.id);
    });
  }

  // --- Shape list (event delegation: one listener for all items) -----------
  list.addEventListener('click', (e) => {
    const item = e.target.closest('li[data-id]');
    if (item) app.select(item.dataset.id);
  });

  // --- Property inputs: edit the base value of non-animated properties -----
  for (const input of inputs) {
    input.addEventListener('input', () => {
      const shape = app.selectedShape();
      const property = input.dataset.prop;
      if (!shape || isAnimated(shape, property)) return;
      const value = property === 'color' ? input.value : parseFloat(input.value);
      if (property !== 'color' && Number.isNaN(value)) return;
      shape.base[property] = value; // the render loop picks this up on the next frame
    });
  }

  ringInput.addEventListener('change', () => {
    const shape = app.selectedShape();
    if (shape) shape.style = ringInput.checked ? 'ring' : 'fill';
  });

  // --- Animate buttons: add a 1 s clip at the playhead ---------------------
  for (const button of document.querySelectorAll('[data-animate]')) {
    button.addEventListener('click', () => {
      const shape = app.selectedShape();
      if (!shape) return;
      const property = button.dataset.animate;
      const duration = app.scene.duration;
      const start = Math.max(0, Math.min(app.currentTime, duration - MIN_CLIP_LENGTH));
      const end = Math.min(start + 1, duration);
      const value = evaluateShape(shape, app.currentTime)[property];
      const clip = createClip(property, start, end, value, value);
      shape.clips.push(clip);
      app.refresh();
      app.timeline.openClipEditor(shape.id, clip.id); // so the user can set the end value
    });
  }

  document.getElementById('delete-shape').addEventListener('click', () => {
    app.scene.shapes = app.scene.shapes.filter((s) => s.id !== app.selectedId);
    app.select(null);
  });

  // --- Rendering -----------------------------------------------------------
  function render() {
    list.innerHTML = '';
    for (const shape of app.scene.shapes) {
      const item = document.createElement('li');
      item.dataset.id = shape.id;
      item.textContent = shapeLabel(shape);
      item.classList.toggle('selected', shape.id === app.selectedId);
      list.appendChild(item);
    }

    const shape = app.selectedShape();
    propsSection.hidden = !shape;
    if (!shape) return;

    for (const input of inputs) {
      const animated = isAnimated(shape, input.dataset.prop);
      input.disabled = animated;
      input.closest('.prop-row').classList.toggle('animated', animated);
    }
    ringRow.hidden = shape.type !== 'circle';
    ringInput.checked = shape.style === 'ring';
    syncValues();
  }

  // Called every frame: show the value at the playhead (skip the field being typed in).
  function syncValues() {
    const shape = app.selectedShape();
    if (!shape) return;
    const state = evaluateShape(shape, app.currentTime);
    for (const input of inputs) {
      if (input === document.activeElement) continue;
      const value = state[input.dataset.prop];
      input.value = typeof value === 'number' ? String(Math.round(value * 100) / 100) : value;
    }
  }

  return { render, syncValues };
}
