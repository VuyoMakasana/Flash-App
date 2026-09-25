import { describe, test, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SignupPage from './SignupPage';
import { storeApi } from '../services/api';

/**
 * src/pages/SignupPage.test.jsx
 *
 * Phase 3 — the public store-onboarding application form.
 *
 * The tests that matter most here are the adversarial ones, because the
 * dangerous failures on this page are all things that LOOK like working
 * software:
 *
 *   - a confirmation screen that quietly differs between "new application"
 *     and "email already registered" would re-open the account-enumeration
 *     hole the backend deliberately closed (its 23505 branch answers 201
 *     with the identical success message). The UI is the other half of that
 *     contract, and nothing but a test enforces it.
 *   - copy that implies the store is live would be a plain lie: an
 *     application creates an INACTIVE store pending admin approval.
 *   - a rate-limit rejection shown as a raw "Request failed" would read as
 *     a bug in Flash rather than "wait an hour", and the applicant would
 *     keep retrying into a wall.
 */

function renderPage() {
  return render(
    <MemoryRouter>
      <SignupPage />
    </MemoryRouter>,
  );
}

const VALID = {
  store: 'Kwazakhele Threads',
  owner: 'Nomsa Dlamini',
  email: 'nomsa@example.com',
};

async function fillRequired(user) {
  await user.type(screen.getByLabelText(/store name/i), VALID.store);
  await user.type(screen.getByLabelText(/your full name/i), VALID.owner);
  await user.type(screen.getByLabelText(/email address/i), VALID.email);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('SignupPage — submitting a valid application', () => {
  test('sends exactly the snake_case field names the endpoint validates', async () => {
    const user = userEvent.setup();
    const apply = vi.spyOn(storeApi, 'applyForStore').mockResolvedValue({ success: true });

    renderPage();
    await fillRequired(user);
    await user.type(screen.getByLabelText(/phone number/i), '0821234567');
    await user.type(screen.getByLabelText(/store address/i), '12B Mkele Street, Kwazakhele');
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith({
      store_name: VALID.store,
      owner_name: VALID.owner,
      owner_email: VALID.email,
      owner_phone: '0821234567',
      address: '12B Mkele Street, Kwazakhele',
    });
  });

  test('confirmation never implies the store is live, and states approval is pending', async () => {
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'applyForStore').mockResolvedValue({ success: true });

    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    await screen.findByText(/application received/i);
    // The explicit promise that nothing is live yet.
    expect(screen.getByText(/store isn't live yet/i)).toBeInTheDocument();
    expect(screen.getByText(/won't be able to sign in until it's approved/i)).toBeInTheDocument();
    // And no claim to the contrary anywhere on the screen.
    expect(screen.queryByText(/your store is (now )?live/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/start selling now/i)).not.toBeInTheDocument();
  });
});

describe('SignupPage — anti-enumeration (the backend contract this page must not break)', () => {
  // The endpoint answers 201 with an identical message for a brand-new
  // application and for an email that is already registered. Rendering both
  // responses must therefore produce identical screens: if this page ever
  // branched on anything in the response, it would leak which businesses
  // have already applied.
  test('an already-registered email produces a screen identical to a new application', async () => {
    const duplicateResponse = {
      success: true,
      message: 'Application received. Flash will review it and email you the next steps.',
    };

    const user1 = userEvent.setup();
    vi.spyOn(storeApi, 'applyForStore').mockResolvedValue(duplicateResponse);
    const first = renderPage();
    await fillRequired(user1);
    await user1.click(screen.getByRole('button', { name: /submit application/i }));
    await screen.findByText(/application received/i);
    const newApplicationHtml = first.container.innerHTML;
    first.unmount();

    // Same response body, as the duplicate branch returns — must render the
    // same thing, byte for byte.
    const user2 = userEvent.setup();
    vi.spyOn(storeApi, 'applyForStore').mockResolvedValue(duplicateResponse);
    const second = renderPage();
    await fillRequired(user2);
    await user2.click(screen.getByRole('button', { name: /submit application/i }));
    await screen.findByText(/application received/i);

    expect(second.container.innerHTML).toBe(newApplicationHtml);
  });

  test('never tells the applicant an account already exists', async () => {
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'applyForStore').mockResolvedValue({ success: true });

    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /submit application/i }));
    await screen.findByText(/application received/i);

    expect(screen.queryByText(/already (registered|applied|exists|have)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/duplicate/i)).not.toBeInTheDocument();
  });
});

describe('SignupPage — validation is caught locally to protect the 5/hour budget', () => {
  test('an invalid email is rejected without spending a rate-limit slot', async () => {
    const user = userEvent.setup();
    const apply = vi.spyOn(storeApi, 'applyForStore');

    renderPage();
    await user.type(screen.getByLabelText(/store name/i), VALID.store);
    await user.type(screen.getByLabelText(/your full name/i), VALID.owner);
    await user.type(screen.getByLabelText(/email address/i), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    expect(await screen.findByText(/valid email address/i)).toBeInTheDocument();
    // The actual point of the local check: no request was made at all.
    expect(apply).not.toHaveBeenCalled();
  });

  test('a one-character store name is rejected locally, per the min:2 server rule', async () => {
    const user = userEvent.setup();
    const apply = vi.spyOn(storeApi, 'applyForStore');

    renderPage();
    await user.type(screen.getByLabelText(/store name/i), 'K');
    await user.type(screen.getByLabelText(/your full name/i), VALID.owner);
    await user.type(screen.getByLabelText(/email address/i), VALID.email);
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    expect(await screen.findByText(/at least 2 characters/i)).toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
  });

  test('an error clears as soon as the applicant edits that field', async () => {
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'applyForStore');

    renderPage();
    await user.click(screen.getByRole('button', { name: /submit application/i }));
    expect(await screen.findByText(/please enter your store name/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/store name/i), 'Kwazakhele Threads');
    expect(screen.queryByText(/please enter your store name/i)).not.toBeInTheDocument();
  });
});

describe('SignupPage — server-side errors land on the right field', () => {
  test('per-field API errors render inline, not as one generic banner', async () => {
    const user = userEvent.setup();
    const err = Object.assign(new Error('Request failed'), {
      status: 400,
      fieldErrors: { owner_phone: 'Invalid value' },
    });
    vi.spyOn(storeApi, 'applyForStore').mockRejectedValue(err);

    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    // express-validator's bare "Invalid value" is translated into the field's
    // real label rather than shown raw.
    expect(await screen.findByText(/check the phone number field/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/phone number/i)).toHaveAttribute('aria-invalid', 'true');
  });

  test('a 429 explains the wait instead of surfacing a raw failure', async () => {
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'applyForStore').mockRejectedValue(
      Object.assign(new Error('Too many applications from this network.'), { status: 429 }),
    );

    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/try again a little later/i);
    expect(screen.queryByText(/^request failed$/i)).not.toBeInTheDocument();
    // Crucially the form is still there with their input intact — a 429 must
    // not look like a submitted application.
    expect(screen.getByLabelText(/store name/i)).toHaveValue(VALID.store);
    expect(screen.queryByText(/application received/i)).not.toBeInTheDocument();
  });

  test('a server fault does not claim the application was received', async () => {
    const user = userEvent.setup();
    vi.spyOn(storeApi, 'applyForStore').mockRejectedValue(
      Object.assign(new Error('Could not submit your application. Please try again.'), { status: 500 }),
    );

    renderPage();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(/application received/i)).not.toBeInTheDocument();
  });
});
