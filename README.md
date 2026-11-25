# Block-FX

A minimal 2D animation editor that runs in the browser. Add shapes, animate their properties on a timeline, preview the result on a WebGL stage, and export the animation as **MP4** or **GIF**.

Built with plain HTML/CSS, vanilla JavaScript (ES modules), Three.js (WebGL2) and a small Node.js + Express server. There is no framework and no build step.

---

## Features

- **Shapes**: square, triangle and circle (filled or ring outline).
- **Properties**: x, y, scale, rotation, color and opacity, all editable from the left panel.
- **Timeline**:
  - Draggable playhead, play/pause, loop toggle and an editable total duration.
  - One group per shape, with clips (bars) for each animated property.
  - Clips can be dragged to move them and resized from either edge.
  - Overlapping clips on the same property stack into extra rows automatically.
  - Each clip has its own start and end value plus an easing curve (linear, ease-in, ease-out, ease-in-out).
- **Stage**: fixed 16:9 canvas (1280×720) that scales to fit the window. Click a shape to select it, drag it to move it.
- **Export**: MP4 or GIF at 24, 30 or 60 fps and 480p, 720p or 1080p, with a live progress bar.
- **Same renderer for preview and export**: the exported video matches the editor frame for frame.
- **Demo scene**: a looping ripple made of 4 concentric rings.

---

## Tech stack

| Layer | Technology |
|---|---|
| UI | Plain HTML + CSS (CSS variables, grid and flexbox) |
| App logic | Vanilla JavaScript, ES modules |
| Rendering | WebGL2 through [Three.js](https://threejs.org/), with hand-written GLSL shaders (`RawShaderMaterial`) |
| Server | Node.js + [Express](https://expressjs.com/) |
| Export | [Puppeteer](https://pptr.dev/) (headless Chrome) + [ffmpeg-static](https://www.npmjs.com/package/ffmpeg-static) |

---

## Getting started

### Requirements

- [Node.js](https://nodejs.org/) 18 or newer
- npm (ships with Node.js)

### Install and run

```bash
git clone https://github.com/JazzXHiro/Block-FX.git
cd Block-FX
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

`npm install` also downloads a copy of Chrome (for Puppeteer) and an ffmpeg binary, so the first install can take a few minutes.

To use a different port:

```bash
# macOS / Linux
PORT=4000 npm start
```

```powershell
# Windows PowerShell
$env:PORT=4000; npm start
```

### Troubleshooting the install

If `npm install` warns that install scripts are "not covered by allowScripts", export will not work until the Chrome and ffmpeg binaries are downloaded. Check that `node_modules/ffmpeg-static/ffmpeg` (or `ffmpeg.exe` on Windows) and `~/.cache/puppeteer` exist. If they don't, run:

```bash
npm install-scripts approve ffmpeg-static puppeteer
npm rebuild
```

---

## How to use

| Area | What you can do |
|---|---|
| **Left panel** | Add a Square, Triangle or Circle. Click a shape in the list to select it and edit its x, y, scale, rotation, color and opacity. Circles also have a *Ring outline* option. Press **Animate** next to a property to add a 1-second clip at the playhead. |
| **Stage** | Click a shape to select it and drag it to move it. If x or y is animated, dragging moves the whole motion path. |
| **Timeline** | Use **Play/Pause**, **Loop** and **Duration**. Click or drag in the ruler to move the playhead. |
| **Clips** | Drag the body of a clip to move it, or drag an edge to change its start or end time. Click a clip to edit its *From* value (left edge), *To* value (right edge) and easing, or to delete it. |
| **Export** | Click **Export**, choose the format, fps and resolution, and the file downloads when rendering finishes. |

A property that has clips is greyed out in the panel. Edit its values on the clips instead.

### How a property is evaluated at time *t*

1. The property has no clips: use the base value from the panel.
2. *t* is inside a clip: interpolate from `from` to `to` using the clip's easing. If clips overlap, the one that started last wins.
3. *t* is after a clip: hold that clip's `to` value.
4. *t* is before the first clip: use that clip's `from` value.

All properties animate at the same time.

---

## Data model

```js
Scene = { duration, shapes[] }
Shape = { id, type: 'square' | 'triangle' | 'circle', style: 'fill' | 'ring',
          base: { x, y, scale, rotation, color, opacity }, clips[] }
Clip  = { id, property, start, end, from, to, easing }
```

---

## Project structure

```
client/
  index.html    page structure (panel, stage, timeline, export dialog)
  style.css     all styles: variables, layout, left panel, stage, timeline, controls
  main.js       app state, playback loop, stage mouse input, export dialog, export mode
  renderer.js   Three.js renderer and shaders; exposes renderAt(scene, t)
  scene.js      data model, easing, evaluation, hit testing, clip stacking
  panel.js      left panel (shape list and property editor)
  timeline.js   timeline, clip drag/resize, clip editor
server/
  server.js     serves the client and handles export
package.json
```

---

## How export works

1. The browser sends the scene as JSON to `POST /export` and receives a job id.
2. The server opens headless Chrome at `/?export=1`, which shows only the canvas, and loads the scene.
3. For every frame `i`, it calls `window.renderAt(i / fps)` and captures the canvas as a PNG.
4. Each PNG is piped into ffmpeg, which encodes an H.264 MP4 or a palette-optimized GIF.
5. Progress is streamed to the browser with Server-Sent Events (`GET /export/:id/events`), and the finished file is served from `GET /export/:id/download`.

Export uses software WebGL (SwiftShader), so it also works on machines without a GPU.

---

## License

ISC
