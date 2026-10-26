/**
 * Admin — split-screen layout editor.
 *
 * - Edits the layout (overlays: local camera, USB devices, shared screens and windows, PNG/GIF images;
 *   main screen: placeholder/video/image/live CCTV)
 * - Crops any source (main screen or overlay) to cut toolbars and black bars off its edges
 * - Live preview with drag-to-move and resize handles (shared stage renderer)
 * - Sends the layout to every program output over Socket.IO ("Auto take" or "Take to program")
 * - Captures the local camera and USB devices (getUserMedia) and screen shares (getDisplayMedia), and streams
 *   each of them to the outputs over WebRTC: one connection per output and source
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
  live: new Map(), // USB devices and screen shares on the layout: source id -> { kind, stream, label, fps }
  pending: { usb: null, screen: null }, // the dialog's preview before "Add to layout": { stream, deviceId | fps }
  stopped: new Set(), // USB sources stopped by hand: plugging devices in does not restart them
  liveElsewhere: {}, // sources another admin window publishes (from the server)
  peers: new Map(), // `${output socket id}|${source id}` -> RTCPeerConnection
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
  releaseUnused();
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
  releaseUnused();
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
  if (!L.templateTarget(state.layout.layers)) {
    toast('Add a camera, USB device or screen share first — templates position it.', true);
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

const LIVE_BADGES = { camera: 'LIVE', usb: 'USB', screen: 'SCREEN' };

function badgeClass(layer) {
  if (L.LIVE_TYPES.includes(layer.type)) return 'badge badge-live';
  if ((layer.src || '').toLowerCase().endsWith('.gif')) return 'badge badge-gif';
  return 'badge';
}

function badgeText(layer) {
  if (LIVE_BADGES[layer.type]) return LIVE_BADGES[layer.type];
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
    layer.type === 'camera' ? state.camera.label || 'Camera off — start it from Add source'
    : layer.type === 'usb' ? layer.device.label || 'USB device'
    : layer.type === 'screen' ? 'Screen, window or browser tab'
    : layer.src ? layer.src.split('/').pop() : 'No file — pick one from Add source';
  renderSourceSection(layer);

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
  $('f-mirror-label').classList.toggle('hidden', layer.type !== 'camera' && layer.type !== 'usb');

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

/** Status and start / stop buttons of a USB device or screen share overlay. */
function renderSourceSection(layer) {
  const shown = layer.type === 'usb' || layer.type === 'screen';
  $('sec-source').classList.toggle('hidden', !shown);
  if (!shown) return;
  const usb = layer.type === 'usb';
  const src = state.live.get(layer.source);
  const elsewhere = !src && !!state.liveElsewhere[layer.source];
  let text = usb ? 'Off' : 'Not shared';
  if (src) {
    const s = src.stream.getVideoTracks()[0].getSettings();
    text = `${usb ? 'Live' : 'Sharing'} · ${s.width} × ${s.height}${s.frameRate ? ` · ${Math.round(s.frameRate)} fps` : ''}`;
  } else if (elsewhere) {
    text = 'Live from another admin window';
  }
  $('src-status').className = `cctv-status${src ? ' live' : elsewhere ? ' connecting' : ''}`;
  $('src-status-text').textContent = text;
  $('src-start').textContent = usb ? 'Start device' : src ? 'Change window…' : 'Share again…';
  $('src-start').classList.toggle('hidden', elsewhere || (usb && !!src));
  $('src-stop').textContent = usb ? 'Stop device' : 'Stop sharing';
  $('src-stop').classList.toggle('hidden', !src);
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
  if (id === 'usb') openUsbTab();
}

function activeTab() {
  return dialog.querySelector('.tab.active').dataset.tab;
}

$('btn-add').addEventListener('click', () => openDialog('camera'));
$('btn-main').addEventListener('click', () => select(L.MAIN_ID));
for (const t of dialog.querySelectorAll('.tab')) t.addEventListener('click', () => switchTab(t.dataset.tab));
for (const b of dialog.querySelectorAll('[data-close]')) b.addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
// previews that were not added to the layout let go of their device or screen
dialog.addEventListener('close', () => {
  stopPending('usb');
  stopPending('screen');
  $('usb-name').value = '';
  $('screen-name').value = '';
  $('screen-pick').textContent = 'Choose a screen or window…';
});

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
    publish('camera');
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
  unpublish('camera');
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
  navigator.mediaDevices.addEventListener('devicechange', () => {
    listCameras();
    if (dialog.open && activeTab() === 'usb') listUsbDevices();
    resumeDevices();
  });
}

