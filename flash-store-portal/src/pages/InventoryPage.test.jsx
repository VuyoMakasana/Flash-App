import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import InventoryPage from './InventoryPage';
import { storeApi } from '../services/api';
import { StoreAuthProvider } from '../context/StoreAuthContext';

/**
 * src/pages/InventoryPage.test.jsx
 *
 * A1 (editing a product after creation) and A2 (reactivation), on the UI side.
 *
 * The backend guarantees are unit-tested separately; what only a UI test can
 * catch is the page sending something the backend will faithfully obey but the
 * owner never intended:
 *
 *   - PATCH treats an absent key as "leave it alone", so a form that submits
 *     every field on every save would re-send unchanged values. The visible
 *     result is right, which is exactly why this needs pinning: the damage is
 *     an audit trail claiming the owner changed a price they never touched.
 *   - a rejected price must say WHY. The backend replies with per-field
 *     messages; collapsing them into "Failed to update product" leaves the
 *     owner retyping the same invalid value.
 *   - Reactivate must exist on deactivated products. Without it the backend
 *     endpoint is real and unreachable, which is the failure mode this whole
 *     piece of work exists to fix.
 */

const ACTIVE = {
  id: 'p-active', product_name: 'Denim Jacket', price: '450.00',
  category: 'Outerwear', brand: 'Levi', description: 'Classic fit',
  is_active: true, stock_by_size: { M: 3 },
};
const DEACTIVATED = {
  id: 'p-gone', product_name: 'Old Hoodie', price: '299.00',
  is_active: false, stock_by_size: {},
};

function renderPage() {
  return render(
    <MemoryRouter>
      <StoreAuthProvider>
        <InventoryPage />
      </StoreAuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(storeApi, 'getProducts').mockResolvedValue({ products: [ACTIVE, DEACTIVATED] });
});

async function openEditor(user) {
  await screen.findByText('Denim Jacket');
  await user.click(screen.getByRole('button', { name: 'Edit Details' }));
  return screen.findByRole('button', { name: 'Save Changes' });
}

describe('A1 — editing a product', () => {
  test('the form opens seeded with the product\'s current values', async () => {
    const user = userEvent.setup();
    renderPage();
    await openEditor(user);

    expect(screen.getByLabelText(/Name/)).toHaveValue('Denim Jacket');
    expect(screen.getByLabelText(/Price/)).toHaveValue(450);
    expect(screen.getByLabelText(/Brand/)).toHaveValue('Levi');
  });

  // The core guarantee: an untouched field is omitted, not re-sent.
  test('sends only the field that actually changed', async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(storeApi, 'updateProduct').mockResolvedValue({ product: ACTIVE });
    renderPage();
    const save = await openEditor(user);

    await user.clear(screen.getByLabelText(/Price/));
    await user.type(screen.getByLabelText(/Price/), '399.99');
    await user.click(save);

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith('p-active', { price: '399.99' });
  });

  test('a save with nothing changed issues no request at all', async () => {
    const user = userEvent.setup();
    const update = vi.spyOn(storeApi, 'updateProduct').mockResolvedValue({ product: ACTIVE });
    renderPage();
    const save = await openEditor(user);

    await user.click(save);

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull());
    expect(update).not.toHaveBeenCalled();
  });

  test('a rejected price shows the backend\'s reason, not a generic failure', async () => {
    const user = userEvent.setup();
    const err = new Error('Request failed');
    err.status = 400;
    err.fieldErrors = { price: 'price must be a number greater than 0 and at most 100000' };
    vi.spyOn(storeApi, 'updateProduct').mockRejectedValue(err);
    renderPage();
    const save = await openEditor(user);

    await user.clear(screen.getByLabelText(/Name/));
    await user.type(screen.getByLabelText(/Name/), 'Denim Jacket II');
    await user.click(save);

    expect(await screen.findByText(/price must be a number greater than 0/)).toBeInTheDocument();
    expect(screen.queryByText('Failed to update product.')).toBeNull();
  });

  test('the list is refreshed after a successful edit, so the row is never stale', async () => {
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'updateProduct').mockResolvedValue({ product: ACTIVE });
    renderPage();
    const save = await openEditor(user);

    await user.clear(screen.getByLabelText(/Brand/));
    await user.type(screen.getByLabelText(/Brand/), 'Wrangler');
    await user.click(save);

    await waitFor(() => expect(storeApi.getProducts).toHaveBeenCalledTimes(2));
  });

  test('a deactivated product offers no Edit button', async () => {
    renderPage();
    await screen.findByText('Old Hoodie');

    const row = screen.getByText('Old Hoodie').closest('.product-row');
    expect(within(row).queryByRole('button', { name: 'Edit Details' })).toBeNull();
  });
});

describe('A2 — reactivating a product', () => {
  test('a deactivated product can be reactivated', async () => {
    const user = userEvent.setup();
    const reactivate = vi.spyOn(storeApi, 'reactivateProduct').mockResolvedValue({ product: DEACTIVATED });
    renderPage();
    await screen.findByText('Old Hoodie');

    const row = screen.getByText('Old Hoodie').closest('.product-row');
    await user.click(within(row).getByRole('button', { name: 'Reactivate' }));

    await waitFor(() => expect(reactivate).toHaveBeenCalledWith('p-gone'));
    // Reloaded, so the product moves back into Active without a manual refresh.
    await waitFor(() => expect(storeApi.getProducts).toHaveBeenCalledTimes(2));
  });

  test('an active product offers no Reactivate button', async () => {
    renderPage();
    await screen.findByText('Denim Jacket');

    const row = screen.getByText('Denim Jacket').closest('.product-row');
    expect(within(row).queryByRole('button', { name: 'Reactivate' })).toBeNull();
  });

  test('a failed reactivation is reported rather than silently doing nothing', async () => {
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'reactivateProduct').mockRejectedValue(new Error('Product not found'));
    renderPage();
    await screen.findByText('Old Hoodie');

    const row = screen.getByText('Old Hoodie').closest('.product-row');
    await user.click(within(row).getByRole('button', { name: 'Reactivate' }));

    expect(await screen.findByText('Product not found')).toBeInTheDocument();
  });
});
