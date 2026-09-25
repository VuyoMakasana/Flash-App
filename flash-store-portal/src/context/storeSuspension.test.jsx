import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { StoreAuthProvider } from './StoreAuthContext';
import ProtectedRoute from '../components/ProtectedRoute';
import LoginPage from '../pages/LoginPage';
import { storeApi, SESSION_ENDED_EVENT } from '../services/api';

/**
 * src/context/storeSuspension.test.jsx
 *
 * The client half of the store-suspension kill switch, tested through the
 * router rather than by poking the context directly — what matters is that a
 * suspended user actually ENDS UP somewhere sensible, not that a state
 * setter fired.
 *
 * The gap this closes: ProtectedRoute decided access purely from a
 * localStorage value, which nothing ever invalidated. The backend was always
 * the real boundary (requests were refused), but the portal kept rendering
 * as though the user were signed in, so a suspended owner saw a dashboard
 * where every panel errored instead of being told what happened.
 */

function Dashboard() {
  return <div>Orders dashboard</div>;
}

function renderPortal() {
  return render(
    <StoreAuthProvider>
      <MemoryRouter initialEntries={['/orders']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/orders"
            element={<ProtectedRoute><Dashboard /></ProtectedRoute>}
          />
        </Routes>
      </MemoryRouter>
    </StoreAuthProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('a store suspended mid-session', () => {
  test('ejects the user to the login screen instead of leaving them on a broken dashboard', async () => {
    localStorage.setItem('flash_store_token', 'live-token');
    localStorage.setItem('flash_store_user', JSON.stringify({ id: 'su-1', role: 'owner' }));

    renderPortal();
    // Signed in to begin with — the guard is genuinely being satisfied here,
    // so the redirect below is caused by the suspension and not by an empty
    // session.
    expect(screen.getByText('Orders dashboard')).toBeInTheDocument();

    // The store is suspended: the very next API call comes back 403.
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: 'This store is not currently active. Please contact Flash support.',
        code: 'STORE_SUSPENDED',
      }),
    });
    await expect(storeApi.getOrders()).rejects.toThrow();

    await waitFor(() => {
      expect(screen.queryByText('Orders dashboard')).not.toBeInTheDocument();
    });
    // findBy, not getBy: the redirect and the login page's own render are two
    // separate commits, so the dashboard is gone a tick before /login paints.
    expect(await screen.findByRole('heading', { name: /flash store portal/i })).toBeInTheDocument();
  });

  test('explains why, rather than silently bouncing them to a login form', async () => {
    localStorage.setItem('flash_store_token', 'live-token');
    localStorage.setItem('flash_store_user', JSON.stringify({ id: 'su-1', role: 'owner' }));

    renderPortal();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: 'This store is not currently active. Please contact Flash support.',
        code: 'STORE_SUSPENDED',
      }),
    });
    await expect(storeApi.getOrders()).rejects.toThrow();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/not currently active/i);
  });

  test('the explanation is shown once, not on every later visit to the login page', async () => {
    // The reason is consumed on read. Otherwise an owner whose store was
    // reactivated would keep being told it was suspended.
    localStorage.setItem('flash_store_session_ended_reason', 'This store is not currently active.');

    const first = render(
      <StoreAuthProvider>
        <MemoryRouter><LoginPage /></MemoryRouter>
      </StoreAuthProvider>,
    );
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    first.unmount();

    render(
      <StoreAuthProvider>
        <MemoryRouter><LoginPage /></MemoryRouter>
      </StoreAuthProvider>,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('an unrelated failure leaves the user signed in', async () => {
    // Session teardown is destructive — it must not fire for a role guard or
    // an expired token, both of which are handled per page.
    localStorage.setItem('flash_store_token', 'live-token');
    localStorage.setItem('flash_store_user', JSON.stringify({ id: 'su-1', role: 'owner' }));

    renderPortal();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: 'Access forbidden. Required role: owner' }),
    });
    await expect(storeApi.getOrders()).rejects.toThrow();

    expect(screen.getByText('Orders dashboard')).toBeInTheDocument();
  });

  test('the context reacts to the event itself, independent of who dispatched it', async () => {
    localStorage.setItem('flash_store_token', 'live-token');
    localStorage.setItem('flash_store_user', JSON.stringify({ id: 'su-1', role: 'owner' }));

    renderPortal();
    expect(screen.getByText('Orders dashboard')).toBeInTheDocument();

    window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { reason: 'suspended' } }));

    await waitFor(() => {
      expect(screen.queryByText('Orders dashboard')).not.toBeInTheDocument();
    });
  });
});
