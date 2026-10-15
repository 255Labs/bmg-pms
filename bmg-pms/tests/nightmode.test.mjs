// Night audit mode timing: dark only while the night audit window is open and that day's audit has not run.
// Run: node tests/nightmode.test.mjs
import { inWindow, auditPending } from '../src/lib/nightmode.js';
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log('  ✓', n); } else { failed++; console.log('  ✗', n); } };
const t = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const night = (bd, date, hm, from = '22:00', to = '06:00') => inWindow(t(hm), from, to) && auditPending(bd, { date, min: t(hm) }, from);
ok('day at 17:00', !night('2026-10-13', '2026-10-13', '17:00'));
ok('dark from 22:00 while the 13th is open', night('2026-10-13', '2026-10-13', '22:00'));
ok('still dark after midnight if the audit has not run', night('2026-10-13', '2026-10-14', '01:30'));
ok('day again once the audit moved the business date (same evening)', !night('2026-10-14', '2026-10-13', '23:40'));
ok('day after midnight once the audit ran', !night('2026-10-14', '2026-10-14', '02:00'));
ok('day after the window closes even if the audit is late', !night('2026-10-13', '2026-10-14', '06:30'));
ok('window that does not cross midnight (20:00–23:00)', night('2026-10-13', '2026-10-13', '21:00', '20:00', '23:00') && !night('2026-10-13', '2026-10-13', '23:30', '20:00', '23:00'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
