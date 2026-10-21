/**
 * Layout model shared by the server (CommonJS) and the browser (window.StreamLayout).
 *
 * A layout describes the 1920x1080 program:
 *   main   — what fills the whole screen (placeholder, uploaded video or image)
 *   layers — split-screen overlays drawn on top, back to front (camera / image)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StreamLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const OUTPUT_W = 1920;
  const OUTPUT_H = 1080;
  const SAFE_MARGIN = 48;

  const LAYER_TYPES = ['camera', 'image'];
  const FITS = ['cover', 'contain', 'fill'];
  const MAIN_TYPES = ['placeholder', 'video', 'image'];

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

  /** Split-screen templates: where the (first) camera layer goes. Images keep their place. */
  const TEMPLATES = {
    pip: { label: 'Picture-in-picture', desc: 'Camera top-left', camera: { x: 48, y: 48, w: 640, h: 360 } },
    side: { label: 'Half split', desc: 'Camera fills the right half', camera: { x: 960, y: 0, w: 960, h: 1080 } },
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
    if (/^https?:\/\//i.test(src)) return true;
    if (/^blob:/i.test(src)) return true;
    return false;
  }

  function sanitizeLayer(raw, index) {
    const l = raw && typeof raw === 'object' ? raw : {};
    const type = LAYER_TYPES.includes(l.type) ? l.type : 'image';
    const w = clamp(Math.round(num(l.w, 640)), 16, OUTPUT_W);
    const h = clamp(Math.round(num(l.h, 360)), 16, OUTPUT_H);
    return {
      id: typeof l.id === 'string' && l.id ? l.id.slice(0, 64) : uid(type) + index,
      type,
      name: String(l.name || (type === 'camera' ? 'Local Camera' : 'Image')).slice(0, 80),
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
    };
  }

  function sanitizeLayout(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const main = s.main && typeof s.main === 'object' ? s.main : {};
    const mainType = MAIN_TYPES.includes(main.type) ? main.type : 'placeholder';
    const layers = Array.isArray(s.layers) ? s.layers.map(sanitizeLayer) : [];
    const seen = new Set();
    for (const l of layers) {
      while (seen.has(l.id)) l.id = uid(l.type);
      seen.add(l.id);
    }
    return {
      version: 1,
      output: { width: OUTPUT_W, height: OUTPUT_H },
      main: {
        type: mainType === 'placeholder' || isSafeSrc(main.src) ? mainType : 'placeholder',
        src: isSafeSrc(main.src) ? main.src : '',
        fit: FITS.includes(main.fit) ? main.fit : 'cover',
        loop: main.loop !== false,
        muted: main.muted !== false,
        label: String(main.label || 'Main Screen').slice(0, 80),
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

  function applyTemplate(layout, templateId) {
    const t = TEMPLATES[templateId];
    if (!t) return layout;
    let done = false;
    const layers = layout.layers.map((l) => {
      if (l.type === 'camera' && !done) {
        done = true;
        return constrain(Object.assign({}, l, t.camera));
      }
      return l;
    });
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
    FITS,
    MAIN_TYPES,
    DEFAULT_LAYOUT,
    TEMPLATES,
    ANCHORS,
    SIZE_PRESETS,
    clamp,
    uid,
    isSafeSrc,
    sanitizeLayer,
    sanitizeLayout,
    constrain,
    snapToAnchor,
    anchorOf,
    resizeToFraction,
    applyTemplate,
    newLayer,
  };
});
