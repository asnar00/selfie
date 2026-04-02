const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const https = require('https');
const crypto = require('crypto');
const { Vonage } = require('@vonage/server-sdk');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  });
}

const app = express();
const PORT = 8083;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const VERSION_PATH = path.join(__dirname, 'version.json');
const USERS_PATH = path.join(__dirname, 'users.json');

// ---- Vonage SMS ----
const vonage = new Vonage({
  apiKey: process.env.VONAGE_API_KEY,
  apiSecret: process.env.VONAGE_API_SECRET
});

// ---- Users & Auth ----
function getUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8')); }
  catch { return {}; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(users, null, 2));
}

function findUserByPhone(phone) {
  const users = getUsers();
  for (const [name, info] of Object.entries(users)) {
    const p = typeof info === 'string' ? info : info.phone;
    if (normalisePhone(p) === normalisePhone(phone)) return { name, ...( typeof info === 'object' ? info : { phone: p }) };
  }
  return null;
}

function normalisePhone(phone) {
  if (!phone) return '';
  let p = phone.replace(/[\s\-()]/g, '');
  if (p.startsWith('0')) p = '44' + p.slice(1);
  if (!p.startsWith('+')) p = '+' + p;
  return p;
}

// Pending SMS codes: phone -> { code, expires }
const pendingCodes = new Map();

// Active tokens: token -> { phone, name, issuedAt }
const AUTH_TOKENS_PATH = path.join(__dirname, 'auth-tokens.json');

function getTokens() {
  try { return JSON.parse(fs.readFileSync(AUTH_TOKENS_PATH, 'utf8')); }
  catch { return {}; }
}

function saveTokens(tokens) {
  fs.writeFileSync(AUTH_TOKENS_PATH, JSON.stringify(tokens, null, 2));
}

function createToken(phone, name) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokens = getTokens();
  tokens[token] = { phone, name, issuedAt: new Date().toISOString() };
  saveTokens(tokens);
  return token;
}

function validateToken(token) {
  if (!token) return null;
  const tokens = getTokens();
  return tokens[token] || null;
}

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---- Version (counter that only bumps on code changes) ----
function computeContentHash() {
  const hash = crypto.createHash('md5');
  const files = [
    path.join(__dirname, 'server.js'),
    ...fs.readdirSync(path.join(__dirname, 'public'))
      .filter(f => /\.(html|js|css|json)$/.test(f))
      .map(f => path.join(__dirname, 'public', f))
  ];
  for (const f of files) {
    try { hash.update(fs.readFileSync(f)); } catch {}
  }
  return hash.digest('hex');
}
function getAppVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8'));
    if (v.hash === computeContentHash()) return v.version;
    const next = (v.version || 0) + 1;
    fs.writeFileSync(VERSION_PATH, JSON.stringify({ version: next, hash: computeContentHash() }));
    return next;
  } catch {
    fs.writeFileSync(VERSION_PATH, JSON.stringify({ version: 1, hash: computeContentHash() }));
    return 1;
  }
}
const APP_VERSION = getAppVersion();

// ---- Logging ----
function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}
function logErr(...args) {
  console.error(`[${new Date().toISOString()}] ERROR`, ...args);
}

// Log all requests
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Catch uncaught errors
process.on('uncaughtException', (err) => {
  logErr('Uncaught exception:', err.stack || err.message);
});
process.on('unhandledRejection', (err) => {
  logErr('Unhandled rejection:', err.stack || err.message);
});

// ---- Reverse geocoding ----
function reverseGeocode(lat, lon) {
  return new Promise((resolve) => {
    if (!lat || !lon) return resolve(null);
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
    https.get(url, { headers: { 'User-Agent': 'fieldnote/1.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function buildAddress(geo) {
  if (!geo || !geo.address) return null;
  return geo.address.road || null;
}

function buildWhisperPrompt(geo) {
  if (!geo || !geo.address) return '';
  const a = geo.address;
  const parts = [a.road, a.quarter, a.suburb, a.city, a.state, a.country].filter(Boolean);
  return `Recording near ${parts.join(', ')}.`;
}

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (_req, file, cb) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    cb(null, `${ts}.webm`);
  }
});
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } });

app.use(express.json());

// ---- Login page ----
app.get('/@login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// ---- SMS auth endpoints ----
app.post('/api/auth/send-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone number required' });

  const user = findUserByPhone(phone);
  if (!user) return res.status(403).json({ error: 'Not an authorised user' });

  const code = String(Math.floor(1000 + Math.random() * 9000));
  pendingCodes.set(normalisePhone(phone), { code, expires: Date.now() + 5 * 60 * 1000, attempts: 0 });

  try {
    await vonage.sms.send({
      to: normalisePhone(phone).replace('+', ''),
      from: 'Fieldnote',
      text: `Your Fieldnote login code is: ${code}`
    });
    log(`SMS code sent to ${normalisePhone(phone)} for ${user.name}`);
    res.json({ ok: true, name: user.name });
  } catch (e) {
    logErr('SMS send error:', e.message);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

app.post('/api/auth/verify', (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code required' });

  const norm = normalisePhone(phone);
  const pending = pendingCodes.get(norm);
  if (!pending) return res.status(403).json({ error: 'No code pending — request a new one' });
  pending.attempts = (pending.attempts || 0) + 1;
  if (pending.attempts > 3) {
    pendingCodes.delete(norm);
    log(`Too many attempts for ${norm}, code invalidated`);
    return res.status(403).json({ error: 'Too many attempts — request a new code' });
  }
  if (pending.code !== code) return res.status(403).json({ error: 'Invalid code' });
  if (Date.now() > pending.expires) {
    pendingCodes.delete(norm);
    return res.status(403).json({ error: 'Code expired' });
  }
  pendingCodes.delete(norm);

  const user = findUserByPhone(phone);
  const token = createToken(norm, user ? user.name : 'unknown');
  log(`User ${user ? user.name : norm} authenticated`);
  res.cookie('authToken', token, { httpOnly: false, maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax' });
  res.json({ ok: true, token, name: user ? user.name : 'unknown' });
});

app.get('/api/auth/check', (req, res) => {
  const token = req.headers['x-auth-token'];
  const user = validateToken(token);
  if (user) return res.json({ ok: true, name: user.name });
  res.status(401).json({ error: 'Not authenticated' });
});

// ---- Invite endpoint ----
app.post('/api/invite', async (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!validateToken(token)) return res.status(401).json({ error: 'Not authenticated' });

  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

  const norm = normalisePhone(phone);
  const users = getUsers();
  users[name] = { phone: norm };
  saveUsers(users);
  log(`User invited: ${name} (${norm})`);

  // Send SMS with login link (use friendly domain, not punycode)
  const loginUrl = `https://fieldnote.nøøb.org/@login?phone=${encodeURIComponent(phone)}`;
  try {
    await vonage.sms.send({
      to: norm.replace('+', ''),
      from: 'Fieldnote',
      text: `Hi ${name}! You've been invited to Fieldnote. Tap to join: ${loginUrl}`
    });
    log(`Invite SMS sent to ${norm}`);
    res.json({ ok: true, smsSent: true });
  } catch (e) {
    logErr('Invite SMS error:', e.message);
    res.json({ ok: true, smsSent: false });
  }
});

app.get('/api/users', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (!validateToken(token)) return res.status(401).json({ error: 'Not authenticated' });
  const users = getUsers();
  const names = Object.keys(users);
  res.json(names);
});

// ---- Auth middleware (protect everything below) ----
const PUBLIC_PATHS = ['/@login', '/api/auth/', '/manifest.json', '/sw.js', '/icon-', '/install', '/@restart'];

app.use((req, res, next) => {
  // Allow public paths
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();
  // Allow static assets (css, js, fonts, images)
  if (/\.(css|js|woff2?|png|jpg|svg|ico)$/.test(req.path)) return next();

  const token = req.headers['x-auth-token'] || req.query.token || parseCookie(req.headers.cookie, 'authToken');
  if (validateToken(token)) return next();

  // For page requests, redirect to login
  if (req.accepts('html')) return res.redirect('/@login');
  // For API requests, return 401
  res.status(401).json({ error: 'Not authenticated' });
});

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// ---- Client log endpoint ----
app.post('/api/log', (req, res) => {
  const user = validateToken(req.headers['x-auth-token'] || req.query.token || parseCookie(req.headers.cookie, 'authToken'));
  const name = user ? user.name : '?';
  const entries = req.body;
  if (Array.isArray(entries)) {
    entries.forEach(e => log(`[client:${name}] ${e.level || 'log'}: ${e.msg}`));
  }
  res.json({ ok: true });
});

// ---- Authenticated routes below ----

// Main page (map + recording)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'map.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  index: false,
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Pre-upload: create a pending record so we know if the upload gets lost
app.post('/api/pre-upload', (req, res) => {
  const { lat, lon, duration, size, timestamp } = req.body;
  const ts = (timestamp || new Date().toISOString()).replace(/[:.]/g, '-').replace('Z', '') + 'Z';
  const pendingPath = path.join(UPLOADS_DIR, `pending-${ts}.json`);
  fs.writeFileSync(pendingPath, JSON.stringify({
    status: 'pending',
    lat: lat || null,
    lon: lon || null,
    duration: duration || null,
    expectedSize: size || null,
    timestamp: timestamp || new Date().toISOString()
  }, null, 2));
  log(`Pre-upload registered: ${duration}s, ${(size/1024/1024).toFixed(1)}MB, lat=${lat} lon=${lon}`);
  res.json({ ok: true });
});

app.post('/upload', (req, res, next) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      logErr('Upload error:', err.message);
      return res.status(500).json({ error: err.message });
    }
    next();
  });
}, (req, res) => {
  const { lat, lon, recorded_at } = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'No video file' });

  const videoPath = req.file.path;
  const metaPath = req.file.path.replace(/\.webm$/, '.json');

  // Write metadata — use client's recording timestamp if available
  const authUser = validateToken(req.headers['x-auth-token'] || req.query.token || parseCookie(req.headers.cookie, 'authToken'));
  fs.writeFileSync(metaPath, JSON.stringify({
    lat: parseFloat(lat) || null,
    lon: parseFloat(lon) || null,
    timestamp: recorded_at || new Date().toISOString(),
    uploaded_at: new Date().toISOString(),
    filename: req.file.filename,
    size: req.file.size,
    user: authUser ? authUser.name : null,
    ip: req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip
  }, null, 2));

  log(`Upload received: ${req.file.filename} (${(req.file.size/1024/1024).toFixed(1)}MB) lat=${lat} lon=${lon}`);

  // Clear any pending records
  fs.readdirSync(UPLOADS_DIR).filter(f => f.startsWith('pending-')).forEach(f => {
    try { fs.unlinkSync(path.join(UPLOADS_DIR, f)); } catch {}
  });

  // Extract thumbnail (skip for audio-only files)
  const thumbPath = videoPath.replace(/\.webm$/, '.jpg');
  execFile('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', videoPath], { timeout: 10000 }, (probeErr, probeOut) => {
    const hasVideo = probeOut && probeOut.trim() === 'video';
    if (!hasVideo) {
      log(`Audio-only file ${req.file.filename}, skipping thumbnail`);
      return;
    }
    execFile('ffmpeg', ['-i', videoPath, '-ss', '0.5', '-vframes', '1', '-q:v', '4', thumbPath, '-y'], { timeout: 30000 }, (err) => {
      if (err) {
        logErr(`Thumbnail error for ${req.file.filename}:`, err.message);
      } else {
        log(`Thumbnail created for ${req.file.filename}`);
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          meta.thumbnail = req.file.filename.replace(/\.webm$/, '.jpg');
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        } catch {}
      }
    });
  });

  // Reverse geocode then transcribe
  reverseGeocode(parseFloat(lat), parseFloat(lon)).then(geo => {
    const address = buildAddress(geo);
    const prompt = buildWhisperPrompt(geo);

    // Save address to metadata
    if (address) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.address = address;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        log(`Geocoded ${req.file.filename}: ${address}`);
      } catch {}
    }

    // Transcribe with location context
    const transcribeScript = path.join(__dirname, 'transcribe.py');
    const python = path.join(__dirname, 'venv', 'bin', 'python3');
    const args = [transcribeScript, videoPath];
    if (prompt) args.push(prompt);
    log(`Transcribing ${req.file.filename} (prompt: "${prompt}")...`);
    execFile(python, args, { timeout: 600000 }, (err, stdout) => {
      if (err) {
        logErr(`Transcription error for ${req.file.filename}:`, err.message);
        return;
      }
      try {
        const { text } = JSON.parse(stdout);
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.transcript = text;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        log(`Transcribed ${req.file.filename}: "${text}"`);
        broadcast('new-upload', { filename: req.file.filename });
        generateReport();
      } catch (e) {
        logErr(`Failed to parse transcription for ${req.file.filename}:`, e.message);
      }
    });
  });

  broadcast('new-upload', { filename: req.file.filename });
  res.json({ ok: true, filename: req.file.filename });
});

