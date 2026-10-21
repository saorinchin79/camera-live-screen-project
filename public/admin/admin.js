/**
 * Admin — split-screen layout editor.
 *
 * - Edits the layout (overlays: local camera, PNG/GIF images; main screen: placeholder/video/image/live CCTV)
 * - Crops any source (main screen or overlay) to cut toolbars and black bars off its edges
 * - Live preview with drag-to-move and resize handles (shared stage renderer)
 * - Sends the layout to every program output over Socket.IO ("Auto take" or "Take to program")
 * - Captures the local camera with getUserMedia and streams it to the outputs over WebRTC
 */
import { createStage } from '/shared/stage.js';

const L = window.StreamLayout;
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  layout: L.sanitizeLayout(L.DEFAULT_LAYOUT),
  selectedId: null,
  lockAspect: true,
  autoTake: true,
  dirty: false,
  outputs: new Set(),
  camera: { stream: null, deviceId: '', label: '', mirror: false },
  peers: new Map(), // output socket id -> RTCPeerConnection
  library: [],
  pendingImage: null, // { file } or { url, name }
  cctv: { cameras: [], status: new Map() }, // saved CCTV cameras (passwords masked) + live status by id
};

const socket = io();

// ---------------------------------------------------------------------------
// Preview stage
// ---------------------------------------------------------------------------

const stage = createStage($('preview'), {
  interactive: true,
  lockAspect: () => state.lockAspect,
  onSelect: (id) => select(id),
  onChange: (layer, live) => updateLayer(layer.id, layer, { live, fromStage: true }),
  // the crop info shows the source size once the first frame is in
  onMediaSize: (id) => { if (id === state.selectedId) renderProps(); },
});
stage.root.classList.add('interactive');

function fitPreview() {
  const monitor = $('monitor');
  const availW = monitor.clientWidth - 8;
  const availH = monitor.clientHeight - 8;
  const scale = Math.max(0.1, Math.min(availW / L.OUTPUT_W, availH / L.OUTPUT_H, 1));
  stage.setScale(scale);
  $('scale-chip').textContent = `${Math.round(scale * 100)} % scale`;
}
new ResizeObserver(fitPreview).observe($('monitor'));
window.addEventListener('resize', fitPreview);

// ---------------------------------------------------------------------------
// Layout mutations
// ---------------------------------------------------------------------------

let pushTimer = null;

function setLayout(next, { push = true } = {}) {
  const sanitized = L.sanitizeLayout(next);
  state.layout = sanitized;
  if (state.selectedId && !sanitized.layers.some((l) => l.id === state.selectedId)) state.selectedId = null;
  renderAll();
  if (push) pushLayout();
}

function pushLayout({ force = false } = {}) {
  if (!state.autoTake && !force) {
    state.dirty = true;
    renderFooter();
    return;
  }
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    socket.emit('layout:set', state.layout, () => {
      state.dirty = false;
      renderFooter();
    });
  }, 40);
}

function updateLayer(id, patch, { live = false, fromStage = false } = {}) {
  const layers = state.layout.layers.map((l) => (l.id === id ? L.constrain(Object.assign({}, l, patch)) : l));
  state.layout = Object.assign({}, state.layout, { layers, template: 'custom' });
  if (live) {
    // mid-drag: the stage already moved the element; refresh numbers only, throttle network
    renderProps();
    renderList();
    renderTemplates();
    if (state.autoTake) throttledPush();
    return;
  }
  renderAll();
  pushLayout();
}

function updateMain(patch, { live = false } = {}) {
  state.layout = Object.assign({}, state.layout, { main: Object.assign({}, state.layout.main, patch) });
  if (live) {
    // mid-slide: redraw the preview, refresh the panel, throttle network
    stage.render(state.layout, state.selectedId);
    renderProps();
    if (state.autoTake) throttledPush();
    return;
  }
  renderAll();
  pushLayout();
}

let throttleTs = 0;
function throttledPush() {
  const now = Date.now();
  if (now - throttleTs > 80) {
    throttleTs = now;
    socket.emit('layout:set', state.layout);
  }
}

function selectedLayer() {
  return state.layout.layers.find((l) => l.id === state.selectedId) || null;
}

function select(id) {
  state.selectedId = id;
  stage.select(id);
  renderMainRow();
  renderList();
  renderProps();
}

function addLayer(layer, { selectIt = true } = {}) {
  const layers = state.layout.layers.concat([layer]);
  state.layout = Object.assign({}, state.layout, { layers, template: 'custom' });
  if (selectIt) state.selectedId = layer.id;
  renderAll();
  pushLayout();
}

function removeLayer(id) {
  const layers = state.layout.layers.filter((l) => l.id !== id);
  state.layout = Object.assign({}, state.layout, { layers });
  if (state.selectedId === id) state.selectedId = null;
  renderAll();
  pushLayout();
}

