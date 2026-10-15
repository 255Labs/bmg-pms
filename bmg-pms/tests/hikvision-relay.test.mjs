// Hikvision relay test: a fake camera with digest login streams events the way a real one does (heartbeats,
// a repeat every second while someone moves, several channels on one stream, a vehicle), and a fake PMS
// receives what the relay forwards. Run: node tests/hikvision-relay.test.mjs
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { episodes, parseAlerts } from '../supabase/functions/_shared/hikvision.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => createHash('md5').update(s).digest('hex');
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

const alert = (type, ch, state = 'active', target = 'human') => `--boundary\r\nContent-Type: application/xml; charset="UTF-8"\r\n\r\n<EventNotificationAlert version="1.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<ipAddress>192.168.88.153</ipAddress><portNo>80</portNo><protocol>HTTP</protocol><macAddress>08:cc:81:16:ff:14</macAddress>
<dynChannelID>${ch}</dynChannelID><dateTime>2026-10-04T20:45:${String(Math.floor(Math.random() * 50) + 10)}+03:00</dateTime><activePostCount>1</activePostCount>
<eventType>${type}</eventType><eventState>${state}</eventState><eventDescription>Motion alarm</eventDescription>${target ? `<targetType>${target}</targetType>` : ''}
</EventNotificationAlert>\r\n`;

console.log('Grouping repeats');
{
  let t = 0; const out = [];
  const ep = episodes({ gapMs: 10_000, now: () => t, onClose: (a) => out.push(a) });
  const a = (ch, state = 'active') => ({ ...parseAlerts(alert('VMD', ch, state))[0] });
  for (let i = 0; i < 6; i++) { ep.add(a(5)); if (i % 2) ep.add(a(2)); t += 1000; }
  ep.sweep(); ok('nothing closes while people are still moving', out.length === 0);
  t += 11_000; ep.sweep();
  ok('one sighting per camera after 10 s of quiet: channel 5 (6 hits) and channel 2 (3 hits), kept apart',
    out.length === 2 && out.find((x) => x.channel === '5').hits === 6 && out.find((x) => x.channel === '2').hits === 3);
  ok('the sighting keeps the person classification and its length', out[0].target === 'human' && out.find((x) => x.channel === '5').seconds === 5);
  ep.add(a(7)); ep.add(a(7, 'inactive'));
  ok('an "inactive" message ends the sighting at once', out.length === 3 && out[2].channel === '7');
}

// ---- fake camera: digest login, then a long-lived multipart stream
const USER = 'pms-relay', PASS = 'Str0ng-test-pass', REALM = 'DS-2CD2346', NONCE = 'abc123nonce';
let logins = 0, refused = 0, stream = null;
const camera = http.createServer((req, res) => {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Digest ')) { res.writeHead(401, { 'www-authenticate': `Digest qop="auth", realm="${REALM}", nonce="${NONCE}", stale="FALSE"` }).end(); return; }
  const p = Object.fromEntries([...auth.matchAll(/(\w+)="?([^",]*)"?/g)].map((m) => [m[1], m[2]]));
  const good = md5(`${md5(`${USER}:${REALM}:${PASS}`)}:${NONCE}:${p.nc}:${p.cnonce}:auth:${md5(`GET:${req.url}`)}`);
  if (p.username !== USER || p.response !== good || req.url !== '/ISAPI/Event/notification/alertStream') { refused++; res.writeHead(401).end(); return; }
  logins++;
  res.writeHead(200, { 'content-type': 'multipart/mixed; boundary=boundary' });
  stream = res;
});
const camPort = await listen(camera);

// ---- fake PMS
const received = [];
let keySeen = '';
const pms = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { keySeen = req.headers['x-relay-key']; received.push(...JSON.parse(b).events); res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'); });
});
const pmsPort = await listen(pms);

const dir = mkdtempSync(join(tmpdir(), 'relay-'));
const run = (extra) => {
  const p = spawn(process.execPath, [join(root, 'tools/hikvision-relay/relay.mjs')], {
    env: { ...process.env, PMS_URL: `http://127.0.0.1:${pmsPort}/ingest`, RELAY_KEY: 'relay-key-1', GAP_SECONDS: '1', FLUSH_SECONDS: '1', QUEUE_FILE: join(dir, `q-${Math.random()}.json`), ...extra },
    stdio: ['ignore', 'pipe', 'pipe'] });
  p.log = ''; p.stdout.on('data', (d) => { p.log += d; }); p.stderr.on('data', (d) => { p.log += d; });
  return p;
};