function stopTracks(stream) {
  if (stream) for (const t of stream.getTracks()) t.stop();
}

/** Shows a stream in the dialog's USB or screen preview, with its size in the corner. */
function showPreview(kind, stream) {
  const video = $(`${kind}-preview`);
  video.srcObject = stream || null;
  video.closest('.cam-preview').classList.toggle('live', !!stream);
  const s = stream ? stream.getVideoTracks()[0].getSettings() : null;
  $(`${kind}-preview-tag`).textContent = s ? `PREVIEW · ${s.width} × ${s.height}${s.frameRate ? ` · ${Math.round(s.frameRate)} FPS` : ''}` : 'PREVIEW';
  $(`${kind}-add`).disabled = !stream;
}

/** Drops the dialog's preview (USB device or screen) unless it went on the layout. */
function stopPending(kind) {
  const p = state.pending[kind];
  state.pending[kind] = null;
  if (p) stopTracks(p.stream);
  if (kind === 'usb') usbToken++;
  showPreview(kind, null);
}

/**
 * A new overlay for a live source, sized to its picture: a share of the output width at the chosen anchor,
 * or the whole program.
 */
function placeNew(type, props, size, anchor, settings) {
  if (Number(size) >= 1) {
    return L.newLayer(type, Object.assign({}, props, { x: 0, y: 0, w: L.OUTPUT_W, h: L.OUTPUT_H, radius: 0, border: false }));
  }
  const aspect = settings.width && settings.height ? settings.height / settings.width : 9 / 16;
  let w = Math.round(L.OUTPUT_W * Number(size));
  let h = Math.round(w * aspect);
  if (h > L.OUTPUT_H) {
    h = L.OUTPUT_H;
    w = Math.round(h / aspect);
  }
  return L.snapToAnchor(L.newLayer(type, Object.assign({}, props, { w, h, radius: 8, border: true })), anchor);
}

// ---------- USB devices (capture cards, webcams) ----------

const FORMAT_SIZES = [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [960, 540], [640, 480]];
const DEFAULT_FORMAT = { width: 1920, height: 1080, fps: 30 };
let usbToken = 0; // the latest preview request: an older one that finishes late is dropped

const formatValue = (f) => `${f.width}x${f.height}@${f.fps}`;

function parseFormat(value) {
  const m = /^(\d+)x(\d+)@(\d+)$/.exec(value || '');
  return m ? { width: Number(m[1]), height: Number(m[2]), fps: Number(m[3]) } : DEFAULT_FORMAT;
}

/** Size and frame rate as constraints the browser meets as closely as the device allows. */
function formatConstraints(format) {
  const c = {};
  if (format.width) Object.assign(c, { width: { ideal: format.width }, height: { ideal: format.height } });
  if (format.fps) c.frameRate = { ideal: format.fps };
  return c;
}

function usbConstraints(deviceId, format) {
  return { video: Object.assign({ deviceId: { exact: deviceId } }, formatConstraints(format)), audio: false };
}

/** The formats to offer for a device: the usual sizes its capabilities reach, at 60 (or 50) and 30 fps. */
function deviceFormats(track) {
  const caps = track.getCapabilities ? track.getCapabilities() : {};
  const maxW = (caps.width && caps.width.max) || DEFAULT_FORMAT.width;
  const maxH = (caps.height && caps.height.max) || DEFAULT_FORMAT.height;
  const maxFps = Math.round((caps.frameRate && caps.frameRate.max) || DEFAULT_FORMAT.fps);
  const rates = maxFps >= 50 ? [maxFps >= 59 ? 60 : 50, 30] : [Math.min(maxFps, 30)];
  const list = [];
  for (const [width, height] of FORMAT_SIZES) {
    if (width > maxW || height > maxH) continue;
    for (const fps of rates) list.push({ width, height, fps });
  }
  return list.length ? list : [DEFAULT_FORMAT];
}

