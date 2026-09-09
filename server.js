const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns');
const dgram = require('dgram');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Turn = require('node-turn');

/* ================================================================== *
 *  1. CONFIG
 * ================================================================== */

const PORT = process.env.PORT || 8080;
const SOUND_DIR = path.join(__dirname, 'sounds');
const SOUND_FILES = ['call.mp3', 'join.mp3', 'leave.mp3'];

/* 1.1 ICE. Audio goes machine to machine. STUN finds the path between two
   home routers; a TURN relay is needed where it cannot (school or mobile
   networks behind symmetric NAT). The server runs its own relay with
   node-turn on the public IP it learns at boot (one STUN question, the same
   kind every call asks), or on TURN_HOST if set. The only setup is on the
   router: forward UDP TURN_PORT and UDP RELAY_PORTS to this machine. Google's
   STUN stays in the list as a fallback for the direct path. */

const TURN_PORT = Number(process.env.TURN_PORT) || 3478;
const TURN_USER = 'dialer';
const TURN_PASS = process.env.TURN_PASS || crypto.randomBytes(12).toString('hex');  // handed to clients on register
const RELAY_PORTS = [49160, 49200];
const RECHECK_MS = 30 * 60 * 1000;            // home connections change public IP now and then

let turnHost = process.env.TURN_HOST || '';   // public hostname or IP; found by STUN when not set
let turn = null;                              // the running relay

const iceServers = () => (turnHost
  ? [{ urls: `stun:${turnHost}:${TURN_PORT}` },
     { urls: `turn:${turnHost}:${TURN_PORT}?transport=udp`, username: TURN_USER, credential: TURN_PASS }]
  : []).concat([{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]);

/* One STUN binding request: the reply carries the address the internet sees us from. */
function detectPublicIp(cb) {
  const s = dgram.createSocket('udp4');
  const req = Buffer.alloc(20);
  req.writeUInt16BE(0x0001, 0);               // binding request, no attributes
  req.writeUInt32BE(0x2112A442, 4);           // magic cookie
  crypto.randomFillSync(req, 8, 12);          // transaction id
  let finished = false;
  const done = (ip) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    s.close();
    cb(ip);
  };
  const timer = setTimeout(() => done(null), 3000);
  s.on('error', () => done(null));
  s.on('message', (m) => {
    let i = 20;
    while (i + 4 <= m.length) {
      const type = m.readUInt16BE(i), len = m.readUInt16BE(i + 2);
      // XOR-MAPPED-ADDRESS (0x0020) is masked with the magic cookie; MAPPED-ADDRESS (0x0001) is plain
      if ((type === 0x0020 || type === 0x0001) && len >= 8 && i + 12 <= m.length && m[i + 5] === 0x01) {
        const x = type === 0x0020 ? [0x21, 0x12, 0xA4, 0x42] : [0, 0, 0, 0];
        done([m[i + 8] ^ x[0], m[i + 9] ^ x[1], m[i + 10] ^ x[2], m[i + 11] ^ x[3]].join('.'));
        return;
      }
      i += 4 + ((len + 3) & ~3);
    }
    done(null);
  });
  s.send(req, 19302, 'stun.l.google.com', (err) => { if (err) done(null); });
}

/* node-turn reads externalIps on every allocation, so a new public IP only
   needs the field updated; pages get the new address list pushed to them. */
function watchPublicIp() {
  setInterval(() => detectPublicIp((ip) => {
    if (!ip || ip === turnHost) return;
    console.log(`  public IP changed: ${turnHost} -> ${ip}`);
    turnHost = ip;
    if (turn) turn.externalIps = ip;
    io.emit('ice', { type: 'ice', iceServers: iceServers() });
  }), RECHECK_MS).unref();
}

function startTurn(lanIps) {
  dns.lookup(turnHost, { family: 4 }, (err, publicIp) => {
    if (err) { console.log(`  TURN: cannot resolve ${turnHost} (${err.code}). Relay not started.`); return; }
    const opts = {
      listeningPort: TURN_PORT,
      listeningIps: ['0.0.0.0'],        // one socket, not one per interface
      externalIps: publicIp,            // relayed addresses must carry the public IP, not the LAN one
      minPort: RELAY_PORTS[0],
      maxPort: RELAY_PORTS[1],
      authMech: 'long-term',
      credentials: { [TURN_USER]: TURN_PASS },
      realm: 'dialer',
      debugLevel: 'ERROR'
    };
    if (lanIps.length) opts.relayIps = [lanIps[0]];   // the address the router forwards to

    // node-turn only logs a failed bind and carries on, so check the port first
    const probe = dgram.createSocket('udp4');
    probe.once('error', (e) => {
      console.log(`  TURN: cannot listen on UDP ${TURN_PORT} (${e.code}). Relay not started.`);
      console.log('');
    });
    probe.bind(TURN_PORT, () => probe.close(() => {
      turn = new Turn(opts);
      turn.start();
      console.log(`  TURN: turn:${turnHost}:${TURN_PORT}, relaying as ${publicIp}`);
      console.log(`  Forward UDP ${TURN_PORT} and UDP ${RELAY_PORTS[0]}-${RELAY_PORTS[1]} on the router to this machine.`);
      console.log('');
    }));
  });
}

/* ================================================================== *
 *  2. CLIENT STYLESHEET
 * ================================================================== */

const CSS = `
  /* One centered column. Everything above the log is a fixed size; the
     log absorbs the leftover height, so the page fits any window. */

  * { box-sizing: border-box; }

  html, body { height: 100%; }

  body {
    margin: 0;
    font: 15px/1.45 system-ui, sans-serif;
    color: #111;
    background: #fff;
    display: flex;
    justify-content: center;
  }

  main {
    width: 100%;
    max-width: 26rem;
    height: 100%;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: .75rem;
    overflow-y: auto;
  }

  h2 { font-size: .9rem; margin: 0 0 .5rem; }
  p  { margin: 0; }

  section { border: 1px solid #ccc; padding: .75rem; }

  /* identity */
  .me { display: flex; align-items: center; justify-content: space-between; gap: .75rem; }
  .num { font-size: 1.75rem; font-weight: 700; letter-spacing: .1em; line-height: 1.1; }
  .state { font-size: .8rem; color: #555; }
  .dot { display: inline-block; width: .5rem; height: .5rem; border-radius: 50%;
         background: #c00; margin-right: .35rem; }
  .dot.on { background: #0a0; }

  /* controls */
  input[type="text"] {
    width: 100%;
    font: inherit;
    font-size: 1rem;            /* under 16px makes iOS zoom the page when the box is tapped */
    padding: .5rem;
    margin-bottom: .5rem;
    text-align: center;
    letter-spacing: .15em;
    border: 1px solid #999;
  }

  button { font: inherit; padding: .5rem .75rem; cursor: pointer; }
  .go, .stop { width: 100%; font-weight: 600; }
  .link { font-size: .8rem; padding: .3rem .5rem; }

  .row { display: flex; gap: .5rem; }
  .row button { flex: 1; width: auto; }

  .center { text-align: center; }
  .hint { font-size: .8rem; color: #555; margin-bottom: .5rem; }
  #status { font-size: .8rem; color: #555; margin-top: .5rem; }

  /* people in the call */
  .peer { display: flex; align-items: center; gap: .5rem; padding: .35rem 0;
          border-bottom: 1px solid #eee; }
  .peer:last-child { border-bottom: none; }
  .peer-num { flex: 1; font-weight: 600; letter-spacing: .05em; }
  .peer-state { font-size: .75rem; color: #555; }
  .peer-state.live { color: #0a0; }
  .peer-state.muted { color: #a60; }

  /* contacts */
  #contacts { max-height: 9rem; overflow-y: auto; }
  .contact { display: flex; align-items: center; gap: .5rem; padding: .35rem 0;
             border-bottom: 1px solid #eee; }
  .contact:last-child { border-bottom: none; }
  .contact-num { flex: 1; font-weight: 600; letter-spacing: .05em; }
  .contact button { width: auto; font-size: .8rem; padding: .3rem .5rem; }
  .empty { font-size: .8rem; color: #555; }

  /* log takes the leftover height */
  .log { flex: 1 1 8rem; min-height: 7rem; display: flex; flex-direction: column; }
  #term {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    border: 1px solid #ccc;
    padding: .5rem;
    font-family: ui-monospace, "Courier New", monospace;
    font-size: .75rem;
    line-height: 1.5;
  }
  .err  { color: #c00; }
  .warn { color: #a60; }

  #streams { display: none; }
  .hidden { display: none; }
`;

