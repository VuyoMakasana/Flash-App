import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SetPasswordPage from './SetPasswordPage';
import { storeApi } from '../services/api';

/**
 * src/pages/SetPasswordPage.test.jsx
 *
 * Phase 3 — step 3: a newly-approved owner sets their first password by
 * spending the single-use invite token from store_password_tokens.
 *
 * What these tests protect:
 *   - the page goes through the EXISTING reset-password endpoint. If someone
 *     later points it at a new invite-specific route, that route would have
 *     to re-implement expiry, single-use and the atomic spend — the exact
 *     duplication the backend avoided on purpose.
 *   - an expired or already-used code must fail safely and explain the
 *     recovery path, without the page guessing which of the two it was (the
 *     backend returns one generic message precisely so a wrong code can't be
 *     distinguished from an expired one).
 *   - the success screen must not appear on any failure, since it tells the
 *     owner their store is open.
 */

function renderPage() {
  return render(
    <MemoryRouter>
      <SetPasswordPage />
    </MemoryRouter>,
  );
}

const TOKEN = 'a'.repeat(96); // real shape: crypto.randomBytes(48).toString('hex')
const GOOD_PASSWORD = 'lekker-boutique-2026';

async function fill(user, { token = TOKEN, password = GOOD_PASSWORD, confirm = GOOD_PASSWORD } = {}) {
  if (token) await user.type(screen.getByLabelText(/setup code/i), token);
  if (password) await user.type(screen.getByLabelText(/choose a password/i), password);
  if (confirm) await user.type(screen.getByLabelText(/confirm password/i), confirm);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SetPasswordPage — the happy path goes through the existing reset endpoint', () => {
  test('calls storeApi.resetPassword with the trimmed token and chosen password', async () => {
    const user = userEvent.setup();
    const reset = vi.spyOn(storeApi, 'resetPassword').mockResolvedValue({ success: true });

    renderPage();
    await fill(user);
    await user.click(screen.getByRole('button', { name: /save password/i }));

    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(reset).toHaveBeenCalledWith(TOKEN, GOOD_PASSWORD);
  });

  test('whitespace around a pasted code is trimmed rather than sent through', async () => {
    const user = userEvent.setup();
    const reset = vi.spyOn(storeApi, 'resetPassword').mockResolvedValue({ success: true });

    renderPage();
    // Real-world: copying the code out of an email very often brings a
    // trailing space or newline with it.
    await user.type(screen.getByLabelText(/setup code/i), `  ${TOKEN}  `);
    await user.type(screen.getByLabelText(/choose a password/i), GOOD_PASSWORD);
    await user.type(screen.getByLabelText(/confirm password/i), GOOD_PASSWORD);
    await user.click(screen.getByRole('button', { name: /save password/i }));

    await waitFor(() => expect(reset).toHaveBeenCalledWith(TOKEN, GOOD_PASSWORD));
  });

  test('confirms success only after the request resolves', async () => {
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'resetPassword').mockResolvedValue({ success: true });

    renderPage();
    await fill(user);
    expect(screen.queryByText(/you're all set/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save password/i }));
    expect(await screen.findByText(/you're all set/i)).toBeInTheDocument();
  });
});

describe('SetPasswordPage — expired, reused and invalid codes', () => {
  test('a rejected code explains expiry and single-use without guessing which failed', async () => {
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'resetPassword').mockRejectedValue(
      Object.assign(new Error('Invalid or expired reset link. Please request a new one.'), { status: 400 }),
    );

    renderPage();
    await fill(user);
    await user.click(screen.getByRole('button', { name: /save password/i }));

    expect(await screen.findByText(/may have expired, or already been used/i)).toBeInTheDocument();
    // The recovery path is spelled out — otherwise an owner whose 7 days ran
    // out has no idea what to do next and simply cannot get in.
    expect(screen.getByRole('alert')).toHaveTextContent(/forgot password/i);
    // And it must not claim success.
    expect(screen.queryByText(/you're all set/i)).not.toBeInTheDocument();
  });

  test('a reused code is treated exactly like an expired one (no oracle)', async () => {
    // The backend cannot distinguish these in its response, and this page
    // must not invent a distinction either.
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'resetPassword').mockRejectedValue(
      Object.assign(new Error('Invalid or expired reset link. Please request a new one.'), { status: 400 }),
    );

    renderPage();
    await fill(user);
    await user.click(screen.getByRole('button', { name: /save password/i }));

    const message = (await screen.findByText(/may have expired, or already been used/i)).textContent;
    expect(message).not.toMatch(/already used/i); // not singled out
    expect(message).not.toMatch(/does not exist|not found/i);
  });

  test('a 429 is surfaced as a wait, not a bad code', async () => {
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'resetPassword').mockRejectedValue(
      Object.assign(new Error('Too many requests'), { status: 429 }),
    );

    renderPage();
    await fill(user);
    await user.click(screen.getByRole('button', { name: /save password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too many attempts/i);
    // Must not tell them the code is wrong when it may be perfectly valid.
    expect(screen.queryByText(/may have expired/i)).not.toBeInTheDocument();
  });
});

describe('SetPasswordPage — local validation', () => {
  test('mismatched passwords are caught before any request', async () => {
    const user = userEvent.setup();
    const reset = vi.spyOn(storeApi, 'resetPassword');

    renderPage();
    await fill(user, { confirm: 'something-else-entirely' });
    await user.click(screen.getByRole('button', { name: /save password/i }));

    expect(await screen.findByText(/don't match/i)).toBeInTheDocument();
    expect(reset).not.toHaveBeenCalled();
  });

  test('a password under the server minimum of 10 is caught locally', async () => {
    const user = userEvent.setup();
    const reset = vi.spyOn(storeApi, 'resetPassword');

    renderPage();
    await fill(user, { password: 'short', confirm: 'short' });
    await user.click(screen.getByRole('button', { name: /save password/i }));

    expect(await screen.findByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(reset).not.toHaveBeenCalled();
  });

  test('a missing setup code is caught locally', async () => {
    const user = userEvent.setup();
    const reset = vi.spyOn(storeApi, 'resetPassword');

    renderPage();
    await fill(user, { token: '' });
    await user.click(screen.getByRole('button', { name: /save password/i }));

    // Scoped to the field's own error node — the page's intro copy also
    // contains the phrase "paste the setup code", and matching that instead
    // would pass even with validation entirely removed.
    const fieldError = await screen.findByText(/please paste the setup code/i);
    expect(fieldError).toHaveClass('onboard-field-error');
    expect(reset).not.toHaveBeenCalled();
  });
});
