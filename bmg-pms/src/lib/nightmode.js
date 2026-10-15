import { useEffect, useState } from 'react';

// Night audit mode: the screens turn dark navy once the night audit window opens (property setting, default
// 22:00–06:00) and the day has not been closed yet; as soon as the audit runs and the business date moves on,
// they go back to day. Each person can still force day or night on their own device.
export const NIGHT_DEFAULT = { enabled: true, from: '22:00', to: '06:00' };
const KEY = 'bmg.mode';
const readMode = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };

// Tell the shell the audit started or finished
export const announceAudit = (running) => window.dispatchEvent(new CustomEvent('bmg:audit', { detail: running }));

// local clock and calendar date at the property
const localNow = (tz) => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
    return { min: Number(p.hour) * 60 + Number(p.minute), date: `${p.year}-${p.month}-${p.day}` };
  } catch { const d = new Date(); return { min: d.getHours() * 60 + d.getMinutes(), date: d.toISOString().slice(0, 10) }; }
};
const dayBefore = (iso) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
// Is the day the window belongs to still open? The window that opened at 22:00 on the 13th belongs to the
// 13th, also after midnight; once the audit has moved the business date past it, the night is over.
export const auditPending = (businessDate, now, from) => {
  const opened = now.min >= toMin(from) ? now.date : dayBefore(now.date);
  return !!businessDate && businessDate <= opened;
};
const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
export const inWindow = (now, from, to) => {
  const a = toMin(from), b = toMin(to);
  return a === b ? false : a < b ? now >= a && now < b : now >= a || now < b;
};

export function useNightMode(property, _page) {
  const [mode, setModeState] = useState(readMode);
  const [running, setRunning] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60000);
    const h = (e) => setRunning(!!e.detail);
    window.addEventListener('bmg:audit', h);
    return () => { clearInterval(t); window.removeEventListener('bmg:audit', h); };
  }, []);
  const cfg = { ...NIGHT_DEFAULT, ...(property?.settings?.night_mode ?? {}) };
  const now = localNow(property?.timezone);
  const timed = cfg.enabled && inWindow(now.min, cfg.from, cfg.to) && auditPending(property?.business_date, now, cfg.from);
  const reason = timed ? (running ? 'running' : 'hours') : null;
  const night = mode === 'night' || (mode === 'auto' && !!reason);
  useEffect(() => {
    document.documentElement.dataset.mode = night ? 'night' : 'day';
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', night ? '#070C24' : '#1B2A5E');
  }, [night, tick]);
  const setMode = (m) => { setModeState(m); try { localStorage.setItem(KEY, m); } catch { /* storage unavailable */ } };
  return { night, mode, setMode, reason: mode === 'night' ? 'chosen' : reason, cfg };
}
