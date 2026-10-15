import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { Field, PageHead, useToast } from '../components/ui.jsx';

// Two-step sign-in (authenticator app) and password change, for everyone.
// Once an authenticator is verified, the database refuses this person's data until the code is entered.
export default function Security() {
  const toast = useToast();
  const { user } = useProperty();
  const [factors, setFactors] = useState(null);
  const [enrol, setEnrol] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState({ a: '', b: '' });

  const load = useCallback(async () => {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) { toast(error.message, 'error'); setFactors([]); return; }
    setFactors((data?.all ?? []).filter((f) => f.factor_type === 'totp'));
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  const step = async (fn, done) => {
    setBusy(true);
    try { await fn(); if (done) toast(done); } catch (e) { toast(e.message ?? String(e), 'error'); } finally { setBusy(false); }
  };

  const start = () => step(async () => {
    // clear half-finished attempts first; Supabase allows only a few unverified factors
    for (const f of factors ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `BMG PMS ${new Date().toISOString().slice(0, 10)}` });
    if (error) throw error;
    setEnrol(data); setCode('');
  });
  const confirm = (e) => { e.preventDefault(); step(async () => {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrol.id, code: code.trim() });
    if (error) throw error;
    setEnrol(null); await load();
  }, 'Two-step sign-in is on'); };
  const remove = (f) => window.confirm('Turn off two-step sign-in? Anyone with your password could then sign in.') && step(async () => {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
    if (error) throw error;
    await load();
  }, 'Two-step sign-in is off');
  const changePassword = (e) => { e.preventDefault(); step(async () => {
    if (pw.a.length < 10) throw new Error('Use at least 10 characters');
    if (pw.a !== pw.b) throw new Error('The two passwords are different');
    const { error } = await supabase.auth.updateUser({ password: pw.a });
    if (error) throw error;
    setPw({ a: '', b: '' });
  }, 'Password changed'); };

  const verified = (factors ?? []).filter((f) => f.status === 'verified');
  return (
    <>
      <PageHead title="Sign-in security" sub={user?.email} />
      <div className="card">
        <h3 className="first">Two-step sign-in</h3>
        {verified.length > 0 ? (
          <>
            <p><span className="badge badge-teal">On</span> After your password, the app asks for the 6-digit code from your authenticator app.</p>
            {verified.map((f) => <p key={f.id} className="row-gap small"><span>{f.friendly_name || 'Authenticator'}</span><button className="link danger" disabled={busy} onClick={() => remove(f)}>Turn off</button></p>)}
          </>
        ) : enrol ? (
          <form onSubmit={confirm}>
            <p>Scan this with Google Authenticator, Microsoft Authenticator or similar, then type the 6-digit code it shows.</p>
            <img src={enrol.totp.qr_code} alt="QR code for your authenticator app" width="180" height="180" style={{ background: '#fff', borderRadius: 12, padding: 8 }} />
            <p className="small muted">Can't scan? Enter this key: <code className="wrap">{enrol.totp.secret}</code></p>
            <Field label="Code from the app"><input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
            <div className="row-gap"><button className="btn btn-primary" disabled={busy}>Turn on</button><button type="button" className="btn" onClick={() => setEnrol(null)}>Cancel</button></div>
          </form>
        ) : (
          <>
            <p className="muted">Protects your account if your password is ever seen or guessed. Strongly recommended for owners, managers and administrators.</p>
            <button className="btn btn-primary" disabled={busy || factors === null} onClick={start}>Set up two-step sign-in</button>
          </>
        )}
      </div>
      <form className="card" onSubmit={changePassword}>
        <h3 className="first">Change password</h3>
        <div className="grid-2">
          <Field label="New password" hint="At least 10 characters"><input type="password" autoComplete="new-password" minLength={10} required value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} /></Field>
          <Field label="Type it again"><input type="password" autoComplete="new-password" minLength={10} required value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} /></Field>
        </div>
        <button className="btn btn-primary" disabled={busy}>Change password</button>
      </form>
    </>
  );
}
