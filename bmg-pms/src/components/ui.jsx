import { createContext, useCallback, useContext, useEffect, useState } from 'react';

// ---------------------------------------------------------------- Toasts
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, kind = 'ok') => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts">
        {items.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => setItems((x) => x.filter((y) => y.id !== t.id))}>
            {t.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// Wraps an async action: shows errors as toasts and tracks busy state
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, success) => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast(success);
      return r;
    } catch (e) {
      toast(e.message || String(e), 'error');
      throw e;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return [run, busy];
}

// ---------------------------------------------------------------- Modal
export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Form bits
export const Field = ({ label, children, hint, span }) => (
  <label className={`field ${span ? 'span-' + span : ''}`}>
    <span className="field-label">{label}</span>
    {children}
    {hint && <span className="field-hint">{hint}</span>}
  </label>
);

export const Badge = ({ kind, children }) => <span className={`badge badge-${kind}`}>{children}</span>;

export const Empty = ({ children }) => <div className="empty">{children}</div>;

export const Loading = () => <div className="loading"><span className="spinner" /> Loading…</div>;

export function Table({ columns, rows, onRow, empty = 'Nothing to show', footer }) {
  if (!rows) return <Loading />;
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? r.stay_id ?? i} onClick={onRow ? () => onRow(r) : undefined} className={onRow ? 'clickable' : ''}>
              {columns.map((c) => (
                <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && <tfoot><tr>{columns.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{footer[c.key] ?? ''}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

export function PageHead({ title, sub, children }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      <div className="page-actions">{children}</div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.value} className={`tab ${value === t.value ? 'active' : ''}`} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export const statusKind = (s) => ({
  confirmed: 'blue', tentative: 'amber', checked_in: 'green', checked_out: 'grey', cancelled: 'red',
  no_show: 'red', partial: 'amber', clean: 'green', inspected: 'teal', dirty: 'amber', out_of_order: 'red',
  open: 'blue', in_progress: 'amber', done: 'green', closed: 'grey', occupied: 'green', vacant: 'grey',
  due_out: 'amber', arriving: 'blue', blocked: 'red', urgent: 'red', high: 'amber', normal: 'blue', low: 'grey',
}[s] ?? 'grey');

// ---------------------------------------------------------------- Menu button
export function Menu({ label: text, items, align = 'left', primary, caret = true }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const t = setTimeout(() => { window.addEventListener('click', close); window.addEventListener('scroll', close, true); }, 0);
    const k = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', k);
    return () => { clearTimeout(t); window.removeEventListener('click', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', k); };
  }, [open]);
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return (
    <div className="menu">
      <button type="button" className={`btn ${primary ? 'btn-primary' : ''} ${caret ? '' : 'btn-icon'}`} aria-haspopup="menu" aria-expanded={open}
        aria-label={caret ? undefined : 'More actions'}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setPos(align === 'right' ? { top: r.bottom + 4, right: window.innerWidth - r.right } : { top: r.bottom + 4, left: r.left });
          setOpen((x) => !x);
        }}>
        {text}{caret && <span className="caret" aria-hidden>▾</span>}
      </button>
      {open && (
        <div className="menu-list" role="menu" style={pos}>
          {shown.map((it, i) => it === '-' ? <div key={i} className="menu-sep" /> : (
            <button key={it.label} type="button" role="menuitem" className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick(); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Side drawer
export function Drawer({ onClose, children, footer, label: aria }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="drawer-back" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <aside className="drawer" role="dialog" aria-label={aria}>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </div>
  );
}
