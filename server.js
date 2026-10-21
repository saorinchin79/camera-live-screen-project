/**
 * Stream Studio — server
 *
 * - Serves the admin page (/admin) and the 1920x1080 program output page (/output)
 * - Keeps the split-screen layout in data/layout.json and broadcasts changes over Socket.IO
 * - Accepts PNG / GIF / JPG / WebP / MP4 / WebM uploads (POST /api/upload)
 * - Relays WebRTC signaling so the admin's local camera is streamed live to every output display
 * - Plays live CCTV cameras (RTSP, RTMP, HTTP MJPEG, HLS) on the main screen through ffmpeg (cctv.js)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const { DEFAULT_LAYOUT, sanitizeLayout, cctvIdOf } = require('./public/shared/layout');
const { createCctv } = require('./cctv');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATA_DIR = path.join(ROOT, 'data');
const LAYOUT_FILE = path.join(DATA_DIR, 'layout.json');
const PORT = Number(process.env.PORT) || 3000;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 500;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

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
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
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
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(file);
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
  // the main screen cannot keep showing a deleted camera
  if (layout.main.type === 'cctv' && cctvIdOf(layout.main.src) === req.params.id) {
    layout = sanitizeLayout(Object.assign({}, layout, { main: Object.assign({}, layout.main, { type: 'placeholder', src: '', label: 'Main Screen' }) }));
    saveLayout(layout);
    io.emit('layout', layout);
  }
  res.json({ ok: true });
});

app.get('/api/cctv/:id/stream.mjpg', (req, res) => cctv.stream(req.params.id, req, res));

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

server.listen(PORT, () => {
  const scheme = process.env.SSL_KEY ? 'https' : 'http';
  console.log('');
  console.log('  Stream Studio is running');
  console.log(`  Admin  : ${scheme}://localhost:${PORT}/admin/`);
  console.log(`  Output : ${scheme}://localhost:${PORT}/output/   (press F for fullscreen)`);
  for (const ip of lanAddresses()) console.log(`  LAN    : ${scheme}://${ip}:${PORT}/`);
  console.log(`  CCTV   : ${cctv.version ? `ffmpeg ${cctv.version.text}` : 'ffmpeg not found — install it or set FFMPEG_PATH to play CCTV cameras'}`);
  if (scheme === 'http') {
    console.log('  Note   : browsers only allow camera access on localhost or HTTPS.');
    console.log('           For LAN use, start with SSL_KEY/SSL_CERT (see README).');
  }
  console.log('');
});

// stop every camera's ffmpeg with the server
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cctv.shutdown();
    process.exit(0);
  });
}
