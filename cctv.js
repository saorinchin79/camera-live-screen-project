/**
 * GP Studio — live CCTV cameras
 *
 * Browsers cannot play RTSP, so while anyone watches a camera the server runs ONE ffmpeg that reads it
 * (RTSP, RTMP, HTTP MJPEG or HLS) and re-encodes it to Motion JPEG. Every frame goes to all viewers as a
 * multipart/x-mixed-replace stream, which a plain <img> plays live. ffmpeg starts with the first viewer,
 * restarts with a back-off when the camera drops, and stops shortly after the last viewer leaves.
 *
 * Camera URLs usually carry the camera password: they stay in data/cctv.json. Viewers only ever get
 * /api/cctv/<id>/stream.mjpg, and the admin gets the URL with the password masked.
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const SCHEMES = ['rtsp', 'rtsps', 'rtmp', 'rtmps', 'http', 'https'];
const PROTOCOLS = 'rtsp,rtsps,rtp,srtp,udp,tcp,tls,http,https,httpproxy,hls,crypto,rtmp,rtmps,rtmpt,rtmpts';
const FPS_CHOICES = [5, 10, 15, 25];
const DEFAULT_FPS = 15;
const MAX_WIDTH = 1920;
const BOUNDARY = 'cctvframe';
const MASK = '••••';
const IDLE_STOP_MS = 15000; // stop ffmpeg this long after the last viewer leaves
const STALL_MS = 15000; // reconnect when a live camera sends nothing for this long
const CONNECT_MS = 30000; // give up on a connection attempt that shows no picture for this long
const RETRY_MS = [2000, 4000, 8000, 15000];
const TEST_TIMEOUT_MS = 15000;

const HINTS = [
  [/\b40[13]\b|unauthori[sz]ed|authori[sz]ation failed|forbidden/i, 'Wrong user name or password for the camera.'],
  [/\b404\b|not found/i, 'The camera answered, but the stream path is wrong.'],
  [/connection refused/i, 'The camera refused the connection: check the IP address and the port (RTSP is usually 554).'],
  [
    /no route to host|host is unreachable|network is unreachable|host is down/i,
    'The camera cannot be reached from this computer. Check that it is on the same network. On macOS, also allow ' +
      'Local Network access for the app that runs the server (System Settings › Privacy & Security › Local Network).',
  ],
  [/timed out|timeout/i, 'The camera did not answer in time: check the address.'],
  [/resolve|name or service not known|nodename nor servname/i, 'The camera address cannot be found.'],
  [/invalid data|could not find codec|does not contain any stream|no video|stream not found/i, 'This URL did not give a video stream that ffmpeg can read.'],
  [/protocol not found|not on whitelist/i, 'This kind of URL is not supported.'],
];

// ---------- camera URLs ----------

/** Splits "scheme://user:pass@host/path" around the password; the user info ends at the last "@" of the host part. */
function splitPassword(url) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)(.*)$/is.exec(url);
  if (!m) return null;
  const [, scheme, authority, rest] = m;
  const at = authority.lastIndexOf('@');
  const colon = authority.indexOf(':');
  if (at < 0 || colon < 0 || colon > at) return null;
  return { head: scheme + authority.slice(0, colon + 1), password: authority.slice(colon + 1, at), tail: authority.slice(at) + rest };
}

function maskUrl(url) {
  const p = splitPassword(url);
  return p && p.password ? p.head + MASK + p.tail : url;
}

/** The admin sends the masked URL back when only the name or frame rate changed: keep the stored password. */
function unmaskUrl(url, storedUrl) {
  const p = splitPassword(url);
  if (!p || p.password !== MASK) return url;
  const stored = storedUrl ? splitPassword(storedUrl) : null;
  if (!stored) throw fail(400, 'Type the camera password again.');
  return p.head + stored.password + p.tail;
}