function moveLayer(id, delta) {
  const layers = state.layout.layers.slice();
  const i = layers.findIndex((l) => l.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= layers.length) return;
  [layers[i], layers[j]] = [layers[j], layers[i]];
  state.layout = Object.assign({}, state.layout, { layers });
  renderAll();
  pushLayout();
}

function applyTemplate(id) {
  if (!state.layout.layers.some((l) => l.type === 'camera')) {
    toast('Add a camera overlay first — templates position the camera window.', true);
    return;
  }
  state.layout = L.applyTemplate(state.layout, id);
  renderAll();
  pushLayout();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  stage.render(state.layout, state.selectedId);
  renderMainRow();
  renderList();
  renderProps();
  renderTemplates();
  renderFooter();
}

function renderMainRow() {
  const m = state.layout.main;
  const file = m.src ? m.src.split('/').pop() : '';
  const desc =
    m.type === 'placeholder' ? `Placeholder "${m.label}"`
    : m.type === 'cctv' ? `Live CCTV · ${m.label}`
    : `${m.type === 'video' ? 'Video' : 'Image'} · ${file}`;
  $('main-meta').textContent = `${desc}${L.hasCrop(m.crop) ? ' · cropped' : ''} · 1920 × 1080`;
  $('btn-main').classList.toggle('selected', state.selectedId === L.MAIN_ID);
}

function badgeClass(layer) {
  if (layer.type === 'camera') return 'badge badge-live';
  if ((layer.src || '').toLowerCase().endsWith('.gif')) return 'badge badge-gif';
  return 'badge';
}

function badgeText(layer) {
  if (layer.type === 'camera') return 'LIVE';
  const ext = (layer.src || '').split('?')[0].split('.').pop().toUpperCase();
  return ['PNG', 'GIF', 'JPG', 'JPEG', 'WEBP'].includes(ext) ? ext : 'IMAGE';
}

function renderList() {
  const list = $('layer-list');
  list.innerHTML = '';
  const layers = state.layout.layers.slice().reverse(); // top-most first
  $('layer-empty').classList.toggle('hidden', layers.length > 0);
  for (const layer of layers) {
    const li = document.createElement('li');
    li.className = 'layer-row' + (layer.id === state.selectedId ? ' selected' : '') + (layer.visible ? '' : ' hidden-layer');
    li.innerHTML = `
      <button class="row-main" type="button">
        <span class="${badgeClass(layer)}">${badgeText(layer)}</span>
        <span class="main-text">
          <span class="row-name"></span>
          <span class="row-meta">${layer.x}, ${layer.y} · ${layer.w} × ${layer.h}</span>
        </span>
      </button>
      <button class="eye-btn ${layer.visible ? '' : 'off'}" type="button" aria-label="Toggle visibility">
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"></path><circle cx="10" cy="10" r="2.5"></circle></svg>
      </button>`;
    li.querySelector('.row-name').textContent = layer.name;
    li.querySelector('.row-main').addEventListener('click', () => select(layer.id));
    li.querySelector('.eye-btn').addEventListener('click', () => updateLayer(layer.id, { visible: !layer.visible }));
    list.appendChild(li);
  }
}

function renderProps() {
  const layer = selectedLayer();
  const isMain = state.selectedId === L.MAIN_ID;
  $('props').classList.toggle('hidden', !layer);
  $('main-props').classList.toggle('hidden', !isMain);
  $('props-title').classList.toggle('hidden', !layer && !isMain);
  $('props-empty').classList.toggle('hidden', !!layer || isMain);
  if (isMain) {
    renderMainProps();
    return;
  }
  if (!layer) return;

  const badge = $('props-badge');
  badge.className = badgeClass(layer);
  badge.textContent = badgeText(layer);
  $('f-name').setAttribute('aria-label', 'Overlay name');
  if (document.activeElement !== $('f-name')) $('f-name').value = layer.name;
  $('props-src').textContent =
    layer.type === 'camera'
      ? state.camera.label || 'Camera off — start it from Add source'
      : layer.src ? layer.src.split('/').pop() : 'No file — pick one from Add source';

  setIfIdle('f-x', layer.x);
  setIfIdle('f-y', layer.y);
  setIfIdle('f-w', layer.w);
  setIfIdle('f-h', layer.h);
  $('f-lock').checked = state.lockAspect;
  $('f-opacity').value = Math.round(layer.opacity * 100);
  $('f-opacity-val').textContent = `${Math.round(layer.opacity * 100)} %`;
  setIfIdle('f-radius', layer.radius);
  $('f-fit').value = layer.fit;
  $('f-border').checked = layer.border;
  $('f-mirror').checked = layer.mirror;
  $('f-mirror-label').classList.toggle('hidden', layer.type !== 'camera');

  // quick sizes
  const sizes = $('size-list');
  sizes.innerHTML = '';
  for (const p of L.SIZE_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill-btn' + (layer.w === Math.round(L.OUTPUT_W * p.fraction) ? ' active' : '');
    b.textContent = p.label;
    b.addEventListener('click', () => updateLayer(layer.id, L.resizeToFraction(layer, p.fraction)));
    sizes.appendChild(b);
  }

  // anchors
  const grid = $('anchor-grid');
  grid.innerHTML = '';
  const current = L.anchorOf(layer);
  for (const a of L.ANCHORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'anchor-btn' + (current === a.id ? ' active' : '');
    b.setAttribute('aria-label', a.label);
    b.title = a.label;
    b.innerHTML = '<span></span>';
    b.addEventListener('click', () => updateLayer(layer.id, L.snapToAnchor(layer, a)));
    grid.appendChild(b);
  }

  const index = state.layout.layers.indexOf(layer);
  $('btn-up').disabled = index >= state.layout.layers.length - 1;
  $('btn-down').disabled = index <= 0;

  placeCropSection($('props'), $('sec-layer'));
  $('crop-section').classList.remove('hidden');
  renderCrop(layer.crop, stage.sourceSize(layer.id));
}