/* ================================================================== *
 *  3. CLIENT MARKUP
 * ================================================================== */

const HTML = `
<main>

  <section>
    <div class="me">
      <div>
        <div class="state"><span class="dot" id="dot"></span><span id="linkState">connecting</span></div>
        <div class="num" id="myNumber">----</div>
      </div>
      <button type="button" class="link" onclick="changeNumber()">Change</button>
    </div>
  </section>

  <section id="setup" class="hidden">
    <h2>Before your first call</h2>
    <p class="hint" id="setupHint"></p>
    <div class="row">
      <button type="button" class="go hidden" id="soundBtn" onclick="enableSound()">Enable sound</button>
      <button type="button" class="go hidden" id="micBtn" onclick="allowMic()">Allow microphone</button>
    </div>
  </section>

  <section id="panelDial">
    <h2 id="dialTitle">Call someone</h2>
    <p class="hint">Enter the number shown on their screen.</p>
    <input type="text" id="dialInput" placeholder="1234" maxlength="8" autocomplete="off" inputmode="numeric">
    <button type="button" class="go" id="dialBtn" onclick="call()">Call</button>
    <p id="status">Ready</p>
  </section>

  <section id="panelOutgoing" class="center hidden">
    <h2>Calling</h2>
    <p class="num" id="outgoingNum">----</p>
    <p class="hint">&nbsp;</p>
    <button type="button" class="stop" onclick="cancelInvite()">Cancel</button>
  </section>

  <section id="panelIncoming" class="center hidden">
    <h2 id="incomingTitle">Incoming call</h2>
    <p class="num" id="incomingNum">----</p>
    <p class="hint">&nbsp;</p>
    <div class="row">
      <button type="button" class="go" onclick="answer()">Answer</button>
      <button type="button" class="stop" onclick="decline()">Decline</button>
    </div>
  </section>

  <section id="panelCall" class="hidden">
    <h2>On a call</h2>
    <p class="hint" id="callCount">&nbsp;</p>
    <div id="peers"></div>
    <p class="num center" id="timer">00:00</p>
    <div class="row">
      <button type="button" id="muteBtn" onclick="toggleMute()">Mute</button>
      <button type="button" class="stop" onclick="leaveCall()">Leave</button>
    </div>
  </section>

  <section>
    <h2>Contacts</h2>
    <div id="contacts"></div>
  </section>

  <section class="log">
    <h2>Log</h2>
    <div id="term"></div>
  </section>

</main>

<div id="streams"></div>
`;

/* ================================================================== *
 *  4. CLIENT SCRIPT
 *
 *  No backticks and no dollar-brace in here: this string is dropped into
 *  a template literal further down.
 * ================================================================== */