/** Hides passwords in text that may echo the camera URL back, such as ffmpeg errors. */
function maskText(text, url) {
  let out = String(text);
  const p = url ? splitPassword(url) : null;
  if (p && p.password.length >= 3) out = out.split(p.password).join(MASK);
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s/]*@/gi, `$1${MASK}@`);
}

function checkUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw fail(400, 'Enter the camera stream URL.');
  if (u.length > 2000 || /[\s\u0000-\u001f]/.test(u)) throw fail(400, 'The stream URL is not valid.');
  const scheme = (/^([a-z][a-z0-9+.-]*):\/\/./i.exec(u) || [])[1];
  if (!scheme || !SCHEMES.includes(scheme.toLowerCase())) throw fail(400, 'Use an rtsp://, rtmp:// or http(s):// stream URL.');
  return u;
}

function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#]*@)?([^/?#:]+)/i.exec(url);
  return m ? m[1] : '';
}

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------- ffmpeg ----------

/** FFMPEG_PATH if set, else the ffmpeg on the PATH (often newer), else the copy npm installed (ffmpeg-static). */
function findFfmpeg(preferred) {
  if (preferred) return preferred;
  if (ffmpegVersion('ffmpeg')) return 'ffmpeg';
  try {
    const bundled = require('ffmpeg-static');
    if (bundled && fs.existsSync(bundled)) return bundled;
  } catch (_) {
    // the optional dependency is not installed
  }
  return 'ffmpeg';
}

function ffmpegVersion(ffmpeg) {
  try {
    const out = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8', timeout: 5000 });
    const m = /ffmpeg version (\S+)/.exec(out.stdout || '');
    if (!m) return null;
    // release builds start with the major version; git builds ("N-…") are newer than any release
    return { text: m[1], major: Number((/^n?(\d+)\./.exec(m[1]) || [])[1]) || 99 };
  } catch (_) {
    return null;
  }
}

function inputArgs(url, env, loglevel) {
  const rtsp = /^rtsps?:/i.test(url);
  return [
    '-hide_banner', '-nostdin', '-loglevel', loglevel,
    '-protocol_whitelist', PROTOCOLS,
    '-fflags', 'nobuffer', '-flags', 'low_delay',
    // a camera's first picture comes ~2 s sooner without the default 5 s of stream analysis
    '-analyzeduration', '500000', '-probesize', '1000000',
    // RTSP over TCP survives Wi-Fi and NAT; ffmpeg 4 called the socket timeout -stimeout
    ...(rtsp ? ['-rtsp_transport', 'tcp', '-allowed_media_types', 'video', env.timeoutFlag, '10000000'] : ['-rw_timeout', '10000000']),
    '-i', url,
    '-an',
  ];
}

/** Square the pixels (some cameras send anamorphic D1), then cap the width. */
function scaleFilter(maxWidth) {
  return `scale='if(gt(sar,0),iw*sar,iw)':ih,setsar=1,scale='trunc(min(${maxWidth},iw)/2)*2':-2`;
}

function streamArgs(cam, env) {
  return [
    ...inputArgs(cam.url, env, 'error'),
    '-vf', `${scaleFilter(MAX_WIDTH)},fps=${cam.fps}`,
    '-c:v', 'mjpeg', '-q:v', '6',
    '-f', 'mpjpeg', '-boundary_tag', BOUNDARY, 'pipe:1',
  ];
}

function testArgs(url, env) {
  return [...inputArgs(url, env, 'info'), '-frames:v', '1', '-vf', scaleFilter(1280), '-c:v', 'mjpeg', '-q:v', '4', '-f', 'image2pipe', 'pipe:1'];
}

