/**
 * Layout model shared by the server (CommonJS) and the browser (window.StreamLayout).
 *
 * A layout describes the 1920x1080 program:
 *   main   — what fills the whole screen (placeholder, uploaded video or image, YouTube video, live CCTV camera)
 *   layers — drawn on top, back to front (local camera, USB device, shared screen, image). Each belongs to a screen:
 *            group "main" layers are part of the main screen (a shared browser tab filling the program, say),
 *            group "split" layers are the split-screen windows above it. The main screen's come first in the list.
 * Every source can be cropped: `crop` cuts a percentage off each edge before the rest is fitted.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StreamLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OUTPUT_W = 1920;
  const OUTPUT_H = 1080;
  const SAFE_MARGIN = 48;

  const LAYER_TYPES = ['camera', 'image', 'usb', 'screen'];
  /** Overlays that show live video from the admin's browser: its camera, a USB device, a shared screen or window. */
  const LIVE_TYPES = ['camera', 'usb', 'screen'];
  const LAYER_NAMES = { camera: 'Local Camera', image: 'Image', usb: 'USB device', screen: 'Screen share' };
  /** A USB device or screen share is published by the admin under a source id; its overlays show that stream. */
  const SOURCE_ID = /^[a-z0-9-]{1,40}$/;
  const FITS = ['cover', 'contain', 'fill'];
  const MAIN_TYPES = ['placeholder', 'video', 'image', 'youtube', 'cctv'];

  /** Selection id the admin uses for the main screen (overlay ids never look like this). */
  const MAIN_ID = '__main__';

  /** Crop: percent cut off each edge of the source; 45 % per edge keeps at least 10 % of it. */
  const CROP_EDGES = ['top', 'right', 'bottom', 'left'];
  const MAX_CROP = 45;

  /** A live CCTV camera is played from this server; the camera URL (and password) stays there. */
  const CCTV_SRC = /^\/api\/cctv\/([a-z0-9-]{1,40})\/stream\.mjpg$/;

  /** A YouTube video plays in YouTube's own player; these are its video and playlist ids. */
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;
  const YT_LIST = /^[A-Za-z0-9_-]{2,64}$/;

  const DEFAULT_LAYOUT = {
    version: 1,
    output: { width: OUTPUT_W, height: OUTPUT_H },
    main: { type: 'placeholder', src: '', fit: 'cover', loop: true, muted: true, label: 'Main Screen' },
    layers: [
      {
        id: 'cam-main',
        type: 'camera',
        name: 'Local Camera',
        x: 48, y: 48, w: 640, h: 360,
        opacity: 1, radius: 8, visible: true, fit: 'cover', mirror: false, border: true,
      },
    ],
    template: 'pip',
  };

  /** Split-screen templates: where the camera layer goes (see templateTarget). Images keep their place. */
  const TEMPLATES = {
    pip: { label: 'Picture-in-picture', desc: 'Camera top-left', camera: { x: 48, y: 48, w: 640, h: 360 } },
    side: { label: 'Half split', desc: 'Camera fills the right half', camera: { x: 960, y: 0, w: 960, h: 1080 } },
    bottomHalf: { label: '1/2 horizontal', desc: 'Camera fills the bottom half', camera: { x: 0, y: 540, w: 1920, h: 540 } },
    bottomThird: { label: '1/3 horizontal', desc: 'Camera fills the bottom third', camera: { x: 0, y: 720, w: 1920, h: 360 } },
    presenter: { label: 'Presenter corner', desc: 'Small camera bottom-right', camera: { x: 1392, y: 762, w: 480, h: 270 } },
    full: { label: 'Camera full screen', desc: 'Camera covers the main screen', camera: { x: 0, y: 0, w: 1920, h: 1080 } },
  };

  /** 3x3 snap anchors: ax/ay are 0, 0.5 or 1. */
  const ANCHORS = [
    { id: 'tl', label: 'Top left', ax: 0, ay: 0 },
    { id: 'tc', label: 'Top centre', ax: 0.5, ay: 0 },
    { id: 'tr', label: 'Top right', ax: 1, ay: 0 },
    { id: 'ml', label: 'Middle left', ax: 0, ay: 0.5 },
    { id: 'c', label: 'Centre', ax: 0.5, ay: 0.5 },
    { id: 'mr', label: 'Middle right', ax: 1, ay: 0.5 },
    { id: 'bl', label: 'Bottom left', ax: 0, ay: 1 },
    { id: 'bc', label: 'Bottom centre', ax: 0.5, ay: 1 },
    { id: 'br', label: 'Bottom right', ax: 1, ay: 1 },
  ];

  /** Quick sizes as a fraction of the output width. */
  const SIZE_PRESETS = [
    { label: '1/4', fraction: 0.25 },
    { label: '1/3', fraction: 1 / 3 },
    { label: '1/2', fraction: 0.5 },
    { label: '2/3', fraction: 2 / 3 },
    { label: 'Full', fraction: 1 },
  ];

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  function uid(prefix) {
    return (prefix || 'layer') + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function isSafeSrc(src) {
    if (typeof src !== 'string' || !src) return false;
    if (src.startsWith('/uploads/')) return true;
    if (CCTV_SRC.test(src)) return true;
    if (/^https?:\/\//i.test(src)) return true;
    if (/^blob:/i.test(src)) return true;
    return false;
  }

  function isCctvSrc(src) {
    return typeof src === 'string' && CCTV_SRC.test(src);
  }

  function cctvSrc(id) {
    return `/api/cctv/${id}/stream.mjpg`;
  }

  function cctvIdOf(src) {
    const m = typeof src === 'string' ? CCTV_SRC.exec(src) : null;
    return m ? m[1] : '';
  }

  /**
   * A YouTube link: watch?v=, youtu.be/, /shorts/, /live/ or /embed/ on youtube.com (www., m., music.) or
   * youtube-nocookie.com, or a playlist; with its start time (t= or start=: 90, 90s, 1m30s). Null for anything else.
   */
  function youtubeInfo(url) {
    let u;
    try {
      u = new URL(String(url || '').trim());
    } catch (_) {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    const path = u.pathname.split('/').filter(Boolean);
    let id = '';
    if (host === 'youtu.be') id = path[0] || '';
    else if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return null;
    else if (path[0] === 'watch') id = u.searchParams.get('v') || '';
    else if (['shorts', 'live', 'embed', 'v'].includes(path[0])) id = path[1] || '';
    else if (path[0] !== 'playlist') return null;
    const list = u.searchParams.get('list') || '';
    const info = { id: YT_ID.test(id) ? id : '', list: YT_LIST.test(list) ? list : '', start: youtubeStart(u.searchParams.get('t') || u.searchParams.get('start')) };
    return info.id || info.list ? info : null;
  }

  /** Seconds from a YouTube start time: "90", "90s", "1m30s", "1h2m3s". */
  function youtubeStart(t) {
    const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(t || '');
    return m ? Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0) : 0;
  }

  /** The link a YouTube main screen keeps: the video, with its playlist and start time, or the playlist. */
  function youtubeSrc(info) {
    if (!info.id) return `https://www.youtube.com/playlist?list=${info.list}`;
    let src = `https://www.youtube.com/watch?v=${info.id}`;
    if (info.list) src += `&list=${info.list}`;
    if (info.start) src += `&t=${info.start}s`;
    return src;
  }

  /**
   * YouTube's player for a main screen: it starts by itself, without controls, muted unless the main screen plays
   * its sound; a single video loops by being its own playlist. Built from the checked ids only, never the raw link.
   */
  function youtubeEmbedUrl(src, opts) {
    const info = youtubeInfo(src);
    if (!info) return '';
    const o = opts || {};
    const q = ['autoplay=1', `mute=${o.muted === false ? 0 : 1}`, 'controls=0', 'playsinline=1', 'rel=0', 'iv_load_policy=3', 'disablekb=1', 'fs=0'];
    if (info.list) q.push(`list=${info.list}`);
    if (o.loop !== false) {
      q.push('loop=1');
      if (!info.list) q.push(`playlist=${info.id}`);
    }
    if (info.start) q.push(`start=${info.start}`);
    return `https://www.youtube.com/embed/${info.id || 'videoseries'}?${q.join('&')}`;
  }

  function sanitizeCrop(raw) {
    const c = raw && typeof raw === 'object' ? raw : {};
    const crop = {};
    for (const edge of CROP_EDGES) crop[edge] = clamp(Math.round(num(c[edge], 0) * 10) / 10, 0, MAX_CROP);
    return crop;
  }

  function hasCrop(crop) {
    return !!crop && CROP_EDGES.some((edge) => crop[edge] > 0);
  }

  /** The USB device an overlay shows (the browser's device id and name) and the format to capture it in; 0 = any. */
  function sanitizeDevice(raw) {
    const d = raw && typeof raw === 'object' ? raw : {};
    return {
      id: typeof d.id === 'string' ? d.id.slice(0, 200) : '',
      label: String(d.label || '').slice(0, 120),
      width: clamp(Math.round(num(d.width, 0)), 0, 7680),
      height: clamp(Math.round(num(d.height, 0)), 0, 4320),
      fps: clamp(Math.round(num(d.fps, 0)), 0, 240),
    };
  }

  function sanitizeLayer(raw, index) {
    const l = raw && typeof raw === 'object' ? raw : {};
    const type = LAYER_TYPES.includes(l.type) ? l.type : 'image';
    const w = clamp(Math.round(num(l.w, 640)), 16, OUTPUT_W);
    const h = clamp(Math.round(num(l.h, 360)), 16, OUTPUT_H);
    const layer = {
      id: typeof l.id === 'string' && l.id ? l.id.slice(0, 64) : uid(type) + index,
      type,
      group: l.group === 'main' ? 'main' : 'split',
      name: String(l.name || LAYER_NAMES[type]).slice(0, 80),
      src: type === 'image' && isSafeSrc(l.src) ? l.src : '',
      x: clamp(Math.round(num(l.x, 0)), -OUTPUT_W, OUTPUT_W),
      y: clamp(Math.round(num(l.y, 0)), -OUTPUT_H, OUTPUT_H),
      w,
      h,
      opacity: clamp(num(l.opacity, 1), 0, 1),
      radius: clamp(Math.round(num(l.radius, 0)), 0, 400),
      visible: l.visible !== false,
      fit: FITS.includes(l.fit) ? l.fit : 'cover',
      mirror: !!l.mirror,
      border: l.border !== false,
      crop: sanitizeCrop(l.crop),
    };
    if (type === 'usb' || type === 'screen') layer.source = SOURCE_ID.test(l.source) ? l.source : uid(type);
    if (type === 'usb') layer.device = sanitizeDevice(l.device);
    return layer;
  }

  function sanitizeLayout(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const main = s.main && typeof s.main === 'object' ? s.main : {};
    const yt = youtubeInfo(main.src);
    // a YouTube link never plays in a video element: a video main screen with one is a YouTube main screen
    const wanted = main.type === 'video' && yt ? 'youtube' : main.type;
    const mainType = MAIN_TYPES.includes(wanted) ? wanted : 'placeholder';
    // a CCTV main screen needs a CCTV stream, a YouTube one a YouTube link, a video or image main screen a file or URL
    const mainSrcOk = mainType === 'youtube' ? !!yt : isSafeSrc(main.src) && (mainType === 'cctv') === isCctvSrc(main.src);
    const layers = sortLayers(Array.isArray(s.layers) ? s.layers.map(sanitizeLayer) : []);
    const seen = new Set();
    for (const l of layers) {
      while (seen.has(l.id)) l.id = uid(l.type);
      seen.add(l.id);
    }
    return {
      version: 1,
      output: { width: OUTPUT_W, height: OUTPUT_H },
      main: {
        type: mainType === 'placeholder' || mainSrcOk ? mainType : 'placeholder',
        src: mainType === 'youtube' && yt ? youtubeSrc(yt) : isSafeSrc(main.src) ? main.src : '',
        fit: FITS.includes(main.fit) ? main.fit : 'cover',
        loop: main.loop !== false,
        muted: main.muted !== false,
        label: String(main.label || 'Main Screen').slice(0, 80),
        crop: sanitizeCrop(main.crop),
      },
      layers,
      template: typeof s.template === 'string' ? s.template.slice(0, 32) : 'custom',
    };
  }

  /** Keep a layer inside the output (or at least touching it) after a move/resize. */
  function constrain(layer) {
    const w = clamp(Math.round(layer.w), 16, OUTPUT_W);
    const h = clamp(Math.round(layer.h), 16, OUTPUT_H);
    return Object.assign({}, layer, {
      w,
      h,
      x: clamp(Math.round(layer.x), 0, OUTPUT_W - w),
      y: clamp(Math.round(layer.y), 0, OUTPUT_H - h),
    });
  }

  function snapToAnchor(layer, anchor, margin) {
    const m = margin == null ? SAFE_MARGIN : margin;
    const a = typeof anchor === 'string' ? ANCHORS.find((x) => x.id === anchor) : anchor;
    if (!a) return layer;
    return constrain(
      Object.assign({}, layer, {
        x: Math.round(m + a.ax * (OUTPUT_W - 2 * m - layer.w)),
        y: Math.round(m + a.ay * (OUTPUT_H - 2 * m - layer.h)),
      })
    );
  }

  /** Which anchor (if any) the layer currently sits on. */
  function anchorOf(layer, margin) {
    for (const a of ANCHORS) {
      const p = snapToAnchor(layer, a, margin);
      if (p.x === layer.x && p.y === layer.y) return a.id;
    }
    return null;
  }

  function resizeToFraction(layer, fraction) {
    const w = clamp(Math.round(OUTPUT_W * fraction), 16, OUTPUT_W);
    const h = clamp(Math.round((w * layer.h) / layer.w), 16, OUTPUT_H);
    return constrain(Object.assign({}, layer, { w, h }));
  }

  /** The main screen's layers first, so they are drawn under the split screen's; each screen keeps its own order. */
  function sortLayers(layers) {
    const rank = (l) => (l.group === 'main' ? 0 : 1);
    return layers.slice().sort((a, b) => rank(a) - rank(b));
  }

  /** The layer a template moves: the split screen's local camera, or without one its first USB device or screen share. */
  function templateTarget(layers) {
    const split = layers.filter((l) => l.group !== 'main');
    return split.find((l) => l.type === 'camera') || split.find((l) => LIVE_TYPES.includes(l.type)) || null;
  }

  function applyTemplate(layout, templateId) {
    const t = TEMPLATES[templateId];
    const target = t ? templateTarget(layout.layers) : null;
    if (!target) return layout;
    const layers = layout.layers.map((l) => (l === target ? constrain(Object.assign({}, l, t.camera)) : l));
    return Object.assign({}, layout, { layers, template: templateId });
  }

  function newLayer(type, props) {
    return sanitizeLayer(Object.assign({ id: uid(type), type }, props || {}), 0);
  }

  return {
    OUTPUT_W,
    OUTPUT_H,
    SAFE_MARGIN,
    LAYER_TYPES,
    LIVE_TYPES,
    FITS,
    MAIN_TYPES,
    MAIN_ID,
    CROP_EDGES,
    MAX_CROP,
    DEFAULT_LAYOUT,
    TEMPLATES,
    ANCHORS,
    SIZE_PRESETS,
    clamp,
    uid,
    isSafeSrc,
    isCctvSrc,
    cctvSrc,
    cctvIdOf,
    youtubeInfo,
    youtubeSrc,
    youtubeEmbedUrl,
    sanitizeCrop,
    hasCrop,
    sanitizeDevice,
    sanitizeLayer,
    sanitizeLayout,
    constrain,
    snapToAnchor,
    anchorOf,
    resizeToFraction,
    sortLayers,
    templateTarget,
    applyTemplate,
    newLayer,
  };
});
