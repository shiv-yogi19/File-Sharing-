'use strict';
const $ = id => document.getElementById(id);
const ICE = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }] };
const MAX_BUFFER = 8 * 1024 * 1024, LOW_BUFFER = 1024 * 1024;

let files = [], ws = null, pc = null, dc = null, role = null;
let pendingIce = [], finished = true, wake = null, ackAll = null, chunk = 65536, urls = [];
const rx = { files: [], cur: null, blobs: [] };
const tr = { bytes: 0, lastB: 0, lastT: 0, speed: 0, lastUI: 0 };

const show = id => document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
const msg = (id, t) => { $(id).textContent = t; };
const send = m => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const safeName = n => String(n).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'file';

function fmt(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : n) + ' ' + u[i];
}

function teardown() {
  finished = true;
  try { if (ws) { ws.onclose = null; ws.close(); } } catch {}
  try { if (dc) dc.close(); } catch {}
  try { if (pc) pc.close(); } catch {}
  try { if (wake) wake.release(); } catch {}
  ws = pc = dc = wake = null; pendingIce = []; ackAll = null;
  urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
  rx.files = []; rx.cur = null; rx.blobs = [];
}
function fail(text) {
  if (finished) return;
  teardown();
  msg('errMsg', text);
  show('error');
}
function goHome() {
  teardown();
  files = []; $('fileInput').value = ''; renderFiles();
  msg('sendMsg', ''); msg('joinMsg', ''); $('codeInput').value = '';
  $('done').hidden = true; $('downloads').replaceChildren();
  show('home');
}

function supported() {
  return !!(window.RTCPeerConnection && window.WebSocket);
}
function needSupport() {
  if (supported()) return true;
  msg('errMsg', "This browser doesn't support WebRTC. Please use a recent Chrome, Edge, Firefox or Safari.");
  show('error');
  return false;
}