const MAIN_BADGES = { placeholder: 'TEXT', video: 'VIDEO', image: 'IMAGE', cctv: 'CCTV' };

function renderMainProps() {
  const m = state.layout.main;
  const badge = $('props-badge');
  badge.className = m.type === 'cctv' ? 'badge badge-live' : 'badge';
  badge.textContent = MAIN_BADGES[m.type];
  $('f-name').setAttribute('aria-label', 'Main screen name');
  if (document.activeElement !== $('f-name')) $('f-name').value = m.label;
  $('props-src').textContent =
    m.type === 'placeholder' ? 'Main screen · placeholder text'
    : m.type === 'cctv' ? 'Main screen · live CCTV camera'
    : `Main screen · ${m.src.split('/').pop()}`;
  $('mp-fit').value = m.fit;

  const isCctv = m.type === 'cctv';
  $('mp-cctv').classList.toggle('hidden', !isCctv);
  $('mp-cctv-hint').classList.add('hidden');
  if (isCctv) renderCctvStatus(state.cctv.status.get(L.cctvIdOf(m.src)));

  // a placeholder has nothing to crop
  placeCropSection($('main-props'));
  $('crop-section').classList.toggle('hidden', m.type === 'placeholder');
  renderCrop(m.crop, stage.sourceSize(L.MAIN_ID));
}

function renderCctvStatus(s) {
  const phase = s ? s.state : 'idle';
  $('mp-cctv').className = `cctv-status ${phase}`;
  $('mp-cctv-text').textContent =
    phase === 'live' ? `Live · ${s.width} × ${s.height} · ${s.viewers} viewer${s.viewers === 1 ? '' : 's'}`
    : phase === 'connecting' ? 'Connecting to the camera…'
    : phase === 'error' ? `Camera offline, retrying · ${s.message}`
    : 'Not connected';
  const hint = $('mp-cctv-hint');
  hint.textContent = phase === 'error' && s.hint ? s.hint : '';
  hint.classList.toggle('hidden', !hint.textContent);
}

/** The crop controls serve the main screen and the overlays: they move into the panel being shown. */
function placeCropSection(host, before = null) {
  const sec = $('crop-section');
  if (sec.parentNode !== host || sec.nextElementSibling !== before) host.insertBefore(sec, before);
}

function renderCrop(crop, size) {
  for (const edge of L.CROP_EDGES) {
    $(`c-${edge}`).value = crop[edge];
    $(`c-${edge}-val`).textContent = `${crop[edge]} %`;
  }
  $('crop-reset').disabled = !L.hasCrop(crop);
  let info = '';
  if (size) {
    const w = Math.round(size.w * (1 - (crop.left + crop.right) / 100));
    const h = Math.round(size.h * (1 - (crop.top + crop.bottom) / 100));
    info = L.hasCrop(crop) ? `Source ${size.w} × ${size.h} → showing ${w} × ${h}` : `Source ${size.w} × ${size.h}`;
  }
  $('crop-info').textContent = info;
}

function setIfIdle(id, value) {
  const el = $(id);
  if (document.activeElement !== el) el.value = value;
}

function renderTemplates() {
  const list = $('template-list');
  if (!list.childElementCount) {
    for (const [id, t] of Object.entries(L.TEMPLATES)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'template-btn';
      b.dataset.template = id;
      const c = t.camera;
      const s = 64 / L.OUTPUT_W;
      b.innerHTML = `
        <span class="template-thumb" aria-hidden="true"><span class="t-cam" style="left:${c.x * s}px;top:${c.y * s}px;width:${c.w * s}px;height:${c.h * s}px"></span></span>
        <span class="template-text"><span class="t-name">${t.label}</span><span class="t-desc">${t.desc}</span></span>`;
      b.addEventListener('click', () => applyTemplate(id));
      list.appendChild(b);
    }
  }
  for (const b of list.children) b.classList.toggle('active', b.dataset.template === state.layout.template);
  $('template-status').textContent = L.TEMPLATES[state.layout.template] ? 'Preset layout' : 'Custom layout';
}

