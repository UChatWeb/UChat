// UCHAT client: profile/filters, WebRTC video, text chat, next/report/stop.

const COUNTRIES = [
  ['us','United States'],['gb','United Kingdom'],['ca','Canada'],['au','Australia'],['in','India'],
  ['pk','Pakistan'],['ae','United Arab Emirates'],['sa','Saudi Arabia'],['eg','Egypt'],['ma','Morocco'],
  ['tr','Turkey'],['de','Germany'],['fr','France'],['es','Spain'],['it','Italy'],['nl','Netherlands'],
  ['pl','Poland'],['ru','Russia'],['ua','Ukraine'],['br','Brazil'],['mx','Mexico'],['ar','Argentina'],
  ['co','Colombia'],['ph','Philippines'],['id','Indonesia'],['my','Malaysia'],['th','Thailand'],
  ['vn','Vietnam'],['jp','Japan'],['kr','South Korea'],['cn','China'],['ng','Nigeria'],['za','South Africa'],
  ['ke','Kenya'],['bd','Bangladesh'],['ir','Iran'],['se','Sweden'],['pt','Portugal'],['ro','Romania'],['nz','New Zealand']
].sort((a, b) => a[1].localeCompare(b[1]));

const LANGUAGES = [
  ['en','English'],['ar','Arabic'],['hi','Hindi'],['ur','Urdu'],['es','Spanish'],['fr','French'],
  ['de','German'],['pt','Portuguese'],['ru','Russian'],['tr','Turkish'],['it','Italian'],['nl','Dutch'],
  ['pl','Polish'],['uk','Ukrainian'],['fa','Persian'],['bn','Bengali'],['id','Indonesian'],['ms','Malay'],
  ['tl','Filipino'],['th','Thai'],['vi','Vietnamese'],['ja','Japanese'],['ko','Korean'],['zh','Chinese'],['sw','Swahili']
].sort((a, b) => a[1].localeCompare(b[1]));

const $ = (id) => document.getElementById(id);
const nameOf = (list, code) => (list.find(([c]) => c === code) || [code, code.toUpperCase()])[1];

function fillSelect(sel, list) {
  if (sel.classList.contains('anyOption')) sel.add(new Option('Anyone', ''));
  else sel.add(new Option('Select…', ''));
  list.forEach(([code, name]) => sel.add(new Option(name, code)));
}
document.querySelectorAll('.countryList').forEach((s) => fillSelect(s, COUNTRIES));
document.querySelectorAll('.languageList').forEach((s) => fillSelect(s, LANGUAGES));

// Remember the user's profile on this device for convenience.
try {
  const saved = JSON.parse(localStorage.getItem('uchat-profile') || 'null');
  if (saved) for (const k of ['dob','gender','country','language']) if (saved[k]) $(k).value = saved[k];
} catch (_) {}

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Production: add a TURN server, e.g.
  // { urls: 'turn:turn.yourdomain.com:3478', username: 'user', credential: 'pass' }
];

const socket = io({ autoConnect: false });
let localStream = null;
let pc = null;
let pendingCandidates = [];
let active = false;

socket.on('online', (n) => ($('onlineCount').textContent = n));

function showError(msg) {
  $('error').textContent = msg;
  $('error').hidden = false;
}

function addMessage(text, who) {
  const div = document.createElement('div');
  div.className = 'msg ' + who;
  if (who === 'sys') div.textContent = text;
  else {
    const b = document.createElement('b');
    b.textContent = who === 'me' ? 'You: ' : 'Stranger: ';
    div.append(b, document.createTextNode(text));
  }
  $('messages').append(div);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function setStatus(text) {
  $('status').textContent = text;
  $('status').hidden = !text;
}

// ---- Setup form ----
$('termsLink').onclick = (e) => { e.preventDefault(); $('terms').showModal(); };
$('closeTerms').onclick = () => $('terms').close();
$('closePaywall').onclick = () => $('paywall').close();

$('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').hidden = true;

  const profile = {
    dob: $('dob').value,
    gender: $('gender').value,
    country: $('country').value,
    language: $('language').value,
    confirmedAdult: $('adult').checked,
  };
  const prefs = {
    ageMin: $('ageMin').value,
    ageMax: $('ageMax').value,
    countries: $('prefCountry').value ? [$('prefCountry').value] : [],
    languages: $('prefLanguage').value ? [$('prefLanguage').value] : [],
    genders: [...document.querySelectorAll('input[name=prefGender]:checked')].map((i) => i.value),
  };

  try {
    localStream = localStream || await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    return showError('Please allow camera and microphone access to use UCHAT.');
  }
  $('localVideo').srcObject = localStream;

  try { localStorage.setItem('uchat-profile', JSON.stringify({ dob: profile.dob, gender: profile.gender, country: profile.country, language: profile.language })); } catch (_) {}

  if (!socket.connected) socket.connect();
  socket.emit('join', { profile, prefs });
});

