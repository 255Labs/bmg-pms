// Hikvision ISAPI event notifications (EventNotificationAlert XML): pushed by an NVR or camera set to
// "HTTP listening", or read from its live stream (/ISAPI/Event/notification/alertStream). Used by the
// on-site relay and the ingest function.

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i'));
  return m ? m[1].trim() : null;
};

// Accepts raw XML or a multipart body containing the XML part (images are ignored)
export function parseAlerts(body) {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  const blocks = text.match(/<EventNotificationAlert[\s\S]*?<\/EventNotificationAlert>/gi) ?? [];
  return blocks.map((xml) => ({
    device: tag(xml, 'macAddress') || tag(xml, 'ipAddress') || '',
    ip: tag(xml, 'ipAddress'),
    channel: tag(xml, 'channelID') ?? tag(xml, 'dynChannelID'),
    event_type: (tag(xml, 'eventType') || 'unknown').toLowerCase(),
    state: (tag(xml, 'eventState') || 'active').toLowerCase(),
    time: tag(xml, 'dateTime'),
    description: tag(xml, 'eventDescription'),
    target: (tag(xml, 'targetType') || '').toLowerCase() || null,   // AcuSense cameras: human, vehicle
  }));
}

// Keep real detections only: active state, not heartbeats or video loss
export const IGNORED = new Set(['videoloss', 'heartbeat', 'unknown']);
export const usable = (alerts) => alerts.filter((a) => a.channel && a.time && a.state === 'active' && !IGNORED.has(a.event_type));

// Cameras repeat an event about once a second while the movement lasts. Episodes turn those repeats into
// one sighting per (device, channel, event type): it opens on the first hit and closes after `gapMs` of quiet.
export function episodes({ gapMs = 10_000, onClose, now = () => Date.now() }) {
  const open = new Map();
  const close = (k) => { const e = open.get(k); open.delete(k); onClose({ ...e.alert, hits: e.hits, ended: e.last, seconds: Math.round((e.lastAt - e.firstAt) / 100) / 10 }); };
  return {
    add(a) {
      const k = `${a.device}|${a.channel}|${a.event_type}`;
      const e = open.get(k);
      if (a.state !== 'active') { if (e) close(k); return; }
      if (e) { e.hits += 1; e.last = a.time; e.lastAt = now(); if (!e.alert.target && a.target) e.alert.target = a.target; return; }
      open.set(k, { alert: a, hits: 1, last: a.time, firstAt: now(), lastAt: now() });
    },
    sweep(all = false) { for (const [k, e] of open) if (all || now() - e.lastAt > gapMs) close(k); },
    get size() { return open.size; },
  };
}
