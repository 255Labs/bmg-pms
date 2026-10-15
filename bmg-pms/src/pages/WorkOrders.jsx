import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { fmtDate, fmtDateTime, label } from '../lib/format';
import { Badge, Field, Modal, PageHead, Table, Tabs, statusKind, useAction } from '../components/ui.jsx';

const CATS = ['maintenance', 'housekeeping', 'engineering', 'it', 'other'];
const PRI = ['low', 'normal', 'high', 'urgent'];

export default function WorkOrders() {
  const { property, lookups, user } = useProperty();
  const [run] = useAction();
  const [tab, setTab] = useState('open');
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);

  const load = useCallback(() => {
    let q = supabase.from('pms_work_orders').select('*, pms_rooms(number)').eq('property_id', property.id)
      .order('created_at', { ascending: false }).limit(300);
    q = tab === 'open' ? q.in('status', ['open', 'in_progress']) : q.in('status', ['done', 'cancelled']);
    return q.then(({ data }) => setRows(data ?? []));
  }, [property.id, tab]);
  useEffect(() => { load(); }, [load]);

  const save = (w) => run(async () => {
    const payload = {
      property_id: property.id, room_id: w.room_id || null, title: w.title, description: w.description || null,
      category: w.category, priority: w.priority, status: w.status, assigned_to: w.assigned_to || null,
      due_date: w.due_date || null, completed_at: w.status === 'done' ? (w.completed_at ?? new Date().toISOString()) : null,
    };
    const { error } = w.id
      ? await supabase.from('pms_work_orders').update(payload).eq('id', w.id)
      : await supabase.from('pms_work_orders').insert({ ...payload, created_by: user.id });
    if (error) throw error;
    setEdit(null);
    load();
  }, 'Work order saved').catch(() => {});

  return (
    <>
      <PageHead title="Work orders" sub="Repairs and tasks for maintenance and housekeeping">
        <button className="btn btn-primary" onClick={() => setEdit({ title: '', category: 'maintenance', priority: 'normal', status: 'open', room_id: '' })}>+ New work order</button>
      </PageHead>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'open', label: 'Open' }, { value: 'closed', label: 'Done / cancelled' }]} />
      <Table rows={rows} onRow={setEdit} empty="No work orders" columns={[
        { key: 'title', label: 'Task', render: (w) => <><strong>{w.title}</strong><div className="small muted">{w.description}</div></> },
        { key: 'room', label: 'Room', render: (w) => w.pms_rooms?.number ?? '—' },
        { key: 'category', label: 'Category', render: (w) => label(w.category) },
        { key: 'priority', label: 'Priority', render: (w) => <Badge kind={statusKind(w.priority)}>{label(w.priority)}</Badge> },
        { key: 'assigned_to', label: 'Assigned to' },
        { key: 'due_date', label: 'Due', render: (w) => fmtDate(w.due_date) },
        { key: 'status', label: 'Status', render: (w) => <Badge kind={statusKind(w.status)}>{label(w.status)}</Badge> },
        { key: 'created_at', label: 'Raised', render: (w) => fmtDateTime(w.created_at) },
      ]} />
      {edit && (
        <Modal title={edit.id ? 'Work order' : 'New work order'} onClose={() => setEdit(null)}
          footer={<><span /><div className="row-gap"><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" form="wo">Save</button></div></>}>
          <form id="wo" className="stack" onSubmit={(e) => { e.preventDefault(); save(edit); }}>
            <Field label="Task"><input required value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
            <Field label="Details"><textarea rows={3} value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <div className="grid-2">
              <Field label="Room">
                <select value={edit.room_id ?? ''} onChange={(e) => setEdit({ ...edit, room_id: e.target.value })}>
                  <option value="">General / public area</option>
                  {lookups.rooms.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}
                </select>
              </Field>
              <Field label="Category"><select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>{CATS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
              <Field label="Priority"><select value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })}>{PRI.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
              <Field label="Status"><select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{['open', 'in_progress', 'done', 'cancelled'].map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
              <Field label="Assigned to"><input value={edit.assigned_to ?? ''} onChange={(e) => setEdit({ ...edit, assigned_to: e.target.value })} /></Field>
              <Field label="Due"><input type="date" value={edit.due_date ?? ''} onChange={(e) => setEdit({ ...edit, due_date: e.target.value })} /></Field>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