socket.on('join-error', (msg) => {
  showError(msg);
  $('setup').hidden = false;
  $('chat').hidden = true;
});

socket.on('joined', ({ premiumBlocked }) => {
  $('setup').hidden = true;
  $('chat').hidden = false;
  if (premiumBlocked) {
    $('paywall').showModal();
    addMessage('Gender filter is a Plus feature — matching with everyone for now.', 'sys');
  }
  active = true;
  socket.emit('find');
});

// ---- WebRTC ----
function closePeer() {
  if (pc) { pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null; pc.close(); }
  pc = null;
  pendingCandidates = [];
  $('remoteVideo').srcObject = null;
  $('partnerInfo').hidden = true;
}

function createPeer() {
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  pc.ontrack = (e) => { $('remoteVideo').srcObject = e.streams[0]; setStatus(''); };
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    if (pc && pc.connectionState === 'failed') {
      addMessage('Connection failed. Finding someone new…', 'sys');
      next();
    }
  };
}

async function flushCandidates() {
  for (const c of pendingCandidates) { try { await pc.addIceCandidate(c); } catch (_) {} }
  pendingCandidates = [];
}

socket.on('waiting', () => setStatus('Looking for someone who matches your filters…'));

socket.on('matched', async ({ initiator, partner }) => {
  closePeer();
  $('messages').innerHTML = '';
  addMessage('You are now chatting with a stranger. Say hi!', 'sys');
  $('partnerInfo').textContent = `${nameOf(COUNTRIES, partner.country)} · speaks ${nameOf(LANGUAGES, partner.language)}`;
  $('partnerInfo').hidden = false;
  setStatus('Connecting…');
  createPeer();
  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { description: pc.localDescription });
  }
});

socket.on('signal', async ({ description, candidate }) => {
  if (!pc) return;
  try {
    if (description) {
      await pc.setRemoteDescription(description);
      await flushCandidates();
      if (description.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { description: pc.localDescription });
      }
    } else if (candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else pendingCandidates.push(candidate);
    }
  } catch (err) {
    console.warn('Signaling error', err);
  }
});

socket.on('partner-left', () => {
  closePeer();
  addMessage('Stranger disconnected.', 'sys');
  if (active) setTimeout(() => socket.emit('find'), 600);
});

socket.on('reported', () => addMessage('Thanks — the user was reported. Finding someone new…', 'sys'));

socket.on('banned', () => {
  closePeer();
  active = false;
  document.body.innerHTML = '<main class="card"><h1>Access suspended</h1><p class="sub">Your access was suspended after multiple reports.</p></main>';
});

socket.on('chat', (text) => addMessage(text, 'them'));

// ---- Controls ----
function next() {
  closePeer();
  active = true;
  setStatus('Looking for someone…');
  socket.emit('find');
}

$('nextBtn').onclick = next;

$('stopBtn').onclick = () => {
  active = false;
  closePeer();
  socket.emit('stop');
  setStatus('Stopped. Press Next to start again.');
  addMessage('You left the chat.', 'sys');
};

$('reportBtn').onclick = () => {
  if (!pc) return;
  const reason = prompt('Why are you reporting? (e.g. nudity, underage, harassment)') || 'unspecified';
  closePeer();
  socket.emit('report', reason);
  setTimeout(() => active && socket.emit('find'), 600);
};

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text || !pc) return;
  socket.emit('chat', text);
  addMessage(text, 'me');
  $('chatInput').value = '';
});

// Keyboard shortcut: Esc = next
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('chat').hidden && document.activeElement !== $('chatInput')) next();
});
