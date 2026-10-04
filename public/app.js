'use strict';
const $ = id => document.getElementById(id);
const ICE = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }] };
const MAX_BUFFER = 8 * 1024 * 1024, LOW_BUFFER = 1024 * 1024, CONN_TIMEOUT = 25000;

const E_CONN = 'Devices could not establish a direct connection. Please try again or use another network.';
const E_WS = 'Lost connection to the signaling service. Please check your internet and try again.';
const E_INT = 'The transfer was interrupted. Please try again.';
const E_EXP = 'This room has expired. Please create a new one.';
const E_TIME = 'Connection timed out. The devices could not reach each other in time. Please try again.';

let files = [], ws = null, pc = null, dc = null, role = null;
let pendingIce = [], finished = true, wake = null, ackAll = null, chunk = 65536, urls = [], connTimer = null, lastCode = '';
const rx = { files: [], cur: null, blobs: [] };
const tr = { bytes: 0, total: 0, lastB: 0, lastT: 0, speed: 0, lastUI: 0 };

const log = (...a) => console.error('[LiquidDrop]', ...a);
const msg = (id, t, kind) => { const el = $(id); el.textContent = t; el.className = 'msg' + (kind ? ' ' + kind : ''); };
const send = m => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
const safeName = n => String(n).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200) || 'file';

function fmt(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 2 : 1) : Math.round(n)) + ' ' + u[i];
}
function fmtTime(s) {
  if (!isFinite(s) || s < 0) return '—';
  if (s < 1) return '<1s';
  s = Math.ceil(s);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm';
}

