/**
 * Keyer — removes a video's backdrop colour (a green screen, the plain colour behind a logo) on the graphics card.
 *
 * A WebGL canvas shows the video frame by frame, with the key colour made see-through:
 *   similarity  how close to the key colour a pixel must be to go (0–100 %; at 100 % grey goes too)
 *   smoothness  how soft the edge between what goes and what stays is
 *   spill       how much of the key colour's tint is taken out of what stays (its edges, its shadows)
 * A colour is matched by its tint (hue and saturation, whatever the brightness), so the darker and lighter parts of an
 * unevenly lit green screen go together; a black, white or grey key is matched by its brightness. An edge that stays
 * is cleaned with the shade of the backdrop next to it. Without a colour the keyer takes the backdrop colour from the
 * picture (backdropColor) and reports it, so the admin can keep it for every screen.
 *
 * Usage:
 *   const keyer = createKeyer(video, { onColor });   // null when the browser has no WebGL
 *   frame.appendChild(keyer.canvas);
 *   keyer.set(layer.key);   // { color: '#rrggbb' or '' to find it, similarity, smoothness, spill } in %
 *   keyer.destroy();
 */

/** The canvas is never larger than the program: a 4K video is keyed at the size it can be shown. */
const MAX_W = 1920;
const MAX_H = 1080;

const VERTEX = `
attribute vec2 corner;
varying vec2 uv;
void main() {
  uv = vec2(corner.x + 1.0, 1.0 - corner.y) * 0.5;
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT = `
precision mediump float;
uniform sampler2D frame;
uniform vec2 pixel;
uniform vec3 keyYcc;
uniform vec3 keyRgb;
uniform vec2 keyTint;
uniform float tintScale;
uniform vec2 keyHue;
uniform float hue;
uniform float similarity;
uniform float smoothness;
uniform float unmix;
uniform float despill;
uniform float tilt;
varying vec2 uv;

vec3 ycc(vec3 rgb) {
  float y = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  return vec3(y, (rgb.b - y) / 1.8556, (rgb.r - y) / 1.5748);
}

vec3 rgbOf(vec3 c) {
  float r = c.x + 1.5748 * c.z;
  float b = c.x + 1.8556 * c.y;
  return vec3(r, (c.x - 0.2126 * r - 0.0722 * b) / 0.7152, b);
}

// how far a pixel is from the key colour: 0 is the key colour, 1 as far as grey is. A colour is compared by its tint
// (Cb / Cr over its brightest channel), so the dark and the bright parts of an unevenly lit backdrop are the same
// to it; a grey key (black, white) by brightness, a quarter of the range being 1
float distanceOf(vec3 rgb) {
  vec3 c = ycc(rgb);
  float bright = max(max(rgb.r, rgb.g), max(rgb.b, 0.15));
  float byTint = length(c.yz / bright - keyTint) * tintScale;
  float byLight = length(c - keyYcc) * 4.0;
  return mix(byLight, byTint, hue);
}

