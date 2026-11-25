// main.js — wires everything together: app state, playback loop, stage mouse input, export dialog.
// With ?export=1 it instead runs the bare "export mode" page that Puppeteer drives.
import { initRenderer, renderAt } from './renderer.js';
import { defaultScene, hitTest, moveShape, LOGICAL_WIDTH, LOGICAL_HEIGHT } from './scene.js';
import { createPanel } from './panel.js';
import { createTimeline } from './timeline.js';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('canvas');

if (params.get('export') === '1') {
  startExportMode();
} else {
  startEditor();
}

// ---------------------------------------------------------------------------
// Export mode: UI hidden, canvas at the export resolution, driven from outside
// ---------------------------------------------------------------------------
function startExportMode() {
  document.body.classList.add('export-mode');
  const width = Number(params.get('w')) || LOGICAL_WIDTH;
  const height = Number(params.get('h')) || LOGICAL_HEIGHT;
  initRenderer(canvas, width, height);

  let scene = { duration: 0, shapes: [] };
  window.loadScene = (s) => { scene = s; };
  window.renderAt = (t) => renderAt(scene, t);
  window.exportReady = true;
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function startEditor() {
  initRenderer(canvas);

  // The whole app state. `currentTime` is the single source of truth for playback.
  const app = {
    scene: defaultScene(),
    selectedId: null,
    currentTime: 0,
    playing: false,
    loop: true,
    panel: null,
    timeline: null,

    selectedShape() {
      return this.scene.shapes.find((s) => s.id === this.selectedId) || null;
    },
    select(id) {
      this.selectedId = id;
      this.refresh();
    },
    // Rebuild the panel and timeline DOM after a structural change.
    refresh() {
      this.panel.render();
      this.timeline.render();
    },
  };

  app.panel = createPanel(app);
  app.timeline = createTimeline(app);
  setupStageInput(app);
  setupExportDialog(app);
  app.refresh();

  // Playback: one requestAnimationFrame loop advances currentTime and redraws.
  let lastNow = performance.now();
  function frame(now) {
    const dt = (now - lastNow) / 1000;
    lastNow = now;

    if (app.playing) {
      app.currentTime += dt;
      const duration = app.scene.duration;
      if (app.currentTime >= duration) {
        if (app.loop) {
          app.currentTime %= duration;
        } else {
          app.currentTime = duration;
          app.playing = false;
          app.timeline.updatePlayButton();
        }
      }
    }

    renderAt(app.scene, app.currentTime);
    app.timeline.updatePlayhead();
    app.panel.syncValues();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Stage input: click to select, drag to move
// ---------------------------------------------------------------------------
function setupStageInput(app) {
  let drag = null; // { id, x, y } last pointer position in logical pixels

  // Convert a mouse position to the 1280x720 logical stage coordinates.
  function toLogical(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * LOGICAL_WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * LOGICAL_HEIGHT,
    };
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = toLogical(e);
    const id = hitTest(app.scene, app.currentTime, p.x, p.y);
    app.select(id);
    if (!id) return;
    drag = { id, x: p.x, y: p.y };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = toLogical(e);
    if (!drag) {
      const over = hitTest(app.scene, app.currentTime, p.x, p.y);
      canvas.style.cursor = over ? 'grab' : 'default';
      return;
    }
    const shape = app.scene.shapes.find((s) => s.id === drag.id);
    if (shape) moveShape(shape, p.x - drag.x, p.y - drag.y);
    drag.x = p.x;
    drag.y = p.y;
  });

  function endDrag() {
    if (!drag) return;
    drag = null;
    canvas.style.cursor = 'grab';
    app.timeline.render(); // clip labels show from/to, which may have shifted
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
}

// ---------------------------------------------------------------------------
// Export dialog: POST the scene, follow progress with Server-Sent Events, download
// ---------------------------------------------------------------------------
function setupExportDialog(app) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('export-dialog');
  const startBtn = $('export-start');
  const progress = $('export-progress');
  const status = $('export-status');

  $('export-btn').addEventListener('click', () => {
    app.playing = false;
    app.timeline.updatePlayButton();
    progress.value = 0;
    status.textContent = '';
    dialog.showModal();
  });

  function finish(message) {
    status.textContent = message;
    startBtn.disabled = false;
  }

  startBtn.addEventListener('click', async () => {
    const [width, height] = $('export-resolution').value.split('x').map(Number);
    const body = {
      scene: app.scene,
      format: $('export-format').value,
      fps: Number($('export-fps').value),
      width,
      height,
    };

    startBtn.disabled = true;
    progress.value = 0;
    status.textContent = 'Starting…';

    let id;
    try {
      const res = await fetch('/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await res.text());
      ({ id } = await res.json());
    } catch (err) {
      finish(`Export failed: ${err.message}`);
      return;
    }

    const events = new EventSource(`/export/${id}/events`);
    events.onmessage = (e) => {
      const job = JSON.parse(e.data);
      progress.max = job.total || 1;
      progress.value = job.frame;
      status.textContent = `${job.status}: frame ${job.frame} / ${job.total}`;
      if (job.status === 'done') {
        events.close();
        window.location.href = `/export/${id}/download`; // triggers the file download
        finish('Done. Downloading…');
      } else if (job.status === 'error') {
        events.close();
        finish(`Export failed: ${job.error}`);
      }
    };
    events.onerror = () => {
      events.close();
      finish('Lost connection to the server.');
    };
  });
}