/** Splits ffmpeg's mpjpeg output ("--boundary", headers with Content-length, the JPEG, CRLF) into frames. */
function createMjpegParser(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const headEnd = buf.indexOf('\r\n\r\n');
      if (headEnd < 0) break;
      const len = /content-length:\s*(\d+)/i.exec(buf.toString('latin1', 0, headEnd));
      if (!len) {
        buf = buf.subarray(headEnd + 4);
        continue;
      }
      const start = headEnd + 4;
      const end = start + Number(len[1]);
      if (buf.length < end) break;
      onFrame(Buffer.from(buf.subarray(start, end)));
      buf = buf.subarray(end);
    }
    if (buf.length > 16 * 1024 * 1024) buf = Buffer.alloc(0); // a broken stream must not grow without bound
  };
}

/** Width and height from a JPEG's start-of-frame marker. */
function jpegSize(jpeg) {
  let i = 2;
  while (i + 9 < jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return { width: jpeg.readUInt16BE(i + 7), height: jpeg.readUInt16BE(i + 5) };
    i += 2 + jpeg.readUInt16BE(i + 2);
  }
  return null;
}

/** The last ffmpeg error line (passwords masked) and a hint for the admin. */
function explain(stderr, url) {
  if (/ffmpeg not found/.test(stderr)) {
    return { message: 'ffmpeg is not installed on the server.', hint: 'Install it (brew install ffmpeg, apt install ffmpeg) or set FFMPEG_PATH.' };
  }
  const lines = maskText(stderr, url)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]*\]\s*/, '').trim())
    .filter(Boolean);
  const tail = lines.slice(-4).join('\n');
  const hit = HINTS.find(([re]) => re.test(tail));
  return { message: (lines[lines.length - 1] || 'The camera stream ended.').slice(0, 240), hint: hit ? hit[1] : '' };
}

/** One frame from the camera, to check a URL before it goes on the program. */
function grabFrame(env, url) {
  return new Promise((resolve) => {
    const proc = spawn(env.ffmpeg, testArgs(url, env), { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, TEST_TIMEOUT_MS);
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20000); });
    proc.on('error', (err) => {
      stderr += '\n' + (err.code === 'ENOENT' ? 'ffmpeg not found' : err.message);
      if (proc.pid === undefined) finish(); // ffmpeg could not be started at all
    });
    proc.on('close', finish);

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const jpeg = Buffer.concat(chunks);
      if (jpeg.length > 100 && jpeg[0] === 0xff && jpeg[1] === 0xd8) {
        const info = /Stream #\d+:\d+[^\n]*?: Video: ([a-z0-9_]+)[^\n]*?\b(\d{2,5})x(\d{2,5})\b/i.exec(stderr);
        resolve({
          ok: true,
          codec: info ? info[1] : '',
          width: info ? Number(info[2]) : 0,
          height: info ? Number(info[3]) : 0,
          image: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
        });
      } else if (timedOut && !/ffmpeg not found/.test(stderr)) {
        resolve({ ok: false, error: `No picture from the camera within ${TEST_TIMEOUT_MS / 1000} s.`, hint: 'Check the address, or try the camera’s sub stream.' });
      } else {
        const why = explain(stderr, url);
        resolve({ ok: false, error: why.message, hint: why.hint });
      }
    }
  });
}

// ---------- one camera: ffmpeg + its viewers ----------

class Hub {
  constructor(cam, env) {
    this.cam = cam;
    this.env = env;
    this.viewers = new Set();
    this.proc = null;
    this.frame = null;
    this.frameAt = 0;
    this.startedAt = 0;
    this.failures = 0;
    this.stopping = false;
    this.restarting = false;
    this.retryTimer = null;
    this.idleTimer = null;
    this.watchdog = null;
    this.status = { id: cam.id, state: 'idle', message: '', hint: '', width: 0, height: 0, viewers: 0 };
  }

