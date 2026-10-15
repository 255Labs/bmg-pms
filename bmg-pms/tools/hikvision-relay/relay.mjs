// On-site Hikvision relay. Runs on any always-on PC or mini PC on the property LAN and forwards camera
// movement to the PMS, keeping it on disk while the internet is down. Two ways to get events, use either or both:
//
//   PULL (recommended): the relay logs in to each camera or NVR and reads its live event stream
//   (/ISAPI/Event/notification/alertStream, digest login). Works even when an NVR does not pass its
//   cameras' smart events on, by pointing at the camera itself (its own IP, or the NVR's Virtual Host port).
//
//     PMS_URL=https://<ref>.supabase.co/functions/v1/hikvision-ingest RELAY_KEY=<key> \
//     PULL_HOSTS=192.168.88.153,192.168.88.111:65001 HIK_USER=pms-relay HIK_PASS=<password> node relay.mjs
//
//   PUSH: the NVR or cameras send events here ("HTTP listening" / "Alarm server" → this PC, port 8090).
//     ... ALLOWED_IPS=192.168.88.111 PORT=8090 node relay.mjs        (PUSH=off turns the listener off)
//
// Options: HIK_PASS_<host with dots as _> a password for one device (HIK_PASS_192_168_88_153),
// HUMAN_ONLY=1 keep only detections the camera classed as a person (AcuSense), GAP_SECONDS=10 quiet time that
// ends a sighting, DEBUG=1 print every event the cameras send, TZ_OFFSET=+03:00 for clocks without a zone.
// PROPERTY_ID is only needed with the old shared HIKVISION_RELAY_KEY.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseAlerts, IGNORED, episodes } from '../../supabase/functions/_shared/hikvision.js';

// Settings come from the environment, or from relay.env next to this file (KEY=value lines; see relay.env.example)
const envFile = process.env.RELAY_ENV ?? fileURLToPath(new URL('./relay.env', import.meta.url));
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const env = process.env;
const { PMS_URL, RELAY_KEY, PROPERTY_ID, PORT = '8090', TZ_OFFSET = '+03:00', QUEUE_FILE = './relay-queue.json', ALLOWED_IPS = '' } = env;
const PULL_HOSTS = (env.PULL_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PUSH = (env.PUSH ?? (PULL_HOSTS.length ? 'off' : 'on')) !== 'off';
const HUMAN_ONLY = env.HUMAN_ONLY === '1';
const DEBUG = env.DEBUG === '1';
const GAP_MS = Number(env.GAP_SECONDS ?? 10) * 1000;
const FLUSH_MS = Number(env.FLUSH_SECONDS ?? 10) * 1000;

if (!PMS_URL || !RELAY_KEY) { console.error('Set PMS_URL and RELAY_KEY'); process.exit(1); }
if (!/^https:\/\//.test(PMS_URL) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(PMS_URL)) { console.error('PMS_URL must start with https://'); process.exit(1); }
if (!PUSH && !PULL_HOSTS.length) { console.error('Nothing to do: set PULL_HOSTS, or leave PUSH on'); process.exit(1); }
const allowed = ALLOWED_IPS.split(',').map((s) => s.trim()).filter(Boolean);
if (PUSH && !allowed.length) console.warn('ALLOWED_IPS is not set: any device on the network can post events. Set it to your NVR\'s IP.');

const MAX_BODY = 1_000_000;     // one pushed alert is a few KB
const MAX_QUEUE = 50_000;       // about a week of busy events; oldest dropped first
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- the queue (survives power cuts)
function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  try { const q = JSON.parse(readFileSync(QUEUE_FILE, 'utf8')); return Array.isArray(q) ? q.slice(-MAX_QUEUE) : []; }
  catch (e) { console.error('Queue file unreadable, starting empty:', e.message); return []; }
}
let queue = loadQueue();
const save = () => { writeFileSync(QUEUE_FILE + '.tmp', JSON.stringify(queue)); renameSync(QUEUE_FILE + '.tmp', QUEUE_FILE); };
const withZone = (t) => (/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t + TZ_OFFSET);

// One sighting per person passing: repeats are grouped, and the sighting is queued when it ends
const sightings = episodes({
  gapMs: GAP_MS,
  onClose: (a) => {
    queue.push({ device: a.device, channel: a.channel, event_type: a.event_type, time: withZone(a.time), ended: a.ended ? withZone(a.ended) : null,
      target: a.target, hits: a.hits, seconds: a.seconds, description: String(a.description ?? '').slice(0, 200) });
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    save();
    if (DEBUG) log('sighting', a.device, 'ch', a.channel, a.event_type, a.target ?? '', `${a.hits} hits`);
  },
});
setInterval(() => sightings.sweep(), 1000).unref();

function take(alerts, from) {
  for (const a of alerts) {
    if (DEBUG) log(from, 'event', a.event_type, a.state, 'ch', a.channel ?? '-', a.target ?? '');
    if (!a.channel || !a.time || IGNORED.has(a.event_type)) continue;
    if (HUMAN_ONLY && a.target && a.target !== 'human') continue;
    sightings.add(a);
  }
}

// ---------------------------------------------------------------- PUSH: devices post to us
if (PUSH) {
  const clientIp = (req) => String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  http.createServer((req, res) => {
    if (allowed.length && !allowed.includes(clientIp(req))) { res.writeHead(403).end(); req.destroy(); return; }
    if (req.method !== 'POST' && req.method !== 'PUT') { res.writeHead(405).end(); return; }
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      try { take(parseAlerts(Buffer.concat(chunks).toString('latin1')), clientIp(req)); res.writeHead(200).end('OK'); }
      catch (e) { console.error('Could not read an alert:', e.message); res.writeHead(400).end(); }
    });
    req.on('error', () => {});
  }).listen(Number(PORT), () => log(`Listening for pushed events on :${PORT}`));
}

