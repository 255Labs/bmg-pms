import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can, downloadCSV, fmtDate, fmtDateTime } from '../lib/format';
import { applyMapping, FIELDS, guessMapping, parseCSV, TEMPLATES } from '../lib/csv';
import { Badge, Field, PageHead, Table, Tabs, useAction } from '../components/ui.jsx';

// Moving from eZee: guests first, then reservations (future bookings and guests in house on cut-over night)
export default function Import() {
  const { property, role, refresh } = useProperty();
  const [run, busy] = useAction();
  const [kind, setKind] = useState('reservations');
  const [file, setFile] = useState(null);
  const [mapping, setMapping] = useState({});
  const [result, setResult] = useState(null);
  const [runs, setRuns] = useState(null);

  const loadRuns = useCallback(() => supabase.from('pms_import_runs').select('id, kind, file_name, total, imported, skipped, failed, created_at')
    .eq('property_id', property.id).order('created_at', { ascending: false }).limit(20).then(({ data }) => setRuns(data ?? [])), [property.id]);
  useEffect(() => { loadRuns(); }, [loadRuns]);

  const rows = useMemo(() => (file ? applyMapping(kind, file.rows, mapping) : []), [file, kind, mapping]);
  if (!can(role, 'setup')) return <><PageHead title="Import from eZee" /><p>Only owners and managers can import data.</p></>;

  const pick = async (f) => {
    if (!f) return;
    const parsed = parseCSV(await f.text());
    setFile({ name: f.name, ...parsed });
    setMapping(guessMapping(kind, parsed.headers));
    setResult(null);
  };
  const switchKind = (k) => { setKind(k); setResult(null); if (file) setMapping(guessMapping(k, file.headers)); };
  const required = kind === 'guests' ? ['first_name'] : ['ezee_no', 'arrival', 'departure'];
  const missing = required.filter((k) => !mapping[k]);

  const start = () => run(async () => {
    const all = { total: 0, imported: 0, skipped: 0, failed: 0, rows: [] };
    for (let i = 0; i < rows.length; i += 500) {
      const r = await rpc(kind === 'guests' ? 'pms_import_guests' : 'pms_import_reservations', { p_property: property.id, p_rows: rows.slice(i, i + 500), p_file: file.name });
      for (const k of ['total', 'imported', 'skipped', 'failed']) all[k] += r[k];
      all.rows.push(...r.rows.map((x) => ({ ...x, row: x.row + i })));
    }
    setResult(all); loadRuns(); refresh();
  }, 'Import finished').catch(() => {});

  return (
    <>
      <PageHead title="Import from eZee" sub="Bring guests, future bookings and guests in house across on cut-over night. Running the same file again never makes duplicates." />
      <Tabs value={kind} onChange={switchKind} tabs={[{ value: 'reservations', label: 'Reservations' }, { value: 'guests', label: 'Guests' }]} />
      <div className="card">
        <ol className="plain-list steps-list">
          <li>In eZee, export {kind === 'guests' ? 'the guest database' : 'arrivals and in-house guests from today onwards'} to Excel and save it as CSV.</li>
          <li>Room types and business sources must use the same names as in Setup.{kind === 'reservations' && ' Mark guests already in house with status "In house" and give their room and balance.'}</li>
          <li>Choose the file, check the columns, then import. Rows with problems are listed; fix them and run the file again.</li>
        </ol>
        <div className="row-gap">
          <label className="btn btn-primary">Choose CSV file<input type="file" accept=".csv,text/csv" hidden onChange={(e) => pick(e.target.files?.[0])} /></label>
          <button className="btn" onClick={() => downloadCSV(`${kind}-template.csv`, parseCSV(TEMPLATES[kind]).rows)}>Download a template</button>
          {file && <span className="muted">{file.name} · {file.rows.length} rows</span>}
        </div>
      </div>

      {file && (
        <>
          <h3>Match the columns</h3>
          <div className="card grid-4">
            {FIELDS[kind].map(([key, name]) => (
              <Field key={key} label={`${name}${required.includes(key) ? ' *' : ''}`}>
                <select value={mapping[key] ?? ''} onChange={(e) => setMapping({ ...mapping, [key]: e.target.value })}>
                  <option value="">Not in file</option>
                  {file.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
              </Field>
            ))}
          </div>
          <h3>First rows as they will be imported</h3>
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{FIELDS[kind].filter(([k]) => mapping[k]).map(([k, n]) => <th key={k}>{n}</th>)}</tr></thead>
              <tbody>{rows.slice(0, 5).map((r, i) => <tr key={i}>{FIELDS[kind].filter(([k]) => mapping[k]).map(([k]) => <td key={k}>{r[k]}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="row-gap">
            <button className="btn btn-primary" disabled={busy || missing.length > 0 || !rows.length} onClick={start}>Import {rows.length} rows</button>
            {missing.length > 0 && <span className="small danger">Match {missing.map((k) => FIELDS[kind].find(([f]) => f === k)[1]).join(', ')} first.</span>}
            {kind === 'reservations' && <span className="small muted">Business date {fmtDate(property.business_date)}: departures on or before it are skipped.</span>}
          </div>
        </>
      )}

      {result && (
        <>
          <h3>Result</h3>
          <dl className="today-stats compact">
            <div><dt>Imported</dt><dd>{result.imported}</dd></div>
            <div><dt>Already there</dt><dd>{result.skipped}</dd></div>
            <div><dt>Need fixing</dt><dd className={result.failed ? 'danger' : ''}>{result.failed}</dd></div>
          </dl>
          <Table rows={result.rows.filter((r) => r.status !== 'imported')} empty="Every row imported." columns={[
            { key: 'row', label: 'Row' },
            { key: 'ref', label: 'eZee no.' },
            { key: 'status', label: 'Result', render: (r) => <Badge kind={r.status === 'failed' ? 'red' : 'grey'}>{r.status === 'failed' ? 'Needs fixing' : 'Already there'}</Badge> },
            { key: 'message', label: 'Why' },
          ]} />
        </>
      )}

      <h3>Earlier imports</h3>
      <Table rows={runs} empty="Nothing imported yet" columns={[
        { key: 'created_at', label: 'When', render: (r) => fmtDateTime(r.created_at) },
        { key: 'kind', label: 'What', render: (r) => (r.kind === 'guests' ? 'Guests' : 'Reservations') },
        { key: 'file_name', label: 'File' },
        { key: 'imported', label: 'Imported', num: true },
        { key: 'skipped', label: 'Already there', num: true },
        { key: 'failed', label: 'Need fixing', num: true },
      ]} />
    </>
  );
}