function renderFooter() {
  const n = state.layout.layers.length;
  const v = state.layout.layers.filter((l) => l.visible).length;
  $('status-layers').textContent = `${n} overlay${n === 1 ? '' : 's'} · ${v} on program`;
  const sync = $('status-sync');
  sync.textContent = state.dirty ? 'Changes not yet on program' : state.autoTake ? 'Live · every change goes to program' : 'On program';
  sync.classList.toggle('dirty', state.dirty);
  $('btn-take').disabled = !state.dirty;
  $('chip-outputs').textContent = `${state.outputs.size} output${state.outputs.size === 1 ? '' : 's'}`;
  const cam = $('chip-camera');
  cam.textContent = state.camera.stream ? 'Camera live' : 'Camera off';
  cam.className = 'chip ' + (state.camera.stream ? 'chip-live' : 'chip-off');
}

// ---------------------------------------------------------------------------
// Properties panel events
// ---------------------------------------------------------------------------

function numField(id, apply) {
  const el = $(id);
  const commit = () => {
    const layer = selectedLayer();
    if (!layer) return;
    const v = Number(el.value);
    if (!Number.isFinite(v)) return;
    updateLayer(layer.id, apply(layer, Math.round(v)));
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
}

numField('f-x', (l, v) => ({ x: v }));
numField('f-y', (l, v) => ({ y: v }));
numField('f-w', (l, v) => {
  const w = L.clamp(v, 16, L.OUTPUT_W);
  return state.lockAspect ? { w, h: L.clamp(Math.round((w * l.h) / l.w), 16, L.OUTPUT_H) } : { w };
});
numField('f-h', (l, v) => {
  const h = L.clamp(v, 16, L.OUTPUT_H);
  return state.lockAspect ? { h, w: L.clamp(Math.round((h * l.w) / l.h), 16, L.OUTPUT_W) } : { h };
});
numField('f-radius', (l, v) => ({ radius: L.clamp(v, 0, 400) }));

$('f-lock').addEventListener('change', (e) => { state.lockAspect = e.target.checked; });
$('f-opacity').addEventListener('input', (e) => {
  const layer = selectedLayer();
  if (!layer) return;
  $('f-opacity-val').textContent = `${e.target.value} %`;
  updateLayer(layer.id, { opacity: Number(e.target.value) / 100 }, { live: true });
  stage.render(state.layout, state.selectedId);
});
$('f-opacity').addEventListener('change', (e) => {
  const layer = selectedLayer();
  if (layer) updateLayer(layer.id, { opacity: Number(e.target.value) / 100 });
});
$('f-fit').addEventListener('change', (e) => { const l = selectedLayer(); if (l) updateLayer(l.id, { fit: e.target.value }); });
$('f-border').addEventListener('change', (e) => { const l = selectedLayer(); if (l) updateLayer(l.id, { border: e.target.checked }); });
$('f-mirror').addEventListener('change', (e) => { const l = selectedLayer(); if (l) updateLayer(l.id, { mirror: e.target.checked }); });
$('f-name').addEventListener('change', (e) => {
  if (state.selectedId === L.MAIN_ID) return updateMain({ label: e.target.value.trim() || state.layout.main.label });
  const l = selectedLayer();
  if (l) updateLayer(l.id, { name: e.target.value.trim() || l.name });
});

// main screen
$('mp-fit').addEventListener('change', (e) => updateMain({ fit: e.target.value }));
$('mp-change').addEventListener('click', () => openDialog('main'));

// crop: the selected overlay, or the main screen; the preview follows the sliders
function setCrop(crop, live) {
  if (state.selectedId === L.MAIN_ID) return updateMain({ crop }, { live });
  const layer = selectedLayer();
  if (!layer) return;
  updateLayer(layer.id, { crop }, { live });
  if (live) stage.render(state.layout, state.selectedId);
}
function selectedCrop() {
  if (state.selectedId === L.MAIN_ID) return state.layout.main.crop;
  const layer = selectedLayer();
  return layer ? layer.crop : null;
}
for (const edge of L.CROP_EDGES) {
  const input = $(`c-${edge}`);
  const apply = (live) => {
    const crop = selectedCrop();
    if (crop) setCrop(L.sanitizeCrop(Object.assign({}, crop, { [edge]: Number(input.value) })), live);
  };
  input.addEventListener('input', () => apply(true));
  input.addEventListener('change', () => apply(false));
}
$('crop-reset').addEventListener('click', () => setCrop(L.sanitizeCrop(), false));

$('btn-up').addEventListener('click', () => { const l = selectedLayer(); if (l) moveLayer(l.id, +1); });
$('btn-down').addEventListener('click', () => { const l = selectedLayer(); if (l) moveLayer(l.id, -1); });
$('btn-delete').addEventListener('click', () => { const l = selectedLayer(); if (l) removeLayer(l.id); });
$('btn-duplicate').addEventListener('click', () => {
  const l = selectedLayer();
  if (!l) return;
  addLayer(L.newLayer(l.type, Object.assign({}, l, { id: undefined, name: l.name + ' copy', x: l.x + 40, y: l.y + 40 })));
});

// keyboard: nudge / delete / deselect
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (['input', 'select', 'textarea'].includes(tag) || $('add-dialog').open) return;
  if (e.key === 'Escape' && state.selectedId === L.MAIN_ID) return select(null);
  const layer = selectedLayer();
  if (!layer) return;
  const step = e.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: { x: layer.x - step }, ArrowRight: { x: layer.x + step }, ArrowUp: { y: layer.y - step }, ArrowDown: { y: layer.y + step } };
  if (moves[e.key]) {
    e.preventDefault();
    updateLayer(layer.id, moves[e.key]);
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    removeLayer(layer.id);
  } else if (e.key === 'Escape') {
    select(null);
  }
});

