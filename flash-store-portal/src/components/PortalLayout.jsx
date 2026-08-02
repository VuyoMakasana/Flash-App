import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useStoreAuth } from '../context/StoreAuthContext';
import { getNavForRole } from '../utils/roleNav';
import { storeApi } from '../services/api';

// Shared shell for every authenticated screen. Nav links are role-filtered
// (getNavForRole) — a role only ever sees a link it can actually use, not
// every screen with an access-denied surprise after clicking
// (FLASH_STORE_ADMIN_DESIGN.md §5.2's proactive-UX nav layer; the API layer
// underneath is what actually enforces this, confirmed already built and
// tested in Stages 3-5 — this is the UX layer on top of it, not instead of it).
export default function PortalLayout({ children }) {
  const { storeUser, logout } = useStoreAuth();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const navClass = ({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link');
  const nav = getNavForRole(storeUser?.role);

  async function handleDeleteAccount() {
    const confirmed = window.confirm(
      'Delete your own account? This cannot be undone — you will be signed out immediately and this login will never work again.',
    );
    if (!confirmed) return;
    setDeleting(true);
    try {
      await storeApi.deleteAccount();
      await logout();
      navigate('/login');
    } catch (err) {
      window.alert(err.message || 'Failed to delete account.');
      setDeleting(false);
    }
  }

  return (
    <div className="portal-shell">
      <header className="portal-header">
        <div className="portal-brand">
          <img src="/flash-logo.png" alt="Flash" className="portal-logo" />
          <nav className="portal-nav">
            {nav.map((item) => (
              <NavLink key={item.path} to={item.path} className={navClass}>{item.label}</NavLink>
            ))}
          </nav>
        </div>
        <div className="portal-header-right">
          <span className="portal-user-info">{storeUser?.name} ({storeUser?.role})</span>
          {storeUser?.role !== 'owner' && (
            <button className="btn-text-danger" onClick={handleDeleteAccount} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete my account'}
            </button>
          )}
          <button onClick={logout}>Sign out</button>
        </div>
      </header>
      <main className="portal-main">{children}</main>
    </div>
  );
}
