import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StoreAuthProvider, useStoreAuth } from './StoreAuthContext';
import { storeApi } from '../services/api';

/**
 * src/context/StoreAuthContext.test.jsx
 *
 * Coverage-remediation Phase 6 — the store portal's login flow, the real
 * gate every other screen in this app sits behind (ProtectedRoute reads
 * storeUser from this same context). First real test this app has ever
 * had, alongside api.test.js.
 *
 * Real-world scenarios this file protects:
 *   - a store staff member logs in with real, valid credentials -> the
 *     real token and user object the backend returns are actually
 *     persisted (so a page refresh doesn't lose the session) and exposed
 *     to the rest of the app
 *   - a backend force-password-reset flag survives being merged onto the
 *     client-side user object (ProtectedRoute's redirect depends on this
 *     exact field existing)
 *   - a failed login (wrong password) never marks anyone as logged in,
 *     and never writes a stale/partial session to localStorage
 *   - logging out clears the real session even if the server-side logout
 *     call itself fails (e.g. network drop) -- the client must never get
 *     stuck "logged in" locally with no way back to the login screen
 */

vi.mock('../services/api', () => ({
  storeApi: { login: vi.fn(), logout: vi.fn() },
}));

// A minimal real consumer -- exercises the context the same way a real
// page (LoginPage) would, through the public useStoreAuth() hook, rather
// than reaching into StoreAuthProvider's internals directly.
function TestConsumer() {
  const { storeUser, login, logout } = useStoreAuth();
  return (
    <div>
      <div data-testid="user-state">{storeUser ? JSON.stringify(storeUser) : 'logged-out'}</div>
      <button onClick={() => login('owner@teststore.co.za', 'realpassword').catch(() => {})}>Log in</button>
      <button onClick={() => logout()}>Log out</button>
    </div>
  );
}

function renderWithProvider() {
  return render(
    <StoreAuthProvider>
      <TestConsumer />
    </StoreAuthProvider>,
  );
}

describe('StoreAuthContext — real login/logout flow', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  test('a successful login persists the real token and user, including the force-password-reset flag', async () => {
    storeApi.login.mockResolvedValue({
      token: 'real-jwt-token',
      storeUser: { id: 'su-1', name: 'Store Owner', role: 'owner' },
      forcePasswordReset: true,
    });

    renderWithProvider();
    await userEvent.click(screen.getByText('Log in'));

    await waitFor(() => {
      expect(screen.getByTestId('user-state')).toHaveTextContent('Store Owner');
    });

    expect(localStorage.getItem('flash_store_token')).toBe('real-jwt-token');
    const persistedUser = JSON.parse(localStorage.getItem('flash_store_user'));
    expect(persistedUser).toEqual(expect.objectContaining({ id: 'su-1', forcePasswordReset: true }));
  });

  test('a failed login never sets a user or writes anything to localStorage', async () => {
    storeApi.login.mockRejectedValue(new Error('Invalid email or password'));

    renderWithProvider();
    await userEvent.click(screen.getByText('Log in'));

    await waitFor(() => expect(storeApi.login).toHaveBeenCalled());

    expect(screen.getByTestId('user-state')).toHaveTextContent('logged-out');
    expect(localStorage.getItem('flash_store_token')).toBeNull();
    expect(localStorage.getItem('flash_store_user')).toBeNull();
  });

  test('logging out clears the real local session even when the server-side call fails', async () => {
    // Start already "logged in" -- a real, previously-persisted session.
    localStorage.setItem('flash_store_token', 'stale-token');
    localStorage.setItem('flash_store_user', JSON.stringify({ id: 'su-1', name: 'Store Owner' }));
    storeApi.logout.mockRejectedValue(new Error('Network request failed'));

    renderWithProvider();
    expect(screen.getByTestId('user-state')).toHaveTextContent('Store Owner');

    await userEvent.click(screen.getByText('Log out'));

    await waitFor(() => {
      expect(screen.getByTestId('user-state')).toHaveTextContent('logged-out');
    });
    expect(localStorage.getItem('flash_store_token')).toBeNull();
    expect(localStorage.getItem('flash_store_user')).toBeNull();
  });
});
