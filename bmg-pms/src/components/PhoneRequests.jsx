import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc, supabase } from '../lib/supabase';
import { fmtDateTime, money } from '../lib/format';
import { Badge, useAction } from './ui.jsx';

const SHOW = { queued: ['Sending to phone', 'blue'], sent: ['Waiting for the guest', 'amber'], paid: ['Paid', 'teal'], failed: ['Not paid', 'red'], expired: ['No answer', 'grey'], cancelled: ['Cancelled', 'grey'] };
const phone = (p) => (p?.startsWith('255') ? `0${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : p);

// Mobile money requests on this folio. While one is waiting it refreshes every 4 seconds,
// and when one is paid the folio reloads so the payment line appears.
export default function PhoneRequests({ folio, onPaid }) {
  const [run] = useAction();
  const [rows, setRows] = useState([]);
  const paidRef = useRef(onPaid);
  paidRef.current = onPaid;
  const load = useCallback(() => supabase.from('pms_payment_requests').select('id, phone, amount, status, error, note, created_at, paid_at')
    .eq('folio_id', folio.id).gte('created_at', new Date(Date.now() - 24 * 3600e3).toISOString()).order('created_at', { ascending: false }).limit(5)
    .then(({ data }) => setRows((prev) => {
      if (prev.some((p) => p.status !== 'paid' && (data ?? []).find((d) => d.id === p.id)?.status === 'paid')) setTimeout(() => paidRef.current?.(), 0);
      return data ?? [];
    })), [folio.id]);
  useEffect(() => { load(); }, [load]);
  const waiting = rows.some((r) => ['queued', 'sent'].includes(r.status));
  useEffect(() => {
    if (!waiting) return undefined;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [waiting, load]);
  if (!rows.length) return null;
  return (
    <div className="phone-requests">
      {rows.map((r) => {
        const [word, kind] = SHOW[r.status] ?? [r.status, 'grey'];
        return (
          <div key={r.id} className={`phone-req ${r.status}`}>
            <span className="pr-amount">{money(r.amount)}</span>
            <span className="muted small">to {phone(r.phone)} · {fmtDateTime(r.created_at)}</span>
            <Badge kind={kind}>{word}</Badge>
            {(r.error || r.note) && <span className="small muted">{r.error ?? r.note}</span>}
            {['queued', 'sent'].includes(r.status) && (
              <button className="link small" onClick={() => run(() => rpc('pms_cancel_payment_request', { p_request: r.id }), 'Stopped waiting').then(load).catch(() => {})}>Stop waiting</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
