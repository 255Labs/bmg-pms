import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Field, useToast } from '../components/ui.jsx';

export default function Login() {
  const toast = useToast();
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) toast('Check your email to confirm the account, then sign in.');
      } else {
        const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
        if (error) throw error;
        toast('Password reset link sent.');
        setMode('signin');
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-art">
        <div className="login-brand">
          <span className="brand-mark light" aria-hidden="true">B</span>
          <span>BMG PMS</span>
        </div>
        <h1>Every room, every night, in one ledger.</h1>
        <p>The front desk, cashier, housekeeping and night audit for BMG Group International properties.</p>
        <div className="login-tape" aria-hidden="true">
          {[[0, 3, 'Moga Kulwa'], [1, 9, 'Fred Mutiso'], [0, 2, 'Lulu Kayanda'], [3, 7, 'Ritha Ambonisye'], [2, 5, 'Baraka Mwita'], [5, 9, 'Amina Said']].map(([a, b, n], i) => (
            <div className="lt-row" key={i}>
              <span className="lt-room">{331 + i}</span>
              <div className="lt-track">
                <span className={`lt-bar lt-${i % 3}`} style={{ left: `${a * 10 + 3}%`, width: `${(b - a) * 10}%` }}>{n}</span>
              </div>
            </div>
          ))}
          <span className="lt-today" />
        </div>
      </div>
      <form className="login-form" onSubmit={submit}>
        <h2>{mode === 'signin' ? 'Sign in to your property' : mode === 'signup' ? 'Create your account' : 'Reset your password'}</h2>
        <Field label="Email">
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {mode !== 'reset' && (
          <Field label="Password">
            <input type="password" required minLength={mode === 'signup' ? 10 : 8} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
        </button>
        <div className="login-links">
          {mode !== 'signin' && <button type="button" className="link" onClick={() => setMode('signin')}>Back to sign in</button>}
          {mode === 'signin' && <button type="button" className="link" onClick={() => setMode('signup')}>Create an account</button>}
          {mode === 'signin' && <button type="button" className="link" onClick={() => setMode('reset')}>Forgot password?</button>}
        </div>
      </form>
    </div>
  );
}
