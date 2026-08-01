import { NavLink } from 'react-router-dom';
import { useStoreAuth } from '../context/StoreAuthContext';

// Shared shell for every authenticated screen — Orders and Inventory both
// use this now, so a second real screen doesn't mean a second copy of the
// sign-out/user-info header (FLASH_STORE_ADMIN_DESIGN.md §6.2's sidebar
// navigation, kept simple as a top nav bar for this small a page count).
export default function PortalLayout({ children }) {
  const { storeUser, logout } = useStoreAuth();
  const navClass = ({ isActive }) => (isActive ? 'nav-link nav-link-active' : 'nav-link');

  return (
    <div className="portal-shell">
      <header className="portal-header">
        <nav className="portal-nav">
          <NavLink to="/orders" className={navClass}>Orders</NavLink>
          <NavLink to="/inventory" className={navClass}>Inventory</NavLink>
          <NavLink to="/settings" className={navClass}>Settings</NavLink>
        </nav>
        <div className="portal-header-right">
          <span>{storeUser?.name} ({storeUser?.role})</span>
          <button onClick={logout}>Sign out</button>
        </div>
      </header>
      <main className="portal-main">{children}</main>
    </div>
  );
}
