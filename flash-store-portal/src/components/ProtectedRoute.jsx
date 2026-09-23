import { Navigate, useLocation } from 'react-router-dom';
import { useStoreAuth } from '../context/StoreAuthContext';

export default function ProtectedRoute({ children }) {
  const { storeUser } = useStoreAuth();
  const location = useLocation();
  if (!storeUser) return <Navigate to="/login" replace />;
  // Admin Platform Phase 3 — a seeded/temporary password must be changed
  // before anything else is reachable. This is a UX nicety, not the real
  // boundary (requireStorePasswordCurrent on the backend already refuses
  // every store-scoped API call while this flag is set) — but without it, a
  // forced-reset account would land on a page that immediately fails every
  // request with a 403 instead of being sent straight to where they can fix it.
  if (storeUser.forcePasswordReset && location.pathname !== '/account') {
    return <Navigate to="/account" replace />;
  }
  return children;
}
