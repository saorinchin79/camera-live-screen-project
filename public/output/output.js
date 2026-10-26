/**
 * Program output — shows the 1920x1080 program and follows the admin's layout in real time.
 * The admin's live sources (local camera, USB devices, screen shares) arrive over WebRTC, one connection per
 * source (signaling relayed by the server); a CCTV main screen is an MJPEG stream from the server.
 */
import { createStage } from '/shared/stage.js';

const L = window.StreamLayout;
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

const wrap = document.getElementById('stage-wrap');
const hint = document.getElementById('hint');

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
const peers = new Map(); // `${admin socket id}|${source id}` -> { pc, pending, from, source }
let connectedBefore = false;

socket.on('connect', () => {
  socket.emit('hello', { role: 'output', name: navigator.userAgent.slice(0, 40) });
  // back after a server restart: the CCTV stream connection died with it
  if (connectedBefore) stage.reloadStreams();
  connectedBefore = true;
});

socket.on('cctv:status', (status) => stage.setCctvStatus(status));

socket.on('layout', (next) => {
  layout = L.sanitizeLayout(next);
  stage.render(layout);
});

socket.on('camera:state', (state) => {
  stage.setCameraActive(state.active, state.label);
});

socket.on('sources', (sources) => stage.setLiveSources(sources));

socket.on('admin:left', ({ id }) => {
  for (const entry of [...peers.values()]) {
    if (entry.from === id) closePeer(entry.from, entry.source);
  }
});

// ---------- WebRTC: receive the admin's live sources ----------

/** "camera" is the local camera; any other source id is a USB device or a screen share. */
function showSource(source, stream) {
  if (source === 'camera') stage.setCameraStream(stream);
  else stage.setSourceStream(source, stream);
}

socket.on('rtc:signal', async ({ from, data }) => {
  if (!data) return;
  const source = data.source || 'camera';
  const key = `${from}|${source}`;
  try {
    if (data.sdp && data.sdp.type === 'offer') {
      closePeer(from, source);
      const pc = new RTCPeerConnection(RTC_CONFIG);
      const entry = { pc, pending: [], from, source };
      peers.set(key, entry);

      pc.ontrack = (e) => showSource(source, e.streams[0] || new MediaStream([e.track]));
      pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('rtc:signal', { to: from, data: { source, candidate: e.candidate } });
      };
      pc.onconnectionstatechange = () => {
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
          if (peers.get(key)?.pc === pc) showSource(source, null);
        }
      };

      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('rtc:signal', { to: from, data: { source, sdp: pc.localDescription } });
      for (const c of entry.pending) await pc.addIceCandidate(c).catch(() => {});
      entry.pending = [];
    } else if (data.candidate) {
      const entry = peers.get(key);
      if (!entry) return;
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(data.candidate).catch(() => {});
      else entry.pending.push(data.candidate);
    } else if (data.bye) {
      closePeer(from, source);
    }
  } catch (err) {
    console.error('WebRTC error', err);
  }
});

function closePeer(from, source) {
  const key = `${from}|${source}`;
  const entry = peers.get(key);
  if (!entry) return;
  try { entry.pc.close(); } catch (_) { /* ignore */ }
  peers.delete(key);
  // another admin window may still send the same source
  if (![...peers.values()].some((e) => e.source === source)) showSource(source, null);
}