console.log('Reading a camera\'s live stream');
const r1 = run({ PULL_HOSTS: `127.0.0.1:${camPort}`, HIK_USER: USER, [`HIK_PASS_127_0_0_1_${camPort}`]: PASS, HUMAN_ONLY: '1' });
for (let i = 0; i < 40 && !stream; i++) await sleep(100);
ok('the relay logs in to the camera with digest authentication', logins === 1 && !!stream, r1.log);
stream.write(alert('videoloss', 3, 'inactive', null));
stream.write(`--boundary\r\nContent-Type: application/xml\r\n\r\n<EventNotificationAlert><eventType>heartBeat</eventType><eventState>active</eventState><dateTime>2026-10-04T20:45:00+03:00</dateTime></EventNotificationAlert>\r\n`);
for (let i = 0; i < 5; i++) {
  stream.write(alert('VMD', 5));
  if (i < 3) stream.write(alert('VMD', 2));
  stream.write(alert('VMD', 9, 'active', 'vehicle'));
  stream.write('--boundary\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8\xff\xe0binary-snapshot\x00\x01\r\n');
  await sleep(150);
}
for (let i = 0; i < 40 && received.length < 2; i++) await sleep(100);
await sleep(600);
ok('people passing become one sighting per camera, not one row per second', received.length === 2, JSON.stringify(received));
const c5 = received.find((e) => e.channel === '5'), c2 = received.find((e) => e.channel === '2');
ok('channel 5 and channel 2 on the same stream stay separate', c5?.hits === 5 && c2?.hits === 3);
ok('heartbeats, video loss and a vehicle (HUMAN_ONLY) are left out', !received.some((e) => ['9', '3'].includes(e.channel) || /heartbeat/i.test(e.event_type)));
ok('each sighting carries the device, event type, person class and Dar es Salaam time', c5?.device === '08:cc:81:16:ff:14' && c5?.event_type === 'vmd' && c5?.target === 'human' && /\+03:00$/.test(c5?.time));
ok('the relay sends with the property\'s relay key', keySeen === 'relay-key-1');
stream.destroy(); stream = null;
for (let i = 0; i < 80 && logins < 2; i++) await sleep(100);
ok('when the stream drops, the relay reconnects by itself', logins === 2, r1.log);
r1.kill();

console.log('Wrong password');
const before = received.length;
const r2 = run({ PULL_HOSTS: `127.0.0.1:${camPort}`, HIK_USER: USER, HIK_PASS: 'wrong' });
await sleep(1500);
ok('a wrong password is refused and reported plainly', refused >= 1 && /login refused/.test(r2.log) && received.length === before, r2.log);
r2.kill();

console.log('Events pushed by the NVR');
const PUSH_PORT = 18000 + Math.floor(Math.random() * 1000);
const r4 = run({ PUSH: 'on', PORT: String(PUSH_PORT), ALLOWED_IPS: '127.0.0.1' });
await sleep(500);
const post = (body) => new Promise((resolve) => { const q = http.request({ host: '127.0.0.1', port: PUSH_PORT, method: 'POST', path: '/' }, (res) => { res.resume(); resolve(res.statusCode); }); q.end(body); });
const st = [];
for (let i = 0; i < 4; i++) st.push(await post(alert('linedetection', 11)));
for (let i = 0; i < 40 && !received.some((e) => e.channel === '11'); i++) await sleep(100);
ok('four pushes of the same line crossing become one sighting', st.every((s) => s === 200) && received.filter((e) => e.channel === '11').length === 1 && received.find((e) => e.channel === '11').hits === 4);
r4.kill();
const r5 = run({ PUSH: 'on', PORT: String(PUSH_PORT + 1), ALLOWED_IPS: '10.0.0.9' });
await sleep(500);
const blocked = await new Promise((resolve) => { const q = http.request({ host: '127.0.0.1', port: PUSH_PORT + 1, method: 'POST', path: '/' }, (res) => { res.resume(); resolve(res.statusCode); }); q.on('error', () => resolve(0)); q.end(alert('VMD', 1)); });
ok('a device that is not in ALLOWED_IPS is refused', blocked === 403 || blocked === 0);
r5.kill();

camera.close(); pms.close(); rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
