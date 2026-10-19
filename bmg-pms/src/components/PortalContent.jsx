import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { fmtDate, money } from '../lib/format';
import { Badge, Field, Modal, useAction } from './ui.jsx';

// Files for the guest portal go into the public media bucket under the property's folder
export async function uploadMedia(propertyId, file, folder, { pdf = false } = {}) {
  if (!file) return null;
  const okType = file.type.startsWith('image/') || (pdf && file.type === 'application/pdf');
  if (!okType) throw new Error(pdf ? 'Choose an image or a PDF' : 'Choose an image (JPG, PNG or WebP)');
  if (file.size > (pdf ? 15 : 5) * 1024 * 1024) throw new Error(pdf ? 'Files must be under 15 MB' : 'Images must be under 5 MB');
  const path = `${propertyId}/${folder}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
  const { error } = await supabase.storage.from('property-media').upload(path, file, { contentType: file.type });
  if (error) throw error;
  return supabase.storage.from('property-media').getPublicUrl(path).data.publicUrl;
}

const KINDS = {
  guide: { title: 'Hotel guide', hint: 'Breakfast times, pool, gym, house rules, emergency numbers, how to use the safe…', add: 'Add a guide section' },
  offer: { title: 'Offers and ads', hint: 'Spa deals, tours, airport transfers, dinner nights. Guests tap "I\'m interested" and the team gets a request.', add: 'Add an offer' },
  document: { title: 'Manuals and menus (PDF)', hint: 'Welcome book, restaurant menu, spa menu, area map. Guests open or download them.', add: 'Add a document' },
};

// The welcome page's content: guide sections, offers and documents (owners and managers)
export function PortalContent() {
  const { property } = useProperty();
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const [run, busy] = useAction();
  const load = useCallback(() => supabase.from('pms_portal_content').select('*').eq('property_id', property.id).order('kind').order('sort_order').order('title')
    .then(({ data }) => setRows(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);
  if (!rows) return null;
  const save = (r) => run(async () => {
    const row = { property_id: property.id, kind: r.kind, title: r.title.trim(), body: r.body?.trim() || null, image_url: r.image_url || null, file_url: r.file_url || null,
      link_url: r.link_url?.trim() || null, price: r.price === '' || r.price == null ? null : Number(r.price), starts_on: r.starts_on || null, ends_on: r.ends_on || null,
      sort_order: Number(r.sort_order) || 0, active: r.active !== false };
    const { error } = r.id ? await supabase.from('pms_portal_content').update(row).eq('id', r.id) : await supabase.from('pms_portal_content').insert(row);
    if (error) throw new Error(/check/.test(error.message) ? 'Links, photos and files must be https addresses, and the end date after the start' : error.message);
  }, 'Saved').then(() => { setEdit(null); load(); }).catch(() => {});
  const remove = (r) => window.confirm(`Remove "${r.title}" from the guest portal?`) && run(async () => {
    const { error } = await supabase.from('pms_portal_content').delete().eq('id', r.id); if (error) throw error;
  }, 'Removed').then(load).catch(() => {});
  return (
    <>
      {Object.entries(KINDS).map(([kind, k]) => {
        const list = rows.filter((r) => r.kind === kind);
        return (
          <div key={kind} className="card stack pc-block">
            <div className="pc-head"><div><h3 className="first">{k.title}</h3><p className="small muted">{k.hint}</p></div>
              <button type="button" className="btn" onClick={() => setEdit({ kind, title: '', body: '', active: true, sort_order: (list.length + 1) * 10 })}>{k.add}</button></div>
            {list.length === 0 ? <p className="small muted">Nothing yet.</p> : (
              <div className="pc-list">
                {list.map((r) => (
                  <div key={r.id} className={`pc-row ${r.active ? '' : 'off'}`}>
                    {r.image_url ? <img src={r.image_url} alt="" /> : <span className="pc-ic" aria-hidden="true">{kind === 'document' ? '📄' : kind === 'offer' ? '✨' : '📘'}</span>}
                    <div className="pc-text"><strong>{r.title}</strong>
                      <span className="small muted">{[r.price != null && money(r.price), r.ends_on && `until ${fmtDate(r.ends_on)}`, r.file_url && 'PDF attached', r.body && r.body.slice(0, 80)].filter(Boolean).join(' · ')}</span></div>
                    {!r.active && <Badge kind="grey">Hidden</Badge>}
                    <button type="button" className="btn btn-small" onClick={() => setEdit({ ...r, price: r.price ?? '' })}>Edit</button>
                    <button type="button" className="btn btn-small btn-danger-ghost" disabled={busy} onClick={() => remove(r)}>Remove</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {edit && <ContentDialog row={edit} busy={busy} onClose={() => setEdit(null)} onSave={save} propertyId={property.id} />}
    </>
  );
}

function ContentDialog({ row, onClose, onSave, busy, propertyId }) {
  const [r, setR] = useState(row);
  const [run, uploading] = useAction();
  const up = (file, key, opts) => run(async () => { const url = await uploadMedia(propertyId, file, 'portal', opts); setR((x) => ({ ...x, [key]: url })); }, 'Uploaded').catch(() => {});
  const k = KINDS[r.kind];
  return (
    <Modal title={`${r.id ? 'Edit' : 'Add'}: ${k.title.toLowerCase()}`} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || uploading || !r.title.trim() || (r.kind === 'document' && !r.file_url)} onClick={() => onSave(r)}>Save</button></>}>
      <div className="stack">
        <Field label="Title"><input maxLength={120} value={r.title} autoFocus onChange={(e) => setR({ ...r, title: e.target.value })} placeholder={r.kind === 'offer' ? 'Couples massage, 60 minutes' : r.kind === 'document' ? 'Welcome book' : 'Breakfast'} /></Field>
        <Field label={r.kind === 'document' ? 'Short description (optional)' : 'Text'}><textarea rows={r.kind === 'guide' ? 5 : 3} maxLength={4000} value={r.body ?? ''} onChange={(e) => setR({ ...r, body: e.target.value })} /></Field>
        {r.kind !== 'document' && (
          <div className="pc-media">
            {r.image_url && <img src={r.image_url} alt="" />}
            <label className="btn">{r.image_url ? 'Change photo' : 'Add a photo'}<input type="file" accept="image/*" hidden onChange={(e) => up(e.target.files[0], 'image_url')} /></label>
            {r.image_url && <button type="button" className="btn btn-ghost" onClick={() => setR({ ...r, image_url: null })}>Remove photo</button>}
          </div>
        )}
        {r.kind !== 'offer' && (
          <div className="pc-media">
            {r.file_url && <a href={r.file_url} target="_blank" rel="noopener noreferrer">The attached PDF</a>}
            <label className="btn">{r.file_url ? 'Change PDF' : 'Attach a PDF manual'}<input type="file" accept="application/pdf,image/*" hidden onChange={(e) => up(e.target.files[0], 'file_url', { pdf: true })} /></label>
          </div>
        )}
        {r.kind === 'offer' && (
          <div className="grid-3">
            <Field label="Price (optional)"><input type="number" min={0} value={r.price ?? ''} onChange={(e) => setR({ ...r, price: e.target.value })} /></Field>
            <Field label="Shown from"><input type="date" value={r.starts_on ?? ''} onChange={(e) => setR({ ...r, starts_on: e.target.value })} /></Field>
            <Field label="Until"><input type="date" value={r.ends_on ?? ''} onChange={(e) => setR({ ...r, ends_on: e.target.value })} /></Field>
          </div>
        )}
        <div className="grid-2">
          <Field label="Web link (optional, https)"><input value={r.link_url ?? ''} onChange={(e) => setR({ ...r, link_url: e.target.value })} placeholder="https://" /></Field>
          <Field label="Order"><input type="number" value={r.sort_order ?? 0} onChange={(e) => setR({ ...r, sort_order: e.target.value })} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={r.active !== false} onChange={(e) => setR({ ...r, active: e.target.checked })} /> Show to guests</label>
      </div>
    </Modal>
  );
}

const PRESETS = [['bmg', 'BMG', '#1B2A5E', '#F5821F', '#F2F4F8'], ['ocean', 'Ocean', '#0B4F6C', '#1FA2D8', '#EDF6FA'], ['safari', 'Safari', '#5A3E1B', '#D99A2B', '#F7F1E6'],
  ['forest', 'Forest', '#1F4D3A', '#7CB342', '#EFF5F0'], ['sunset', 'Sunset', '#7A1F3D', '#FF7A45', '#FBF0EE'], ['midnight', 'Midnight gold', '#111827', '#C9A227', '#F5F4F0']];

// The portal's look for one hotel: platform administrators only
export function PortalLook({ propertyId, propertyName }) {
  const [t, setT] = useState(null);
  const [run, busy] = useAction();
  const load = useCallback(() => rpc('pms_admin_portal_theme', { p_property: propertyId }).then((d) => setT({ ...d, preset: d.custom ? 'custom' : d.preset })).catch(() => setT(null)), [propertyId]);
  useEffect(() => { load(); }, [load]);
  if (!t) return null;
  const pick = (p) => setT({ ...t, preset: p[0], primary: p[2], accent: p[3], background: p[4] });
  const colour = (k, v) => setT({ ...t, preset: 'custom', [k]: v });
  const addPhoto = (file) => run(async () => {
    if ((t.hero_images ?? []).length >= 8) throw new Error('At most 8 portal photos');
    const url = await uploadMedia(propertyId, file, 'portal-hero');
    setT((x) => ({ ...x, hero_images: [...(x.hero_images ?? []), { url, caption: '' }] }));
  }, 'Photo added').catch(() => {});
  const move = (i, d) => setT((x) => { const a = [...x.hero_images]; const [m] = a.splice(i, 1); a.splice(i + d, 0, m); return { ...x, hero_images: a }; });
  const save = () => run(() => rpc('pms_admin_save_portal_theme', { p_property: propertyId, p: { preset: t.preset, primary: t.primary, accent: t.accent, background: t.background,
    heading_font: t.heading_font, tagline: t.tagline, hero_images: t.hero_images ?? [] } }), 'Portal look saved').then(load).catch(() => {});
  const photos = [...(t.hero_images ?? [])];
  return (
    <div className="look">
      <div className="look-form stack">
        <div className="card stack">
          <h3 className="first">Theme</h3>
          <div className="look-presets">
            {PRESETS.map((p) => (
              <button key={p[0]} type="button" className={`look-preset ${t.preset === p[0] ? 'on' : ''}`} onClick={() => pick(p)} aria-pressed={t.preset === p[0]}>
                <span className="look-sw" style={{ background: `linear-gradient(135deg, ${p[2]} 0 60%, ${p[3]} 60% 100%)` }} />{p[1]}
              </button>
            ))}
            <span className={`look-preset ${t.preset === 'custom' ? 'on' : ''}`}><span className="look-sw" style={{ background: `linear-gradient(135deg, ${t.primary} 0 60%, ${t.accent} 60% 100%)` }} />Own colours</span>
          </div>
          <div className="grid-3">
            <Field label="Main colour"><input type="color" value={t.primary} onChange={(e) => colour('primary', e.target.value.toUpperCase())} /></Field>
            <Field label="Accent (buttons)"><input type="color" value={t.accent} onChange={(e) => colour('accent', e.target.value.toUpperCase())} /></Field>
            <Field label="Page background"><input type="color" value={t.background} onChange={(e) => colour('background', e.target.value.toUpperCase())} /></Field>
          </div>
          <div className="grid-2">
            <Field label="Heading style"><select value={t.heading_font} onChange={(e) => setT({ ...t, heading_font: e.target.value })}>
              <option value="rounded">Friendly (rounded)</option><option value="modern">Modern (bold)</option><option value="classic">Classic (serif)</option></select></Field>
            <Field label="Tagline under the name"><input maxLength={120} value={t.tagline ?? ''} onChange={(e) => setT({ ...t, tagline: e.target.value })} placeholder="Where the ocean meets Africa" /></Field>
          </div>
        </div>
        <div className="card stack">
          <h3 className="first">Hotel photos for the portal</h3>
          <p className="small muted">Up to 8 photos slide by at the top of every guest's page, first one first. The hotel's own gallery (Setup → Logo, photos and highlights) follows them. Wide photos of at least 1600 px look best.</p>
          <div className="look-photos">
            {photos.map((p, i) => (
              <div key={p.url} className="look-photo">
                <img src={p.url} alt="" />
                <input placeholder="Caption (optional)" maxLength={120} value={p.caption ?? ''} onChange={(e) => setT((x) => ({ ...x, hero_images: x.hero_images.map((y, k) => (k === i ? { ...y, caption: e.target.value } : y)) }))} />
                <div className="row-gap">
                  <button type="button" className="btn btn-small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move earlier">←</button>
                  <button type="button" className="btn btn-small" disabled={i === photos.length - 1} onClick={() => move(i, 1)} aria-label="Move later">→</button>
                  <button type="button" className="btn btn-small btn-danger-ghost" onClick={() => setT((x) => ({ ...x, hero_images: x.hero_images.filter((_, k) => k !== i) }))}>Remove</button>
                </div>
              </div>
            ))}
            {photos.length < 8 && <label className="look-add">+ Add a photo<input type="file" accept="image/*" hidden onChange={(e) => addPhoto(e.target.files[0])} /></label>}
          </div>
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save the portal look</button>
      </div>
      <div className="look-preview" aria-label="Preview">
        <div className="look-phone" style={{ '--gp-p': t.primary, '--gp-a': t.accent, '--gp-bg': t.background }}>
          <div className={`gp gp-font-${t.heading_font}`} style={{ '--gp-p': t.primary, '--gp-a': t.accent, '--gp-bg': t.background, minHeight: 0, paddingBottom: 16 }}>
            <header className={`gp-hero big ${photos.length ? 'has-photo' : ''}`}>
              {photos[0] && <img src={photos[0].url} alt="" className="on" />}
              <div className="gp-hero-shade" />
              <div className="gp-hero-body"><span className="gp-logo gp-logo-text">{(propertyName ?? 'H').slice(0, 1)}</span>
                <div><h1>{propertyName}</h1>{t.tagline && <p className="gp-tagline">{t.tagline}</p>}</div></div>
            </header>
            <section className="gp-card gp-letter gp-lift"><h2>Karibu, Neema!</h2><p>We are delighted to have you with us.</p></section>
            <section className="gp-pass"><div className="gp-pass-top"><div><span>Guest</span><strong>Neema Kweka</strong></div><div className="gp-pass-room"><span>Room</span><strong>201</strong></div></div></section>
            <div style={{ padding: '14px 14px 0' }}><button type="button" className="gp-btn gp-btn-primary" style={{ width: '100%' }}>I'm interested</button></div>
          </div>
        </div>
        <p className="small muted">Preview</p>
      </div>
    </div>
  );
}
