import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStoreAuth } from '../context/StoreAuthContext';

export default function LoginPage() {
  const { login } = useStoreAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      navigate('/orders');
    } catch (err) {
      // err.status is only ever set once a real HTTP response comes back
      // (see services/api.js) — a network-level failure (server down, a
      // misconfigured ALLOWED_ORIGINS blocking this origin via CORS) never
      // reaches that point at all, and must not be shown as "wrong
      // password": that's actively misleading for diagnosing a real
      // deployment mistake, not a credentials problem.
      if (err.status === 429) setError('Too many attempts — please wait before trying again.');
      else if (err.status === 401) setError('Invalid email or password.');
      else setError('Could not reach the server. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>Flash Store Portal</h1>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