/* ---------- screens & steps ---------- */
const STEPS = { s: ['Select', 'Code', 'Connect', 'Send', 'Done'], r: ['Code', 'Connect', 'Receive', 'Done'] };
function setStep(side, i) {
  const ol = $('steps');
  if (ol.dataset.side !== side) {
    ol.dataset.side = side;
    ol.replaceChildren(...STEPS[side].map(t => { const li = document.createElement('li'); li.textContent = t; return li; }));
  }
  Array.from(ol.children).forEach((li, k) => {
    li.className = k < i ? 'done' : k === i ? 'now' : '';
    if (k === i) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
}
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  $('steps').hidden = !['send', 'room', 'join', 'transfer'].includes(id);
  if (id === 'join') { msg('joinMsg', ''); $('connectBtn').disabled = false; }
  if (id === 'send') { msg('sendMsg', ''); $('createRoom').disabled = false; }
  window.scrollTo(0, 0);
  const h = document.querySelector('#' + id + ' h1, #' + id + ' h2');
  if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
}
function setState(text, kind) {
  const el = $('tState');
  el.textContent = text; el.className = 'state' + (kind ? ' ' + kind : '');
  $('tCard').classList.toggle('live', kind === 'run');
}
function resetTransferUI() {
  $('done').hidden = true; $('downloads').replaceChildren();
  $('tBar').style.transform = 'scaleX(0)'; $('tBarWrap').setAttribute('aria-valuenow', '0');
  $('tPct').textContent = '0%'; $('tName').textContent = '—';
  $('tSize').textContent = '0 B / 0 B'; $('tSpeed').textContent = '0 B/s';
  $('tEta').textContent = 'ETA —'; $('tFileNo').textContent = 'File 1 of 1';
  setState('Connecting', '');
}

function teardown() {
  finished = true;
  clearTimeout(connTimer); connTimer = null;
  try { if (ws) { ws.onclose = null; ws.close(); } } catch {}
  try { if (dc) dc.close(); } catch {}
  try { if (pc) pc.close(); } catch {}
  try { if (wake) wake.release(); } catch {}
  ws = pc = dc = wake = null; pendingIce = []; ackAll = null;
  urls.forEach(u => URL.revokeObjectURL(u)); urls = [];
  rx.files = []; rx.cur = null; rx.blobs = [];
}
function fail(text, cause) {
  if (finished) return;
  if (cause) log(cause);
  teardown();
  $('errMsg').textContent = text;
  show('error');
}
function goHome() {
  teardown();
  files = []; $('fileInput').value = ''; renderFiles();
  lastCode = ''; $('codeInput').value = ''; renderOtp();
  resetTransferUI();
  show('home');
}
function startConnTimer() {
  clearTimeout(connTimer);
  connTimer = setTimeout(() => fail(E_TIME, 'connection timeout'), CONN_TIMEOUT);
}

function supported() { return !!(window.RTCPeerConnection && window.WebSocket); }
function needSupport() {
  if (supported()) return true;
  finished = false;
  $('errMsg').textContent = "This browser doesn't support WebRTC. Please use a recent Chrome, Edge, Firefox or Safari.";
  finished = true; show('error');
  return false;
}

/* ---------- SDP compatibility ---------- */
// Removes "a=extmap-allow-mixed" (and malformed a=extmap lines with <2 fields)
// that some older / TV browsers cannot parse. Everything else is untouched.
function cleanSDP(d) {
  if (!d || typeof d.sdp !== 'string') return d;
  const lines = d.sdp.split(/\r?\n/).filter(l => {
    const t = l.trim();
    if (!t) return true;
    if (/^a=extmap-allow-mixed/i.test(t)) return false;
    if (/^a=extmap:\S*$/i.test(t)) return false;
    return true;
  });
  const sdp = lines.filter((l, i) => l.trim() || i === lines.length - 1).join('\r\n');
  return { type: d.type, sdp };
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
    } catch (e) { log(e); return reject('ws'); }
    ws = sock;
    sock.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!m || typeof m !== 'object') return;
      if (m.type === 'ok') return done(resolve);
      if (m.type === 'error' && !settled) return done(reject, m.code);
      onSignal(m);
    };
    sock.onerror = () => done(reject, 'ws');
    sock.onclose = ev => {
      if (!settled) return done(reject, 'ws');
      const expired = /expired/i.test((ev && ev.reason) || '');
      setTimeout(() => {
        if (!finished && (!dc || dc.readyState !== 'open')) fail(expired ? E_EXP : E_WS, 'signaling closed: ' + (ev && ev.code) + ' ' + (ev && ev.reason));
      }, expired ? 0 : 3000);
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
    if (s === 'failed') fail(E_CONN, 'peer connection failed');
  };
}
async function flushIce() {
  for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch {} }
  pendingIce = [];
}
async function onSignal(m) {
  try {
    if (m.type === 'peer-joined' && role === 'sender') {
      $('room').dataset.state = 'linked';
      msg('roomStatus', '🟢 Device Connected — starting transfer...');
      setStep('s', 2); startConnTimer();
      makePC();
      setupDC(pc.createDataChannel('file', { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      send({ type: 'offer', sdp: cleanSDP(pc.localDescription) });
    } else if (m.type === 'offer' && role === 'receiver') {
      makePC();
      pc.ondatachannel = e => setupDC(e.channel);
      await pc.setRemoteDescription(cleanSDP(m.sdp));
      await flushIce();
      await pc.setLocalDescription(await pc.createAnswer());
      send({ type: 'answer', sdp: cleanSDP(pc.localDescription) });
    } else if (m.type === 'answer' && role === 'sender') {
      await pc.setRemoteDescription(cleanSDP(m.sdp));
      await flushIce();
    } else if (m.type === 'ice') {
      if (pc && pc.remoteDescription) { try { await pc.addIceCandidate(m.candidate); } catch {} }
      else pendingIce.push(m.candidate);
    } else if (m.type === 'peer-left') {
      if (dc && dc.readyState === 'open') return;
      if (role === 'sender') {
        clearTimeout(connTimer);
        $('room').dataset.state = 'wait';
        msg('roomStatus', '🟢 Waiting for the other device...');
        setStep('s', 1);
        if (pc) { try { pc.close(); } catch {} pc = null; }
      } else fail('The sender left the room. Please ask them to create a new one.', 'peer-left');
    }
  } catch (err) {
    fail(E_CONN, err);
  }
}

/* ---------- data channel ---------- */
function setupDC(ch) {
  dc = ch; ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = LOW_BUFFER;
  ch.onopen = () => {
    clearTimeout(connTimer);
    closeSignaling();
    resetTransferUI();
    show('transfer');
    if (role === 'sender') { setStep('s', 3); startSend(); }
    else {
      setStep('r', 2);
      $('tTitle').textContent = 'Receiving';
      $('tName').textContent = 'Waiting for sender…';
      setState('Connected', 'ok');
    }
  };
  ch.onclose = () => fail(E_INT, 'data channel closed');
  ch.onerror = e => fail(E_INT, e);
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
    const inst = (tr.bytes - tr.lastB) / ((now - tr.lastT) / 1000);
    tr.speed = tr.speed ? tr.speed * 0.6 + inst * 0.4 : inst;
    tr.lastT = now; tr.lastB = tr.bytes;
  }
  const p = total ? Math.min(100, Math.floor(done / total * 100)) : 100;
  $('tName').textContent = name;
  $('tBar').style.transform = 'scaleX(' + (p / 100) + ')';
  $('tBarWrap').setAttribute('aria-valuenow', String(p));
  $('tPct').textContent = p + '%';
  $('tSize').textContent = fmt(done) + ' / ' + fmt(total);
  $('tSpeed').textContent = fmt(tr.speed) + '/s';
  $('tFileNo').textContent = `File ${idx + 1} of ${n}`;
  $('tEta').textContent = 'ETA ' + (tr.speed > 0 ? fmtTime((tr.total - tr.bytes) / tr.speed) : '—');
}
function resetStats() { tr.bytes = 0; tr.lastB = 0; tr.speed = 0; tr.lastT = performance.now(); tr.lastUI = 0; }
function showDone(title, sub) {
  $('okText').textContent = '✓ ' + title;
  $('okSub').textContent = sub;
  $('tEta').textContent = 'ETA —';
  setState('Completed', 'ok');
  $('done').hidden = false;
}

async function startSend() {
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch {}
  $('tTitle').textContent = 'Sending';
  setState('Sending', 'run');
  const m = pc.sctp && pc.sctp.maxMessageSize;
  chunk = Math.min(256 * 1024, m > 0 ? m : 65536);
  resetStats();
  tr.total = files.reduce((a, f) => a + f.size, 0);
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
    setStep('s', 9);
    $('tTitle').textContent = 'Sent';
    showDone('Transfer Complete', n > 1 ? `${n} files sent successfully` : 'File sent successfully');
  } catch (err) {
    fail(E_INT, err);
  }
}

function onData(e) {
  if (typeof e.data === 'string') {
    let m; try { m = JSON.parse(e.data); } catch (err) { return fail(E_INT, err); }
    if (!m || typeof m !== 'object') return;
    if (role === 'sender') {
      if (m.t === 'ack' && m.i === files.length - 1 && ackAll) ackAll();
      return;
    }
    if (m.t === 'meta') {
      if (!Array.isArray(m.files) || !m.files.length || !m.files.every(f => f && typeof f.name === 'string' && Number.isFinite(f.size) && f.size >= 0)) return fail(E_INT, 'invalid meta');
      rx.files = m.files; rx.blobs = []; resetStats();
      tr.total = m.files.reduce((a, f) => a + f.size, 0);
    } else if (m.t === 'start') {
      const f = rx.files[m.i]; if (!f) return;
      rx.cur = { i: m.i, parts: [], got: 0 };
      setState('Receiving', 'run');
      ui(f.name, 0, f.size, m.i, rx.files.length, true);
    } else if (m.t === 'end') {
      const f = rx.files[m.i], c = rx.cur;
      if (!f || !c || c.i !== m.i || c.got !== f.size) return fail(E_INT, 'incomplete file');
      rx.blobs[m.i] = new Blob(c.parts, { type: f.type || 'application/octet-stream' });
      rx.cur = null;
      ui(f.name, f.size, f.size, m.i, rx.files.length, true);
      dc.send(JSON.stringify({ t: 'ack', i: m.i }));
      if (m.i === rx.files.length - 1) completeReceive();
    }
  } else if (role === 'receiver' && rx.cur) {
    const c = rx.cur, f = rx.files[c.i];
    c.parts.push(e.data); c.got += e.data.byteLength; tr.bytes += e.data.byteLength;
    if (c.got > f.size) return fail(E_INT, 'too much data');
    ui(f.name, c.got, f.size, c.i, rx.files.length, false);
  }
}

function completeReceive() {
  finished = true;
  setStep('r', 9);
  const box = $('downloads'); box.replaceChildren();
  rx.blobs.forEach((b, i) => {
    const u = URL.createObjectURL(b); urls.push(u);
    const a = document.createElement('a');
    a.className = 'btn primary'; a.href = u; a.download = safeName(rx.files[i].name);
    a.textContent = '⬇ Download ' + rx.files[i].name + ' (' + fmt(b.size) + ')';
    box.appendChild(a);
  });
  showDone('Transfer Complete', rx.blobs.length > 1 ? `${rx.blobs.length} files are ready to download` : 'Your file is ready to download');
}

/* ---------- send screen ---------- */
function icon(f) {
  const t = f.type || '', n = f.name.toLowerCase();
  if (t.startsWith('image/')) return '🖼️';
  if (t.startsWith('video/')) return '🎬';
  if (t.startsWith('audio/')) return '🎵';
  if (t === 'application/pdf') return '📕';
  if (/\.(zip|rar|7z|tar|gz)$/.test(n)) return '🗜️';
  if (t.startsWith('text/')) return '📝';
  return '📄';
}
function renderFiles() {
  const ul = $('fileList'); ul.replaceChildren();
  files.forEach((f, i) => {
    const li = document.createElement('li'); li.style.setProperty('--i', i);
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = icon(f); ic.setAttribute('aria-hidden', 'true');
    const info = document.createElement('div'); info.className = 'info';
    const nm = document.createElement('div'); nm.textContent = f.name; nm.title = f.name;
    const mt = document.createElement('div'); mt.className = 'meta'; mt.textContent = fmt(f.size) + ' · ' + (f.type || 'file');
    info.append(nm, mt);
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'rm'; rm.textContent = '✕'; rm.setAttribute('aria-label', 'Remove ' + f.name);
    rm.onclick = () => { files.splice(i, 1); renderFiles(); };
    li.append(ic, info, rm); ul.appendChild(li);
  });
  ul.hidden = !files.length;
  const sum = $('fileSum');
  sum.hidden = !files.length;
  sum.textContent = `${files.length} file${files.length > 1 ? 's' : ''} · ${fmt(files.reduce((a, f) => a + f.size, 0))}`;
  $('dropLabel').classList.toggle('compact', files.length > 0);
  $('dropText').textContent = files.length ? 'Change or add files' : 'Tap to choose files';
}
function rand6() {
  const a = new Uint32Array(1); crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}
function renderCode(code) {
  const el = $('code'); el.replaceChildren();
  el.setAttribute('aria-label', 'Room code ' + code.split('').join(' '));
  code.split('').forEach((d, i) => {
    const s = document.createElement('span'); s.textContent = d; s.style.setProperty('--i', i);
    s.setAttribute('aria-hidden', 'true'); el.appendChild(s);
  });
}

/* ---------- join screen (segmented input) ---------- */
const inp = $('codeInput'), boxes = Array.from(document.querySelectorAll('#otp b'));
function renderOtp() {
  const v = inp.value, focused = document.activeElement === inp;
  boxes.forEach((b, i) => {
    const had = b.textContent;
    b.textContent = v[i] || '';
    b.classList.toggle('fill', !!v[i]);
    b.classList.toggle('on', focused && i === Math.min(v.length, 5));
    if (v[i] && had !== v[i]) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  });
}
function caretEnd() { try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch {} }
inp.addEventListener('input', () => { inp.value = inp.value.replace(/\D/g, '').slice(0, 6); renderOtp(); });
inp.addEventListener('focus', () => { caretEnd(); renderOtp(); });
inp.addEventListener('blur', renderOtp);
inp.addEventListener('click', caretEnd);
inp.addEventListener('keydown', e => { if (e.key === 'Enter') $('connectBtn').click(); });
function shakeOtp() { const o = $('otp'); o.classList.remove('shake'); void o.offsetWidth; o.classList.add('shake'); }

/* ---------- wiring ---------- */
$('goSend').onclick = () => { if (needSupport()) { setStep('s', 0); show('send'); } };
$('goJoin').onclick = () => { if (needSupport()) { setStep('r', 0); show('join'); inp.focus(); } };
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', goHome));

$('fileInput').onchange = e => {
  files = Array.from(e.target.files || []);
  e.target.value = '';
  renderFiles(); msg('sendMsg', '');
};
const dz = $('dropLabel');
['dragenter', 'dragover'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => dz.addEventListener(t, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => {
  const list = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (list.length) { files = list; renderFiles(); msg('sendMsg', ''); }
});

$('createRoom').onclick = async () => {
  if (!files.length) return msg('sendMsg', 'Please select at least one file first.', 'err');
  msg('sendMsg', 'Creating room…', 'busy');
  $('createRoom').disabled = true;
  for (let i = 0; i < 6; i++) {
    const code = rand6();
    try {
      await connect('sender', code);
      lastCode = code;
      renderCode(code);
      $('room').dataset.state = 'wait';
      msg('roomStatus', '🟢 Waiting for the other device...');
      setStep('s', 1);
      show('room');
      return;
    } catch (e) {
      if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
      if (e !== 'taken') {
        finished = true; $('createRoom').disabled = false;
        return msg('sendMsg', 'Could not reach the signaling service. Check your internet and try again.', 'err');
      }
    }
  }
  finished = true; $('createRoom').disabled = false;
  msg('sendMsg', 'Could not create a room. Please try again.', 'err');
};

$('copyBtn').onclick = async () => {
  const btn = $('copyBtn');
  try { await navigator.clipboard.writeText(lastCode); btn.textContent = 'Copied ✓'; }
  catch { btn.textContent = 'Select the code to copy'; }
  setTimeout(() => { btn.textContent = 'Copy Code'; }, 1800);
};

$('connectBtn').onclick = async () => {
  const code = inp.value.trim();
  if (!/^\d{6}$/.test(code)) { shakeOtp(); return msg('joinMsg', 'Invalid room code. Enter all 6 digits.', 'err'); }
  lastCode = code;
  $('connectBtn').disabled = true;
  msg('joinMsg', 'Connecting…', 'busy');
  try {
    await connect('receiver', code);
    setStep('r', 1);
    msg('joinMsg', 'Connected — creating direct link…', 'busy');
    startConnTimer();
  } catch (e) {
    finished = true;
    if (ws) { ws.onclose = null; try { ws.close(); } catch {} ws = null; }
    $('connectBtn').disabled = false;
    shakeOtp();
    msg('joinMsg', e === 'not_found' ? 'Room not found or expired. Check the code and try again.'
      : e === 'full' ? 'This room already has two devices.'
      : 'Could not reach the signaling service. Check your internet and try again.', 'err');
  }
};

$('retryBtn').onclick = () => {
  teardown();
  if (role === 'receiver') { setStep('r', 0); show('join'); inp.value = lastCode; renderOtp(); }
  else if (files.length) { setStep('s', 0); show('send'); }
  else goHome();
};

renderFiles(); renderOtp();
