/**
 * Makes GP Studio's icons from the logo, gp-logo.png in this folder: node setup/brand/make-icons.js
 *
 *   mark — the GP emblem on transparent: the favicon, the admin's header and the shortcut icons
 *   tile — the emblem on white, square and opaque (iOS turns transparency black): the home screen icons
 *
 * The logo is the emblem on a transparent background, with any margin: the emblem is found by its visible pixels.
 * Needs ffmpeg: the copy npm installed (ffmpeg-static) or one on the PATH.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const LOGO = path.join(__dirname, 'gp-logo.png');
let FFMPEG = 'ffmpeg';
try {
  FFMPEG = require(path.join(ROOT, 'node_modules', 'ffmpeg-static')) || FFMPEG;
} catch (_) {
  // the one on the PATH
}

const ffmpeg = (args) => execFileSync(FFMPEG, ['-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 28 });

/** The logo's size (from its PNG header) and its pixels, as RGBA. */
function pixels() {
  const head = fs.readFileSync(LOGO).subarray(0, 24);
  if (head.toString('latin1', 1, 4) !== 'PNG') throw new Error(`${LOGO} is not a PNG`);
  const w = head.readUInt32BE(16);
  const h = head.readUInt32BE(20);
  return { w, h, px: ffmpeg(['-i', LOGO, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']) };
}

/** Where the emblem is: the box around the logo's visible pixels. */
function measure({ w, h, px }) {
  if (px[3] > 8) console.warn('note: the logo has no transparent background, the icons keep its background');
  const b = { x0: w, x1: -1, y0: h, y1: -1 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] <= 8) continue;
      b.x0 = Math.min(b.x0, x);
      b.x1 = Math.max(b.x1, x);
      b.y0 = Math.min(b.y0, y);
      b.y1 = Math.max(b.y1, y);
    }
  }
  if (b.x1 < 0) throw new Error(`${LOGO} has no visible pixels`);
  return { x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1 };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-icons-'));
const emblem = measure(pixels());
console.log('emblem:', JSON.stringify(emblem));
const crop = `crop=${emblem.w}:${emblem.h}:${emblem.x}:${emblem.y}`;
/** The side of a square in which the emblem takes the given share of the width. */
const side = (share) => Math.round(Math.max(emblem.w, emblem.h) / share);

/**
 * The emblem on transparent, the given size, with 2 % to spare on each side. It is scaled with premultiplied
 * alpha: scaling RGBA as it is would mix the transparent black around the emblem into its edges, a dark rim.
 */
function mark(size, to) {
  const s = side(0.96);
  const file = to || path.join(tmp, `mark-${size}.png`);
  ffmpeg([
    '-i', LOGO, '-vf',
    `${crop},pad=${s}:${s}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=gbrap,premultiply=inplace=1,` +
      `scale=${size}:${size}:flags=area,unpremultiply=inplace=1,format=rgba`,
    '-frames:v', '1', file,
  ]);
  return file;
}

/** The emblem on an opaque white square of the given size, 82 % of its width. */
function tile(size, to) {
  const s = side(0.82);
  ffmpeg([
    '-f', 'lavfi', '-i', `color=white:s=${s}x${s},format=gbrp`, '-i', LOGO, '-filter_complex',
    `[1]${crop},format=gbrap[e];[0][e]overlay=(W-w)/2:(H-h)/2:format=gbrp,format=rgb24,` +
      `scale=${size}:${size}:flags=area`,
    '-frames:v', '1', to,
  ]);
  return to;
}

/** An .ico of PNG images (Windows Vista and later, every browser). */
function ico(files, to) {
  const images = files.map((f) => ({ size: Number(/-(\d+)\.png$/.exec(f)[1]), data: fs.readFileSync(f) }));
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2); // icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    head[o] = head[o + 1] = size >= 256 ? 0 : size; // 0 = 256
    head.writeUInt16LE(1, o + 4); // colour planes
    head.writeUInt16LE(32, o + 6); // bits per pixel
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  fs.writeFileSync(to, Buffer.concat([head, ...images.map((i) => i.data)]));
}

const pub = (f) => path.join(ROOT, 'public', f);
ico([16, 32, 48].map((s) => mark(s)), pub('favicon.ico'));
mark(64, pub('icons/mark-64.png'));
tile(180, pub('apple-touch-icon.png'));
tile(192, pub('icons/tile-192.png'));
tile(512, pub('icons/tile-512.png'));
// the desktop shortcuts
ico([16, 24, 32, 48, 64, 128, 256].map((s) => mark(s)), path.join(ROOT, 'setup', 'stream-studio.ico'));
mark(256, path.join(ROOT, 'setup', 'stream-studio.png'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('icons written: public/favicon.ico, public/apple-touch-icon.png, public/icons/, setup/stream-studio.ico and .png');
