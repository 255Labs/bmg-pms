import { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '../lib/supabase';
import Icon from '../components/icons.jsx';

// The guest's own page for their stay: #/stay/<link token>. No PMS account: the link, then a 6-digit key that goes
// only to the phone number or email on the booking. Everything stops working at check-out.
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const day = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const when = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const STATUS = { new: ['Sent', 'gp-st-new'], accepted: ['On its way', 'gp-st-acc'], done: ['Done', 'gp-st-done'], declined: ['Not possible', 'gp-st-dec'], cancelled: ['Cancelled', 'gp-st-can'] };
const ICON = { food: '🍽️', housekeeping: '🧹', towels: '🛁', amenities: '🧴', maintenance: '🔧', laundry: '👕', taxi: '🚕', wakeup: '⏰', late_checkout: '🕑', other: '💬', offer: '🎁' };
const storeKey = (token) => `bmg-stay-${token.slice(0, 16)}`;
const getSession = (token) => { try { return localStorage.getItem(storeKey(token)); } catch { return null; } };
const setSession = (token, s) => { try { if (s) localStorage.setItem(storeKey(token), s); else localStorage.removeItem(storeKey(token)); } catch { /* storage off */ } };

const FONTS = { rounded: 'gp-font-rounded', modern: 'gp-font-modern', classic: 'gp-font-classic' };
const themeStyle = (t) => (t ? { '--gp-p': t.primary, '--gp-a': t.accent, '--gp-bg': t.background } : undefined);

export default function GuestPortal({ token }) {
  const [session, setSess] = useState(() => getSession(token));
  const [theme, setTheme] = useState(null);
  const signOut = useCallback(() => { setSession(token, null); setSess(null); }, [token]);
  return (
    <div className={`gp ${FONTS[theme?.heading_font] ?? FONTS.rounded}`} style={themeStyle(theme)}>
      {session ? <Stay session={session} onSignedOut={signOut} onTheme={setTheme} />
        : <SignIn token={token} onTheme={setTheme} onSignedIn={(s) => { setSession(token, s); setSess(s); }} />}
    </div>
  );
}

// The top of every page: the hotel's photos sliding by (or its colours), logo, name and a line under it
function Hero({ theme, name, logo, line, big }) {
  const photos = theme?.photos ?? [];
  const [i, setI] = useState(0);
  useEffect(() => {
    if (photos.length < 2) return undefined;
    const t = setInterval(() => setI((x) => (x + 1) % photos.length), 5000);
    return () => clearInterval(t);
  }, [photos.length]);
  return (
    <header className={`gp-hero ${big ? 'big' : ''} ${photos.length ? 'has-photo' : ''}`}>
      {photos.map((p, k) => <img key={p.url} src={p.url} alt={p.caption ?? ''} className={k === i ? 'on' : ''} />)}
      <div className="gp-hero-shade" />
      <div className="gp-hero-body">
        {logo ? <img src={logo} alt="" className="gp-logo" /> : <span className="gp-logo gp-logo-text">{(name ?? 'H').slice(0, 1)}</span>}
        <div>
          <h1>{name ?? 'Your stay'}</h1>
          {theme?.tagline && <p className="gp-tagline">{theme.tagline}</p>}
          {line && <p className="gp-line">{line}</p>}
        </div>
      </div>
      {photos.length > 1 && <div className="gp-dots">{photos.map((p, k) => <button key={p.url} className={k === i ? 'on' : ''} onClick={() => setI(k)} aria-label={`Photo ${k + 1}`} />)}</div>}
      {photos[i]?.caption && <span className="gp-caption">{photos[i].caption}</span>}
    </header>
  );
}

function SignIn({ token, onSignedIn, onTheme }) {
  const [info, setInfo] = useState(null);
  const [err, setErr] = useState('');
  const [contact, setContact] = useState('');
  const [sent, setSent] = useState(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { rpc('pms_portal_open', { p_token: token }).then((d) => { setInfo(d); onTheme(d.theme); }).catch((e) => setErr(e.message)); }, [token, onTheme]);
  const ask = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await rpc('pms_portal_send_key', { p_token: token, p_contact: contact });
      if (r.ok) setSent(r); else setErr(r.error);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const login = async (e) => {
    e?.preventDefault(); setBusy(true); setErr('');
    try {
      const r = await rpc('pms_portal_login', { p_token: token, p_key: key });
      if (r.ok) onSignedIn(r.session); else setErr(r.error);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  if (!info) return <div className="gp-card gp-center gp-pad">{err ? <><h2>Link not available</h2><p>{err}</p></> : <p>Loading…</p>}</div>;
  return (
    <>
      <Hero theme={info.theme} name={info.property} logo={info.logo_url} line={info.guest ? `Karibu, ${info.guest}!` : 'Karibu!'} big />
      <div className="gp-card gp-lift">
        {!sent ? (
          <form onSubmit={ask} className="gp-form">
            <h2>Sign in to your stay</h2>
            <p>We will send a 6-digit key to the {[info.by_sms && 'mobile number', info.by_email && 'email'].filter(Boolean).join(' or ')} you gave when booking
              {info.phone_hint || info.email_hint ? <> ({[info.by_sms && info.phone_hint, info.by_email && info.email_hint].filter(Boolean).join(' or ')})</> : null}.</p>
            <label className="gp-label" htmlFor="gp-contact">Your {info.by_sms && info.by_email ? 'mobile number or email' : info.by_email ? 'email' : 'mobile number'}</label>
            <input id="gp-contact" className="gp-input" autoComplete={info.by_email && !info.by_sms ? 'email' : 'tel'} required value={contact}
              placeholder={info.by_sms ? '0754 123 456' : 'you@example.com'} onChange={(e) => setContact(e.target.value)} />
            <button className="gp-btn gp-btn-primary" disabled={busy || !contact.trim()}>{busy ? 'Sending…' : 'Send me a key'}</button>
            <button type="button" className="gp-link" onClick={() => setSent({ desk: true })}>Reception gave me a key</button>
          </form>
        ) : (
          <form onSubmit={login} className="gp-form">
            <h2>Enter your key</h2>
            <p>{sent.desk ? 'Type the key reception gave you.' : `We sent it by ${sent.by === 'sms' ? 'text' : 'email'} to ${sent.sent_to}. It works for 15 minutes.`}</p>
            <input className="gp-input gp-key" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required value={key} aria-label="6-digit key"
              placeholder="••••••" onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setKey(v); }} />
            <button className="gp-btn gp-btn-primary" disabled={busy || key.length !== 6}>{busy ? 'Checking…' : 'Open my stay'}</button>
            <button type="button" className="gp-link" onClick={() => { setSent(null); setKey(''); setErr(''); }}>Send a new key</button>
          </form>
        )}
        {err && <p className="gp-error" role="alert">{err}</p>}
      </div>
      <p className="gp-foot"><span>Only the guest on this booking can open this page. It closes when you check out.</span>{info.phone && <span>Reception: <a href={`tel:${info.phone}`}>{info.phone}</a></span>}</p>
    </>
  );
}

const NAV = [['welcome', 'Welcome', 'home'], ['food', 'Food', 'pos'], ['services', 'Services', 'sparkle'], ['requests', 'Requests', 'list'], ['bill', 'Bill', 'receipt']];

function Stay({ session, onSignedOut, onTheme }) {
  const [data, setData] = useState(null);
  const [wel, setWel] = useState(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState('welcome');
  const [flash, setFlash] = useState('');
  const fail = useCallback((e) => { if (/SIGNED_OUT/.test(e.message)) onSignedOut(); else setErr(e.message); }, [onSignedOut]);
  const load = useCallback(() => Promise.all([
    rpc('pms_portal_home', { p_session: session }).then((d) => { setData(d); setErr(''); }),
    rpc('pms_portal_welcome', { p_session: session }).then((w) => { setWel(w); onTheme(w.theme); }),
  ]).catch(fail), [session, fail, onTheme]);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (data && !data.food && tab === 'food') setTab('services'); }, [data, tab]);
  useEffect(() => { window.scrollTo({ top: 0 }); }, [tab]);
  const done = async (msg) => { setFlash(msg); setTimeout(() => setFlash(''), 4000); await load(); setTab('requests'); };
  const send = async (p) => { await rpc('pms_portal_request', { p_session: session, p }); await done('Sent! The team has your request.'); };
  const offer = async (id, note) => { await rpc('pms_portal_offer', { p_session: session, p_offer: id, p_details: note || null }); await done('Thank you! The team will contact you about this offer.'); };
  if (!data || !wel) return <div className="gp-card gp-center gp-pad">{err ? <p className="gp-error">{err}</p> : <p>Loading your stay…</p>}</div>;
  const cur = data.property.currency;
  const open = data.requests.filter((r) => ['new', 'accepted'].includes(r.status)).length;
  const nav = NAV.filter(([k]) => k !== 'food' || data.food);
  return (
    <>
      <Hero theme={wel.theme} name={data.property.name} logo={data.property.logo_url} big={tab === 'welcome'}
        line={tab === 'welcome' ? null : `Room ${data.stay.room ?? '–'} · ${day(data.stay.arrival)} to ${day(data.stay.departure)}`} />
      {flash && <div className="gp-flash" role="status">{flash}</div>}
      <main className="gp-main">
        {tab === 'welcome' && <Welcome w={wel} currency={cur} onOffer={offer} onGo={setTab} />}
        {tab === 'food' && <Food menu={data.menu} currency={cur} onSend={send} />}
        {tab === 'services' && <Services list={data.services} onSend={send} />}
        {tab === 'requests' && <Requests list={data.requests} currency={cur} session={session} onChanged={load} />}
        {tab === 'bill' && <Bill bill={data.bill} currency={cur} />}
        <p className="gp-foot"><span>Check-out by {String(data.property.check_out_time ?? '').slice(0, 5)}. This page closes when you check out.</span>
          {data.property.phone && <span>Need anything else? Call <a href={`tel:${data.property.phone}`}>{data.property.phone}</a></span>}
          <button className="gp-link" onClick={() => rpc('pms_portal_logout', { p_session: session }).finally(onSignedOut)}>Sign out</button></p>
      </main>
      <nav className="gp-bottom" role="tablist" aria-label="Your stay">
        {nav.map(([k, l, ic]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            <span className="gp-bottom-ic"><Icon name={ic} size={21} />{k === 'requests' && open > 0 && <b>{open}</b>}</span>{l}
          </button>
        ))}
      </nav>
    </>
  );
}

