import { useCallback, useEffect, useState } from 'react';
import { rpc, supabase } from '../lib/supabase';
import { Field, Loading, useAction } from './ui.jsx';

// The guest portal's look for one hotel, set by BMG's platform administrators: a ready-made theme or own colours,
// the heading style, a tagline and up to 8 photos for the slideshow at the top (the hotel's gallery follows them).
export const PRESETS = [
  ['bmg', 'BMG', '#1B2A5E', '#F5821F', '#F2F4F8'], ['ocean', 'Ocean', '#0B4F6C', '#1FA2D8', '#EDF6FA'],
  ['safari', 'Safari', '#5A3E1B', '#D99A2B', '#F7F1E6'], ['forest', 'Forest', '#1F4D3A', '#7CB342', '#EFF5F0'],
  ['sunset', 'Sunset', '#7A1F3D', '#FF7A45', '#FBF0EE'], ['midnight', 'Midnight gold', '#111827', '#C9A227', '#F5F4F0'],
];
const FONTS = [['rounded', 'Friendly (rounded)'], ['modern', 'Modern (bold sans)'], ['classic', 'Classic (serif)']];

export default function PortalLook({ propertyId, propertyName }) {
  const [run, busy] = useAction();
  const [t, setT] = useState(null);
  const load = useCallback(() => rpc('pms_admin_portal_theme', { p_property: propertyId }).then((x) => setT({
    preset: x.custom ? 'custom' : x.preset, primary: x.primary, accent: x.accent, background: x.background,
    heading_font: x.heading_font, tagline: x.tagline ?? '', hero_images: x.hero_images ?? [], gallery: (x.photos ?? []).slice((x.hero_images ?? []).length),
  })).catch(() => setT(false)), [propertyId]);
  useEffect(() => { load(); }, [load]);
  if (t === null) return <Loading />;
  if (t === false) return <p className="danger">The portal look could not be loaded.</p>;
  const pick = (p) => setT({ ...t, preset: p[0], primary: p[2], accent: p[3], background: p[4] });
  const colour = (k, v) => setT({ ...t, preset: 'custom', [k]: v.toUpperCase() });
  const move = (i, d) => { const a = [...t.hero_images]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setT({ ...t, hero_images: a }); };
  const upload = (files) => run(async () => {
    const list = [...files].slice(0, 8 - t.hero_images.length);
    const added = [];
    for (const f of list) {
      if (!f.type.startsWith('image/')) throw new Error('Choose images (JPG, PNG or WebP)');
      if (f.size > 6 * 1024 * 1024) throw new Error(`${f.name} is over 6 MB`);
      const path = `${propertyId}/portal-hero/${Date.now()}-${f.name.replace(/[^\w.-]/g, '_')}`;
      const { error } = await supabase.storage.from('property-media').upload(path, f, { contentType: f.type });
      if (error) throw error;
      added.push({ url: supabase.storage.from('property-media').getPublicUrl(path).data.publicUrl, caption: '' });
    }
    setT((x) => ({ ...x, hero_images: [...x.hero_images, ...added] }));
  }, 'Photo added. Save to publish it.').catch(() => {});
  const save = () => run(() => rpc('pms_admin_save_portal_theme', { p_property: propertyId, p: {
    preset: t.preset, primary: t.primary, accent: t.accent, background: t.background, heading_font: t.heading_font, tagline: t.tagline,
    hero_images: t.hero_images.map((h) => ({ url: h.url, caption: h.caption || null })) } }), 'Portal look saved').then(load).catch(() => {});
  return (
    <div className="plook">
      <div className="plook-edit stack">
        <div>
          <span className="field-label">Theme</span>
          <div className="plook-presets">
            {PRESETS.map((p) => (
              <button key={p[0]} type="button" className={`plook-preset ${t.preset === p[0] ? 'on' : ''}`} onClick={() => pick(p)} aria-pressed={t.preset === p[0]}>
                <span className="plook-sw" style={{ background: `linear-gradient(135deg, ${p[2]} 0 55%, ${p[3]} 55% 100%)` }} />{p[1]}
              </button>
            ))}
            <span className={`plook-preset ${t.preset === 'custom' ? 'on' : ''}`}><span className="plook-sw plook-sw-custom" />Own colours</span>
          </div>
        </div>
        <div className="grid-3">
          {[['primary', 'Main colour'], ['accent', 'Buttons and highlights'], ['background', 'Page background']].map(([k, l]) => (
            <Field key={k} label={l}>
              <span className="plook-colour"><input type="color" value={t[k]} onChange={(e) => colour(k, e.target.value)} aria-label={l} />
                <input value={t[k]} maxLength={7} onChange={(e) => /^#[0-9A-Fa-f]{0,6}$/.test(e.target.value) && setT({ ...t, preset: 'custom', [k]: e.target.value.toUpperCase() })} /></span>
            </Field>
          ))}
        </div>
        <div className="grid-2">
          <Field label="Heading style"><select value={t.heading_font} onChange={(e) => setT({ ...t, heading_font: e.target.value })}>{FONTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          <Field label="Tagline" hint="Under the hotel's name"><input maxLength={120} value={t.tagline} onChange={(e) => setT({ ...t, tagline: e.target.value })} placeholder="Where the ocean meets Africa" /></Field>
        </div>
        <div>
          <span className="field-label">Hotel photos for the slideshow ({t.hero_images.length} of 8)</span>
          <p className="small muted">Wide photos work best (at least 1200 px across). The hotel's own gallery photos{t.gallery.length ? ` (${t.gallery.length})` : ''} play after these.</p>
          <div className="plook-photos">
            {t.hero_images.map((h, i) => (
              <div key={h.url} className="plook-photo">
                <img src={h.url} alt="" />
                <input value={h.caption ?? ''} maxLength={120} placeholder="Caption (optional)" onChange={(e) => setT({ ...t, hero_images: t.hero_images.map((x, k) => (k === i ? { ...x, caption: e.target.value } : x)) })} />
                <div className="plook-photo-btns">
                  <button type="button" className="icon-btn" onClick={() => move(i, -1)} aria-label="Earlier" disabled={i === 0}>‹</button>
                  <button type="button" className="icon-btn" onClick={() => move(i, 1)} aria-label="Later" disabled={i === t.hero_images.length - 1}>›</button>
                  <button type="button" className="icon-btn danger" onClick={() => setT({ ...t, hero_images: t.hero_images.filter((_, k) => k !== i) })} aria-label="Remove">✕</button>
                </div>
              </div>
            ))}
            {t.hero_images.length < 8 && (
              <label className="plook-add"><span aria-hidden="true">＋</span>Add photos<input type="file" accept="image/*" multiple hidden onChange={(e) => upload(e.target.files)} /></label>
            )}
          </div>
        </div>
        <div className="row-gap"><button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save portal look</button>
          <span className="small muted">Guests see it the next time their page refreshes.</span></div>
      </div>
      <Preview t={t} name={propertyName} />
    </div>
  );
}

// A phone-sized picture of the welcome page in these colours
function Preview({ t, name }) {
  const photo = t.hero_images[0]?.url ?? t.gallery[0]?.url;
  const font = t.heading_font === 'classic' ? 'Georgia, serif' : t.heading_font === 'modern' ? 'Nunito, sans-serif' : 'Fredoka, sans-serif';
  return (
    <div className="plook-phone" aria-label="Preview" style={{ background: t.background }}>
      <div className="plook-hero" style={{ background: photo ? `linear-gradient(180deg, transparent 30%, ${t.primary}) , url("${photo}") center/cover` : `linear-gradient(150deg, ${t.primary}, ${t.primary}cc)` }}>
        <div className="plook-hero-text"><strong style={{ fontFamily: font }}>{name}</strong>{t.tagline && <small>{t.tagline}</small>}</div>
      </div>
      <div className="plook-card"><strong style={{ fontFamily: font, color: t.primary }}>Karibu, Neema!</strong><span>We are delighted to have you with us.</span></div>
      <div className="plook-pass" style={{ background: `linear-gradient(135deg, ${t.primary}, ${t.accent})` }}><span>Room</span><strong>204</strong><span>12 Oct → 15 Oct · 3 nights</span></div>
      <div className="plook-btn" style={{ background: t.accent }}>I'm interested</div>
      <div className="plook-nav">{['Welcome', 'Food', 'Services', 'Bill'].map((x, i) => <span key={x} style={i === 0 ? { color: t.primary, fontWeight: 800 } : undefined}>{x}</span>)}</div>
    </div>
  );
}