const CLIENT_JS = `
  /* ---------- 4.1 config ---------- */

  var RTC = {
    // replaced by the server's list on registered (its own STUN/TURN once the relay is up)
    iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
    iceCandidatePoolSize: 4,     // gather candidates early so calls connect fast
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };

  var MIC = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,           // mono: fewer packets, less to buffer
      latency: 0                 // ask the driver for the smallest buffer it will give
    }
  };

  var NO_ANSWER_MS = 45000;      // give up on an outgoing invite
  var MISSED_MS    = 60000;      // stop ringing an unanswered incoming invite
  var CONNECT_MS   = 30000;      // how long a new connection may take to come up
  var DROP_MS      = 15000;      // how long a stalled connection may try to recover

  /* ---------- 4.2 state ---------- */

  var ws = null;                 // the Socket.IO socket
  var myNumber = null;
  var myToken = null;            // proves to the server that a reconnect is us, so we keep our number
  var wanted = null;             // number to fall back to if an explicit Change is refused
  var regTimer = null;           // re-sends register until the server answers
  var elsewhereWarned = false;   // told the user once that another tab holds the number
  var peers = {};                // number -> { pc, state, muted, ice, joined, audio, dropTimer, tracks }
  var localStream = null;
  var micPending = null;         // the getUserMedia call in flight, so two askers share one prompt
  var micOn = true;
  var micGranted = false;
  var outgoing = null;           // number we are ringing
  var incoming = null;           // number ringing us
  var incomingSize = 0;          // how many are already in their call
  var leaving = false;           // suppresses per-peer sounds while we tear the call down
  var answering = false;         // Answer was tapped: the incoming invite is being accepted
  var closing = false;           // page is going away
  var outTimer = null, inTimer = null;     // one timer per ring, since both can ring at once
  var callTimer = null, seconds = 0;

  function $(id) { return document.getElementById(id); }
  function digits(s) { return String(s || '').replace(/[^0-9]/g, ''); }
  function validNumber(n) { return /^[0-9]{1,8}$/.test(n); }
  function peerNumbers() { return Object.keys(peers); }
  function inCall() { return peerNumbers().length > 0; }
  function ringing() { return !!outgoing || (!!incoming && !answering); }
  function hasTurn() {
    return RTC.iceServers.some(function (s) { return String(s.urls).indexOf('turn:') !== -1; });
  }

  /* ---------- 4.3 log ---------- */

  function log(msg, kind) {
    var row = document.createElement('div');
    if (kind) row.className = kind;
    row.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
    var t = $('term');
    t.appendChild(row);
    while (t.childNodes.length > 300) t.removeChild(t.firstChild);
    t.scrollTop = t.scrollHeight;
  }

  /* ---------- 4.4 sound ----------
     One Audio object per clip, reused forever. Every play stops that clip
     first, so a sound can never stack on top of itself. */

  var sfx = {}, sfxPrimed = false, sfxWarned = false, sfxAnnounced = false;

  var SOUNDS = { calling: 'call.mp3', joined: 'join.mp3', leave: 'leave.mp3' };

  function initSfx() {
    Object.keys(SOUNDS).forEach(function (name) {
      var a = new Audio('sounds/' + SOUNDS[name]);
      a.preload = 'auto';
      a.addEventListener('error', function () {
        log('Could not load sounds/' + SOUNDS[name] + ' - is the file there?', 'err');
      });
      sfx[name] = a;
    });
    sfx.calling.loop = true;
  }

  /* Browsers refuse audio until a page has earned it, so we ask the moment
     someone opens the page by test-playing every clip silently. */
  function primeSfx() {
    if (sfxPrimed) return Promise.resolve(true);

    var attempts = Object.keys(sfx).map(function (name) {
      var a = sfx[name];
      if (!a.paused) return Promise.resolve('ok');

      var vol = a.volume;
      a.volume = 0;
      var p;
      try { p = a.play(); } catch (e) { a.volume = vol; return Promise.resolve('blocked'); }
      if (!p || !p.then) { a.pause(); a.currentTime = 0; a.volume = vol; return Promise.resolve('ok'); }

      return p.then(function () {
        a.pause(); a.currentTime = 0; a.volume = vol;
        return 'ok';
      }).catch(function (err) {
        a.volume = vol;
        return (err && err.name && err.name !== 'NotAllowedError') ? 'badfile' : 'blocked';
      });
    });

    return Promise.all(attempts).then(function (results) {
      var stopped = results.some(function (r) { return r === 'blocked'; });
      sfxPrimed = !stopped;
      if (!stopped) {
        sfxWarned = false;
        if (!sfxAnnounced && results.every(function (r) { return r === 'ok'; })) {
          sfxAnnounced = true;
          log('Sound is ready.');
        }
      }
      // a ring that began while the clip was being test-played was skipped: start it now
      if (ringing() && sfx.calling && sfx.calling.paused) startRing();
      renderSetup();
      return !stopped;
    });
  }

  function enableSound() {
    sfxPrimed = false;
    primeSfx().then(function (ok) {
      if (ok) log('Sound enabled.');
      else log('Still blocked. Allow sound for this page in the browser site settings.', 'err');
    });
    // remote audio that was refused earlier gets another go now that we have a gesture
    peerNumbers().forEach(function (n) {
      var a = peers[n].audio;
      if (!a) return;
      var p = a.play();
      if (p && p.catch) p.catch(function () { /* still refused; the banner stays up */ });
    });
  }

  function playFailed(err) {
    if (err && err.name === 'AbortError') return;      // we stopped it ourselves before it started
    if (err && err.name && err.name !== 'NotAllowedError') {
      log('Sound problem: ' + err.name, 'err');
      return;
    }
    sfxPrimed = false;
    renderSetup();
    if (sfxWarned) return;
    sfxWarned = true;
    log('Sound is blocked. Use Enable sound above.', 'warn');
  }

  function stopClip(a) {
    if (!a) return;
    try { a.pause(); a.currentTime = 0; } catch (e) { /* not loaded yet */ }
  }

  function playOnce(name) {
    var a = sfx[name];
    if (!a) return;
    stopClip(a);
    var p = a.play();
    if (p && p.catch) p.catch(playFailed);
  }

  function startRing() {
    var a = sfx.calling;
    if (!a || !a.paused) return;
    a.currentTime = 0;
    var p = a.play();
    if (p && p.catch) p.catch(playFailed);
  }

  function stopRing() {
    if (ringing()) return;                 // something else is still ringing
    stopClip(sfx.calling);
  }

  /* ---------- 4.5 microphone ---------- */

  function watchMicPermission() {
    if (!navigator.permissions || !navigator.permissions.query) return;
    try {
      var q = navigator.permissions.query({ name: 'microphone' });
      if (!q || !q.then) return;
      q.then(function (p) {
        micGranted = (p.state === 'granted');
        renderSetup();
        p.onchange = function () { micGranted = (p.state === 'granted'); renderSetup(); };
      }).catch(function () { /* microphone not queryable here */ });
    } catch (e) { /* older browser */ }
  }

  function hasMicApi() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function noMicApi() {
    log('No microphone access on this page. Browsers only allow it on localhost or HTTPS - see the note in the terminal where you started the server.', 'err');
    setStatus('Insecure page: no microphone');
  }

  /* Asking up front means answering a call does not stall on a permission
     dialog while the other side is ringing. */
  function allowMic() {
    if (!hasMicApi()) { noMicApi(); return; }
    navigator.mediaDevices.getUserMedia(MIC).then(function (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      micGranted = true;
      log('Microphone ready.');
      renderSetup();
    }).catch(function (err) {
      log('Microphone not allowed: ' + ((err && err.name) || err), 'err');
    });
  }

  /* Every call flow goes through here. One getUserMedia at a time: two peers
     asking at once share the same prompt and the same stream. */
  function ensureMic() {
    if (localStream) return Promise.resolve(true);
    if (!micPending) {
      micPending = openMic().then(function (ok) { micPending = null; return ok; });
    }
    return micPending;
  }

  async function openMic() {
    if (!hasMicApi()) { noMicApi(); return false; }
    try {
      var stream = await navigator.mediaDevices.getUserMedia(MIC);
      micGranted = true;
      renderSetup();
      if (!inCall() && !outgoing && !incoming) {
        // whatever needed the microphone ended while the prompt was open
        stream.getTracks().forEach(function (t) { t.stop(); });
        return false;
      }
      localStream = stream;
      applyMute();
      log('Microphone open.');
      return true;
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        log('Microphone blocked. Allow it in the address bar and try again.', 'err');
        setStatus('Microphone blocked');
      } else if (err && err.name === 'NotFoundError') {
        log('No microphone found on this machine.', 'err');
        setStatus('No microphone');
      } else if (!window.isSecureContext) {
        log('Microphone needs a secure page. See the note in the terminal where you started the server.', 'err');
        setStatus('Insecure page: no microphone');
      } else {
        log('Microphone error: ' + ((err && err.message) || err), 'err');
        setStatus('No microphone');
      }
      return false;
    }
  }

  function releaseMic() {
    if (!localStream) return;
    localStream.getTracks().forEach(function (t) { t.stop(); });
    localStream = null;
  }

  function applyMute() {
    if (!localStream) return;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = micOn; });
  }

  function toggleMute() {
    micOn = !micOn;
    applyMute();
    send({ type: 'status', muted: !micOn });
    log(micOn ? 'Microphone on.' : 'Microphone muted.');
    renderCall();
  }

  /* ---------- 4.6 identity and contacts ---------- */

  function loadStore(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function saveStore(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* private mode */ } }
  /* The server hands out the number on the first visit and ties it to this
     browser's token for good; both are kept here so the same number comes
     back every time. */
  function loadNumber() {
    myNumber = digits(loadStore('myNumber')).slice(0, 8) || null;
    $('myNumber').textContent = myNumber || '----';
    myToken = loadStore('token');
    if (!myToken) {
      myToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      saveStore('token', myToken);
    }
  }

  function register() {
    clearTimeout(regTimer);
    regTimer = setTimeout(register, 5000);     // until the server answers, or while another tab holds our number
    send({ type: 'register', number: myNumber || '', token: myToken });
  }

  function changeNumber() {
    if (!myNumber) { setStatus('Not registered yet'); return; }
    if (inCall() || outgoing || incoming) { setStatus('End the call first'); return; }
    var next = prompt('Pick a number (up to 8 digits):', myNumber);
    if (next === null) return;
    next = digits(next).slice(0, 8);
    if (!next) { log('Numbers only.', 'err'); return; }
    if (next === myNumber) return;
    wanted = myNumber;                       // fall back to this if the new one is refused
    myNumber = next;
    saveStore('myNumber', myNumber);
    $('myNumber').textContent = myNumber;
    log('Switching to ' + myNumber + '.');
    register();
  }

  function contacts() {
    try {
      var list = JSON.parse(loadStore('contacts') || '[]');
      return Array.isArray(list) ? list.filter(function (n) { return /^[0-9]{1,8}$/.test(n); }) : [];
    } catch (e) { return []; }
  }

  function saveContact(num) {
    if (!num || num === myNumber) return;
    var list = contacts();
    if (list.indexOf(num) !== -1) return;
    list.push(num);
    saveStore('contacts', JSON.stringify(list));
    renderContacts();
  }

  function removeContact(num) {
    saveStore('contacts', JSON.stringify(contacts().filter(function (n) { return n !== num; })));
    renderContacts();
  }

  /* ---------- 4.7 socket ----------
     Socket.IO. Every message is emitted under its type and the payload is the
     message object itself. Reconnection (1-5s backoff) and the long-polling
     fallback for networks that block WebSockets are built in. */

  var EVENTS = ['registered', 'taken', 'ice', 'unreachable', 'busy', 'ringing', 'cancelled', 'declined',
                'joined', 'peer-joined', 'peer-left', 'peer-status', 'signal'];

  function connect() {
    if (closing) return;
    if (typeof io !== 'function') { log('The socket.io client did not load. Reload the page.', 'err'); return; }
    ws = io();

    ws.on('connect', function () {
      $('dot').className = 'dot on';
      $('linkState').textContent = 'online';
      register();
    });

    ws.on('disconnect', function () {
      clearTimeout(regTimer);
      regTimer = null;
      if (closing) return;
      $('dot').className = 'dot';
      $('linkState').textContent = 'offline';
      log('Lost the server. Reconnecting.', 'warn');
    });

    // the server checks we are still here before letting another socket take our number
    ws.on('probe', function (ack) { if (typeof ack === 'function') ack(); });

    EVENTS.forEach(function (type) {
      ws.on(type, function (msg) {
        if (!msg || typeof msg !== 'object') msg = {};
        msg.type = type;
        handle(msg);
      });
    });
  }

  function send(obj) {
    if (ws && ws.connected) { ws.emit(obj.type, obj); return true; }
    return false;
  }

  function sendSignal(to, data) { send({ type: 'signal', to: to, data: data }); }

  function handle(msg) {
    switch (msg.type) {
      case 'registered':
        clearTimeout(regTimer);
        regTimer = null;
        wanted = null;
        elsewhereWarned = false;
        myNumber = msg.number;
        saveStore('myNumber', myNumber);
        $('myNumber').textContent = myNumber;
        $('linkState').textContent = 'online';
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) RTC.iceServers = msg.iceServers;
        log('Registered as ' + msg.number + '.');
        break;

      case 'taken':
        clearTimeout(regTimer);
        regTimer = null;
        if (msg.reason === 'elsewhere') {
          // same browser, another tab: that one keeps the number, we keep asking until it goes away
          $('linkState').textContent = 'open in another tab';
          if (!elsewhereWarned) {
            elsewhereWarned = true;
            log('This number is open in another tab. Close that tab and this one takes over.', 'warn');
          }
          regTimer = setTimeout(register, 5000);
          break;
        }
        if (msg.number !== (myNumber || '')) break;    // about a number we have already moved on from
        if (wanted) {
          myNumber = wanted;
          log(msg.number + ' belongs to someone else. Staying on ' + myNumber + '.', 'warn');
        } else {
          myNumber = null;
          log(msg.number + ' belongs to someone else now. Getting a new number.', 'warn');
        }
        wanted = null;
        saveStore('myNumber', myNumber || '');
        $('myNumber').textContent = myNumber || '----';
        register();
        break;

      case 'ice':
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) RTC.iceServers = msg.iceServers;
        break;

      case 'unreachable':
        if (msg.number !== outgoing) break;
        log(msg.number + ' is not online.', 'err');
        clearOutgoing(msg.number + ' is not online');
        break;

      case 'busy':
        if (msg.number === incoming) {
          // we accepted, but by now they are in a different call and calls cannot merge
          log(msg.number + ' is in another call now.', 'warn');
          clearIncoming(msg.number + ' is in another call');
          break;
        }
        if (msg.number !== outgoing) break;
        log(msg.number + ' cannot take the call right now.', 'warn');
        clearOutgoing(msg.number + ' is busy');
        break;

      case 'ringing':
        onRinging(msg);
        break;

      case 'cancelled':
        if (msg.from !== incoming) break;
        log(msg.from + ' stopped calling.');
        clearIncoming('Missed call');
        break;

      case 'declined':
        if (msg.from !== outgoing) break;
        log(msg.from + ' declined.', 'warn');
        clearOutgoing(msg.from + ' declined');
        break;

      case 'joined':
        onJoined(msg);
        break;

      case 'peer-joined':
        onPeerJoined(msg);
        break;

      case 'peer-left':
        onPeerLeft(msg);
        break;

      case 'peer-status':
        if (peers[msg.from]) { peers[msg.from].muted = !!msg.muted; renderCall(); }
        break;

      case 'signal':
        onSignal(msg);
        break;
    }
  }

  /* ---------- 4.8 peers: one connection per person in the call ---------- */

  function createPeer(number) {
    if (peers[number]) return peers[number];

    var rec = {
      number: number,
      pc: new RTCPeerConnection(RTC),
      state: 'connecting',
      muted: false,
      ice: [],
      joined: false,
      audio: null,
      dropTimer: null,
      tracks: false
    };
    peers[number] = rec;

    rec.pc.onicecandidate = function (e) {
      if (e.candidate) sendSignal(number, { candidate: e.candidate });
    };

    rec.pc.ontrack = function (e) {
      attachAudio(rec, (e.streams && e.streams[0]) || new MediaStream([e.track]));
      tuneReceivers(rec.pc);
    };

    rec.pc.onconnectionstatechange = function () { onPeerState(rec); };

    // a connection that never comes up (they never answered our offer, or
    // ICE found no path and never said so) must not sit in the list forever
    rec.dropTimer = setTimeout(function () {
      rec.dropTimer = null;
      if (peers[number] && rec.pc.connectionState !== 'connected') {
        log(number + ' did not connect.', 'warn');
        dropPeer(number);
      }
    }, CONNECT_MS);

    saveContact(number);
    renderAll();
    return rec;
  }

  function addTracks(rec) {
    if (rec.tracks || !localStream) return;
    rec.tracks = true;
    localStream.getTracks().forEach(function (t) { rec.pc.addTrack(t, localStream); });
    tuneSenders(rec.pc);
  }

  /* Latency: ask the receiver not to sit on a jitter buffer, and mark our
     own audio high priority so wifi does not queue it behind other
     traffic. Both are best effort and ignored where unsupported. */
  function tuneReceivers(pc) {
    try {
      pc.getReceivers().forEach(function (r) {
        if ('playoutDelayHint' in r) r.playoutDelayHint = 0;
      });
    } catch (e) { /* not supported */ }
  }

  function tuneSenders(pc) {
    try {
      pc.getSenders().forEach(function (s) {
        if (!s.track || s.track.kind !== 'audio' || !s.getParameters || !s.setParameters) return;
        var params = s.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].priority = 'high';
        var p = s.setParameters(params);
        if (p && p.catch) p.catch(function () { /* older browser */ });
      });
    } catch (e) { /* not supported */ }
  }

  function attachAudio(rec, stream) {
    if (!stream) return;
    if (!rec.audio) {
      rec.audio = document.createElement('audio');
      rec.audio.autoplay = true;
      $('streams').appendChild(rec.audio);
    }
    rec.audio.srcObject = stream;
    var p = rec.audio.play();
    if (p && p.catch) p.catch(function () { /* a live stream is normally allowed */ });
  }

  function onPeerState(rec) {
    if (!peers[rec.number]) return;
    var s = rec.pc.connectionState;

    if (s === 'connected') {
      clearTimeout(rec.dropTimer);
      rec.dropTimer = null;
      rec.state = 'live';
      if (!rec.joined) {
        rec.joined = true;
        playOnce('joined');
        log(rec.number + ' joined the call.');
      }
      startCallTimer();
      tuneReceivers(rec.pc);
      renderAll();
      return;
    }

    if (s === 'disconnected') {
      rec.state = 'reconnecting';
      renderCall();
      clearTimeout(rec.dropTimer);
      rec.dropTimer = setTimeout(function () {
        rec.dropTimer = null;
        if (peers[rec.number] && rec.pc.connectionState !== 'connected') {
          log(rec.number + ' dropped out.', 'warn');
          dropPeer(rec.number);
        }
      }, DROP_MS);
      return;
    }

    if (s === 'failed') {
      log(hasTurn()
        ? 'Could not connect to ' + rec.number + '.'
        : 'Could not reach ' + rec.number + ' directly. A TURN relay would be needed here, see the README.', 'err');
      dropPeer(rec.number);
    }
  }

  function closePeer(number) {
    var rec = peers[number];
    if (!rec) return;
    delete peers[number];

    clearTimeout(rec.dropTimer);
    rec.pc.onicecandidate = null;
    rec.pc.ontrack = null;
    rec.pc.onconnectionstatechange = null;
    try { rec.pc.close(); } catch (e) { /* already closed */ }

    if (rec.audio) {
      try { rec.audio.pause(); } catch (e) { /* nothing playing */ }
      rec.audio.srcObject = null;
      try { $('streams').removeChild(rec.audio); } catch (e) { /* already gone */ }
      rec.audio = null;
    }
  }

  /* One person left; the rest of the call carries on. When they were the
     last, the call is over, but a ring in progress is still a live attempt. */
  function dropPeer(number) {
    if (!peers[number]) return;
    closePeer(number);
    if (leaving) return;
    playOnce('leave');
    if (inCall()) { renderAll(); return; }
    settle('Call ended', false);
  }

  /* ---------- 4.9 joining and leaving ---------- */

  /* Someone we were ringing, or who was ringing us, is now in our call:
     that invite has been overtaken by events, so stop ringing either way. */
  function inviteResolved(number) {
    if (outgoing === number) {
      outgoing = null;
      clearTimeout(outTimer);
      outTimer = null;
    }
    if (incoming === number) {
      incoming = null;
      incomingSize = 0;
      answering = false;
      clearTimeout(inTimer);
      inTimer = null;
    }
    stopRing();
  }

  function onJoined(msg) {
    // We are the newcomer, so we send the offers and nobody offers twice.
    // Peer records exist before anything awaits, so a peer-status arriving
    // right behind this message finds its record.
    var members = (Array.isArray(msg.members) ? msg.members : []).map(String)
      .filter(function (n) { return validNumber(n) && n !== myNumber; });
    members.forEach(inviteResolved);
    members.forEach(function (n) { offerTo(createPeer(n)); });
    if (!micOn) send({ type: 'status', muted: true });
    setStatus('In a call');
    renderAll();
  }

  async function onPeerJoined(msg) {
    var number = String(msg.number || '');
    if (!validNumber(number) || number === myNumber) return;
    inviteResolved(number);
    createPeer(number);              // they are the newcomer, so they offer us
    setStatus('In a call');
    renderAll();
    if (!(await ensureMic())) { leaveCall(true); return; }
    if (!micOn) send({ type: 'status', muted: true });
  }

  function onPeerLeft(msg) {
    if (!peers[msg.number]) return;
    log(msg.number + ' left the call.');
    dropPeer(msg.number);
  }

  async function offerTo(rec) {
    if (!(await ensureMic())) { leaveCall(true); return; }
    if (!peers[rec.number]) return;
    addTracks(rec);
    try {
      var offer = await rec.pc.createOffer();
      await rec.pc.setLocalDescription(offer);
    } catch (e) {
      log('Could not call ' + rec.number + ': ' + e, 'err');
      dropPeer(rec.number);
      return;
    }
    if (!peers[rec.number]) return;
    sendSignal(rec.number, { sdp: rec.pc.localDescription });
  }

  function onSignal(msg) {
    var rec = peers[msg.from];
    var data = msg.data || {};

    if (!rec) {
      // An offer can land a moment before peer-joined does.
      if (!data.sdp || data.sdp.type !== 'offer') return;
      rec = createPeer(msg.from);
    }

    if (data.sdp) {
      if (data.sdp.type === 'offer') acceptOffer(rec, data.sdp);
      else acceptAnswer(rec, data.sdp);
    } else if (data.candidate) {
      if (rec.pc.remoteDescription) {
        var p = rec.pc.addIceCandidate(data.candidate);
        if (p && p.catch) p.catch(function () { /* stale */ });
      } else if (rec.ice.length < 200) {
        rec.ice.push(data.candidate);
      }
    }
  }

  async function acceptOffer(rec, sdp) {
    // no microphone means no call at all, and the server must hear that we
    // are gone, or everyone else keeps a silent "connecting" entry for us
    if (!(await ensureMic())) { leaveCall(true); return; }
    if (!peers[rec.number]) return;
    addTracks(rec);
    try {
      await rec.pc.setRemoteDescription(sdp);
      await flushIce(rec);
      var answer = await rec.pc.createAnswer();
      await rec.pc.setLocalDescription(answer);
    } catch (e) {
      log('Could not answer ' + rec.number + ': ' + e, 'err');
      dropPeer(rec.number);
      return;
    }
    if (!peers[rec.number]) return;
    sendSignal(rec.number, { sdp: rec.pc.localDescription });
  }

  async function acceptAnswer(rec, sdp) {
    if (rec.pc.signalingState !== 'have-local-offer') return;   // duplicate answer
    try {
      await rec.pc.setRemoteDescription(sdp);
      await flushIce(rec);
    } catch (e) {
      log('Could not connect to ' + rec.number + ': ' + e, 'err');
      dropPeer(rec.number);
    }
  }

  async function flushIce(rec) {
    for (var i = 0; i < rec.ice.length; i++) {
      if (!peers[rec.number]) break;
      try { await rec.pc.addIceCandidate(rec.ice[i]); } catch (e) { /* stale */ }
    }
    rec.ice = [];
  }

  /* ---------- 4.10 the buttons ---------- */

  function call() {
    var num = digits($('dialInput').value).slice(0, 8);
    if (!num) { setStatus('Enter a number first'); return; }
    if (!myNumber) { setStatus('Not registered yet'); return; }
    if (num === myNumber) { setStatus('That is your own number'); return; }
    if (peers[num]) { setStatus(num + ' is already in this call'); return; }
    if (num === incoming) { $('dialInput').value = ''; answer(); return; }   // calling back whoever is ringing us
    if (outgoing) { setStatus('Already calling ' + outgoing); return; }
    if (!ws || !ws.connected) { setStatus('Not connected to the server'); return; }

    outgoing = num;
    $('outgoingNum').textContent = num;
    $('dialInput').value = '';
    send({ type: 'invite', to: num });
    startRing();
    clearTimeout(outTimer);
    outTimer = setTimeout(function () { outTimer = null; noAnswer(); }, NO_ANSWER_MS);
    log(inCall() ? 'Asking ' + num + ' to join.' : 'Calling ' + num + '.');
    setStatus(inCall() ? 'Waiting for ' + num : 'Calling ' + num);
    renderAll();
  }

  function noAnswer() {
    if (!outgoing) return;
    log(outgoing + ' did not answer.', 'warn');
    send({ type: 'cancel' });
    clearOutgoing('No answer');
  }

  function cancelInvite() {
    if (!outgoing) return;
    send({ type: 'cancel' });
    log('Stopped calling ' + outgoing + '.');
    clearOutgoing('Call cancelled');
  }

  function onRinging(msg) {
    var from = String(msg.from || '');
    if (!validNumber(from)) return;
    incoming = from;
    incomingSize = msg.size || 0;
    answering = false;
    $('incomingNum').textContent = from;
    $('incomingTitle').textContent = incomingSize > 1
      ? 'Asking you to join a call'
      : (inCall() ? 'Wants to join your call' : 'Incoming call');
    log('Incoming call from ' + from + '.');
    startRing();
    clearTimeout(inTimer);
    inTimer = setTimeout(function () {
      inTimer = null;
      if (!incoming || answering) return;
      send({ type: 'decline' });
      log('Missed call from ' + incoming + '.', 'warn');
      clearIncoming('Missed call');
    }, MISSED_MS);
    renderAll();
  }

  /* The invite stays live until the server puts us in the call, so a caller
     who gives up while the microphone prompt is open is still handled. */
  async function answer() {
    if (!incoming || answering) return;
    answering = true;
    var from = incoming;

    clearTimeout(inTimer);
    inTimer = null;
    stopRing();
    setStatus('Answering ' + from);
    renderAll();

    var ok = await ensureMic();
    if (incoming !== from || !answering) return;    // they gave up meanwhile; already cleaned up
    if (!ok) { answering = false; decline(true); return; }

    send({ type: 'accept' });
    log('Answered ' + from + '.');
    // the server answers with joined or peer-joined (or cancelled / busy);
    // if it somehow never does, do not sit in limbo
    inTimer = setTimeout(function () {
      inTimer = null;
      if (incoming !== from || !answering) return;
      log('Could not join ' + from + '.', 'err');
      clearIncoming('Could not join ' + from);
    }, 10000);
  }

  function decline(keepStatus) {
    if (!incoming) return;
    send({ type: 'decline' });
    log('Declined ' + incoming + '.');
    clearIncoming(keepStatus === true ? $('status').textContent : 'Declined');
  }

  function leaveCall(keepStatus) {
    if (!inCall() && !outgoing && !incoming) return;
    leaving = true;
    peerNumbers().forEach(closePeer);
    leaving = false;
    endCallLocally(keepStatus === true ? $('status').textContent : 'Call ended', true);
  }

  /* Everything that ends a call funnels through here, so leave.mp3 plays
     exactly once, the server hears about it, and nothing is left running. */
  function endCallLocally(statusText, playSound) {
    peerNumbers().forEach(closePeer);
    if (outgoing) send({ type: 'cancel' });
    if (incoming && !answering) send({ type: 'decline' });
    send({ type: 'leave' });                 // a no-op on the server if we were not in a room
    clearTimeout(outTimer);
    clearTimeout(inTimer);
    outTimer = inTimer = null;
    outgoing = null;
    incoming = null;
    incomingSize = 0;
    answering = false;
    stopCallTimer();
    releaseMic();
    micOn = true;
    stopClip(sfx.calling);
    if (playSound) playOnce('leave');
    setStatus(statusText);
    renderAll();
  }

  /* One ring or one peer is over. Back to idle if nothing else is going on;
     otherwise a ring still in progress keeps its panel and its sound. */
  function settle(statusText, playSound) {
    if (!inCall() && !ringing() && !answering) { endCallLocally(statusText, playSound); return; }
    if (!inCall() && !answering) {
      // the call itself is over even though a ring is still up
      send({ type: 'leave' });
      stopCallTimer();
      releaseMic();
      micOn = true;
    }
    setStatus(statusText);
    renderAll();
  }

  function clearOutgoing(statusText) {
    outgoing = null;
    clearTimeout(outTimer);
    outTimer = null;
    stopRing();
    settle(statusText, true);                // the attempt is over
  }

  function clearIncoming(statusText) {
    incoming = null;
    incomingSize = 0;
    answering = false;
    clearTimeout(inTimer);
    inTimer = null;
    stopRing();
    settle(statusText, true);
  }

  /* ---------- 4.11 rendering ---------- */

  function show(id, on) {
    var el = $(id);
    if (el) el.classList.toggle('hidden', !on);
  }

  function setStatus(text) { $('status').textContent = text; }

  function renderAll() {
    renderPanels();
    renderCall();
    renderSetup();
  }

  function renderPanels() {
    var ringIn = !!incoming && !answering;
    show('panelDial', !outgoing && !ringIn);
    show('panelOutgoing', !!outgoing);
    show('panelIncoming', ringIn);
    show('panelCall', inCall());
    $('dialTitle').textContent = inCall() ? 'Add someone to the call' : 'Call someone';
    $('dialBtn').textContent = inCall() ? 'Add' : 'Call';
  }

  function renderCall() {
    var box = $('peers');
    box.innerHTML = '';
    var list = peerNumbers().sort();

    list.forEach(function (n) {
      var rec = peers[n];
      var row = document.createElement('div');
      row.className = 'peer';

      var num = document.createElement('span');
      num.className = 'peer-num';
      num.textContent = n;

      var st = document.createElement('span');
      st.className = 'peer-state' + (rec.state === 'live' ? (rec.muted ? ' muted' : ' live') : '');
      st.textContent = rec.state === 'live' ? (rec.muted ? 'muted' : 'connected') : rec.state;

      row.appendChild(num);
      row.appendChild(st);
      box.appendChild(row);
    });

    $('callCount').textContent = list.length === 1
      ? 'You and 1 other person'
      : 'You and ' + list.length + ' other people';
    $('muteBtn').textContent = micOn ? 'Mute' : 'Unmute';
  }

  function renderSetup() {
    var needSound = !sfxPrimed;
    var needMic = !micGranted;
    show('soundBtn', needSound);
    show('micBtn', needMic);
    show('setup', needSound || needMic);
    $('setupHint').textContent = needSound && needMic
      ? 'This browser needs permission for sound and the microphone.'
      : needSound
        ? 'This browser will not play the ringtone until you allow sound on this page.'
        : 'Allowing the microphone now means answering a call is instant.';
  }

  function startCallTimer() {
    if (callTimer) return;
    seconds = 0;
    $('timer').textContent = '00:00';
    callTimer = setInterval(function () {
      seconds++;
      var m = Math.floor(seconds / 60), s = seconds % 60;
      $('timer').textContent = (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
    }, 1000);
  }

  function stopCallTimer() {
    clearInterval(callTimer);
    callTimer = null;
    seconds = 0;
    $('timer').textContent = '00:00';
  }

  function renderContacts() {
    var box = $('contacts');
    var list = contacts();
    box.innerHTML = '';

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No one saved yet. People you talk to get added here.';
      box.appendChild(empty);
      return;
    }

    list.forEach(function (num) {
      var row = document.createElement('div');
      row.className = 'contact';

      var label = document.createElement('span');
      label.className = 'contact-num';
      label.textContent = num;

      var callBtn = document.createElement('button');
      callBtn.type = 'button';
      callBtn.className = 'go';
      callBtn.textContent = 'Call';
      callBtn.onclick = function () { $('dialInput').value = num; call(); };

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'link';
      del.textContent = 'Remove';
      del.onclick = function () { removeContact(num); };

      row.appendChild(label);
      row.appendChild(callBtn);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  /* ---------- 4.12 boot ---------- */

  function goodbye() {
    if (closing) return;
    closing = true;
    if (outgoing) send({ type: 'cancel' });
    if (inCall()) send({ type: 'leave' });
    stopClip(sfx.calling);
    stopClip(sfx.joined);
    stopClip(sfx.leave);
  }

  window.addEventListener('beforeunload', goodbye);
  window.addEventListener('pagehide', goodbye);
  // coming back from the back-forward cache would revive a page that has already said goodbye
  window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });

  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, primeSfx, { once: true });
  });

  $('dialInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') call();
  });

  initSfx();
  primeSfx();                  // ask the browser for audio the moment we load
  watchMicPermission();
  loadNumber();
  renderContacts();
  renderAll();

  if (!window.RTCPeerConnection) {
    log('This browser does not support WebRTC. Calls will not work.', 'err');
  } else if (!hasMicApi()) {
    noMicApi();
  }

  connect();
  log(myNumber ? 'Ready. Your number is ' + myNumber + '.' : 'Ready. Asking the server for a number.');
`;