void main() {
  vec3 rgb = texture2D(frame, uv).rgb;
  // the distance averaged over 3 x 3 pixels, so compression noise does not speckle the edges; and the backdrop
  // around the pixel, so an edge is cleaned with the shade of the backdrop next to it
  float d = 0.0;
  vec3 back = vec3(0.0);
  float backs = 0.0;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      vec3 near = texture2D(frame, uv + vec2(float(x), float(y)) * pixel).rgb;
      float dn = distanceOf(near);
      float w = 1.0 - smoothstep(similarity, similarity + smoothness, dn);
      d += dn;
      back += near * w;
      backs += w;
    }
  }
  d /= 9.0;
  float alpha = smoothstep(similarity, similarity + smoothness, d);
  // an edge that stays was mixed with the backdrop: take it back out (premultiplied by alpha)
  vec3 key = backs > 0.01 ? back / backs : keyRgb;
  vec3 color = clamp(mix(rgb * alpha, rgb - (1.0 - alpha) * key, unmix), 0.0, alpha);
  // what stays and still leans to the key's hue loses that lean: a pink edge on red turns white, a dark red shadow
  // black (the green-screen despill, for any colour); colours of another hue keep theirs
  vec3 c = ycc(color);
  float along = dot(c.yz, keyHue);
  float across = length(c.yz - along * keyHue);
  c.yz -= keyHue * max(0.0, along - across * tilt) * despill;
  gl_FragColor = vec4(clamp(rgbOf(c), 0.0, alpha), alpha);
}`;

const smoothstep = (lo, hi, v) => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/**
 * The key colour as the shader takes it: its RGB, its Y / Cb / Cr, its tint (Cb / Cr over its brightest channel, the
 * same for every shade of it) and the scale that makes 1 the distance from that tint to grey, the direction of its hue
 * in Cb / Cr, and how much it is a colour rather than a grey (0–1).
 */
function keyOf(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const cb = (b - y) / 1.8556;
  const cr = (r - y) / 1.5748;
  const chroma = Math.hypot(cb, cr);
  const bright = Math.max(r, g, b, 0.15);
  const tint = chroma / bright;
  return {
    rgb: [r, g, b],
    ycc: [y, cb, cr],
    tint: [cb / bright, cr / bright],
    tintScale: tint ? 1 / tint : 0,
    dir: chroma ? [cb / chroma, cr / chroma] : [0, 0],
    hue: smoothstep(0.08, 0.2, tint),
  };
}

/**
 * The colour behind a video's subject: the most common colour of its current frame, the edges counting more (a logo
 * or a person stands in the middle). '' when the frame cannot be read: not loaded yet, or from another site.
 */
export function backdropColor(video) {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return '';
  const w = 64;
  const h = Math.max(4, Math.round((w * video.videoHeight) / video.videoWidth));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let px;
  try {
    ctx.drawImage(video, 0, 0, w, h);
    px = ctx.getImageData(0, 0, w, h).data;
  } catch (_) {
    return '';
  }
  // a colour by its tint (each channel over the brightest, 8 levels), so every shade of an unevenly lit green screen
  // falls in one bin; a grey (black, white) by its brightness (16 levels). A pixel near the edge counts four times
  const bins = new Map(); // bin -> { weight, r, g, b }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
      const max = Math.max(r, g, b);
      const key = max - Math.min(r, g, b) > 32 && max > 40
        ? 16 + (((r * 7) / max) | 0) * 64 + (((g * 7) / max) | 0) * 8 + (((b * 7) / max) | 0)
        : max >> 4;
      const weight = x < w / 10 || x >= w - w / 10 || y < h / 10 || y >= h - h / 10 ? 4 : 1;
      const bin = bins.get(key) || { weight: 0, r: 0, g: 0, b: 0 };
      bin.weight += weight;
      bin.r += r * weight;
      bin.g += g * weight;
      bin.b += b * weight;
      bins.set(key, bin);
    }
  }
  let best = null;
  for (const bin of bins.values()) {
    if (!best || bin.weight > best.weight) best = bin;
  }
  return '#' + [best.r, best.g, best.b].map((s) => Math.round(s / best.weight).toString(16).padStart(2, '0')).join('');
}

/** Only a video from this server can be keyed: a page may not read the pictures of another site's video. */
export function canKey(src) {
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch (_) {
    return false;
  }
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
}

export function createKeyer(video, { onColor = () => {} } = {}) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false, depth: false, stencil: false });
  if (!gl) return null;

  let uniforms = null;
  let settings = { color: '', similarity: 40, smoothness: 20, spill: 50 };
  let key = null; // keyOf(the colour in use); null until the backdrop colour is found
  let request = 0;
  let dead = false;
  const rvfc = 'requestVideoFrameCallback' in video;

  /** Builds the shader and its square; again after the graphics card was reset. False when it does not compile. */
  function init() {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const corner = gl.getAttribLocation(program, 'corner');
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    uniforms = {};
    for (const name of ['pixel', 'keyYcc', 'keyRgb', 'keyTint', 'tintScale', 'keyHue', 'hue', 'similarity', 'smoothness', 'unmix', 'despill', 'tilt']) {
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return true;
  }

  /** Draws the video's current frame without its backdrop colour (nothing until the video has a frame). */
  function draw() {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (dead || !uniforms || gl.isContextLost() || !w || !h || video.readyState < 2) return;
    if (!key) {
      const color = backdropColor(video);
      if (!color) return;
      key = keyOf(color);
      setTimeout(() => { if (!dead) onColor(color); });
    }
    const s = Math.min(1, MAX_W / w, MAX_H / h);
    const cw = Math.max(1, Math.round(w * s));
    const ch = Math.max(1, Math.round(h * s));
    if (canvas.width !== cw || canvas.height !== ch) Object.assign(canvas, { width: cw, height: ch });
    gl.viewport(0, 0, cw, ch);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    const spill = settings.spill / 100;
    gl.uniform2f(uniforms.pixel, 1 / cw, 1 / ch);
    gl.uniform3fv(uniforms.keyYcc, key.ycc);
    gl.uniform3fv(uniforms.keyRgb, key.rgb);
    gl.uniform2fv(uniforms.keyTint, key.tint);
    gl.uniform1f(uniforms.tintScale, key.tintScale);
    gl.uniform2fv(uniforms.keyHue, key.dir);
    gl.uniform1f(uniforms.hue, key.hue);
    gl.uniform1f(uniforms.similarity, settings.similarity / 100);
    gl.uniform1f(uniforms.smoothness, Math.max(0.001, settings.smoothness / 100));
    // up to 50 % what stays loses more and more of the key's tint; above it, hues further from the key's lose it too
    gl.uniform1f(uniforms.unmix, Math.min(1, spill * 2));
    gl.uniform1f(uniforms.despill, Math.min(1, spill * 2) * key.hue);
    gl.uniform1f(uniforms.tilt, Math.min(1, 1.5 - spill));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // every new frame of the video (or every screen refresh, in a browser without requestVideoFrameCallback)
  function tick() {
    request = 0;
    draw();
    schedule();
  }

  function schedule() {
    cancel();
    if (!dead) request = rvfc ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
  }

  function cancel() {
    if (request) (rvfc ? video.cancelVideoFrameCallback(request) : cancelAnimationFrame(request));
    request = 0;
  }

  const lose = () => {
    const ext = gl.getExtension('WEBGL_lose_context');
    if (ext) ext.loseContext();
  };
  if (!init()) {
    lose();
    return null;
  }

  // a new file starts the frames again; a paused video shows where it was moved to
  const onLoad = () => { draw(); schedule(); };
  video.addEventListener('loadeddata', onLoad);
  video.addEventListener('seeked', draw);
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => { if (init()) draw(); });
  schedule();

  return {
    canvas,
    /** New settings from the layout; an empty colour finds the backdrop colour again. */
    set(next) {
      if (next.color !== settings.color) key = next.color ? keyOf(next.color) : null;
      settings = Object.assign({}, next);
      draw();
    },
    destroy() {
      dead = true;
      cancel();
      video.removeEventListener('loadeddata', onLoad);
      video.removeEventListener('seeked', draw);
      canvas.remove();
      lose(); // let go of the context now: a browser keeps only a few
    },
  };
}