function fillFormats(track, wanted) {
  const sel = $('usb-format');
  const formats = deviceFormats(track);
  sel.innerHTML = '';
  for (const f of formats) {
    const o = document.createElement('option');
    o.value = formatValue(f);
    o.textContent = `${f.width} × ${f.height} · ${f.fps} fps`;
    sel.appendChild(o);
  }
  // the wanted format if the device has it, else the largest up to 1080p at 30 fps
  const pick = formats.find((f) => formatValue(f) === formatValue(wanted)) || formats.find((f) => f.width <= 1920 && f.fps <= 30) || formats[0];
  sel.value = formatValue(pick);
}

function deviceError(e) {
  if (e.name === 'NotAllowedError') return 'Camera access was blocked. Allow the camera for this site in the browser address bar, then try again.';
  if (e.name === 'NotReadableError' || e.name === 'AbortError') {
    return 'The device is busy: close the other programs that use it (Zoom, Teams, OBS, the Camera app), then choose it again.';
  }
  if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') return 'The device is not connected: plug it in, then choose it again.';
  return `Could not start the device: ${e.message}`;
}

/** The overlay that shows a device, if there is one: devices on the layout are shared, never captured twice. */
function usbLayerOf(deviceId) {
  return state.layout.layers.find((l) => l.type === 'usb' && l.device.id === deviceId) || null;
}

/** Fills the device list; false while the browser hides the devices until camera access is allowed. */
async function listUsbDevices() {
  const sel = $('usb-device');
  const current = sel.value;
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch (_) {
    // no device access in this browser
  }
  if (devices.length && !devices[0].deviceId) return false;
  sel.innerHTML = '';
  if (!devices.length) {
    sel.innerHTML = '<option value="">No device found — plug one in</option>';
    return true;
  }
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = (d.label || `Video device ${i + 1}`) + (usbLayerOf(d.deviceId) ? ' · on the layout' : '');
    sel.appendChild(o);
  });
  if (devices.some((d) => d.deviceId === current)) sel.value = current;
  return true;
}

async function openUsbTab() {
  const err = $('usb-error');
  err.classList.add('hidden');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    err.textContent = 'This browser cannot use devices here. Open the admin on http://localhost or over HTTPS.';
    err.classList.remove('hidden');
    return;
  }
  if (!(await listUsbDevices())) {
    // the browser names the devices only once camera access is allowed: ask now
    try {
      stopTracks(await navigator.mediaDevices.getUserMedia({ video: true }));
    } catch (e) {
      err.textContent = deviceError(e);
      err.classList.remove('hidden');
      return;
    }
    await listUsbDevices();
  }
  if (!state.pending.usb) startUsbPreview();
}

/** Shows the chosen device: its live stream when it is on the layout already, else a new capture. */
async function startUsbPreview() {
  const deviceId = $('usb-device').value;
  const err = $('usb-error');
  err.classList.add('hidden');
  stopPending('usb');
  const token = usbToken;
  $('usb-name').value = '';
  if (!deviceId) return;
  const layer = usbLayerOf(deviceId);
  const live = layer && state.live.get(layer.source);
  if (live) {
    fillFormats(live.stream.getVideoTracks()[0], layer.device);
    showPreview('usb', live.stream);
    $('usb-name').placeholder = live.label;
    return;
  }
  const format = layer ? layer.device : parseFormat($('usb-format').value);
  try {
    const stream = await navigator.mediaDevices.getUserMedia(usbConstraints(deviceId, format));
    if (token !== usbToken || !dialog.open) return stopTracks(stream);
    const track = stream.getVideoTracks()[0];
    state.pending.usb = { stream, deviceId };
    track.addEventListener('ended', () => {
      if (state.pending.usb && state.pending.usb.stream === stream) stopPending('usb');
    });
    fillFormats(track, format);
    showPreview('usb', stream);
    $('usb-name').placeholder = track.label || 'USB device';
  } catch (e) {
    if (token !== usbToken) return;
    err.textContent = deviceError(e);
    err.classList.remove('hidden');
  }
}

$('usb-device').addEventListener('change', startUsbPreview);

$('usb-format').addEventListener('change', async () => {
  const layer = usbLayerOf($('usb-device').value);
  const live = layer && state.live.get(layer.source);
  const stream = live ? live.stream : state.pending.usb && state.pending.usb.stream;
  if (!stream) return startUsbPreview();
  const format = parseFormat($('usb-format').value);
  try {
    // a device on the program changes format in place: the outputs keep their connection
    await stream.getVideoTracks()[0].applyConstraints(formatConstraints(format));
  } catch (_) {
    $('usb-error').textContent = 'The device cannot use this format. Choose another one.';
    $('usb-error').classList.remove('hidden');
  }
  showPreview('usb', stream);
  if (live) updateDevice(layer.source, format);
});