// ---------------------------------------------------------------------------
// Footer actions
// ---------------------------------------------------------------------------

$('f-autotake').addEventListener('change', (e) => {
  state.autoTake = e.target.checked;
  if (state.autoTake && state.dirty) pushLayout();
  renderFooter();
});
$('btn-take').addEventListener('click', () => pushLayout({ force: true }));
$('btn-reset').addEventListener('click', () => {
  if (!confirm('Reset the layout to the default (one camera overlay, placeholder main screen)?')) return;
  state.selectedId = null;
  setLayout(L.DEFAULT_LAYOUT);
});

// ---------------------------------------------------------------------------
// Add source dialog
// ---------------------------------------------------------------------------

const dialog = $('add-dialog');

function openDialog(tab) {
  switchTab(tab || 'camera');
  if (!dialog.open) dialog.showModal();
  if (tab === 'image' || !tab) loadLibrary();
  if ((tab || 'camera') === 'camera') listCameras();
  syncMainForm();
}

function switchTab(id) {
  for (const t of dialog.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === id);
  for (const p of dialog.querySelectorAll('.tab-panel')) p.classList.toggle('active', p.dataset.panel === id);
  if (id === 'image') loadLibrary();
  if (id === 'camera') listCameras();
}

$('btn-add').addEventListener('click', () => openDialog('camera'));
$('btn-main').addEventListener('click', () => select(L.MAIN_ID));
for (const t of dialog.querySelectorAll('.tab')) t.addEventListener('click', () => switchTab(t.dataset.tab));
for (const b of dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });

for (const sel of dialog.querySelectorAll('.anchor-select')) {
  for (const a of L.ANCHORS) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.label;
    sel.appendChild(o);
  }
  sel.value = 'tl';
}

