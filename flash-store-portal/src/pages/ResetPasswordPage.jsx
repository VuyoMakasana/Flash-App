import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { storeApi } from '../services/api';

// Admin Platform Phase 3 — pairs with sendStorePasswordResetEmail
// (backend/src/services/emailService.js), which currently emails the raw
// reset code/token directly (no dedicated reset-password web page existed
// yet on the backend side either) — this page is that landing page: paste
// the code you were emailed, set a new password.
export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setLoading(true);
    try {
      await storeApi.resetPassword(token.trim(), newPassword);
      setSuccess(true);
      setTimeout(() => navigate('/login'), 1500);
    } catch (err) {
      setError(err.message || 'Could not reset password. The code may be invalid or expired.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Set a new password</h1>
        {success ? (
          <p>Password updated. Redirecting to sign in…</p>
        ) : (
          <>
            <label>
              Reset code
              <input value={token} onChange={(e) => setToken(e.target.value)} required autoFocus />
            </label>
            <label>
              New password
              <input type="password" minLength={10} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
            </label>
            <label>
              Confirm new password
              <input type="password" minLength={10} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button type="submit" disabled={loading}>{loading ? 'Updating…' : 'Set new password'}</button>
          </>
        )}
        <Link to="/login" style={{ fontSize: 13, marginTop: 8 }}>Back to sign in</Link>
      </form>
    </div>
  );
}