$('usb-add').addEventListener('click', () => {
  const deviceId = $('usb-device').value;
  const layer = usbLayerOf(deviceId);
  const sourceId = layer ? layer.source : L.uid('usb');
  let stream = state.live.has(sourceId) ? state.live.get(sourceId).stream : null;
  if (!stream) {
    const p = state.pending.usb;
    if (!p || p.deviceId !== deviceId) return;
    state.pending.usb = null;
    stream = p.stream;
  }
  const track = stream.getVideoTracks()[0];
  const name = $('usb-name').value.trim() || track.label || 'USB device';
  const device = Object.assign({ id: deviceId, label: track.label }, parseFormat($('usb-format').value));
  if (!state.live.has(sourceId)) setLive(sourceId, { kind: 'usb', stream, label: track.label || name });
  state.stopped.delete(sourceId);
  addLayer(placeNew('usb', { name, source: sourceId, device }, $('usb-size').value, $('usb-pos').value, track.getSettings()));
  dialog.close();
  toast(`${name} is live on the program.`);
});

/** Remembers a device's new format (or new browser id) on every overlay that shows it. */
function updateDevice(sourceId, patch) {
  const layers = state.layout.layers.map((l) => (l.source === sourceId ? Object.assign({}, l, { device: Object.assign({}, l.device, patch) }) : l));
  state.layout = Object.assign({}, state.layout, { layers });
  renderAll();
  pushLayout();
}

/** Captures a USB overlay's device: found by its id, or by its name once the browser has renewed the id. */
async function startDevice(sourceId, device) {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
  const match = devices.find((d) => d.deviceId === device.id) || devices.find((d) => device.label && d.label === device.label);
  if (!match) throw Object.assign(new Error('The device is not connected.'), { name: 'NotFoundError' });
  const stream = await navigator.mediaDevices.getUserMedia(usbConstraints(match.deviceId, device));
  if (!state.layout.layers.some((l) => l.source === sourceId)) return stopTracks(stream); // removed meanwhile
  setLive(sourceId, { kind: 'usb', stream, label: stream.getVideoTracks()[0].label || device.label });
  if (match.deviceId !== device.id) updateDevice(sourceId, { id: match.deviceId });
}

let resuming = null;

/**
 * USB devices on the layout start again by themselves when the admin opens and when a device is plugged in,
 * once the browser allows the camera: opening the admin never pops up a permission question.
 */
function resumeDevices() {
  if (!resuming) resuming = resumeNow().finally(() => { resuming = null; });
  return resuming;
}

async function resumeNow() {
  const wanted = new Map(); // source id -> its device
  for (const l of state.layout.layers) {
    if (l.type !== 'usb' || state.live.has(l.source) || state.stopped.has(l.source) || state.liveElsewhere[l.source]) continue;
    if (!wanted.has(l.source)) wanted.set(l.source, l.device);
  }
  if (!wanted.size || !(await cameraAllowed())) return;
  for (const [sourceId, device] of wanted) {
    if (state.live.has(sourceId)) continue;
    try {
      await startDevice(sourceId, device);
    } catch (_) {
      // not plugged in, or busy: plugging a device in tries again
    }
  }
}

async function cameraAllowed() {
  try {
    return (await navigator.permissions.query({ name: 'camera' })).state === 'granted';
  } catch (_) {
    return false; // the browser cannot tell: devices start from their overlay instead
  }
}

// ---------- screen share ----------

const SURFACE_NAMES = { monitor: 'Screen', window: 'Window', browser: 'Browser tab' };

/** The browser asks which screen, window or tab to share; rejects when the person cancels. */
async function pickScreen(fps) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: fps, max: fps }, width: { max: 1920 }, height: { max: 1080 } },
    audio: false,
    selfBrowserSurface: 'exclude', // never this admin tab: it would show itself
    surfaceSwitching: 'include',
  });
  // text stays sharp at 15 and 30 fps; at 60 fps smooth motion matters more
  stream.getVideoTracks()[0].contentHint = fps >= 60 ? 'motion' : 'detail';
  return stream;
}

function screenName(stream) {
  return SURFACE_NAMES[stream.getVideoTracks()[0].getSettings().displaySurface] || 'Screen share';
}