  join(req, res) {
    res.writeHead(200, {
      'Content-Type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Connection: 'close',
      'X-Accel-Buffering': 'no',
    });
    this.viewers.add(res);
    clearTimeout(this.idleTimer);
    req.on('close', () => this.leave(res));
    res.on('error', () => this.leave(res));
    // a new viewer sees the current picture at once instead of waiting for the next frame
    if (this.frame && Date.now() - this.frameAt < 5000) this.send(res, this.frame);
    if (this.proc && this.stopping) {
      // ffmpeg is still shutting down after the last viewer left: start it again once it is gone
      this.stopping = false;
      this.restarting = true;
    }
    if (!this.proc && !this.retryTimer) this.start();
    else this.setStatus({});
  }

  leave(res) {
    if (!this.viewers.delete(res)) return;
    this.setStatus({});
    if (!this.viewers.size) this.idleTimer = setTimeout(() => this.stop(), IDLE_STOP_MS);
  }

  start() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopping = false;
    this.restarting = false;
    this.stalled = false;
    this.setStatus({ state: 'connecting', message: '', hint: '' });
    let stderr = '';
    const proc = spawn(this.env.ffmpeg, streamArgs(this.cam, this.env), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    this.startedAt = Date.now();
    proc.stdout.on('data', createMjpegParser((jpeg) => this.onFrame(jpeg)));
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    proc.on('error', (err) => {
      stderr += '\n' + (err.code === 'ENOENT' ? 'ffmpeg not found' : err.message);
      if (proc.pid === undefined) this.onExit(proc, stderr); // ffmpeg could not be started at all
    });
    proc.on('close', () => this.onExit(proc, stderr));
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.checkStall(), 5000);
  }

  onFrame(jpeg) {
    this.frame = jpeg;
    this.frameAt = Date.now();
    if (this.status.state !== 'live') {
      this.failures = 0;
      const size = jpegSize(jpeg) || { width: 0, height: 0 };
      this.setStatus({ state: 'live', message: '', hint: '', width: size.width, height: size.height });
    }
    for (const res of this.viewers) this.send(res, jpeg);
  }

  send(res, jpeg) {
    if (res.writableEnded || res.destroyed) return;
    if (res.writableNeedDrain) return; // a slow viewer skips frames instead of piling them up in memory
    res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
    res.write(jpeg);
    res.write('\r\n');
  }

  checkStall() {
    if (!this.proc) return;
    const now = Date.now();
    const quiet = this.status.state === 'live' ? now - this.frameAt > STALL_MS : now - this.startedAt > CONNECT_MS;
    if (quiet) {
      this.stalled = true;
      this.proc.kill('SIGKILL');
    }
  }

  onExit(proc, stderr) {
    if (this.proc !== proc) return;
    this.proc = null;
    clearInterval(this.watchdog);
    if (this.stopping) return this.setStatus({ state: 'idle' });
    if (this.restarting && this.viewers.size) return this.start();
    const why = this.stalled
      ? { message: 'The camera stopped sending pictures.', hint: '' }
      : explain(stderr || 'The camera stream ended.', this.cam.url);
    this.setStatus({ state: 'error', message: why.message, hint: why.hint });
    if (!this.viewers.size) return;
    const delay = RETRY_MS[Math.min(this.failures, RETRY_MS.length - 1)];
    this.failures++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.viewers.size) this.start();
    }, delay);
  }

  /** The URL or frame rate changed: reconnect now. */
  update(cam) {
    this.cam = cam;
    this.failures = 0;
    if (this.proc) {
      this.restarting = true;
      this.proc.kill('SIGKILL');
    } else if (this.retryTimer) {
      this.start();
    }
  }

  stop() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.frame = null;
    if (!this.proc) return this.setStatus({ state: 'idle' });
    this.stopping = true;
    // ffmpeg 7 ignores SIGTERM while it streams into a pipe, and a live pipe has nothing to finish
    this.proc.kill('SIGKILL');
  }

  /** The camera was deleted: end every viewer's stream too. */
  close() {
    this.stop();
    for (const res of this.viewers) res.end();
    this.viewers.clear();
  }

  setStatus(patch) {
    Object.assign(this.status, patch, { viewers: this.viewers.size });
    this.env.onStatus(Object.assign({}, this.status));
  }
}

