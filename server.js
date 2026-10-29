/**
 * GP Studio — server
 *
 * - Serves the admin page (/admin) and the 1920x1080 program output page (/output)
 * - Keeps the split-screen layout in data/layout.json and broadcasts changes over Socket.IO
 * - Accepts PNG / GIF / JPG / WebP / MP4 / WebM uploads (POST /api/upload)
 * - Relays WebRTC signaling so the admin's local camera is streamed live to every output display
 * - Plays live CCTV cameras (RTSP, RTMP, HTTP MJPEG, HLS) on the main screen through ffmpeg (cctv.js)
 * - Checks YouTube links for the main screen: their title, and whether their owner lets other sites play them
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const { DEFAULT_LAYOUT, sanitizeLayout, withoutSource, cctvIdOf, youtubeInfo, youtubeSrc } = require('./public/shared/layout');
const { createCctv } = require('./cctv');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_DIR = path.join(ROOT, 'data');
const LAYOUT_FILE = path.join(DATA_DIR, 'layout.json');
const PORT = Number(process.env.PORT) || readPortFile() || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 500;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

/** data/port.txt changes the port without editing the launchers (updates keep the data folder). */
function readPortFile() {
  try {
    const port = Number(fs.readFileSync(path.join(DATA_DIR, 'port.txt'), 'utf8').trim());
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
  } catch (_) {
    return 0;
  }
}

// ---------- layout persistence ----------

function loadLayout() {
  try {
    const raw = fs.readFileSync(LAYOUT_FILE, 'utf8');
    return sanitizeLayout(JSON.parse(raw));
  } catch (err) {
    const layout = sanitizeLayout(DEFAULT_LAYOUT);
    saveLayout(layout);
    return layout;
  }
}

function saveLayout(layout) {
  fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2));
}

let layout = loadLayout();

/** Nothing keeps showing a deleted file or camera: its windows go, a main screen showing it goes back to its placeholder. */
function dropSource(shows) {
  const next = withoutSource(layout, shows);
  if (next === layout) return;
  layout = next;
  saveLayout(layout);
  io.emit('layout', layout);
}

// ---------- uploads ----------

const ALLOWED_TYPES = {
  'image/png': '.png',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
};

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename(req, file, cb) {
    const ext = ALLOWED_TYPES[file.mimetype] || path.extname(file.originalname).toLowerCase();
    const base = path
      .basename(file.originalname, path.extname(file.originalname))
      .replace(/[^a-zA-Z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'file';
    cb(null, `${Date.now().toString(36)}-${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (ALLOWED_TYPES[file.mimetype]) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: PNG, GIF, JPG, WebP, MP4, WebM.`));
  },
});

// ---------- live CCTV ----------

const cctv = createCctv({
  file: path.join(DATA_DIR, 'cctv.json'),
  ffmpeg: process.env.FFMPEG_PATH,
  onStatus: (status) => io.emit('cctv:status', status),
});

// ---------- app ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => res.redirect('/admin/'));
app.use('/admin', express.static(path.join(PUBLIC_DIR, 'admin')));
app.use('/output', express.static(path.join(PUBLIC_DIR, 'output')));
app.use('/shared', express.static(path.join(PUBLIC_DIR, 'shared')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/layout', (req, res) => res.json(layout));

app.put('/api/layout', (req, res) => {
  layout = sanitizeLayout(req.body);
  saveLayout(layout);
  io.emit('layout', layout);
  res.json(layout);
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received (field name must be "file").' });
    res.json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      size: req.file.size,
      type: req.file.mimetype,
    });
  });
});

