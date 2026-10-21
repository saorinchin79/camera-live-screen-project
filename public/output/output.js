/**
 * Program output — shows the 1920x1080 program and follows the admin's layout in real time.
 * The admin's local camera arrives over WebRTC (signaling relayed by the server); a CCTV main screen
 * is an MJPEG stream from the server.
 */
import { createStage } from '/shared/stage.js';

const L = window.StreamLayout;
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const wrap = document.getElementById('stage-wrap');
const hint = document.getElementById('hint');
const statusEl = document.getElementById('status');

const stage = createStage(wrap, { interactive: false });
let layout = L.sanitizeLayout(L.DEFAULT_LAYOUT);
stage.render(layout);

// ---------- fit the 1920x1080 stage to the window ----------

function fit() {
  const scale = Math.min(window.innerWidth / L.OUTPUT_W, window.innerHeight / L.OUTPUT_H);
  stage.setScale(scale);
}
window.addEventListener('resize', fit);
fit();

// ---------- fullscreen + hint ----------

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}
document.addEventListener('dblclick', toggleFullscreen);
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  if (e.key === 'h' || e.key === 'H') hint.classList.toggle('hidden');
});

let hintTimer = setTimeout(() => hint.classList.add('hidden'), 8000);
let cursorTimer = null;
document.addEventListener('mousemove', () => {
  document.body.classList.add('show-cursor');
  hint.classList.remove('hidden');
  clearTimeout(hintTimer);
  clearTimeout(cursorTimer);
  hintTimer = setTimeout(() => hint.classList.add('hidden'), 4000);
  cursorTimer = setTimeout(() => document.body.classList.remove('show-cursor'), 3000);
});

// ---------- realtime layout ----------

const socket = io();
const peers = new Map(); // admin socket id -> RTCPeerConnection
let connectedBefore = false;

function setStatus(text) {
  statusEl.textContent = text;
}

socket.on('connect', () => {
  socket.emit('hello', { role: 'output', name: navigator.userAgent.slice(0, 40) });
  setStatus('Connected · waiting for layout');
  // back after a server restart: the CCTV stream connection died with it
  if (connectedBefore) stage.reloadStreams();
  connectedBefore = true;
});

socket.on('cctv:status', (status) => stage.setCctvStatus(status));

socket.on('disconnect', () => setStatus('Disconnected from server — reconnecting…'));

socket.on('layout', (next) => {
  layout = L.sanitizeLayout(next);
  stage.render(layout);
  setStatus(`Layout received · ${layout.layers.filter((l) => l.visible).length} overlay(s) on program`);
});

socket.on('camera:state', (state) => {
  stage.setCameraActive(state.active, state.label);
});

socket.on('admin:left', ({ id }) => {
  closePeer(id);
});

// ---------- WebRTC: receive the admin's camera ----------

socket.on('rtc:signal', async ({ from, data }) => {
  if (!data) return;
  try {
    if (data.sdp && data.sdp.type === 'offer') {
      closePeer(from);
      const pc = new RTCPeerConnection(RTC_CONFIG);
      const entry = { pc, pending: [] };
      peers.set(from, entry);

      pc.ontrack = (e) => {
        const stream = e.streams[0] || new MediaStream([e.track]);
        stage.setCameraStream(stream);
        setStatus('Camera stream connected');
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('rtc:signal', { to: from, data: { candidate: e.candidate } });
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
          if (peers.get(from)?.pc === pc) {
            stage.setCameraStream(null);
            setStatus('Camera stream ended');
          }
        }
      };

      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtc:signal', { to: from, data: { sdp: pc.localDescription } });
      for (const c of entry.pending) await pc.addIceCandidate(c).catch(() => {});
      entry.pending = [];
    } else if (data.candidate) {
      const entry = peers.get(from);
      if (!entry) return;
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate).catch(() => {});
      else entry.pending.push(data.candidate);
    } else if (data.bye) {
      closePeer(from);
    }
  } catch (err) {
    console.error('WebRTC error', err);
    setStatus('Camera connection error: ' + err.message);
  }
});

function closePeer(id) {
  const entry = peers.get(id);
  if (!entry) return;
  try { entry.pc.close(); } catch (_) { /* ignore */ }
  peers.delete(id);
  if (peers.size === 0) stage.setCameraStream(null);
}