const cancelled = (e) => e.name === 'NotAllowedError' && !/system/i.test(e.message);

function screenError(e) {
  if (/system/i.test(e.message)) {
    return 'This computer does not let the browser share the screen. On macOS, allow the browser in System Settings › Privacy & Security › Screen & System Audio Recording, then restart it.';
  }
  return `Could not share the screen: ${e.message}`;
}

$('screen-pick').addEventListener('click', async () => {
  const err = $('screen-error');
  err.classList.add('hidden');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    err.textContent = 'This browser cannot share the screen here. Open the admin on http://localhost or over HTTPS, in Chrome, Edge or Firefox.';
    err.classList.remove('hidden');
    return;
  }
  const fps = Number($('screen-fps').value);
  try {
    const stream = await pickScreen(fps);
    stopPending('screen');
    state.pending.screen = { stream, fps };
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (state.pending.screen && state.pending.screen.stream === stream) stopPending('screen');
    });
    showPreview('screen', stream);
    $('screen-name').placeholder = screenName(stream);
    $('screen-pick').textContent = 'Choose another screen or window…';
  } catch (e) {
    if (cancelled(e)) return;
    err.textContent = screenError(e);
    err.classList.remove('hidden');
  }
});

$('screen-add').addEventListener('click', () => {
  const p = state.pending.screen;
  if (!p) return;
  state.pending.screen = null;
  const sourceId = L.uid('screen');
  const name = $('screen-name').value.trim() || screenName(p.stream);
  setLive(sourceId, { kind: 'screen', stream: p.stream, label: name, fps: p.fps });
  const settings = p.stream.getVideoTracks()[0].getSettings();
  addLayer(placeNew('screen', { name, source: sourceId, fit: 'contain' }, $('screen-size').value, $('screen-pos').value, settings));
  dialog.close();
  toast(`${name} is shared on the program.`);
});

// ---------- live sources: USB devices and screen shares on the layout ----------

/** Puts a stream on the layout under a source id (new, or restarting one) and publishes it to the outputs. */
function setLive(sourceId, src) {
  const old = state.live.get(sourceId);
  if (old && old.stream !== src.stream) stopTracks(old.stream);
  state.live.set(sourceId, src);
  src.stream.getVideoTracks()[0].addEventListener('ended', () => onSourceEnded(sourceId, src.stream));
  stage.setSourceStream(sourceId, src.stream);
  publish(sourceId);
  announceSources();
  renderProps();
}

function stopSource(sourceId) {
  const src = state.live.get(sourceId);
  if (!src) return;
  state.live.delete(sourceId);
  stopTracks(src.stream);
  stage.setSourceStream(sourceId, null);
  unpublish(sourceId);
  announceSources();
  renderProps();
}

/** The device was unplugged, or the browser's "Stop sharing" ended a share. */
function onSourceEnded(sourceId, stream) {
  const src = state.live.get(sourceId);
  if (!src || src.stream !== stream) return;
  stopSource(sourceId);
  if (src.kind === 'usb') toast(`${src.label} was disconnected. It starts again when it is plugged back in.`, true);
  else toast(`${src.label} is no longer shared.`);
}

/** Stops the USB devices and screen shares that no overlay shows any more. */
function releaseUnused() {
  const used = new Set(state.layout.layers.map((l) => l.source).filter(Boolean));
  for (const id of [...state.live.keys()]) {
    if (!used.has(id)) stopSource(id);
  }
}

/** Tells the server what this admin publishes: the outputs say "Connecting…" for these, "off" for the rest. */
function announceSources() {
  const list = {};
  for (const [id, src] of state.live) list[id] = { kind: src.kind, label: src.label };
  socket.emit('sources:state', list);
}

$('src-start').addEventListener('click', async () => {
  const layer = selectedLayer();
  if (!layer || !layer.source) return;
  try {
    if (layer.type === 'usb') {
      state.stopped.delete(layer.source);
      await startDevice(layer.source, layer.device);
    } else {
      const prev = state.live.get(layer.source);
      const fps = prev ? prev.fps : 30;
      setLive(layer.source, { kind: 'screen', stream: await pickScreen(fps), label: layer.name, fps });
    }
  } catch (e) {
    if (layer.type === 'screen' && cancelled(e)) return;
    toast(layer.type === 'usb' ? deviceError(e) : screenError(e), true);
  }
});