app.get('/api/uploads', (req, res) => {
  const files = fs
    .readdirSync(UPLOAD_DIR)
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const stat = fs.statSync(path.join(UPLOAD_DIR, f));
      return { name: f, url: `/uploads/${f}`, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  res.json(files);
});

app.delete('/api/uploads/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(UPLOAD_DIR, name);
  // a file of the folder, as the list shows them: never a hidden file or the folder above
  if (name.startsWith('.') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(file);
  dropSource((s) => s.src === `/uploads/${name}`);
  res.json({ ok: true });
});

app.get('/api/cctv', (req, res) => res.json(cctv.list()));

app.post('/api/cctv/test', async (req, res) => {
  try {
    res.json(await cctv.test(req.body));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/cctv', (req, res) => respond(res, () => cctv.save(null, req.body)));
app.put('/api/cctv/:id', (req, res) => respond(res, () => cctv.save(req.params.id, req.body)));

app.delete('/api/cctv/:id', (req, res) => {
  if (!cctv.remove(req.params.id)) return res.status(404).json({ error: 'Camera not found.' });
  dropSource((s) => s.type === 'cctv' && cctvIdOf(s.src) === req.params.id);
  res.json({ ok: true });
});

app.get('/api/cctv/:id/stream.mjpg', (req, res) => cctv.stream(req.params.id, req, res));

// A YouTube link before it goes on air: YouTube's oEmbed gives its title, and refuses a video whose owner does not
// let other sites play it (401 / 403), or one that is private, removed or mistyped.
app.get('/api/youtube', async (req, res) => {
  const info = youtubeInfo(req.query.url);
  if (!info) return res.status(400).json({ ok: false, error: 'This is not a link to a YouTube video or playlist.' });
  const src = youtubeSrc(info);
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(src)}`, { signal: AbortSignal.timeout(6000) });
    if (r.status === 401 || r.status === 403) {
      return res.json({ ok: false, error: 'The owner of this video does not let other sites play it. Choose another video.' });
    }
    if (!r.ok) return res.json({ ok: false, error: 'YouTube cannot find this video: it may be private, removed or mistyped.' });
    const data = await r.json();
    res.json({ ok: true, src, title: String(data.title || '').slice(0, 80), author: String(data.author_name || '').slice(0, 80) });
  } catch (_) {
    // no answer from YouTube (no internet here, or a slow one): the screens try to play it all the same
    res.json({ ok: true, src, title: '', unchecked: true });
  }
});

function respond(res, fn) {
  try {
    res.json(fn());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

// ---------- http(s) server ----------

let server;
if (process.env.SSL_KEY && process.env.SSL_CERT) {
  server = https.createServer(
    { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) },
    app
  );
} else {
  server = http.createServer(app);
}

// ---------- realtime ----------

const io = new Server(server, { maxHttpBufferSize: 1e6 });

/** socket.id -> { role: 'admin' | 'output', name } */
const peers = new Map();
let cameraState = { active: false, label: '' };
/** admin socket id -> the USB devices and screen shares it publishes: { source id: { kind, label } } */
const liveSources = new Map();

function allLiveSources() {
  return Object.assign({}, ...liveSources.values());
}

function outputIds() {
  return [...peers.entries()].filter(([, p]) => p.role === 'output').map(([id]) => id);
}

function adminIds() {
  return [...peers.entries()].filter(([, p]) => p.role === 'admin').map(([id]) => id);
}

function broadcastPeers() {
  const summary = { admins: adminIds().length, outputs: outputIds().length, outputIds: outputIds() };
  for (const id of adminIds()) io.to(id).emit('peers', summary);
}

io.on('connection', (socket) => {
  socket.on('hello', (info = {}) => {
    const role = info.role === 'admin' ? 'admin' : 'output';
    peers.set(socket.id, { role, name: String(info.name || '').slice(0, 60) });
    // before the layout: an admin window restarts only the USB devices no other window publishes
    socket.emit('sources', allLiveSources());
    socket.emit('layout', layout);
    socket.emit('camera:state', cameraState);
    for (const status of cctv.statuses()) socket.emit('cctv:status', status);
    if (role === 'output') {
      for (const id of adminIds()) io.to(id).emit('output:joined', { id: socket.id });
    }
    broadcastPeers();
  });

  // Admin pushes a new layout (preview edits or "Take to program")
  socket.on('layout:set', (next, ack) => {
    const peer = peers.get(socket.id);
    if (!peer || peer.role !== 'admin') return;
    layout = sanitizeLayout(next);
    saveLayout(layout);
    socket.broadcast.emit('layout', layout);
    if (typeof ack === 'function') ack(layout);
  });

  // Admin reports whether its camera is on (outputs show a placeholder when off)
  socket.on('camera:state', (state = {}) => {
    const peer = peers.get(socket.id);
    if (!peer || peer.role !== 'admin') return;
    cameraState = { active: !!state.active, label: String(state.label || '').slice(0, 80) };
    socket.broadcast.emit('camera:state', cameraState);
  });

  // Admin reports the USB devices and screen shares it publishes (outputs say "Connecting…" for those)
  socket.on('sources:state', (list) => {
    const peer = peers.get(socket.id);
    if (!peer || peer.role !== 'admin') return;
    const clean = {};
    for (const [id, s] of Object.entries(list && typeof list === 'object' ? list : {}).slice(0, 32)) {
      if (!/^[a-z0-9-]{1,40}$/.test(id) || !s || typeof s !== 'object') continue;
      clean[id] = { kind: s.kind === 'screen' ? 'screen' : 'usb', label: String(s.label || '').slice(0, 80) };
    }
    liveSources.set(socket.id, clean);
    io.emit('sources', allLiveSources());
  });

  // WebRTC signaling relay: { to, data } -> delivered as { from, data }
  socket.on('rtc:signal', ({ to, data } = {}) => {
    if (!to || !peers.has(to)) return;
    io.to(to).emit('rtc:signal', { from: socket.id, data });
  });

  socket.on('outputs:list', (ack) => {
    if (typeof ack === 'function') ack(outputIds());
  });

  socket.on('disconnect', () => {
    const peer = peers.get(socket.id);
    peers.delete(socket.id);
    if (peer && peer.role === 'output') {
      for (const id of adminIds()) io.to(id).emit('output:left', { id: socket.id });
    }
    if (peer && peer.role === 'admin') {
      for (const id of outputIds()) io.to(id).emit('admin:left', { id: socket.id });
    }
    if (liveSources.delete(socket.id)) io.emit('sources', allLiveSources());
    broadcastPeers();
  });
});

// ---------- start ----------

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/** The desktop launchers set OPEN_BROWSER=1: the admin opens once the server is ready. */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}

/** Is the server already on this port a GP Studio? */
async function isStreamStudio(base) {
  try {
    const res = await fetch(`${base}/api/layout`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    return !!(body && body.output && body.output.width === 1920);
  } catch (_) {
    return false;
  }
}

const scheme = process.env.SSL_KEY && process.env.SSL_CERT ? 'https' : 'http';
const adminUrl = `${scheme}://localhost:${PORT}/admin/`;

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(err);
    process.exit(1);
  }
  // started twice (desktop icon while it runs at login, say): show the running copy instead of failing
  if (await isStreamStudio(`${scheme}://localhost:${PORT}`)) {
    console.log(`\n  GP Studio is already running: ${adminUrl}\n`);
    if (process.env.OPEN_BROWSER) openBrowser(adminUrl);
    process.exit(0);
  }
  console.error(`\n  Port ${PORT} is used by another program. Close that program, or give GP Studio`);
  console.error(`  another port: write a number such as 3001 into ${path.join(DATA_DIR, 'port.txt')}\n`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  GP Studio is running');
  console.log(`  Admin  : ${adminUrl}`);
  console.log(`  Output : ${scheme}://localhost:${PORT}/output/   (press F for fullscreen)`);
  for (const ip of lanAddresses()) console.log(`  LAN    : ${scheme}://${ip}:${PORT}/`);
  const bundled = cctv.ffmpegPath !== 'ffmpeg' && !process.env.FFMPEG_PATH ? ' (installed with GP Studio)' : '';
  console.log(`  CCTV   : ${cctv.version ? `ffmpeg ${cctv.version.text}${bundled}` : 'ffmpeg not found — install it or set FFMPEG_PATH to play CCTV cameras'}`);
  if (scheme === 'http') {
    console.log('  Note   : browsers only allow camera access on localhost or HTTPS.');
    console.log('           For LAN use, start with SSL_KEY/SSL_CERT (see README).');
  }
  console.log('  Stop   : close this window or press Ctrl+C');
  console.log('');
  if (process.env.OPEN_BROWSER) openBrowser(adminUrl);
});

// stop every camera's ffmpeg with the server (SIGHUP: the terminal window was closed)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    cctv.shutdown();
    process.exit(0);
  });
}
