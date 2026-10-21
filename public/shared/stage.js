/**
 * Stage renderer — draws a layout (main screen + split-screen overlays) into a DOM container.
 * Used by the admin preview (interactive: drag to move, handles to resize) and by the program output.
 *
 * Usage:
 *   const stage = createStage(container, { interactive: true, onSelect, onChange, lockAspect: () => true });
 *   stage.render(layout, selectedId);
 *   stage.setScale(0.6);
 *   stage.setCameraStream(mediaStream);
 */
const L = window.StreamLayout;

const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function createStage(container, options = {}) {
  const opts = Object.assign(
    { interactive: false, onSelect: () => {}, onChange: () => {}, lockAspect: () => false },
    options
  );

  const root = document.createElement('div');
  root.className = 'stage';
  root.style.width = L.OUTPUT_W + 'px';
  root.style.height = L.OUTPUT_H + 'px';

  const mainEl = document.createElement('div');
  mainEl.className = 'stage-main';
  root.appendChild(mainEl);

  const layersEl = document.createElement('div');
  layersEl.className = 'stage-layers';
  root.appendChild(layersEl);

  container.appendChild(root);

  const state = {
    layout: null,
    selectedId: null,
    scale: 1,
    cameraStream: null,
    cameraActive: false,
    cameraLabel: '',
    mainKey: '',
    els: new Map(), // layer id -> { el, media, placeholder }
  };

  // ---------- public API ----------

  function setScale(scale) {
    state.scale = scale;
    root.style.transform = `scale(${scale})`;
    container.style.width = Math.round(L.OUTPUT_W * scale) + 'px';
    container.style.height = Math.round(L.OUTPUT_H * scale) + 'px';
  }

  function setCameraStream(stream) {
    state.cameraStream = stream || null;
    for (const [, entry] of state.els) {
      if (entry.type === 'camera') attachCamera(entry);
    }
  }

  function setCameraActive(active, label) {
    state.cameraActive = !!active;
    state.cameraLabel = label || '';
    for (const [, entry] of state.els) {
      if (entry.type === 'camera') attachCamera(entry);
    }
  }

  function render(layout, selectedId) {
    state.layout = layout;
    if (selectedId !== undefined) state.selectedId = selectedId;
    renderMain(layout.main);
    renderLayers(layout.layers);
  }

  function select(id) {
    state.selectedId = id;
    for (const [lid, entry] of state.els) entry.el.classList.toggle('selected', lid === id);
  }

  // ---------- main screen ----------

  function renderMain(main) {
    const key = [main.type, main.src, main.fit, main.loop, main.muted, main.label].join('|');
    if (key === state.mainKey) return;
    state.mainKey = key;
    mainEl.innerHTML = '';

    if (main.type === 'video' && main.src) {
      const v = document.createElement('video');
      v.src = main.src;
      v.autoplay = true;
      v.loop = main.loop;
      v.muted = main.muted;
      v.playsInline = true;
      v.style.objectFit = main.fit;
      v.setAttribute('aria-label', main.label);
      mainEl.appendChild(v);
      v.play().catch(() => {});
      return;
    }
    if (main.type === 'image' && main.src) {
      const img = document.createElement('img');
      img.src = main.src;
      img.alt = main.label;
      img.style.objectFit = main.fit;
      mainEl.appendChild(img);
      return;
    }
    const ph = document.createElement('div');
    ph.className = 'stage-main-placeholder';
    ph.innerHTML = `<span class="stage-main-title"></span><span class="stage-main-sub">PROGRAM INPUT · ${L.OUTPUT_W} × ${L.OUTPUT_H} · 16:9</span>`;
    ph.querySelector('.stage-main-title').textContent = main.label || 'Main Screen';
    mainEl.appendChild(ph);
  }

  // ---------- overlays ----------

  function renderLayers(layers) {
    const ids = new Set(layers.map((l) => l.id));
    for (const [id, entry] of state.els) {
      if (!ids.has(id)) {
        entry.el.remove();
        state.els.delete(id);
      }
    }
    layers.forEach((layer, index) => {
      let entry = state.els.get(layer.id);
      if (!entry || entry.type !== layer.type) {
        if (entry) entry.el.remove();
        entry = createLayerEl(layer);
        state.els.set(layer.id, entry);
      }
      updateLayerEl(entry, layer, index);
      // keep DOM order == z-order
      if (layersEl.children[index] !== entry.el) layersEl.insertBefore(entry.el, layersEl.children[index] || null);
    });
  }

  function createLayerEl(layer) {
    const el = document.createElement('div');
    el.className = `layer layer-${layer.type}`;
    el.dataset.id = layer.id;

    const box = document.createElement('div');
    box.className = 'layer-box';
    el.appendChild(box);

    const placeholder = document.createElement('div');
    placeholder.className = 'layer-placeholder';
    placeholder.innerHTML = '<span class="layer-badge"></span><span class="layer-name"></span><span class="layer-note"></span>';
    box.appendChild(placeholder);

    let media;
    if (layer.type === 'camera') {
      media = document.createElement('video');
      media.autoplay = true;
      media.muted = true;
      media.playsInline = true;
      const sil = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      sil.setAttribute('viewBox', '0 0 160 90');
      sil.setAttribute('preserveAspectRatio', 'xMidYMax meet');
      sil.setAttribute('class', 'layer-silhouette');
      sil.innerHTML = '<circle cx="80" cy="38" r="18"></circle><path d="M34 92c4-24 22-34 46-34s42 10 46 34z"></path>';
      placeholder.insertBefore(sil, placeholder.firstChild);
    } else {
      media = document.createElement('img');
      media.alt = '';
      media.draggable = false;
      media.addEventListener('error', () => el.classList.add('media-error'));
      media.addEventListener('load', () => el.classList.remove('media-error'));
    }
    box.appendChild(media);

    const entry = { el, box, media, placeholder, type: layer.type, layer };

    if (opts.interactive) {
      const label = document.createElement('div');
      label.className = 'layer-label';
      el.appendChild(label);
      entry.label = label;
      for (const dir of HANDLE_DIRS) {
        const h = document.createElement('div');
        h.className = `handle handle-${dir}`;
        h.dataset.dir = dir;
        el.appendChild(h);
      }
      el.addEventListener('pointerdown', (e) => onPointerDown(e, entry));
    }
    return entry;
  }

  function updateLayerEl(entry, layer, index) {
    entry.layer = layer;
    const { el, box, media, placeholder } = entry;
    el.style.left = layer.x + 'px';
    el.style.top = layer.y + 'px';
    el.style.width = layer.w + 'px';
    el.style.height = layer.h + 'px';
    el.style.zIndex = String(index + 1);
    el.style.opacity = String(layer.opacity);
    el.style.display = layer.visible ? '' : 'none';
    el.classList.toggle('selected', layer.id === state.selectedId);
    box.style.borderRadius = layer.radius + 'px';
    box.classList.toggle('bordered', !!layer.border);
    media.style.objectFit = layer.fit;
    media.style.transform = layer.mirror ? 'scaleX(-1)' : '';

    placeholder.querySelector('.layer-badge').textContent = layer.type === 'camera' ? 'LIVE' : badgeFor(layer.src);
    placeholder.querySelector('.layer-name').textContent = layer.name;
    placeholder.querySelector('.layer-note').textContent = `${layer.w} × ${layer.h}`;
    if (entry.label) entry.label.textContent = `${layer.name} · ${layer.x}, ${layer.y} · ${layer.w} × ${layer.h}`;

    if (layer.type === 'camera') {
      attachCamera(entry);
    } else {
      if (media.getAttribute('src') !== (layer.src || '')) {
        if (layer.src) media.setAttribute('src', layer.src);
        else media.removeAttribute('src');
      }
      el.classList.toggle('no-media', !layer.src);
    }
  }

  function attachCamera(entry) {
    const { media, el, placeholder } = entry;
    const stream = state.cameraStream;
    if (stream) {
      if (media.srcObject !== stream) {
        media.srcObject = stream;
        media.play().catch(() => {});
      }
      el.classList.remove('no-media');
    } else {
      if (media.srcObject) media.srcObject = null;
      el.classList.add('no-media');
      placeholder.querySelector('.layer-note').textContent = state.cameraActive
        ? 'Connecting to camera…'
        : 'Camera is off — start it in the admin';
    }
  }

  function badgeFor(src) {
    if (!src) return 'IMAGE';
    const ext = src.split('?')[0].split('.').pop().toUpperCase();
    return ['PNG', 'GIF', 'JPG', 'JPEG', 'WEBP'].includes(ext) ? ext : 'IMAGE';
  }

  // ---------- interaction (admin preview) ----------

  let drag = null;

  function onPointerDown(e, entry) {
    if (e.button !== 0) return;
    const handle = e.target.closest('.handle');
    const layer = entry.layer;
    e.preventDefault();
    e.stopPropagation();
    opts.onSelect(layer.id);
    drag = {
      entry,
      start: Object.assign({}, layer),
      dir: handle ? handle.dataset.dir : 'move',
      sx: e.clientX,
      sy: e.clientY,
      current: Object.assign({}, layer),
      moved: false,
    };
    entry.el.setPointerCapture(e.pointerId);
    entry.el.addEventListener('pointermove', onPointerMove);
    entry.el.addEventListener('pointerup', onPointerUp);
    entry.el.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / state.scale;
    const dy = (e.clientY - drag.sy) / state.scale;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !drag.moved) return;
    drag.moved = true;
    const s = drag.start;
    let next;
    if (drag.dir === 'move') {
      next = L.constrain(Object.assign({}, s, { x: s.x + dx, y: s.y + dy }));
    } else {
      next = resizeFrom(s, drag.dir, dx, dy, opts.lockAspect() || e.shiftKey);
    }
    drag.current = next;
    applyGeometry(drag.entry, next);
    opts.onChange(next, true);
  }

  function onPointerUp(e) {
    if (!drag) return;
    const { entry, current, moved } = drag;
    entry.el.removeEventListener('pointermove', onPointerMove);
    entry.el.removeEventListener('pointerup', onPointerUp);
    entry.el.removeEventListener('pointercancel', onPointerUp);
    try { entry.el.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    drag = null;
    if (moved) opts.onChange(current, false);
  }

  function resizeFrom(s, dir, dx, dy, keepAspect) {
    const minW = 16;
    const minH = 16;
    let { x, y, w, h } = s;
    const ratio = s.w / s.h;

    if (dir.includes('e')) w = s.w + dx;
    if (dir.includes('s')) h = s.h + dy;
    if (dir.includes('w')) { w = s.w - dx; x = s.x + dx; }
    if (dir.includes('n')) { h = s.h - dy; y = s.y + dy; }

    w = Math.max(minW, w);
    h = Math.max(minH, h);

    if (keepAspect) {
      const horizontal = dir === 'e' || dir === 'w';
      const vertical = dir === 'n' || dir === 's';
      if (horizontal) h = w / ratio;
      else if (vertical) w = h * ratio;
      else if (Math.abs(dx) >= Math.abs(dy)) h = w / ratio;
      else w = h * ratio;
      if (dir.includes('w')) x = s.x + s.w - w;
      if (dir.includes('n')) y = s.y + s.h - h;
    }

    // keep inside the output
    if (x < 0) { if (dir.includes('w')) { w += x; if (keepAspect) h = w / ratio; } x = 0; }
    if (y < 0) { if (dir.includes('n')) { h += y; if (keepAspect) w = h * ratio; } y = 0; }
    if (x + w > L.OUTPUT_W) { w = L.OUTPUT_W - x; if (keepAspect) h = w / ratio; }
    if (y + h > L.OUTPUT_H) { h = L.OUTPUT_H - y; if (keepAspect) w = h * ratio; }

    return L.constrain({ ...s, x, y, w, h });
  }

  function applyGeometry(entry, layer) {
    entry.el.style.left = layer.x + 'px';
    entry.el.style.top = layer.y + 'px';
    entry.el.style.width = layer.w + 'px';
    entry.el.style.height = layer.h + 'px';
    entry.placeholder.querySelector('.layer-note').textContent = `${layer.w} × ${layer.h}`;
    if (entry.label) entry.label.textContent = `${layer.name} · ${layer.x}, ${layer.y} · ${layer.w} × ${layer.h}`;
  }

  if (opts.interactive) {
    root.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.layer')) opts.onSelect(null);
    });
  }

  return { root, render, select, setScale, setCameraStream, setCameraActive, get scale() { return state.scale; } };
}