$('src-stop').addEventListener('click', () => {
  const layer = selectedLayer();
  if (!layer || !layer.source) return;
  if (layer.type === 'usb') state.stopped.add(layer.source);
  stopSource(layer.source);
});

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
  announceSources();
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
  releaseUnused();
  renderAll();
  resumeDevices();
});

// what every admin window publishes; the others' sources show as live elsewhere
socket.on('sources', (sources) => {
  state.liveElsewhere = {};
  for (const [id, s] of Object.entries(sources || {})) {
    if (!state.live.has(id)) state.liveElsewhere[id] = s;
  }
  stage.setLiveSources(state.liveElsewhere);
  renderProps();
  resumeDevices();
});

socket.on('peers', (p) => {
  state.outputs = new Set(p.outputIds || []);
  renderFooter();
});

socket.on('output:joined', ({ id }) => {
  state.outputs.add(id);
  renderFooter();
  for (const sourceId of liveSourceIds()) createPeer(id, sourceId);
});

socket.on('output:left', ({ id }) => {
  state.outputs.delete(id);
  closeOutputPeers(id);
  renderFooter();
});

// ---------------------------------------------------------------------------
// WebRTC: publish the camera, USB devices and screen shares to every output
// ---------------------------------------------------------------------------

/** One connection per output and source, so one source starts or stops without touching the others. */
const peerKey = (outputId, sourceId) => `${outputId}|${sourceId}`;

/** The stream a source id stands for: "camera" is the local camera. */
function sourceStream(sourceId) {
  if (sourceId === 'camera') return state.camera.stream;
  const src = state.live.get(sourceId);
  return src ? src.stream : null;
}

function liveSourceIds() {
  return (state.camera.stream ? ['camera'] : []).concat([...state.live.keys()]);
}

async function createPeer(outputId, sourceId) {
  closePeer(outputId, sourceId);
  const stream = sourceStream(sourceId);
  if (!stream) return;
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const key = peerKey(outputId, sourceId);
  const entry = { pc, pending: [] };
  state.peers.set(key, entry);
  for (const track of stream.getTracks()) pc.addTrack(track, stream);
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('rtc:signal', { to: outputId, data: { source: sourceId, candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') {
      // try once more (e.g. the output reloaded mid-negotiation)
      setTimeout(() => { if (state.outputs.has(outputId) && state.peers.get(key)?.pc === pc) createPeer(outputId, sourceId); }, 1500);
    }
  };
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('rtc:signal', { to: outputId, data: { source: sourceId, sdp: pc.localDescription } });
    if (sourceId !== 'camera') await raiseBitrate(pc);
  } catch (err) {
    console.error('WebRTC offer failed', err);
  }
}

/** Screens and capture cards carry small text: allow more than WebRTC's usual 2.5 Mbit/s on the local network. */
async function raiseBitrate(pc) {
  for (const sender of pc.getSenders()) {
    const params = sender.getParameters();
    if (!sender.track || sender.track.kind !== 'video' || !params.encodings || !params.encodings.length) continue;
    params.encodings[0].maxBitrate = 8000000;
    await sender.setParameters(params).catch(() => {});
  }
}

socket.on('rtc:signal', async ({ from, data }) => {
  const entry = data && state.peers.get(peerKey(from, data.source || 'camera'));
  if (!entry) return;
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

/** (Re)publishes a source to every output: when it starts, or when its stream changes. */
function publish(sourceId) {
  for (const id of state.outputs) createPeer(id, sourceId);
}

function unpublish(sourceId) {
  for (const id of state.outputs) closePeer(id, sourceId);
}

function closePeer(outputId, sourceId) {
  const key = peerKey(outputId, sourceId);
  const entry = state.peers.get(key);
  if (!entry) return;
  try { entry.pc.close(); } catch (_) { /* ignore */ }
  state.peers.delete(key);
  socket.emit('rtc:signal', { to: outputId, data: { source: sourceId, bye: true } });
}

function closeOutputPeers(outputId) {
  for (const key of [...state.peers.keys()]) {
    if (key.startsWith(outputId + '|')) closePeer(outputId, key.slice(outputId.length + 1));
  }
}

window.addEventListener('beforeunload', () => {
  if (state.camera.stream) socket.emit('camera:state', { active: false, label: '' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

renderAll();
fitPreview();