// ---------------------------------------------------------------- PULL: we read each device's live stream
const md5 = (s) => createHash('md5').update(s).digest('hex');
function digestHeader(www, { user, pass, method, path }, nc) {
  const p = Object.fromEntries([...www.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1].toLowerCase(), m[2]]));
  const ha1 = md5(`${user}:${p.realm}:${pass}`), ha2 = md5(`${method}:${path}`);
  const cnonce = randomBytes(8).toString('hex'), n = String(nc).padStart(8, '0');
  const qop = (p.qop ?? '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : null;
  const response = qop ? md5(`${ha1}:${p.nonce}:${n}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${p.nonce}:${ha2}`);
  return `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", uri="${path}", response="${response}"`
    + (qop ? `, qop=${qop}, nc=${n}, cnonce="${cnonce}"` : '') + (p.opaque ? `, opaque="${p.opaque}"` : '') + (p.algorithm ? `, algorithm=${p.algorithm}` : '');
}

function get(host, path, headers) {
  const [hostname, port = '80'] = host.split(':');
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port: Number(port), path, method: 'GET', headers }, resolve);
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('no answer')));
    req.end();
  });
}

const STREAM = '/ISAPI/Event/notification/alertStream';
async function pull(host) {
  const key = 'HIK_PASS_' + host.replace(/[^\w]/g, '_');
  const cred = { user: env.HIK_USER ?? 'admin', pass: env[key] ?? env.HIK_PASS ?? '', method: 'GET', path: STREAM };
  if (!cred.pass) { console.error(`${host}: set HIK_PASS (or ${key})`); return; }
  let wait = 5000;
  for (;;) {
    try {
      let res = await get(host, STREAM, {});
      if (res.statusCode === 401 && /digest/i.test(res.headers['www-authenticate'] ?? '')) {
        const www = res.headers['www-authenticate']; res.resume();
        res = await get(host, STREAM, { authorization: digestHeader(www, cred, 1) });
      }
      if (res.statusCode === 401) { res.resume(); throw new Error('login refused: check HIK_USER and the password'); }
      if (res.statusCode !== 200) { res.resume(); throw new Error(`HTTP ${res.statusCode}`); }
      log(`${host}: connected, reading events`);
      wait = 5000;
      await new Promise((resolve, reject) => {
        let buf = '';
        let idle = setTimeout(() => res.destroy(new Error('silent for 90 s')), 90_000);
        res.setEncoding('latin1');                         // snapshots in the stream are binary; we only want the XML
        res.on('data', (chunk) => {
          clearTimeout(idle); idle = setTimeout(() => res.destroy(new Error('silent for 90 s')), 90_000);
          buf += chunk;
          const end = buf.lastIndexOf('</EventNotificationAlert>');
          if (end >= 0) { take(parseAlerts(buf.slice(0, end + 25)), host); buf = buf.slice(end + 25); }
          if (buf.length > 2_000_000) buf = buf.slice(-200_000);
        });
        res.on('end', () => { clearTimeout(idle); resolve(); });
        res.on('error', (e) => { clearTimeout(idle); reject(e); });
      });
      log(`${host}: stream ended, reconnecting`);
    } catch (e) {
      log(`${host}: ${e.message}; retrying in ${wait / 1000} s`);
      if (/login refused/.test(e.message)) wait = 60_000;
    }
    sightings.sweep(true);
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 60_000);
  }
}
for (const h of PULL_HOSTS) pull(h);

// ---------------------------------------------------------------- forward to the PMS
let sending = false;
async function flush() {
  if (!queue.length || sending) return;
  sending = true;
  const batch = queue.slice(0, 1000);
  try {
    const r = await fetch(PMS_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-relay-key': RELAY_KEY },
      body: JSON.stringify({ property_id: PROPERTY_ID || undefined, events: batch }), signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    queue = queue.slice(batch.length);
    save();
    log('sent', batch.length, 'sightings');
  } catch (e) {
    log('send failed, will retry:', e.message);
  } finally { sending = false; }
}
setInterval(flush, FLUSH_MS);

// Stopping the service: queue what is still open so it is not lost
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { sightings.sweep(true); process.exit(0); });