/* ================================================================== *
 *  5. PAGE ASSEMBLY
 * ================================================================== */

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dialer</title>
<style>${CSS}</style>
</head>
<body>
${HTML}
<script src="/socket.io/socket.io.js"></script>
<script>${CLIENT_JS}</script>
</body>
</html>`;

/* ================================================================== *
 *  6. HTTP: PAGE + SOUNDS
 * ================================================================== */

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

/* Streams a file, honouring Range requests so Safari and iOS will play
   the audio instead of stalling on it. */
function serveFile(req, res, file, type) {
  let stat;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch (e) {
    console.log(`  ! missing ${path.relative(__dirname, file)}`);
    notFound(res);
    return;
  }

  const total = stat.size;
  const range = req.headers.range;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(String(range).trim()) : null;

  if (match) {
    let start = match[1] === '' ? null : parseInt(match[1], 10);
    let end = match[2] === '' ? null : parseInt(match[2], 10);

    if (start === null && end === null) { start = 0; end = total - 1; }
    else if (start === null) { start = Math.max(total - end, 0); end = total - 1; }
    else if (end === null) { end = total - 1; }

    end = Math.min(end, total - 1);

    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }

    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const partial = fs.createReadStream(file, { start, end });
    partial.on('error', () => res.destroy());
    partial.pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache'
  });
  if (req.method === 'HEAD') { res.end(); return; }
  const whole = fs.createReadStream(file);
  whole.on('error', () => res.destroy());
  whole.pipe(res);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
    res.end('Method not allowed');
    return;
  }

  let pathname;
  try { pathname = decodeURIComponent(req.url.split('?')[0]); }
  catch (e) { notFound(res); return; }

  if (pathname === '/' || pathname === '/index.html') {
    const body = Buffer.from(PAGE, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  if (pathname.startsWith('/sounds/')) {
    const name = pathname.slice('/sounds/'.length);
    if (SOUND_FILES.indexOf(name) === -1) { notFound(res); return; }
    serveFile(req, res, path.join(SOUND_DIR, name), 'audio/mpeg');
    return;
  }

  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  notFound(res);
});

/* ================================================================== *
 *  7. ROOMS: WHO IS IN WHICH CALL
 * ================================================================== */

const users = new Map();        // number -> Socket.IO socket
const rooms = new Map();        // roomId -> Set of numbers
const roomOf = new Map();       // number -> roomId
const inviteTo = new Map();     // invitee -> inviter   (one ringing invite each way)
const inviteFrom = new Map();   // inviter -> invitee

let nextRoom = 1;

const isNumber = (n) => /^[0-9]{1,8}$/.test(n);

/* Numbers are permanent. A browser's first visit gets a free random 4-digit
   number tied to its token and written to numbers.json, so nobody else can
   take it, online or not, and a server restart keeps it. A number whose owner
   has not been seen for STALE_MS can be claimed by someone else. */
const REGISTRY = path.join(__dirname, 'numbers.json');
const STALE_MS = 30 * 24 * 60 * 60 * 1000;
const registry = loadRegistry();   // token -> { number, seen }

function loadRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    const out = {};
    for (const [token, v] of Object.entries(raw)) {
      if (v && isNumber(v.number)) out[token] = { number: String(v.number), seen: Number(v.seen) || 0 };
    }
    return out;
  } catch (e) { return {}; }   // first run, or an unreadable file: start empty
}

function saveRegistry() {
  try { fs.writeFileSync(REGISTRY, JSON.stringify(registry, null, 2)); }
  catch (e) { console.log(`  ! could not write ${REGISTRY}: ${e.message}`); }
}

const ownerOf = (number) => Object.keys(registry).find((t) => registry[t].number === number) || null;

function freeNumber() {
  const used = new Set(Object.values(registry).map((r) => r.number));
  let n;
  do { n = String(Math.floor(1000 + Math.random() * 9000)); } while (used.has(n) || users.has(n));
  return n;
}

// Gives `token` the number it asks for (its own, or a free one), or a fresh
// one when it asks for none. Returns null when the number is someone else's.
function claim(token, number) {
  const mine = registry[token];
  if (!number) number = (mine && mine.number) || freeNumber();
  const owner = ownerOf(number);
  if (owner && owner !== token) {
    const stale = !users.has(number) && Date.now() - registry[owner].seen >= STALE_MS;
    if (!stale) return null;
    delete registry[owner];                     // long gone: the number is free again
  }
  const changed = !mine || mine.number !== number || Date.now() - mine.seen > 60000;
  registry[token] = { number, seen: Date.now() };
  if (changed) saveRegistry();
  return number;
}

function tell(number, obj) {
  const socket = users.get(number);
  if (socket && socket.connected) socket.emit(obj.type, obj);
}

function membersOf(number) {
  const id = roomOf.get(number);
  return id && rooms.get(id) ? [...rooms.get(id)] : [];
}

function newRoom(number) {
  const id = 'r' + nextRoom++;
  rooms.set(id, new Set([number]));
  roomOf.set(number, id);
  return id;
}

/* The newcomer is told who is already here and offers them all; everyone
   already here is told to expect an offer. */
function joinRoom(number, id) {
  const set = rooms.get(id);
  if (!set || set.has(number)) return;
  const existing = [...set];

  tell(number, { type: 'joined', members: existing });
  existing.forEach((m) => tell(m, { type: 'peer-joined', number }));

  set.add(number);
  roomOf.set(number, id);

  // an invite still ringing between two people who are now in the same call
  // has been overtaken by events; both clients notice from joined/peer-joined
  existing.forEach((m) => {
    if (inviteFrom.get(m) === number) { inviteFrom.delete(m); inviteTo.delete(number); }
    if (inviteFrom.get(number) === m) { inviteFrom.delete(number); inviteTo.delete(m); }
  });
  console.log(`  call ${id}: ${[...set].join(' + ')}`);
}

function leaveRoom(number) {
  const id = roomOf.get(number);
  if (!id) return;
  roomOf.delete(number);

  const set = rooms.get(id);
  if (!set) return;
  set.delete(number);
  set.forEach((m) => tell(m, { type: 'peer-left', number }));

  // A room of one is not a call: free the last person so they can be called again.
  if (set.size <= 1) {
    set.forEach((m) => roomOf.delete(m));
    rooms.delete(id);
  }
}

function clearInvites(number) {
  const invitee = inviteFrom.get(number);
  if (invitee) {
    inviteFrom.delete(number);
    inviteTo.delete(invitee);
    tell(invitee, { type: 'cancelled', from: number });
  }
  const inviter = inviteTo.get(number);
  if (inviter) {
    inviteTo.delete(number);
    inviteFrom.delete(inviter);
    tell(inviter, { type: 'declined', from: number });
  }
}

function forget(number) {
  clearInvites(number);
  leaveRoom(number);
  users.delete(number);
}

/* ================================================================== *
 *  8. SIGNALING
 * ================================================================== */

const io = new Server(server, { maxHttpBufferSize: 256 * 1024 });   // an SDP is a few KB
const GRACE_MS = 10000;   // how long a cleanly closed socket may come back with its token before its number and call are given up

io.on('connection', (socket) => {
  let me = null;

  const handlers = {
    invite(msg) {
      const to = String(msg.to || '');
      if (!isNumber(to) || to === me) return;

      const target = users.get(to);
      if (!target || !target.connected) { tell(me, { type: 'unreachable', number: to }); return; }   // gone, or in its reconnect grace
      if (inviteFrom.has(me)) return;                                  // one invite at a time
      if (roomOf.get(to) && roomOf.get(to) === roomOf.get(me)) return; // already in this call

      // Busy only when they truly cannot take it: mid-invite, or already
      // in a different call of their own.
      const clash = inviteTo.has(to) || inviteFrom.has(to) ||
                    (roomOf.get(to) && roomOf.get(me) && roomOf.get(to) !== roomOf.get(me));
      if (clash) { tell(me, { type: 'busy', number: to }); return; }

      inviteFrom.set(me, to);
      inviteTo.set(to, me);
      tell(to, { type: 'ringing', from: me, size: membersOf(me).length });
    },

    cancel() {
      const invitee = inviteFrom.get(me);
      if (!invitee) return;
      inviteFrom.delete(me);
      inviteTo.delete(invitee);
      tell(invitee, { type: 'cancelled', from: me });
    },

    decline() {
      const inviter = inviteTo.get(me);
      if (!inviter) return;
      inviteTo.delete(me);
      inviteFrom.delete(inviter);
      tell(inviter, { type: 'declined', from: me });
    },

    accept() {
      const inviter = inviteTo.get(me);
      if (!inviter) return;
      inviteTo.delete(me);
      inviteFrom.delete(inviter);

      if (!users.has(inviter)) { tell(me, { type: 'cancelled', from: inviter }); return; }

      const mine = roomOf.get(me);
      const theirs = roomOf.get(inviter);

      // Two separate calls cannot be merged, so this is refused rather than guessed at.
      if (mine && theirs && mine !== theirs) {
        tell(me, { type: 'busy', number: inviter });
        tell(inviter, { type: 'declined', from: me });
        return;
      }

      if (mine && mine === theirs) return;         // already together; the invite was moot
      if (mine) joinRoom(inviter, mine);           // they join the call I am already in
      else if (theirs) joinRoom(me, theirs);       // I join theirs
      else joinRoom(me, newRoom(inviter));         // a brand new call for the two of us
    },

    // Leaves the call only. Invites have their own cancel and decline, so a
    // ring in progress survives the call around it ending.
    leave() {
      leaveRoom(me);
    },

    status(msg) {
      const id = roomOf.get(me);
      const set = id && rooms.get(id);
      if (!set) return;
      set.forEach((n) => {
        if (n !== me) tell(n, { type: 'peer-status', from: me, muted: !!msg.muted });
      });
    },

    // Media negotiation only ever flows between two people in the same call.
    signal(msg) {
      const to = String(msg.to || '');
      if (!isNumber(to) || to === me || !msg.data || typeof msg.data !== 'object') return;
      const id = roomOf.get(me);
      if (!id || roomOf.get(to) !== id) return;
      tell(to, { type: 'signal', from: me, data: msg.data });
    }
  };

  // Asks a socket to answer within a second. A zombie (its client vanished mid-blip) cannot.
  const alive = (s) => new Promise((resolve) => s.timeout(1000).emit('probe', (err) => resolve(!err)));

  async function register(msg) {
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 64) : '';
    if (!token) return;
    let num = String(msg.number || '').trim();
    if (num && !isNumber(num)) num = '';

    const granted = claim(token, num);
    if (!granted) { socket.emit('taken', { type: 'taken', number: num }); return; }
    num = granted;

    const holder = users.get(num);
    if (holder && holder !== socket) {
      // The same token from another socket: a tab that reconnected after a
      // blip reclaims its number, and with it its place in its call, from the
      // socket it left behind. If that socket still answers, it is a second
      // tab in the same browser, and the live one keeps the number.
      if (holder.token !== token) { socket.emit('taken', { type: 'taken', number: num }); return; }
      if (holder.connected && await alive(holder)) {
        socket.emit('taken', { type: 'taken', number: num, reason: 'elsewhere' });
        return;
      }
      if (!socket.connected || users.get(num) !== holder) return;   // the world moved on while we waited
      console.log(`  ${num} reconnected`);
    }

    if (me && me !== num) {
      forget(me);
      console.log(`  ${me} -> ${num}`);
    }
    me = num;
    socket.token = token;
    users.set(num, socket);
    tell(me, { type: 'registered', number: num, iceServers: iceServers() });
    console.log(`+ ${num} online   (${users.size} connected)`);
  }

  // every message type is its own event; the payload is the message object
  const dispatch = (type, msg) => {
    if (!msg || typeof msg !== 'object') msg = {};
    // a socket whose number was reclaimed by a reconnecting tab no longer speaks for it
    if (me && users.get(me) !== socket) me = null;
    if (type === 'register') { register(msg).catch((e) => console.log(`  ! register: ${e.message}`)); return; }
    if (me) handlers[type](msg);
  };
  socket.on('register', (msg) => dispatch('register', msg));
  Object.keys(handlers).forEach((type) => socket.on(type, (msg) => dispatch(type, msg)));

  // Socket.IO's own ping (25s interval, 20s timeout) reaps sockets that died
  // without a close. A socket that did close (wifi roaming, a laptop lid) gets
  // GRACE_MS to come back with its token before its number and call are dropped.
  socket.on('disconnect', () => {
    if (!me || users.get(me) !== socket) return;
    const number = me;
    setTimeout(() => {
      if (users.get(number) !== socket) return;   // reclaimed by a reconnecting tab meanwhile
      forget(number);
      console.log(`- ${number} offline  (${users.size} connected)`);
    }, GRACE_MS);
  });
});

/* ================================================================== *
 *  9. BOOT
 * ================================================================== */

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use. Close the other server or run:`);
    console.error(`  PORT=8081 node server.js\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Dialer running');
  console.log('  ─────────────────────────────────────────');
  console.log(`  This machine:   http://localhost:${PORT}`);

  const nets = os.networkInterfaces();
  const lan = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) lan.push(net.address);
    }
  }
  lan.forEach((ip) => console.log(`  Other machines: http://${ip}:${PORT}`));

  console.log('');
  const missing = SOUND_FILES.filter((f) => !fs.existsSync(path.join(SOUND_DIR, f)));
  if (missing.length) {
    console.log(`  Sounds: MISSING ${missing.join(', ')}`);
    console.log(`  Expected in ${SOUND_DIR}`);
  } else {
    console.log(`  Sounds: ${SOUND_FILES.join(', ')} found`);
  }

  console.log('');
  console.log('  Heads up: browsers only allow microphone access on');
  console.log('  localhost or HTTPS. On another computer, open');
  console.log('  chrome://flags/#unsafely-treat-insecure-origin-as-secure');
  console.log(`  and add the http://${lan[0] || 'YOUR-IP'}:${PORT} address.`);
  console.log('');

  if (turnHost) startTurn(lan);
  else detectPublicIp((ip) => {
    if (!ip) {
      console.log('  TURN: off. Could not learn the public IP (no internet?). Direct calls only.');
      console.log('');
      return;
    }
    turnHost = ip;
    startTurn(lan);
    watchPublicIp();
  });
});