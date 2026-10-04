// UCHAT signaling + matchmaking server
// Pairs strangers by mutual filters (gender, age range, country, language)
// and relays WebRTC signaling. Video itself flows peer-to-peer.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
// For local testing only: unlocks premium (gender) filters for everyone.
const PREMIUM_DEV_MODE = process.env.PREMIUM_DEV_MODE === 'true';
const REPORTS_TO_BAN = Number(process.env.REPORTS_TO_BAN || 3);
const MIN_AGE = 18;
const MAX_AGE = 99;

const GENDERS = ['male', 'female', 'other'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, online: io.engine.clientsCount }));

// ---- State (in memory; move to Redis for multiple servers) ----
const waiting = new Map();   // socketId -> socket
const partners = new Map();  // socketId -> partner socketId
const reportCounts = new Map(); // ip -> number of reports received
const bannedIps = new Set();

// ---- Helpers ----
function clientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0] : socket.handshake.address).trim();
}

function code(v) {
  return typeof v === 'string' && /^[a-z]{2}$/i.test(v) ? v.toLowerCase() : null;
}

function codeList(arr, max = 10) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map(code).filter(Boolean))].slice(0, max);
}

function clampAge(n, fallback) {
  n = parseInt(n, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(MAX_AGE, Math.max(MIN_AGE, n));
}

function ageFromDob(dob) {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

function isPremium(socket) {
  // TODO: replace with a real check (Stripe subscription tied to a user account).
  return PREMIUM_DEV_MODE || socket.data.premium === true;
}

function parseJoin(socket, data) {
  if (!data || typeof data !== 'object') return { error: 'Invalid data.' };
  const p = data.profile || {};
  const q = data.prefs || {};

  if (p.confirmedAdult !== true) return { error: 'You must confirm you are 18 or older.' };
  const age = ageFromDob(p.dob);
  if (age === null || age < MIN_AGE) return { error: 'UCHAT is for adults 18+ only.' };
  if (age > 120) return { error: 'Invalid date of birth.' };

  const gender = GENDERS.includes(p.gender) ? p.gender : null;
  const country = code(p.country);
  const language = code(p.language);
  if (!gender || !country || !language) return { error: 'Please complete your profile.' };

  let ageMin = clampAge(q.ageMin, MIN_AGE);
  let ageMax = clampAge(q.ageMax, MAX_AGE);
  if (ageMin > ageMax) [ageMin, ageMax] = [ageMax, ageMin];

  let genders = Array.isArray(q.genders) ? q.genders.filter((g) => GENDERS.includes(g)) : [];
  let premiumBlocked = false;
  if (genders.length && !isPremium(socket)) {
    genders = []; // gender filter is a paid feature
    premiumBlocked = true;
  }

  const premium = isPremium(socket);
  // Free users get one country and one language filter; premium gets several.
  const maxMulti = premium ? 10 : 1;

  return {
    profile: { gender, age, country, language },
    prefs: {
      genders,
      ageMin,
      ageMax,
      countries: codeList(q.countries, maxMulti),
      languages: codeList(q.languages, maxMulti),
    },
    premiumBlocked,
  };
}

// Does user A accept user B?
function wants(a, b) {
  const p = a.data.prefs;
  const t = b.data.profile;
  if (p.genders.length && !p.genders.includes(t.gender)) return false;
  if (t.age < p.ageMin || t.age > p.ageMax) return false;
  if (p.countries.length && !p.countries.includes(t.country)) return false;
  if (p.languages.length && !p.languages.includes(t.language)) return false;
  return true;
}

function compatible(a, b) {
  if (a.id === b.id) return false;
  if (a.data.ip === b.data.ip && process.env.ALLOW_SAME_IP !== 'true') return false;
  if (a.data.recent.has(b.id) || b.data.recent.has(a.id)) return false;
  return wants(a, b) && wants(b, a);
}

function remember(a, b) {
  for (const [x, y] of [[a, b], [b, a]]) {
    x.data.recent.add(y.id);
    if (x.data.recent.size > 5) x.data.recent.delete(x.data.recent.values().next().value);
  }
}

function endChat(socket, notifyPartner = true) {
  const pid = partners.get(socket.id);
  if (!pid) return;
  partners.delete(socket.id);
  partners.delete(pid);
  const partner = io.sockets.sockets.get(pid);
  if (partner && notifyPartner) partner.emit('partner-left');
}

function findMatch(socket) {
  endChat(socket);
  waiting.delete(socket.id);

  for (const [id, other] of waiting) {
    if (!other.connected) { waiting.delete(id); continue; }
    if (compatible(socket, other)) {
      waiting.delete(id);
      partners.set(socket.id, other.id);
      partners.set(other.id, socket.id);
      remember(socket, other);
      const info = (s) => ({ country: s.data.profile.country, language: s.data.profile.language });
      socket.emit('matched', { initiator: true, partner: info(other) });
      other.emit('matched', { initiator: false, partner: info(socket) });
      return;
    }
  }
  waiting.set(socket.id, socket);
  socket.emit('waiting', { queue: waiting.size });
}

// ---- Socket handlers ----
io.on('connection', (socket) => {
  socket.data.ip = clientIp(socket);
  socket.data.recent = new Set();
  socket.data.lastFind = 0;

  if (bannedIps.has(socket.data.ip)) {
    socket.emit('banned');
    return socket.disconnect(true);
  }

  socket.on('join', (data) => {
    const parsed = parseJoin(socket, data);
    if (parsed.error) return socket.emit('join-error', parsed.error);
    socket.data.profile = parsed.profile;
    socket.data.prefs = parsed.prefs;
    socket.emit('joined', { premium: isPremium(socket), premiumBlocked: parsed.premiumBlocked });
  });

  socket.on('find', () => {
    if (!socket.data.profile) return socket.emit('join-error', 'Complete your profile first.');
    const now = Date.now();
    if (now - socket.data.lastFind < 800) return; // basic anti-spam on "Next"
    socket.data.lastFind = now;
    findMatch(socket);
  });

  socket.on('signal', (msg) => {
    const pid = partners.get(socket.id);
    if (pid) io.to(pid).emit('signal', msg);
  });

  socket.on('chat', (text) => {
    const pid = partners.get(socket.id);
    if (!pid || typeof text !== 'string') return;
    const clean = text.trim().slice(0, 500);
    if (clean) io.to(pid).emit('chat', clean);
  });

  socket.on('report', (reason) => {
    const pid = partners.get(socket.id);
    if (!pid) return;
    const partner = io.sockets.sockets.get(pid);
    endChat(socket);
    if (partner) {
      const ip = partner.data.ip;
      const count = (reportCounts.get(ip) || 0) + 1;
      reportCounts.set(ip, count);
      // TODO: persist reports + send to a human moderation queue.
      console.log(`[report] ${ip} reason=${String(reason).slice(0, 50)} count=${count}`);
      if (count >= REPORTS_TO_BAN) {
        bannedIps.add(ip);
        partner.emit('banned');
        partner.disconnect(true);
      }
    }
    socket.emit('reported');
  });

  socket.on('stop', () => {
    endChat(socket);
    waiting.delete(socket.id);
  });

  socket.on('disconnect', () => {
    endChat(socket);
    waiting.delete(socket.id);
  });
});

setInterval(() => io.emit('online', io.engine.clientsCount), 10000);

server.listen(PORT, () => {
  console.log(`UCHAT running on http://localhost:${PORT}${PREMIUM_DEV_MODE ? ' (premium dev mode)' : ''}`);
});
