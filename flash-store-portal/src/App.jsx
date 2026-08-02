import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { StoreAuthProvider, useStoreAuth } from './context/StoreAuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import OrdersPage from './pages/OrdersPage';
import InventoryPage from './pages/InventoryPage';
import SettingsPage from './pages/SettingsPage';
import NotAvailablePage from './pages/NotAvailablePage';
import { getDefaultRouteForRole } from './utils/roleNav';

// A role-aware fallback — replaces the previous hardcoded redirect to
// /orders, which sent Inventory Staff/Finance to a screen they can't use
// at all. Not logged in falls through to /login via ProtectedRoute on
// whatever route this lands on.
function DefaultRedirect() {
  const { storeUser } = useStoreAuth();
  return <Navigate to={storeUser ? getDefaultRouteForRole(storeUser.role) : '/login'} replace />;
}

export default function App() {
  return (
    <StoreAuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/orders"
            element={
              <ProtectedRoute>
                <OrdersPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/inventory"
            element={
              <ProtectedRoute>
                <InventoryPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <SettingsPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/not-available"
            element={
              <ProtectedRoute>
                <NotAvailablePage />
              </ProtectedRoute>
            }
          />
          <Route path="/" element={<DefaultRedirect />} />
          <Route path="*" element={<DefaultRedirect />} />
        </Routes>
      </BrowserRouter>
    </StoreAuthProvider>
  );
}
