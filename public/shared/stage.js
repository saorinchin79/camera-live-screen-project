/**
 * Stage renderer — draws a layout (main screen + split-screen overlays) into a DOM container.
 * Used by the admin preview (interactive: drag to move, handles to resize) and by the program output.
 *
 * Usage:
 *   const stage = createStage(container, { interactive: true, onSelect, onChange, lockAspect: () => true, onMediaSize, onKeyColor });
 *   stage.render(layout, selectedId);
 *   stage.setScale(0.6);
 *   stage.setCameraStream(mediaStream);
 *   stage.setSourceStream(sourceId, mediaStream);   // a USB device or screen share
 *   stage.setLiveSources(sources);  // the server's "sources" events: what the admin publishes
 *   stage.setCctvStatus(status);   // the server's "cctv:status" events
 *   stage.startSound();   // after the first click or key on the page: videos and YouTube players with sound can start
 * A video window with Remove background on (layer.key) is drawn by a keyer; onKeyColor(id, color) reports the
 * backdrop colour it found when the layout had none.
 */
import { createKeyer, canKey } from './keyer.js';

const L = window.StreamLayout;

const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const LAYER_BADGES = { camera: 'LIVE', usb: 'USB', screen: 'SCREEN', video: 'VIDEO', youtube: 'YOUTUBE', cctv: 'CCTV', text: 'TEXT' };
/** The attribute that names a main screen's media for screen readers. */
const LABEL_ATTRS = { VIDEO: 'aria-label', IFRAME: 'title' };

