import { Navigate } from 'react-router-dom';
import { useStoreAuth } from '../context/StoreAuthContext';

export default function ProtectedRoute({ children }) {
  const { storeUser } = useStoreAuth();
  if (!storeUser) return <Navigate to="/login" replace />;
  return children;
}