function toast(message, isError) {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// ---------- camera ----------

async function listCameras() {
  const sel = $('cam-device');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const current = sel.value || state.camera.deviceId;
    sel.innerHTML = '';
    if (!cams.length) {
      sel.innerHTML = '<option value="">No camera found</option>';
      return;
    }
    cams.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Camera ${i + 1}${d.label ? '' : ' (allow access to see names)'}`;
      sel.appendChild(o);
    });
    if (current && cams.some((d) => d.deviceId === current)) sel.value = current;
  } catch (err) {
    sel.innerHTML = '<option value="">Camera list unavailable</option>';
  }
}

async function startCamera() {
  const err = $('cam-error');
  err.classList.add('hidden');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    err.textContent = 'This browser cannot access the camera here. Open the admin on http://localhost or over HTTPS.';
    err.classList.remove('hidden');
    return null;
  }
  const [w, h] = $('cam-res').value.split('x').map(Number);
  const deviceId = $('cam-device').value;
  const constraints = {
    video: Object.assign({ width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } }, deviceId ? { deviceId: { exact: deviceId } } : {}),
    audio: $('cam-audio').checked,
  };
  try {
    stopCamera({ silent: true });
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getVideoTracks()[0];
    state.camera.stream = stream;
    state.camera.deviceId = track.getSettings().deviceId || deviceId;
    state.camera.label = `${track.label || 'Camera'} · ${track.getSettings().width || w} × ${track.getSettings().height || h}`;
    state.camera.mirror = $('cam-mirror').checked;
    track.addEventListener('ended', () => stopCamera());

    const prev = $('cam-preview');
    prev.srcObject = stream;
    prev.closest('.cam-preview').classList.add('live');
    prev.closest('.cam-preview').classList.toggle('mirror', state.camera.mirror);
    $('cam-stop').classList.remove('hidden');
    $('cam-start').textContent = 'Use this camera & add to layout';

    stage.setCameraStream(stream);
    socket.emit('camera:state', { active: true, label: state.camera.label });
    await listCameras();
    restartPeers();
    renderFooter();
    renderProps();
    return stream;
  } catch (e) {
    err.textContent =
      e.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow the camera for this site in the browser address bar, then try again.'
        : `Could not start the camera: ${e.message}`;
    err.classList.remove('hidden');
    return null;
  }
}

function stopCamera({ silent = false } = {}) {
  if (state.camera.stream) {
    for (const t of state.camera.stream.getTracks()) t.stop();
  }
  state.camera.stream = null;
  state.camera.label = '';
  stage.setCameraStream(null);
  const prev = $('cam-preview');
  prev.srcObject = null;
  prev.closest('.cam-preview').classList.remove('live');
  $('cam-stop').classList.add('hidden');
  $('cam-start').textContent = 'Start camera & add to layout';
  closeAllPeers();
  if (!silent) socket.emit('camera:state', { active: false, label: '' });
  renderFooter();
  renderProps();
}

$('cam-start').addEventListener('click', async () => {
  const stream = await startCamera();
  if (!stream) return;
  const mirror = $('cam-mirror').checked;
  const existing = state.layout.layers.find((l) => l.type === 'camera');
  if (existing) {
    updateLayer(existing.id, { mirror });
  } else {
    const fraction = Number($('cam-size').value);
    const w = Math.round(L.OUTPUT_W * fraction);
    const base = L.newLayer('camera', { name: 'Local Camera', w, h: Math.round((w * 9) / 16), mirror, radius: 8, border: true });
    addLayer(L.snapToAnchor(base, $('cam-pos').value));
  }
  dialog.close();
  toast('Camera is live on the program.');
});
$('cam-stop').addEventListener('click', () => stopCamera());
$('cam-mirror').addEventListener('change', (e) => {
  $('cam-preview').closest('.cam-preview').classList.toggle('mirror', e.target.checked);
  const cam = state.layout.layers.find((l) => l.type === 'camera');
  if (cam && state.camera.stream) updateLayer(cam.id, { mirror: e.target.checked });
});
$('cam-device').addEventListener('change', () => { if (state.camera.stream) startCamera(); });
$('cam-res').addEventListener('change', () => { if (state.camera.stream) startCamera(); });

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', listCameras);
}

// ---------- images (PNG / GIF) ----------

const dropzone = $('dropzone');
const imgFile = $('img-file');

function setPendingImage(p) {
  state.pendingImage = p;
  $('img-file-name').textContent = p ? p.name : '';
  $('img-add').disabled = !p;
  $('img-add').textContent = p && p.url ? 'Add to layout' : 'Upload & add to layout';
  for (const b of $('img-library').querySelectorAll('button')) b.classList.toggle('active', !!(p && p.url && b.dataset.url === p.url));
}

imgFile.addEventListener('change', () => {
  const f = imgFile.files[0];
  if (f) setPendingImage({ file: f, name: f.name });
});
for (const ev of ['dragenter', 'dragover']) dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
for (const ev of ['dragleave', 'drop']) dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); });
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) setPendingImage({ file: f, name: f.name });
});

async function loadLibrary() {
  const ul = $('img-library');
  try {
    const res = await fetch('/api/uploads');
    state.library = (await res.json()).filter((f) => /\.(png|gif|jpe?g|webp)$/i.test(f.name));
    ul.innerHTML = '';
    if (!state.library.length) {
      ul.innerHTML = '<li class="muted small">Nothing uploaded yet.</li>';
      return;
    }
    for (const f of state.library) {
      const li = document.createElement('li');
      const img = document.createElement('img');
      img.src = f.url;
      img.alt = '';
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.url = f.url;
      b.textContent = f.name;
      b.addEventListener('click', () => setPendingImage({ url: f.url, name: f.name }));
      li.append(img, b);
      ul.appendChild(li);
    }
  } catch (_) {
    ul.innerHTML = '<li class="muted small">Could not load the library.</li>';
  }
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

function imageSize(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
    img.onerror = () => resolve({ w: 400, h: 300 });
    img.src = url;
  });
}

$('img-add').addEventListener('click', async () => {
  const p = state.pendingImage;
  const err = $('img-error');
  err.classList.add('hidden');
  if (!p) return;
  const btn = $('img-add');
  btn.disabled = true;
  try {
    let url = p.url;
    let name = p.name;
    if (!url) {
      btn.textContent = 'Uploading…';
      const up = await uploadFile(p.file);
      url = up.url;
      name = up.name;
    }
    const nat = await imageSize(url);
    const sizeVal = $('img-size').value;
    let w = sizeVal === 'natural' ? nat.w : Math.round(L.OUTPUT_W * Number(sizeVal));
    w = L.clamp(w, 16, L.OUTPUT_W);
    let h = Math.round((w * nat.h) / nat.w);
    if (h > L.OUTPUT_H) { h = L.OUTPUT_H; w = Math.round((h * nat.w) / nat.h); }
    const isGif = /\.gif$/i.test(url);
    const base = L.newLayer('image', {
      name: name.replace(/\.[^.]+$/, ''),
      src: url, w, h,
      fit: 'contain', border: false, radius: 0,
    });
    addLayer(L.snapToAnchor(base, $('img-pos').value));
    setPendingImage(null);
    imgFile.value = '';
    dialog.close();
    toast(isGif ? 'GIF added — it animates on the program.' : 'Image added to the layout.');
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = !state.pendingImage;
    btn.textContent = 'Upload & add to layout';
  }
});

// ---------- main screen ----------

function syncMainForm() {
  const m = state.layout.main;
  const type = m.type === 'video' && /^https?:/i.test(m.src) ? 'url' : m.type;
  const radio = dialog.querySelector(`input[name="main-type"][value="${type}"]`);
  if (radio) radio.checked = true;
  $('main-label').value = m.type === 'cctv' ? 'Main Screen' : m.label;
  $('main-url').value = type === 'url' ? m.src : '';
  $('main-fit').value = m.fit;
  $('main-loop').checked = m.loop;
  $('main-muted').checked = m.muted;
  showMainFields();
  loadCctv(m.type === 'cctv' ? L.cctvIdOf(m.src) : undefined);
}

function showMainFields() {
  const type = dialog.querySelector('input[name="main-type"]:checked').value;
  for (const el of dialog.querySelectorAll('[data-main]')) el.classList.toggle('hidden', el.dataset.main !== type);
  $('main-video-opts').classList.toggle('hidden', type !== 'video' && type !== 'url');
}
for (const r of dialog.querySelectorAll('input[name="main-type"]')) r.addEventListener('change', showMainFields);

// ---------- main screen: live CCTV ----------

async function loadCctv(selectId) {
  try {
    const res = await fetch('/api/cctv');
    state.cctv.cameras = await res.json();
  } catch (_) {
    state.cctv.cameras = [];
  }
  const sel = $('cctv-select');
  const keep = selectId !== undefined ? selectId : sel.value;
  sel.innerHTML = '';
  for (const cam of state.cctv.cameras) {
    const o = document.createElement('option');
    o.value = cam.id;
    o.textContent = cam.name;
    sel.appendChild(o);
  }
  const add = document.createElement('option');
  add.value = '';
  add.textContent = '+ Add a new camera';
  sel.appendChild(add);
  sel.value = state.cctv.cameras.some((c) => c.id === keep) ? keep : state.cctv.cameras[0] ? state.cctv.cameras[0].id : '';
  fillCctvForm();
}

function selectedCctv() {
  return state.cctv.cameras.find((c) => c.id === $('cctv-select').value) || null;
}

function fillCctvForm() {
  const cam = selectedCctv();
  $('cctv-name').value = cam ? cam.name : '';
  $('cctv-url').value = cam ? cam.url : ''; // the password comes back masked; leave it to keep it
  $('cctv-fps').value = String(cam ? cam.fps : 15);
  $('cctv-delete').classList.toggle('hidden', !cam);
  $('cctv-shot').classList.add('hidden');
  $('cctv-shot-hint').classList.remove('hidden');
  setCctvResult('');
}
$('cctv-select').addEventListener('change', fillCctvForm);

function setCctvResult(text, kind) {
  const el = $('cctv-result');
  el.textContent = text;
  el.className = 'small' + (kind ? ` ${kind}` : '');
}

async function postJson(url, method, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/** Saves the camera in the form (new or changed) and returns it. */
async function saveCctv() {
  const cam = selectedCctv();
  const body = { name: $('cctv-name').value, url: $('cctv-url').value, fps: Number($('cctv-fps').value) };
  const saved = await postJson(cam ? `/api/cctv/${cam.id}` : '/api/cctv', cam ? 'PUT' : 'POST', body);
  await loadCctv(saved.id);
  return saved;
}

$('cctv-test').addEventListener('click', async () => {
  const btn = $('cctv-test');
  const cam = selectedCctv();
  btn.disabled = true;
  btn.textContent = 'Testing…';
  setCctvResult('Connecting to the camera, this can take a few seconds…');
  try {
    const r = await postJson('/api/cctv/test', 'POST', { id: cam ? cam.id : undefined, url: $('cctv-url').value });
    if (!r.ok) return setCctvResult([r.error, r.hint].filter(Boolean).join(' '), 'error');
    $('cctv-shot').src = r.image;
    $('cctv-shot').classList.remove('hidden');
    $('cctv-shot-hint').classList.add('hidden');
    setCctvResult(`Connected · ${r.width} × ${r.height}${r.codec ? ` · ${r.codec.toUpperCase()}` : ''}`, 'ok');
  } catch (e) {
    setCctvResult(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Test connection';
  }
});

$('cctv-delete').addEventListener('click', async () => {
  const cam = selectedCctv();
  if (!cam || !confirm(`Delete the camera "${cam.name}"? If it is on the main screen, the main screen goes back to the placeholder.`)) return;
  const res = await fetch(`/api/cctv/${cam.id}`, { method: 'DELETE' });
  if (!res.ok) return setCctvResult('Could not delete the camera.', 'error');
  await loadCctv('');
  toast(`Camera "${cam.name}" deleted.`);
});

$('main-apply').addEventListener('click', async () => {
  const err = $('main-error');
  err.classList.add('hidden');
  const type = dialog.querySelector('input[name="main-type"]:checked').value;
  const btn = $('main-apply');
  btn.disabled = true;
  try {
    const main = Object.assign({}, state.layout.main, {
      fit: $('main-fit').value,
      loop: $('main-loop').checked,
      muted: $('main-muted').checked,
      label: $('main-label').value.trim() || 'Main Screen',
    });
    if (type === 'placeholder') {
      main.type = 'placeholder';
      main.src = '';
    } else if (type === 'url') {
      const url = $('main-url').value.trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('Enter a direct http(s) link to an .mp4 or .webm file.');
      main.type = 'video';
      main.src = url;
    } else if (type === 'cctv') {
      btn.textContent = 'Saving camera…';
      const cam = await saveCctv();
      main.type = 'cctv';
      main.src = L.cctvSrc(cam.id);
      main.label = cam.name;
    } else {
      const input = type === 'video' ? $('main-video') : $('main-image');
      const file = input.files[0];
      if (!file) {
        if (state.layout.main.type === type && state.layout.main.src) {
          // keep the current file, only options changed
        } else {
          throw new Error('Choose a file first.');
        }
      } else {
        btn.textContent = 'Uploading…';
        const up = await uploadFile(file);
        main.src = up.url;
      }
      main.type = type;
    }
    // a crop belongs to its source: a new source starts uncropped
    const prev = state.layout.main;
    if (main.type !== prev.type || main.src !== prev.src) main.crop = L.sanitizeCrop();
    state.layout = Object.assign({}, state.layout, { main });
    renderAll();
    pushLayout();
    dialog.close();
    toast('Main screen updated.');
  } catch (e) {
    err.textContent = e.message;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply to main screen';
  }
});

// ---------------------------------------------------------------------------
// Realtime: layout sync + peers
// ---------------------------------------------------------------------------

let connectedBefore = false;
socket.on('connect', () => {
  socket.emit('hello', { role: 'admin', name: 'admin' });
  if (state.camera.stream) socket.emit('camera:state', { active: true, label: state.camera.label });
  // back after a server restart: the CCTV stream connection died with it
  if (connectedBefore) stage.reloadStreams();
  connectedBefore = true;
});

socket.on('cctv:status', (status) => {
  state.cctv.status.set(status.id, status);
  stage.setCctvStatus(status);
  if (state.selectedId === L.MAIN_ID) renderMainProps();
});

socket.on('layout', (next) => {
  // Initial layout from the server, or a change made by another admin window.
  if (state.dirty) return;
  state.layout = L.sanitizeLayout(next);
  if (state.selectedId && !state.layout.layers.some((l) => l.id === state.selectedId)) state.selectedId = null;
  renderAll();
});

socket.on('peers', (p) => {
  state.outputs = new Set(p.outputIds || []);
  renderFooter();
});

socket.on('output:joined', ({ id }) => {
  state.outputs.add(id);
  renderFooter();
  if (state.camera.stream) createPeer(id);
});

socket.on('output:left', ({ id }) => {
  state.outputs.delete(id);
  closePeer(id);
  renderFooter();
});

// ---------------------------------------------------------------------------
// WebRTC: publish the camera to every output
// ---------------------------------------------------------------------------

async function createPeer(id) {
  closePeer(id);
  const stream = state.camera.stream;
  if (!stream) return;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const entry = { pc, pending: [] };
  state.peers.set(id, entry);
  for (const track of stream.getTracks()) pc.addTrack(track, stream);
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('rtc:signal', { to: id, data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      // try once more (e.g. the output reloaded mid-negotiation)
      setTimeout(() => { if (state.outputs.has(id) && state.peers.get(id)?.pc === pc) createPeer(id); }, 1500);
    }
  };
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rtc:signal', { to: id, data: { sdp: pc.localDescription } });
  } catch (err) {
    console.error('WebRTC offer failed', err);
  }
}

socket.on('rtc:signal', async ({ from, data }) => {
  const entry = state.peers.get(from);
  if (!entry || !data) return;
  try {
    if (data.sdp && data.sdp.type === 'answer') {
      await entry.pc.setRemoteDescription(data.sdp);
      for (const c of entry.pending) await entry.pc.addIceCandidate(c).catch(() => {});
      entry.pending = [];
    } else if (data.candidate) {
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate).catch(() => {});
      else entry.pending.push(data.candidate);
    }
  } catch (err) {
    console.error('WebRTC signal error', err);
  }
});

function restartPeers() {
  for (const id of state.outputs) createPeer(id);
}

function closePeer(id) {
  const entry = state.peers.get(id);
  if (!entry) return;
  try { entry.pc.close(); } catch (_) { /* ignore */ }
  state.peers.delete(id);
  socket.emit('rtc:signal', { to: id, data: { bye: true } });
}

function closeAllPeers() {
  for (const id of [...state.peers.keys()]) closePeer(id);
}

window.addEventListener('beforeunload', () => {
  if (state.camera.stream) socket.emit('camera:state', { active: false, label: '' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

renderAll();
fitPreview();