export function createStage(container, options = {}) {
  const opts = Object.assign(
    { interactive: false, onSelect: () => {}, onChange: () => {}, lockAspect: () => false, onMediaSize: () => {}, onKeyColor: () => {} },
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
    streams: new Map(), // source id -> MediaStream of a USB device or screen share
    liveSources: {}, // source id -> { kind, label } that the admin publishes right now
    mainKey: '',
    mainView: null, // the main screen's media in its crop frame (see mountMedia)
    cctv: new Map(), // camera id -> latest status from the server
    els: new Map(), // layer id -> { el, media, view, placeholder }
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

  function setSourceStream(id, stream) {
    if (stream) state.streams.set(id, stream);
    else state.streams.delete(id);
    for (const [, entry] of state.els) {
      if (entry.layer.source === id) attachSource(entry);
    }
  }

  function setLiveSources(sources) {
    state.liveSources = sources || {};
    for (const [, entry] of state.els) {
      if (entry.layer.source) attachSource(entry);
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
    mainEl.classList.toggle('selected', id === L.MAIN_ID);
    for (const [lid, entry] of state.els) entry.el.classList.toggle('selected', lid === id);
  }

  /** Size of a source (main screen: L.MAIN_ID) once its first frame is known, else null (also for YouTube's player). */
  function sourceSize(id) {
    const view = id === L.MAIN_ID ? state.mainView : (state.els.get(id) || {}).view;
    return view && view.w && !view.nominal ? { w: view.w, h: view.h } : null;
  }

  // ---------- main screen ----------

  function renderMain(main) {
    const key = [main.type, main.src, main.loop, main.muted].join('|');
    if (key !== state.mainKey) {
      state.mainKey = key;
      buildMain(main);
    }
    // the name changes in place: renaming must not restart a video or reconnect a camera
    const title = mainEl.querySelector('.stage-main-title');
    if (title) title.textContent = main.label || 'Main Screen';
    if (state.mainView) state.mainView.media.setAttribute(LABEL_ATTRS[state.mainView.media.tagName] || 'alt', main.label);
    mainEl.classList.toggle('selected', state.selectedId === L.MAIN_ID);
    if (state.mainView) fitMedia(state.mainView, L.OUTPUT_W, L.OUTPUT_H, main.fit, main.crop);
    renderCctvState();
  }

  function buildMain(main) {
    unmountMedia(state.mainView);
    state.mainView = null;
    mainEl.innerHTML = '';
    mainEl.className = 'stage-main';

    if (main.type === 'video' && main.src) {
      const v = document.createElement('video');
      v.src = main.src;
      v.autoplay = true;
      v.loop = main.loop;
      v.muted = main.muted;
      v.playsInline = true;
      v.setAttribute('aria-label', main.label);
      state.mainView = mountMedia(mainEl, v, L.MAIN_ID);
      mainEl.classList.add('has-media');
      v.play().catch(() => {});
      return;
    }
    if (main.type === 'youtube' && main.src) {
      // YouTube's own player plays on every screen by itself; nothing in it can be clicked on the program
      const player = document.createElement('iframe');
      player.src = L.youtubeEmbedUrl(main.src, main);
      player.title = main.label;
      player.allow = 'autoplay; encrypted-media';
      player.referrerPolicy = 'strict-origin-when-cross-origin';
      player.tabIndex = -1;
      state.mainView = mountMedia(mainEl, player, L.MAIN_ID);
      // the player has no size of its own: a 16:9 window that letterboxes the video, which crop and fit work on
      Object.assign(state.mainView, { w: L.OUTPUT_W, h: L.OUTPUT_H, nominal: true });
      mainEl.classList.add('has-media');
      return;
    }
    if (main.type === 'image' && main.src) {
      const img = document.createElement('img');
      img.src = main.src;
      img.alt = main.label;
      img.draggable = false;
      state.mainView = mountMedia(mainEl, img, L.MAIN_ID);
      mainEl.classList.add('has-media');
      return;
    }
    if (main.type === 'cctv' && main.src) {
      // MJPEG from the server: shown from the first frame on, reconnected when the stream breaks
      const img = document.createElement('img');
      img.alt = main.label;
      img.draggable = false;
      state.mainView = mountMedia(mainEl, img, L.MAIN_ID, { poll: true });
      img.addEventListener('error', scheduleCctvReload);
      mainEl.classList.add('has-media', 'cctv', 'cctv-waiting');
      mainEl.appendChild(makePlaceholder(main.label, 'LIVE CCTV · CONNECTING…'));
      const badge = document.createElement('div');
      badge.className = 'stage-main-badge';
      badge.textContent = 'RECONNECTING';
      mainEl.appendChild(badge);
      img.src = main.src;
      return;
    }
    mainEl.appendChild(makePlaceholder(main.label || 'Main Screen', `PROGRAM INPUT · ${L.OUTPUT_W} × ${L.OUTPUT_H} · 16:9`));
  }

  function makePlaceholder(title, sub) {
    const ph = document.createElement('div');
    ph.className = 'stage-main-placeholder';
    ph.innerHTML = '<span class="stage-main-title"></span><span class="stage-main-sub"></span>';
    ph.querySelector('.stage-main-title').textContent = title;
    ph.querySelector('.stage-main-sub').textContent = sub;
    return ph;
  }

  // ---------- live CCTV on the main screen ----------

  let cctvRetry = null;

  function scheduleCctvReload() {
    if (cctvRetry) return;
    cctvRetry = setTimeout(() => {
      cctvRetry = null;
      reloadStreams();
    }, 3000);
  }

  /**
   * Starts the videos and YouTube players that play their sound (the main screen's and the windows'), after a first
   * click or key on the page: a browser plays sound only on a page someone has used, so they could not start by
   * themselves before. A video file goes on where it is; a YouTube player is loaded again.
   */
  function startSound() {
    const main = state.layout && state.layout.main;
    if (main && !main.muted && state.mainView) {
      if (main.type === 'video') {
        state.mainView.media.play().catch(() => {});
      } else if (main.type === 'youtube') {
        state.mainKey = '';
        renderMain(main);
      }
    }
    for (const entry of state.els.values()) {
      if (entry.layer.muted !== false) continue;
      if (entry.type === 'video') {
        entry.media.play().catch(() => {});
      } else if (entry.type === 'youtube') {
        entry.src = '';
        attachYoutube(entry);
      }
    }
  }

  /** Reconnects the CCTV streams (the main screen's and the windows'), e.g. after the server restarted. */
  function reloadStreams() {
    const main = state.layout && state.layout.main;
    if (state.mainView && main && main.type === 'cctv') state.mainView.media.src = `${main.src}?t=${Date.now()}`;
    for (const entry of state.els.values()) {
      if (entry.type === 'cctv' && entry.src) entry.media.src = `${entry.src}?t=${Date.now()}`;
    }
  }

  function setCctvStatus(status) {
    if (!status || !status.id) return;
    state.cctv.set(status.id, status);
    renderCctvState();
    for (const entry of state.els.values()) {
      if (entry.type === 'cctv' && L.cctvIdOf(entry.src) === status.id) noteCctv(entry);
    }
  }

  function renderCctvState() {
    const main = state.layout && state.layout.main;
    if (!main || main.type !== 'cctv' || !state.mainView) return;
    const status = state.cctv.get(L.cctvIdOf(main.src));
    mainEl.classList.toggle('cctv-down', !!status && (status.state === 'error' || status.state === 'connecting'));
    const sub = mainEl.querySelector('.stage-main-sub');
    if (!sub) return;
    if (status && status.state === 'error') {
      // the admin sees why; the program only says that it is retrying
      sub.textContent = opts.interactive ? `CCTV OFFLINE · ${status.message}` : 'CCTV OFFLINE · RETRYING';
    } else {
      sub.textContent = 'LIVE CCTV · CONNECTING…';
    }
  }

  // ---------- media: crop + fit ----------

  /**
   * Puts a media element in a crop frame. The frame is the part of the source that stays visible (sized
   * by fitMedia); the media inside it is the whole source, shifted so the cropped edges fall outside.
   */
  function mountMedia(parent, media, id, { poll = false } = {}) {
    const frame = document.createElement('div');
    frame.className = 'media-frame';
    frame.appendChild(media);
    parent.appendChild(frame);
    const view = { id, media, frame, w: 0, h: 0, boxW: 1, boxH: 1, fit: 'cover', crop: null, timer: null };
    const check = () => measure(view);
    if (media.tagName === 'VIDEO') {
      media.addEventListener('loadedmetadata', check);
      media.addEventListener('resize', check);
    } else {
      media.addEventListener('load', check);
    }
    // an MJPEG stream need not fire "load" for its frames: watch its size instead
    if (poll) view.timer = setInterval(check, 500);
    return view;
  }

  function measure(view) {
    const m = view.media;
    const w = m.videoWidth || m.naturalWidth || 0;
    const h = m.videoHeight || m.naturalHeight || 0;
    if (!w || !h || (w === view.w && h === view.h)) return;
    view.w = w;
    view.h = h;
    fitMedia(view);
    if (view === state.mainView) mainEl.classList.remove('cctv-waiting');
    // a CCTV window shows its picture from the first frame on
    const entry = state.els.get(view.id);
    if (entry && entry.view === view && entry.type === 'cctv') entry.el.classList.remove('no-media');
    opts.onMediaSize(view.id, { w, h });
  }

  function unmountMedia(view) {
    if (!view) return;
    clearInterval(view.timer);
    if (view.keyer) view.keyer.destroy();
    const m = view.media;
    if (m.tagName === 'IMG' || m.tagName === 'IFRAME') {
      m.removeAttribute('src'); // also ends an MJPEG stream's connection; a YouTube player goes with its element
    } else if (!m.srcObject) {
      m.pause();
      m.removeAttribute('src');
      m.load();
    }
  }

  const pct = (v) => `${(v * 100).toFixed(3)}%`;

  /**
   * Shows the cropped part of the source in a box of boxW × boxH: `crop` cuts a percentage off each edge,
   * then the rest is fitted (cover / contain / fill). Without a box it re-applies the last one, e.g. once
   * the source size is known. Mirroring (a transform on the media) flips the picture inside the same frame.
   */
  function fitMedia(view, boxW, boxH, fit, crop) {
    if (boxW) Object.assign(view, { boxW, boxH, fit, crop });
    const { frame } = view;
    const c = view.crop || L.sanitizeCrop();
    if (!view.w || !view.h) {
      // size not known yet: plain object-fit, and a cropped source stays hidden until it can be cropped
      Object.assign(frame.style, { left: '0', top: '0', width: '100%', height: '100%', visibility: L.hasCrop(c) ? 'hidden' : '' });
      placeMedia(view, { left: '0', top: '0', width: '100%', height: '100%', objectFit: view.fit });
      return;
    }
    const keepW = 1 - (c.left + c.right) / 100; // share of the source that stays visible
    const keepH = 1 - (c.top + c.bottom) / 100;
    const cropAspect = (view.w * keepW) / (view.h * keepH);
    const boxAspect = view.boxW / view.boxH;
    let fw = 1; // frame size as a share of the box
    let fh = 1;
    if (view.fit === 'contain') {
      if (cropAspect > boxAspect) fh = boxAspect / cropAspect;
      else fw = cropAspect / boxAspect;
    } else if (view.fit === 'cover') {
      if (cropAspect > boxAspect) fw = cropAspect / boxAspect;
      else fh = boxAspect / cropAspect;
    }
    Object.assign(frame.style, { left: pct((1 - fw) / 2), top: pct((1 - fh) / 2), width: pct(fw), height: pct(fh), visibility: '' });
    placeMedia(view, {
      left: pct(-c.left / 100 / keepW),
      top: pct(-c.top / 100 / keepH),
      width: pct(1 / keepW),
      height: pct(1 / keepH),
      objectFit: 'fill',
    });
  }

  /** Where the media sits in its crop frame; a keyed video's canvas, shown instead of the video, sits there too. */
  function placeMedia(view, style) {
    Object.assign(view.media.style, style);
    if (view.keyer) Object.assign(view.keyer.canvas.style, style);
  }

  // ---------- overlays ----------

  function removeLayerEl(entry) {
    entry.el.remove();
    unmountMedia(entry.view);
    clearTimeout(entry.retry);
  }

  function renderLayers(layers) {
    const ids = new Set(layers.map((l) => l.id));
    for (const [id, entry] of state.els) {
      if (!ids.has(id)) {
        removeLayerEl(entry);
        state.els.delete(id);
      }
    }
    layers.forEach((layer, index) => {
      let entry = state.els.get(layer.id);
      if (!entry || entry.type !== layer.type) {
        if (entry) removeLayerEl(entry);
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

    if (layer.type === 'camera') {
      const sil = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      sil.setAttribute('viewBox', '0 0 160 90');
      sil.setAttribute('preserveAspectRatio', 'xMidYMax meet');
      sil.setAttribute('class', 'layer-silhouette');
      sil.innerHTML = '<circle cx="80" cy="38" r="18"></circle><path d="M34 92c4-24 22-34 46-34s42 10 46 34z"></path>';
      placeholder.insertBefore(sil, placeholder.firstChild);
    }
    // a text window's words (its element is .layer-text already)
    let caption = null;
    if (layer.type === 'text') {
      const line = document.createElement('div');
      line.className = 'layer-caption';
      caption = line.appendChild(document.createElement('span'));
      box.appendChild(line);
    }
    const media = createMedia(layer, el);
    // an MJPEG stream need not fire "load" for its frames: its size is watched instead
    const view = media ? mountMedia(box, media, layer.id, { poll: layer.type === 'cctv' }) : null;
    // YouTube's player has no size of its own: a 16:9 window that letterboxes the video
    if (layer.type === 'youtube') Object.assign(view, { w: L.OUTPUT_W, h: L.OUTPUT_H, nominal: true });

    const entry = { el, box, media, view, placeholder, caption, type: layer.type, layer, src: '', retry: null };
    // a CCTV stream that breaks connects again by itself
    if (layer.type === 'cctv') media.addEventListener('error', () => retryCctv(entry));

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
    if (media) media.style.transform = layer.mirror ? 'scaleX(-1)' : '';

    placeholder.querySelector('.layer-badge').textContent = LAYER_BADGES[layer.type] || badgeFor(layer.src);
    placeholder.querySelector('.layer-name').textContent = layer.name;
    placeholder.querySelector('.layer-note').textContent = `${layer.w} × ${layer.h}`;
    if (entry.label) entry.label.textContent = `${layer.name} · ${layer.x}, ${layer.y} · ${layer.w} × ${layer.h}`;

    if (layer.type === 'camera') attachCamera(entry);
    else if (layer.source) attachSource(entry);
    else if (layer.type === 'youtube') attachYoutube(entry);
    else if (layer.type === 'text') attachText(entry, layer);
    else attachFile(entry);
    if (layer.type === 'video') keyVideo(entry);
    if (entry.view) fitMedia(entry.view, layer.w, layer.h, layer.fit, layer.crop);
  }

  /** The element that shows a layer: a video for live sources and video files, YouTube's player, else an image. */
  function createMedia(layer, el) {
    if (layer.type === 'text') return null;
    if (layer.type === 'youtube') {
      const player = document.createElement('iframe');
      player.allow = 'autoplay; encrypted-media';
      player.referrerPolicy = 'strict-origin-when-cross-origin';
      player.tabIndex = -1;
      return player;
    }
    const video = L.LIVE_TYPES.includes(layer.type) || layer.type === 'video';
    const media = document.createElement(video ? 'video' : 'img');
    if (video) {
      media.autoplay = true;
      media.muted = true;
      media.playsInline = true;
    } else {
      media.alt = '';
      media.draggable = false;
    }
    if (layer.type === 'image' || layer.type === 'video') {
      // a file that does not load shows the window's placeholder instead
      media.addEventListener('error', () => el.classList.add('media-error'));
      media.addEventListener(video ? 'loadeddata' : 'load', () => el.classList.remove('media-error'));
    }
    return media;
  }

  /** An image, a video file or a CCTV stream, played from the layer's src. */
  function attachFile(entry) {
    const { layer, media, el } = entry;
    if (entry.src !== layer.src) {
      entry.src = layer.src;
      entry.view.w = entry.view.h = 0; // a new picture is fitted again once its size is known
      if (layer.src) media.setAttribute('src', layer.src);
      else media.removeAttribute('src');
      if (layer.type === 'video' && layer.src) media.play().catch(() => {});
    }
    if (layer.type === 'video') {
      media.loop = layer.loop;
      media.muted = layer.muted;
    }
    // a CCTV window waits for its first frame
    el.classList.toggle('no-media', !layer.src || (layer.type === 'cctv' && !entry.view.w));
    if (layer.type === 'cctv') noteCctv(entry);
  }

  /**
   * Remove background on a video window: a keyer draws the video without its backdrop colour in the video's place,
   * and the video itself is hidden. Only a video from this server can be keyed; in a browser without WebGL
   * (keyer null) the video plays as it is.
   */
  function keyVideo(entry) {
    const { layer, view, media } = entry;
    const on = layer.key.on && !!layer.src && canKey(layer.src);
    if (on && view.keyer === undefined) {
      view.keyer = createKeyer(media, { onColor: (color) => opts.onKeyColor(layer.id, color) });
      if (view.keyer) view.frame.appendChild(view.keyer.canvas);
    } else if (!on && view.keyer) {
      view.keyer.destroy();
      view.keyer = undefined;
    }
    if (on && view.keyer) {
      view.keyer.canvas.style.transform = media.style.transform;
      view.keyer.set(layer.key);
    }
    entry.el.classList.toggle('keyed', !!(on && view.keyer));
  }

  /** YouTube's player for a window: started again only when the video, its loop or its sound change. */
  function attachYoutube(entry) {
    const { layer, media } = entry;
    const url = L.youtubeEmbedUrl(layer.src, layer);
    if (entry.src !== url) {
      entry.src = url;
      if (url) media.src = url;
      else media.removeAttribute('src');
    }
    media.title = layer.name;
    entry.el.classList.toggle('no-media', !url);
  }

  /** A text window shows its name on one line, as large as the window takes it. */
  function attachText(entry, layer) {
    const size = Math.min(layer.h * 0.5, (layer.w * 0.88) / (Math.max(1, layer.name.length) * 0.56));
    entry.caption.textContent = layer.name;
    entry.caption.style.fontSize = `${Math.max(10, Math.round(size))}px`;
  }

  /** Why a CCTV window has no picture yet: the admin sees the camera's error, the program that it is retrying. */
  function noteCctv(entry) {
    if (entry.view.w) return;
    const status = state.cctv.get(L.cctvIdOf(entry.src));
    entry.placeholder.querySelector('.layer-note').textContent =
      status && status.state === 'error' ? (opts.interactive ? `CCTV offline · ${status.message}` : 'CCTV offline · retrying') : 'Connecting…';
  }

  function retryCctv(entry) {
    if (entry.retry) return;
    entry.retry = setTimeout(() => {
      entry.retry = null;
      if (state.els.get(entry.layer.id) === entry && entry.src) entry.media.src = `${entry.src}?t=${Date.now()}`;
    }, 3000);
  }

  function attachCamera(entry) {
    showStream(entry, state.cameraStream, state.cameraActive ? 'Connecting to camera…' : 'Camera is off — start it in the admin');
  }

  /** A USB device or screen share: the stream published under the overlay's source id. */
  function attachSource(entry) {
    const { layer } = entry;
    let note;
    if (state.liveSources[layer.source]) {
      // the admin publishes it: the program waits for the video, the admin preview gets it from another window
      note = opts.interactive ? 'Live from another admin window' : 'Connecting…';
    } else {
      note = layer.type === 'usb' ? 'Device is off — start it in the admin' : 'Not shared — share it again in the admin';
    }
    showStream(entry, state.streams.get(layer.source), note);
  }

  function showStream(entry, stream, offNote) {
    const { media, el, placeholder } = entry;
    if (stream) {
      if (media.srcObject !== stream) {
        media.srcObject = stream;
        media.play().catch(() => {});
      }
      el.classList.remove('no-media');
    } else {
      if (media.srcObject) media.srcObject = null;
      el.classList.add('no-media');
      placeholder.querySelector('.layer-note').textContent = offNote;
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
    if (entry.view) fitMedia(entry.view, layer.w, layer.h, layer.fit, layer.crop);
    if (entry.type === 'text') attachText(entry, layer);
    entry.placeholder.querySelector('.layer-note').textContent = `${layer.w} × ${layer.h}`;
    if (entry.label) entry.label.textContent = `${layer.name} · ${layer.x}, ${layer.y} · ${layer.w} × ${layer.h}`;
  }

  if (opts.interactive) {
    root.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.layer')) opts.onSelect(null);
    });
  }

  return {
    root,
    render,
    select,
    setScale,
    setCameraStream,
    setCameraActive,
    setSourceStream,
    setLiveSources,
    setCctvStatus,
    reloadStreams,
    startSound,
    sourceSize,
    get scale() { return state.scale; },
  };
}