// ---------- the camera list ----------

/**
 * @param {{ file: string, ffmpeg?: string, onStatus?: (status: object) => void }} options
 *   file — JSON file the cameras are saved in; ffmpeg — path to use instead of finding one;
 *   onStatus — called whenever a camera connects, drops or gains a viewer
 */
function createCctv({ file, ffmpeg, onStatus = () => {} }) {
  const ffmpegPath = findFfmpeg(ffmpeg);
  const version = ffmpegVersion(ffmpegPath);
  const env = { ffmpeg: ffmpegPath, onStatus, timeoutFlag: version && version.major < 5 ? '-stimeout' : '-timeout' };
  const hubs = new Map();
  let cams = load();

  function load() {
    try {
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(list) ? list.filter((c) => c && c.id && c.url) : [];
    } catch (_) {
      return [];
    }
  }

  function persist() {
    fs.writeFileSync(file, JSON.stringify(cams, null, 2), { mode: 0o600 });
  }

  function find(id) {
    return cams.find((c) => c.id === id) || null;
  }

  function view(cam) {
    const hub = hubs.get(cam.id);
    const status = hub ? Object.assign({}, hub.status) : { id: cam.id, state: 'idle', message: '', hint: '', width: 0, height: 0, viewers: 0 };
    return { id: cam.id, name: cam.name, url: maskUrl(cam.url), fps: cam.fps, status };
  }

  return {
    version,
    ffmpegPath,

    list() {
      return cams.map(view);
    },

    /** Adds a camera (id null) or changes one; returns it with the password masked. */
    save(id, body = {}) {
      const existing = id ? find(id) : null;
      if (id && !existing) throw fail(404, 'Camera not found.');
      const url = checkUrl(unmaskUrl(String(body.url || '').trim(), existing && existing.url));
      const name = String(body.name || '').trim().slice(0, 60) || hostOf(url) || 'CCTV camera';
      const fps = FPS_CHOICES.includes(Number(body.fps)) ? Number(body.fps) : DEFAULT_FPS;
      if (existing) {
        const reconnect = existing.url !== url || existing.fps !== fps;
        Object.assign(existing, { name, url, fps });
        persist();
        if (reconnect && hubs.has(id)) hubs.get(id).update(existing);
        return view(existing);
      }
      const cam = { id: 'cctv-' + crypto.randomBytes(4).toString('hex'), name, url, fps };
      cams.push(cam);
      persist();
      return view(cam);
    },

    remove(id) {
      const cam = find(id);
      if (!cam) return false;
      if (hubs.has(id)) {
        hubs.get(id).close();
        hubs.delete(id);
      }
      cams = cams.filter((c) => c !== cam);
      persist();
      return true;
    },

    /** GET /api/cctv/:id/stream.mjpg — joins the camera's live MJPEG stream. */
    stream(id, req, res) {
      const cam = find(id);
      if (!cam) return res.status(404).type('text/plain').send('Unknown camera');
      let hub = hubs.get(id);
      if (!hub) {
        hub = new Hub(cam, env);
        hubs.set(id, hub);
      }
      hub.join(req, res);
    },

    /** Checks a URL (or a saved camera with its password masked) by grabbing one frame. */
    async test(body = {}) {
      const existing = body.id ? find(String(body.id)) : null;
      const url = checkUrl(unmaskUrl(String(body.url || '').trim(), existing && existing.url));
      return grabFrame(env, url);
    },

    statuses() {
      return [...hubs.values()].map((h) => Object.assign({}, h.status));
    },

    shutdown() {
      for (const hub of hubs.values()) hub.stop();
    },
  };
}

module.exports = {
  createCctv,
  findFfmpeg,
  ffmpegVersion,
  maskUrl,
  maskText,
  unmaskUrl,
  checkUrl,
  createMjpegParser,
  jpegSize,
  FPS_CHOICES,
};
