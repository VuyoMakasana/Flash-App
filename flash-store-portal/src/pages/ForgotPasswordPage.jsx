import { useState } from 'react';
import { Link } from 'react-router-dom';
import { storeApi } from '../services/api';

// Admin Platform Phase 3 — always shows the same success message regardless
// of whether the email matches a real account (storeAuthController's own
// anti-enumeration contract) — the UI must not undermine that by, say,
// only showing success after confirming the account exists client-side.
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await storeApi.forgotPassword(email);
      setSubmitted(true);
    } catch (err) {
      if (err.status === 429) setError('Too many requests — please wait before trying again.');
      else setError('Could not reach the server. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Reset your password</h1>
        {submitted ? (
          <p>If an account exists for that email, a reset code has been sent to it.</p>
        ) : (
          <>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button type="submit" disabled={loading}>{loading ? 'Sending…' : 'Send reset code'}</button>
          </>
        )}
        <Link to="/login" style={{ fontSize: 13, marginTop: 8 }}>Back to sign in</Link>
      </form>
    </div>
  );
}