// Install page
app.get('/install', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'install.html'));
});

app.get('/map', (_req, res) => res.redirect('/'));

// Report page
app.get('/report', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'report.html'));
});

// Serve uploaded videos
app.use('/videos', express.static(UPLOADS_DIR));

// API: list all uploads with metadata
app.get('/api/uploads', (_req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR).filter(f => f.endsWith('.json'));
  const entries = files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(UPLOADS_DIR, f), 'utf8'));
    } catch { return null; }
  }).filter(e => e && e.lat != null && e.lon != null);
  res.json(entries);
});

// ---- Report generation ----
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic();
const REPORT_PATH = path.join(__dirname, 'report.json');

function getEntries() {
  const files = fs.readdirSync(UPLOADS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('pending-'));
  return files.map(f => {
    try { return JSON.parse(fs.readFileSync(path.join(UPLOADS_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(e => e && e.transcript).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function formatTranscripts(entries) {
  return entries.map(e => {
    const d = new Date(e.timestamp);
    const time = d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `[${time}, ${e.address || 'unknown location'}]\n${e.transcript}`;
  }).join('\n\n');
}

function findLatestSession(entries) {
  if (!entries.length) return [];
  // Latest session = all entries from the most recent day
  const lastDate = new Date(entries[entries.length - 1].timestamp).toDateString();
  return entries.filter(e => new Date(e.timestamp).toDateString() === lastDate);
}

let reportGenerating = false;

async function generateReport() {
  if (reportGenerating) return;
  reportGenerating = true;
  try {
    const allEntries = getEntries();
    if (!allEntries.length) return;
    const latestSession = findLatestSession(allEntries);

    const latestTranscripts = formatTranscripts(latestSession);
    const allTranscripts = formatTranscripts(allEntries);
    const singleSession = latestSession.length === allEntries.length;

    const sessionDate = new Date(latestSession[0].timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `You are analysing field recordings from political canvassing sessions. The recordings are audio notes taken by canvassers as they go door-to-door. Some recordings contain actual voter feedback; others are just logistics, testing, or personal chatter — ignore those.

Important context:
- Canvassers only record when something is noteworthy. Not every voter contact results in a recording, so a small number of recordings does not imply a small number of contacts. Do not comment on the volume of recordings or suggest the data is limited.
- Read every transcript carefully. If a voter raises a concern (e.g. service charges, local issues), it MUST appear in the Voter Concerns section. Do not miss any.

${singleSession ? `
Produce a single report for this canvassing session:

# ${sessionDate}

Recordings:

${allTranscripts}

Report the following (omit any section heading if there is genuinely nothing for it):
- **Voter Concerns** — Each distinct issue raised by a voter, with location and brief detail.
- **Positive Responses** — Any positive interactions or support expressed.
- **Strategic Notes** — Patterns, recommended follow-ups, timing observations, areas to revisit.
- **Summary** — 2-3 sentence summary.
` : `
Produce a report with TWO sections:

# ${sessionDate}

These are the recordings from the most recent canvassing day:

${latestTranscripts}

Report the following (omit any section heading if there is genuinely nothing for it):
- **Voter Concerns** — Each distinct issue raised by a voter, with location and brief detail.
- **Positive Responses** — Any positive interactions or support expressed.
- **Strategic Notes** — Patterns, recommended follow-ups, timing observations, areas to revisit.
- **Session Summary** — 2-3 sentence summary.

---

# Cumulative Report — All Sessions

All recordings to date:

${allTranscripts}

Report the following:
- **All Voter Concerns** — Complete list of every issue raised by voters across all sessions.
- **All Positive Responses** — All positive interactions recorded.
- **Recurring Themes** — Issues or patterns that appear across multiple sessions or locations.
- **Strategic Recommendations** — Overall recommendations based on all data collected.
- **Overall Summary** — 2-3 sentence summary of all canvassing to date.
`}`
      }]
    });

    const report = message.content[0].text;
    fs.writeFileSync(REPORT_PATH, JSON.stringify({
      report,
      generatedAt: new Date().toISOString(),
      entryCount: allEntries.length
    }, null, 2));
    log(`Report generated and saved (${allEntries.length} entries)`);
  } catch (e) {
    logErr('Report generation error:', e.message);
  } finally {
    reportGenerating = false;
  }
}

app.post('/api/report/generate', async (_req, res) => {
  await generateReport();
  res.json({ ok: true });
});

app.get('/api/report', (_req, res) => {
  if (fs.existsSync(REPORT_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
      return res.json(cached);
    } catch {}
  }
  res.json({ report: 'No report available yet. Record a video and a report will be generated automatically.' });
});

// SSE for live updates
const sseClients = new Map(); // res -> { id, lat, lon, lastSeen }
let clientIdCounter = 0;

app.get('/api/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.flushHeaders();
  const clientId = ++clientIdCounter;
  const authUser = validateToken(req.query.token || parseCookie(req.headers.cookie, 'authToken'));
  const userName = authUser ? authUser.name : '?';
  sseClients.set(res, { id: clientId, name: userName, lat: null, lon: null, lastSeen: Date.now() });
  res.write(`event: welcome\ndata: ${JSON.stringify({ id: clientId })}\n\n`);
  log(`SSE client ${clientId} connected (${sseClients.size} total)`);
  req.on('close', () => {
    sseClients.delete(res);
    log(`SSE client ${clientId} disconnected (${sseClients.size} total)`);
    broadcastLocations();
  });
});

// Client location updates
app.post('/api/location', (req, res) => {
  const { id, lat, lon } = req.body;
  for (const [sseRes, info] of sseClients) {
    if (info.id === id) {
      info.lat = lat;
      info.lon = lon;
      info.lastSeen = Date.now();
      break;
    }
  }
  broadcastLocations();
  res.json({ ok: true });
});

function broadcastLocations() {
  const locations = [];
  for (const [, info] of sseClients) {
    if (info.lat != null && info.lon != null) {
      locations.push({ id: info.id, name: info.name, lat: info.lat, lon: info.lon });
    }
  }
  broadcast('locations', locations);
}

function broadcast(event, data) {
  for (const [client] of sseClients) {
    client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

// Version endpoint
app.get('/api/version', (_req, res) => {
  res.json({ version: APP_VERSION });
});

// Restart endpoint
app.post('/@restart', (_req, res) => {
  res.json({ ok: true, restarting: true });
  log('Restarting server...');
  // Close SSE connections so server.close() doesn't hang
  for (const [client] of sseClients) { client.end(); }
  sseClients.clear();
  server.close(() => {
    const { spawn } = require('child_process');
    const child = spawn(process.argv[0], process.argv.slice(1), {
      stdio: 'inherit',
      detached: true,
      cwd: process.cwd()
    });
    child.unref();
    // Give child a moment to bind the port before we exit
    setTimeout(() => process.exit(0), 500);
  });
  // Failsafe: if server.close hangs, force exit after 3s
  setTimeout(() => { log('Forced exit'); process.exit(1); }, 3000);
});

const server = app.listen(PORT, () => {
  log(`Fieldnote server running on http://localhost:${PORT}`);
});
