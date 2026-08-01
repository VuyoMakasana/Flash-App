import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { StoreAuthProvider } from './context/StoreAuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import OrdersPage from './pages/OrdersPage';

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
          <Route path="/" element={<Navigate to="/orders" replace />} />
          <Route path="*" element={<Navigate to="/orders" replace />} />
        </Routes>
      </BrowserRouter>
    </StoreAuthProvider>
  );
}