// The welcome page: letter, booking, Wi-Fi, offers, guide and documents, printable
function Welcome({ w, currency, onOffer, onGo }) {
  const b = w.booking;
  const g = w.guest;
  const [copied, setCopied] = useState(false);
  const [openG, setOpenG] = useState(null);
  const [asking, setAsking] = useState(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const copy = () => { try { navigator.clipboard.writeText(w.welcome.wifi_password); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* no clipboard */ } };
  const guests = [`${b.adults} adult${b.adults === 1 ? '' : 's'}`, b.children ? `${b.children} child${b.children === 1 ? '' : 'ren'}` : null].filter(Boolean).join(', ');
  return (
    <div className="gp-welcome">
      <section className="gp-card gp-letter gp-lift">
        <h2>{w.welcome.title}</h2>
        {w.welcome.text ? w.welcome.text.split(/\n{2,}/).map((para, k) => <p key={k}>{para}</p>)
          : <p>We are delighted to have you with us at {w.property.name}. Everything for your stay is here: order food to your room, ask for anything you need, and see your bill.</p>}
        {w.welcome.signed && <p className="gp-signed">{w.welcome.signed}</p>}
      </section>

      <section className="gp-pass" aria-label="Your booking">
        <div className="gp-pass-top">
          <div><span>Guest</span><strong>{[g.title, g.first_name, g.last_name].filter(Boolean).join(' ')}</strong></div>
          <div className="gp-pass-room"><span>Room</span><strong>{b.room ?? '–'}</strong></div>
        </div>
        <div className="gp-pass-dates">
          <div><span>Check-in</span><strong>{day(b.arrival)}</strong><small>from {String(w.property.check_in_time ?? '').slice(0, 5)}</small></div>
          <div className="gp-pass-nights">{b.nights} night{b.nights === 1 ? '' : 's'}</div>
          <div className="right"><span>Check-out</span><strong>{day(b.departure)}</strong><small>by {String(w.property.check_out_time ?? '').slice(0, 5)}</small></div>
        </div>
        <dl className="gp-pass-facts">
          <div><dt>Booking</dt><dd>#{b.res_no}</dd></div>
          <div><dt>Room type</dt><dd>{b.room_type}</dd></div>
          <div><dt>Guests</dt><dd>{guests}</dd></div>
          {b.rate_plan && <div><dt>Plan</dt><dd>{b.rate_plan}</dd></div>}
          {b.company && <div><dt>Company</dt><dd>{b.company}</dd></div>}
        </dl>
      </section>

      {w.welcome.wifi_name && (
        <section className="gp-card gp-wifi">
          <span className="gp-wifi-ic" aria-hidden="true">📶</span>
          <div><span>Wi-Fi</span><strong>{w.welcome.wifi_name}</strong>{w.welcome.wifi_password && <small>Password: <b>{w.welcome.wifi_password}</b></small>}</div>
          {w.welcome.wifi_password && <button className="gp-chip" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>}
        </section>
      )}

      <div className="gp-quick">
        <button onClick={() => onGo('food')}><span aria-hidden="true">🍽️</span>Order food</button>
        <button onClick={() => onGo('services')}><span aria-hidden="true">🛎️</span>Ask for something</button>
        <button onClick={() => onGo('bill')}><span aria-hidden="true">🧾</span>My bill</button>
      </div>

      {w.offers.length > 0 && (
        <section className="gp-section">
          <h2>Offers for you</h2>
          <div className="gp-offers">
            {w.offers.map((o) => (
              <article key={o.id} className="gp-offer">
                {o.image_url ? <img src={o.image_url} alt="" /> : <div className="gp-offer-art" aria-hidden="true">✨</div>}
                <div className="gp-offer-body">
                  <h3>{o.title}</h3>
                  {o.body && <p>{o.body}</p>}
                  <div className="gp-offer-foot">
                    {o.price != null && <strong>{currency} {fmt(o.price)}</strong>}
                    {o.ends_on && <small>Until {day(o.ends_on)}</small>}
                  </div>
                  {o.asked ? <span className="gp-st gp-st-done">The team has your interest</span>
                    : <button className="gp-btn gp-btn-primary gp-btn-sm" onClick={() => { setAsking(o); setNote(''); setErr(''); }}>I'm interested</button>}
                  {o.link_url && <a className="gp-link" href={o.link_url} target="_blank" rel="noopener noreferrer">More details</a>}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {w.guide.length > 0 && (
        <section className="gp-section">
          <h2>Hotel guide</h2>
          <div className="gp-card gp-guide">
            {w.guide.map((x) => (
              <div key={x.id} className={`gp-acc ${openG === x.id ? 'open' : ''}`}>
                <button onClick={() => setOpenG(openG === x.id ? null : x.id)} aria-expanded={openG === x.id}><span>{x.title}</span><span aria-hidden="true">{openG === x.id ? '−' : '+'}</span></button>
                {openG === x.id && (
                  <div className="gp-acc-body">
                    {x.image_url && <img src={x.image_url} alt="" />}
                    {x.body && x.body.split(/\n+/).map((l, k) => <p key={k}>{l}</p>)}
                    {x.file_url && <a className="gp-link" href={x.file_url} target="_blank" rel="noopener noreferrer">Open the PDF</a>}
                    {x.link_url && <a className="gp-link" href={x.link_url} target="_blank" rel="noopener noreferrer">More details</a>}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {w.documents.length > 0 && (
        <section className="gp-section">
          <h2>Guides and menus to download</h2>
          <div className="gp-card gp-docs">
            {w.documents.map((d) => (
              <a key={d.id} href={d.file_url} target="_blank" rel="noopener noreferrer" className="gp-doc">
                <span aria-hidden="true">📄</span><span><strong>{d.title}</strong>{d.body && <small>{d.body}</small>}</span><span aria-hidden="true">↗</span>
              </a>
            ))}
          </div>
        </section>
      )}

      <section className="gp-card gp-contact">
        <h2>{w.property.name}</h2>
        {w.property.address && <p>{w.property.address}</p>}
        <div className="gp-contact-row">
          {w.property.phone && <a className="gp-chip" href={`tel:${w.property.phone}`}>Call reception</a>}
          {w.property.email && <a className="gp-chip" href={`mailto:${w.property.email}`}>Email us</a>}
          <button className="gp-chip" onClick={() => window.print()}>Save or print this page</button>
        </div>
      </section>

      {asking && (
        <div className="gp-sheet-back" onClick={() => setAsking(null)}>
          <div className="gp-sheet" role="dialog" aria-label={asking.title} onClick={(e) => e.stopPropagation()}>
            <h3>{asking.title}</h3>
            <p>Tell us when suits you, or anything we should know. The team will confirm with you.</p>
            <textarea className="gp-input" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Tomorrow at 4pm, for two" />
            {err && <p className="gp-error">{err}</p>}
            <button className="gp-btn gp-btn-primary" onClick={() => onOffer(asking.id, note).then(() => setAsking(null)).catch((x) => setErr(x.message))}>Send</button>
            <button className="gp-link" onClick={() => setAsking(null)}>Not now</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Food({ menu, currency, onSend }) {
  const [cart, setCart] = useState({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const groups = useMemo(() => menu.reduce((m, i) => { (m[i.category] ??= []).push(i); return m; }, {}), [menu]);
  const lines = Object.entries(cart).filter(([, q]) => q > 0).map(([id, qty]) => ({ ...menu.find((m) => m.id === id), qty }));
  const total = lines.reduce((n, l) => n + l.qty * Number(l.price), 0);
  const add = (id, d) => setCart((c) => ({ ...c, [id]: Math.max(0, Math.min(20, (c[id] ?? 0) + d)) }));
  const order = async () => {
    setBusy(true); setErr('');
    try { await onSend({ kind: 'food', details: notes || null, items: lines.map((l) => ({ item_id: l.id, qty: l.qty })) }); setCart({}); setNotes(''); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <>
      {Object.entries(groups).map(([cat, items]) => (
        <section key={cat} className="gp-card">
          <h2>{cat}</h2>
          {items.map((i) => (
            <div key={i.id} className="gp-dish">
              {i.image_url && <img src={i.image_url} alt="" />}
              <div className="gp-dish-name"><strong>{i.name}</strong><span>{currency} {fmt(i.price)}</span></div>
              <div className="gp-qty">
                {cart[i.id] > 0 && <><button onClick={() => add(i.id, -1)} aria-label={`One less ${i.name}`}>−</button><span>{cart[i.id]}</span></>}
                <button onClick={() => add(i.id, 1)} aria-label={`Add ${i.name}`} className="gp-add">+</button>
              </div>
            </div>
          ))}
        </section>
      ))}
      {lines.length > 0 && (
        <div className="gp-cart">
          <div className="gp-cart-sum">{lines.reduce((n, l) => n + l.qty, 0)} items · <strong>{currency} {fmt(total)}</strong></div>
          <textarea className="gp-input" rows={2} maxLength={500} placeholder="Anything the kitchen should know? (no chilli, allergies…)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          {err && <p className="gp-error">{err}</p>}
          <button className="gp-btn gp-btn-primary" disabled={busy} onClick={order}>{busy ? 'Sending…' : 'Order to my room'}</button>
          <p className="gp-small">Charged to your room bill when the kitchen accepts it.</p>
        </div>
      )}
    </>
  );
}

function Services({ list, onSend }) {
  const [pick, setPick] = useState(null);
  const [details, setDetails] = useState('');
  const [at, setAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const timed = ['wakeup', 'taxi', 'housekeeping', 'laundry'].includes(pick?.kind);
  const send = async (e) => {
    e.preventDefault(); setBusy(true); setErr('');
    try { await onSend({ kind: pick.kind, details: details || null, wanted_at: at ? new Date(at).toISOString() : null }); setPick(null); setDetails(''); setAt(''); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return (
    <section className="gp-card">
      <h2>How can we help?</h2>
      <div className="gp-services">
        {list.map((s) => (
          <button key={s.kind} className={`gp-service ${pick?.kind === s.kind ? 'on' : ''}`} onClick={() => { setPick(s); setErr(''); }}>
            <span className="gp-emoji" aria-hidden="true">{ICON[s.kind]}</span>{s.title}
          </button>
        ))}
      </div>
      {pick && (
        <form className="gp-form" onSubmit={send}>
          <h3>{pick.title}</h3>
          {timed && <><label className="gp-label" htmlFor="gp-at">{pick.kind === 'wakeup' ? 'Wake me at' : 'When?'}</label>
            <input id="gp-at" type="datetime-local" className="gp-input" required={pick.kind === 'wakeup'} value={at} onChange={(e) => setAt(e.target.value)} /></>}
          <label className="gp-label" htmlFor="gp-details">{pick.kind === 'other' ? 'What do you need?' : 'Anything to add? (optional)'}</label>
          <textarea id="gp-details" className="gp-input" rows={3} maxLength={500} required={pick.kind === 'other'} value={details} onChange={(e) => setDetails(e.target.value)}
            placeholder={pick.kind === 'taxi' ? 'Where to, and how many people' : pick.kind === 'maintenance' ? 'What is not working?' : ''} />
          {err && <p className="gp-error">{err}</p>}
          <button className="gp-btn gp-btn-primary" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
        </form>
      )}
    </section>
  );
}

function Requests({ list, currency, session, onChanged }) {
  const [err, setErr] = useState('');
  if (!list.length) return <section className="gp-card gp-center"><p>No requests yet. Order food or ask for a service and you can follow it here.</p></section>;
  return (
    <section className="gp-card">
      <h2>My requests</h2>
      {err && <p className="gp-error">{err}</p>}
      {list.map((r) => {
        const [word, cls] = STATUS[r.status] ?? [r.status, ''];
        return (
          <div key={r.id} className="gp-req">
            <span className="gp-emoji" aria-hidden="true">{ICON[r.kind]}</span>
            <div className="gp-req-body">
              <div className="gp-req-top"><strong>{r.title}</strong><span className={`gp-st ${cls}`}>{word}</span></div>
              {r.kind === 'food' && r.items?.length > 0 && <div className="gp-small">{r.items.map((i) => `${i.qty} × ${i.name}`).join(', ')} · {currency} {fmt(r.total)}</div>}
              {r.details && <div className="gp-small">“{r.details}”</div>}
              {r.wanted_at && <div className="gp-small">For {when(r.wanted_at)}</div>}
              {r.staff_note && <div className="gp-note">{r.staff_note}</div>}
              <div className="gp-small gp-muted">{when(r.created_at)}</div>
              {r.status === 'new' && <button className="gp-link" onClick={() => rpc('pms_portal_cancel', { p_session: session, p_request: r.id }).then(onChanged).catch((e) => setErr(e.message))}>Cancel</button>}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Bill({ bill, currency }) {
  return (
    <section className="gp-card">
      <h2>My bill</h2>
      {bill.lines.length === 0 ? <p>Nothing on your bill yet.</p> : (
        <table className="gp-bill"><tbody>
          {bill.lines.map((l, i) => (
            <tr key={i}><td className="gp-muted">{day(l.date)}</td><td>{l.description}</td><td className="num">{Number(l.amount) < 0 ? '−' : ''}{fmt(Math.abs(l.amount))}</td></tr>
          ))}
        </tbody></table>
      )}
      <div className={`gp-balance ${Number(bill.balance) < 0 ? 'credit' : ''}`}><span>{Number(bill.balance) > 0 ? 'Still to pay' : Number(bill.balance) < 0 ? 'In credit' : 'All settled'}</span><strong>{currency} {fmt(Math.abs(bill.balance))}</strong></div>
      <p className="gp-small">Pay at reception at any time. Company-paid charges are not shown here.</p>
    </section>
  );
}