/* ---------- signaling ---------- */
function connect(r, code) {
  return new Promise((resolve, reject) => {
    role = r; finished = false;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    let sock;
    try {
      sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?code=${code}&role=${r}`);
    } catch { return reject('ws'); }
    ws = sock;
    sock.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'ok') return done(resolve);
      if (m.type === 'error' && !settled) return done(reject, m.code);
      onSignal(m);
    };
    sock.onerror = () => done(reject, 'ws');
    sock.onclose = () => {
      if (!settled) return done(reject, 'ws');
      setTimeout(() => {
        if (!finished && (!dc || dc.readyState !== 'open')) fail('WebSocket disconnected. Please check your internet and try again.');
      }, 3000);
    };
  });
}
function closeSignaling() {
  if (ws) { ws.onclose = null; try { ws.close(1000); } catch {} ws = null; }
}

function makePC() {
  if (pc) { try { pc.close(); } catch {} }
  pendingIce = [];
  pc = new RTCPeerConnection(ICE);
  pc.onicecandidate = e => { if (e.candidate) send({ type: 'ice', candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    $('tConn').textContent = s.charAt(0).toUpperCase() + s.slice(1);
    if (s === 'failed') fail('Connection failed. A direct link could not be created (a strict network or firewall may be blocking it). Try another network.');
  };
}
async function flushIce() {
  for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
  pendingIce = [];
}
async function onSignal(m) {
  try {
    if (m.type === 'peer-joined' && role === 'sender') {
      msg('roomStatus', '🟢 Device Connected — starting transfer...');
      makePC();
      setupDC(pc.createDataChannel('file', { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      send({ type: 'offer', sdp: pc.localDescription });
    } else if (m.type === 'offer' && role === 'receiver') {
      makePC();
      pc.ondatachannel = e => setupDC(e.channel);
      await pc.setRemoteDescription(m.sdp);
      await flushIce();
      await pc.setLocalDescription(await pc.createAnswer());
      send({ type: 'answer', sdp: pc.localDescription });
    } else if (m.type === 'answer' && role === 'sender') {
      await pc.setRemoteDescription(m.sdp);
      await flushIce();
    } else if (m.type === 'ice') {
      if (pc && pc.remoteDescription) { try { await pc.addIceCandidate(m.candidate); } catch {} }
      else pendingIce.push(m.candidate);
    } else if (m.type === 'peer-left') {
      if (dc && dc.readyState === 'open') return;
      if (role === 'sender') {
        msg('roomStatus', '🟢 Waiting for the other device...');
        if (pc) { try { pc.close(); } catch {} pc = null; }
      } else fail('Connection lost. The sender left the room.');
    }
  } catch (err) {
    fail('Connection failed. ' + (err && err.message ? err.message : ''));
  }
}

/* ---------- data channel ---------- */
function setupDC(ch) {
  dc = ch; ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = LOW_BUFFER;
  ch.onopen = () => {
    closeSignaling();
    $('tConn').textContent = 'Connected';
    $('done').hidden = true;
    show('transfer');
    if (role === 'sender') startSend();
    else { $('tTitle').textContent = 'Receiving'; $('tName').textContent = 'Waiting for sender…'; }
  };
  ch.onclose = () => fail('File transfer interrupted. The connection was closed.');
  ch.onerror = () => fail('File transfer interrupted.');
  ch.onmessage = onData;
}

function drain(ch) {
  return new Promise(res => {
    const h = () => { ch.removeEventListener('bufferedamountlow', h); ch.removeEventListener('close', h); res(); };
    ch.addEventListener('bufferedamountlow', h);
    ch.addEventListener('close', h);
  });
}

function ui(name, done, total, idx, n, force) {
  const now = performance.now();
  if (!force && now - tr.lastUI < 100) return;
  tr.lastUI = now;
  if (now - tr.lastT >= 500) {
    tr.speed = (tr.bytes - tr.lastB) / ((now - tr.lastT) / 1000);
    tr.lastT = now; tr.lastB = tr.bytes;
  }
  const p = total ? Math.min(100, Math.floor(done / total * 100)) : 100;
  $('tName').textContent = name;
  $('tBar').style.width = p + '%';
  $('tPct').textContent = p + '%';
  $('tSize').textContent = fmt(done) + ' / ' + fmt(total);
  $('tSpeed').textContent = fmt(tr.speed) + '/s';
  $('tFileNo').textContent = `File ${idx + 1} of ${n}`;
}
function resetStats() { tr.bytes = 0; tr.lastB = 0; tr.speed = 0; tr.lastT = performance.now(); tr.lastUI = 0; }

async function startSend() {
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch {}
  $('tTitle').textContent = 'Sending';
  const m = pc.sctp && pc.sctp.maxMessageSize;
  chunk = Math.min(256 * 1024, m > 0 ? m : 65536);
  resetStats();
  const ch = dc, n = files.length;
  try {
    const allAck = new Promise(r => { ackAll = r; });
    ch.send(JSON.stringify({ t: 'meta', files: files.map(f => ({ name: f.name, size: f.size, type: f.type })) }));
    for (let i = 0; i < n; i++) {
      const f = files[i];
      ch.send(JSON.stringify({ t: 'start', i }));
      let sent = 0;
      ui(f.name, 0, f.size, i, n, true);
      while (sent < f.size) {
        if (ch.readyState !== 'open') throw new Error('closed');
        if (ch.bufferedAmount > MAX_BUFFER) await drain(ch);
        if (ch.readyState !== 'open') throw new Error('closed');
        const buf = await f.slice(sent, sent + chunk).arrayBuffer();
        ch.send(buf);
        sent += buf.byteLength; tr.bytes += buf.byteLength;
        ui(f.name, sent, f.size, i, n, false);
      }
      ui(f.name, f.size, f.size, i, n, true);
      ch.send(JSON.stringify({ t: 'end', i }));
    }
    await allAck;
    finished = true;
    try { if (wake) wake.release(); } catch {}
    $('tPct').textContent = '100%';
    $('done').hidden = false;
    $('downloads').replaceChildren();
    $('tTitle').textContent = 'Sent';
  } catch {
    fail('File transfer interrupted. Please try again.');
  }
}

function onData(e) {
  if (typeof e.data === 'string') {
    let m; try { m = JSON.parse(e.data); } catch { return fail('Received invalid data.'); }
    if (role === 'sender') {
      if (m.t === 'ack' && m.i === files.length - 1 && ackAll) ackAll();
      return;
    }
    if (m.t === 'meta') {
      if (!Array.isArray(m.files) || !m.files.every(f => f && typeof f.name === 'string' && Number.isFinite(f.size) && f.size >= 0)) return fail('Received invalid file information.');
      rx.files = m.files; rx.blobs = []; resetStats();
    } else if (m.t === 'start') {
      const f = rx.files[m.i]; if (!f) return;
      rx.cur = { i: m.i, parts: [], got: 0 };
      ui(f.name, 0, f.size, m.i, rx.files.length, true);
    } else if (m.t === 'end') {
      const f = rx.files[m.i], c = rx.cur;
      if (!f || !c || c.i !== m.i || c.got !== f.size) return fail('File transfer interrupted. The file arrived incomplete.');
      rx.blobs[m.i] = new Blob(c.parts, { type: f.type || 'application/octet-stream' });
      rx.cur = null;
      ui(f.name, f.size, f.size, m.i, rx.files.length, true);
      dc.send(JSON.stringify({ t: 'ack', i: m.i }));
      if (m.i === rx.files.length - 1) completeReceive();
    }
  } else if (role === 'receiver' && rx.cur) {
    const c = rx.cur, f = rx.files[c.i];
    c.parts.push(e.data); c.got += e.data.byteLength; tr.bytes += e.data.byteLength;
    if (c.got > f.size) return fail('File transfer interrupted. Received more data than expected.');
    ui(f.name, c.got, f.size, c.i, rx.files.length, false);
  }
}

function completeReceive() {
  finished = true;
  $('tTitle').textContent = 'Receiving';
  const box = $('downloads'); box.replaceChildren();
  rx.blobs.forEach((b, i) => {
    const u = URL.createObjectURL(b); urls.push(u);
    const a = document.createElement('a');
    a.className = 'btn primary'; a.href = u; a.download = safeName(rx.files[i].name);
    a.textContent = '⬇ Download ' + rx.files[i].name + ' (' + fmt(b.size) + ')';
    box.appendChild(a);
  });
  $('done').hidden = false;
}

/* ---------- UI wiring ---------- */
function renderFiles() {
  const ul = $('fileList'); ul.replaceChildren();
  files.forEach(f => {
    const li = document.createElement('li');
    const a = document.createElement('span'), b = document.createElement('span');
    a.textContent = '📄 ' + f.name; b.textContent = fmt(f.size);
    li.append(a, b); ul.appendChild(li);
  });
  ul.hidden = files.length === 0;
}
function rand6() {
  const a = new Uint32Array(1); crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}

$('goSend').onclick = () => { if (needSupport()) show('send'); };
$('goJoin').onclick = () => { if (needSupport()) show('join'); };
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', goHome));

$('fileInput').onchange = e => {
  files = Array.from(e.target.files || []);
  renderFiles(); msg('sendMsg', '');
};

$('createRoom').onclick = async () => {
  if (!files.length) return msg('sendMsg', 'Please select at least one file first.');
  msg('sendMsg', '');
  for (let i = 0; i < 6; i++) {
    const code = rand6();
    try {
      await connect('sender', code);
      $('code').textContent = code;
      msg('roomStatus', '🟢 Waiting for the other device...');
      show('room');
      return;
    } catch (e) {
      if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
      if (e !== 'taken') { finished = true; return msg('sendMsg', 'WebSocket disconnected. Check your internet and try again.'); }
    }
  }
  finished = true;
  msg('sendMsg', 'Could not create a room. Please try again.');
};

$('copyBtn').onclick = async () => {
  const code = $('code').textContent;
  try { await navigator.clipboard.writeText(code); $('copyBtn').textContent = 'Copied ✓'; }
  catch { $('copyBtn').textContent = 'Long-press the code to copy'; }
  setTimeout(() => { $('copyBtn').textContent = 'Copy Code'; }, 1800);
};

$('codeInput').oninput = e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); };
$('connectBtn').onclick = async () => {
  const code = $('codeInput').value.trim();
  if (!/^\d{6}$/.test(code)) return msg('joinMsg', 'Invalid room code. Enter all 6 digits.');
  msg('joinMsg', 'Connecting…');
  try {
    await connect('receiver', code);
    msg('joinMsg', '🟢 Connected to room. Creating direct link…');
  } catch (e) {
    finished = true;
    if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
    msg('joinMsg', e === 'not_found' ? 'Room not found. Check the code and try again.'
      : e === 'full' ? 'This room already has two devices.'
      : 'WebSocket disconnected. Check your internet and try again.');
  }
};
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('connectBtn').click(); });
