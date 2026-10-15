import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Field, useToast } from './ui.jsx';

// After the password, people with two-step sign-in type their 6-digit code
export function MfaChallenge({ onDone }) {
  const toast = useToast();
  const [factor, setFactor] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    supabase.auth.mfa.listFactors().then(({ data }) => setFactor((data?.totp ?? []).find((f) => f.status === 'verified') ?? null));
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
      if (error) throw error;
      onDone();
    } catch (err) { toast(err.message === 'Invalid TOTP code entered' ? 'That code is not right. Codes change every 30 seconds.' : err.message, 'error'); setCode(''); }
    finally { setBusy(false); }
  };
  return (
    <div className="center-screen">
      <form className="card narrow" onSubmit={submit}>
        <h2 className="first">Enter your code</h2>
        <p className="muted">Open your authenticator app and type the 6-digit code for BMG PMS.</p>
        <Field label="Code"><input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required
          value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
        <div className="row-gap">
          <button className="btn btn-primary" disabled={busy || !factor}>Continue</button>
          <button type="button" className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
        <p className="small muted" style={{ marginTop: 12 }}>Lost your phone? Ask a platform administrator to reset two-step sign-in for your account.</p>
      </form>
    </div>
  );
}

// The password-reset email signs the person in; they must choose a new password before anything else
export function SetPassword({ onDone }) {
  const toast = useToast();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (a.length < 10) { toast('Use at least 10 characters', 'error'); return; }
    if (a !== b) { toast('The two passwords are different', 'error'); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: a });
    setBusy(false);
    if (error) { toast(error.message, 'error'); return; }
    toast('Password changed');
    onDone();
  };
  return (
    <div className="center-screen">
      <form className="card narrow" onSubmit={submit}>
        <h2 className="first">Choose a new password</h2>
        <Field label="New password" hint="At least 10 characters"><input type="password" autoFocus autoComplete="new-password" minLength={10} required value={a} onChange={(e) => setA(e.target.value)} /></Field>
        <Field label="Type it again"><input type="password" autoComplete="new-password" minLength={10} required value={b} onChange={(e) => setB(e.target.value)} /></Field>
        <button className="btn btn-primary" disabled={busy}>Save password</button>
      </form>
    </div>
  );
}
