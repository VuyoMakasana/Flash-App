import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { storeApi } from '../services/api';
import { useStoreAuth } from '../context/StoreAuthContext';
import { getDefaultRouteForRole } from '../utils/roleNav';
import PortalLayout from '../components/PortalLayout';

// Admin Platform Phase 3 — every store account's own independent
// change-password flow, reachable by every role (not gated by roleNav.js —
// this is a "my own account" page, not a store-management screen). Also
// where a seeded/temporary password (force_password_reset) gets changed —
// ProtectedRoute redirects here automatically until that happens.
export default function AccountPage() {
  const { storeUser, clearForcePasswordReset } = useStoreAuth();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
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
    if (newPassword.length < 10) {
      setError('New password must be at least 10 characters.');
      return;
    }
    setLoading(true);
    try {
      const { token } = await storeApi.changePassword(currentPassword, newPassword);
      clearForcePasswordReset(token);
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      if (storeUser?.forcePasswordReset) {
        // Was here because it was mandatory — now that it's done, go
        // straight to wherever this role actually lands.
        setTimeout(() => navigate(getDefaultRouteForRole(storeUser.role)), 1200);
      }
    } catch (err) {
      setError(err.message || 'Failed to change password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <PortalLayout>
      <h1>My Account</h1>
      {storeUser?.forcePasswordReset && (
        <p className="form-error">
          Your password is temporary and must be changed before you can use the rest of the portal.
        </p>
      )}
      <form className="add-product-form" onSubmit={handleSubmit} style={{ maxWidth: 420 }}>
        <label>
          Current password
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label>
          New password
          <input
            type="password"
            minLength={10}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
          />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            minLength={10}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        {success && <p className="form-success">Password updated.</p>}
        <button type="submit" disabled={loading}>{loading ? 'Updating…' : 'Change password'}</button>
      </form>
      <p style={{ marginTop: 24, color: '#6b7280', fontSize: 14 }}>
        Signed in as {storeUser?.name} ({storeUser?.email}) — {storeUser?.role?.replace('_', ' ')}.
      </p>
    </PortalLayout>
  );
}
