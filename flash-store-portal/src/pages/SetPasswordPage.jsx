import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { storeApi } from '../services/api';

/**
 * Phase 3 — step 3 of onboarding: a newly-approved owner chooses their first
 * password.
 *
 * Deliberately reuses POST /api/store-auth/reset-password and the existing
 * store_password_tokens table rather than adding an invite-specific endpoint.
 * StoreOnboardingService.approve() mints the token into that same table
 * (7-day TTL, vs 1 hour for a real reset), and that endpoint already does
 * every part correctly: it accepts only a token that is unused AND unexpired,
 * spends it inside a transaction, stamps password_changed_at, and clears
 * force_password_reset. One token mechanism means one thing to keep secure.
 *
 * This is a separate PAGE from ResetPasswordPage, though, because the two
 * moments read completely differently to the person in front of them: this one
 * is "you've been approved, welcome" and happens exactly once, where
 * /reset-password is "you forgot your password". Sharing the mechanism costs
 * nothing; sharing the copy would have greeted a brand-new store owner with a
 * page titled "Set a new password" and a field called "Reset code".
 *
 * The setup code is pasted, never carried in the URL. That is the existing
 * flow's own choice and it is kept on purpose: a single-use credential in a
 * query string leaks into browser history, into the Referer header of any
 * third-party request the page makes, and into static-host access logs. A
 * one-click magic link would be friendlier, and is a reasonable thing to want
 * — it is written up as an open trade-off in the Phase 3 record rather than
 * decided here, because it weakens a security property that is currently
 * intact.
 */

const MIN_PASSWORD_LENGTH = 10; // matches storeAuthRoutes.js: isLength({ min: 10 })

export default function SetPasswordPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  function validateLocally() {
    const errors = {};
    if (!token.trim()) errors.token = 'Please paste the setup code from your email.';
    if (!password) {
      errors.password = 'Please choose a password.';
    } else if (password.length < MIN_PASSWORD_LENGTH) {
      errors.password = `Please use at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    // Checked before sending: a mismatch is the single most common mistake on
    // this form, and it would otherwise cost a round trip to learn about.
    if (password && confirm !== password) {
      errors.confirm = 'These two passwords don\'t match.';
    }
    return errors;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);

    const localErrors = validateLocally();
    if (Object.keys(localErrors).length) {
      setFieldErrors(localErrors);
      return;
    }
    setFieldErrors({});
    setLoading(true);

    try {
      await storeApi.resetPassword(token.trim(), password);
      setDone(true);
      setTimeout(() => navigate('/login'), 2000);
    } catch (err) {
      if (err.status === 429) {
        setFormError('Too many attempts — please wait a few minutes and try again.');
      } else if (err.fieldErrors?.newPassword) {
        setFieldErrors({ password: `Please use at least ${MIN_PASSWORD_LENGTH} characters.` });
      } else if (err.status === 400) {
        // The backend answers with one generic message for invalid, expired
        // and already-used codes alike, so that a wrong code can't be told
        // apart from an expired one. Surfaced against the code field, with
        // the recovery path spelled out, but deliberately not guessing which
        // of the three it was.
        setFieldErrors({
          token: 'This setup code isn\'t valid. It may have expired, or already been used.',
        });
        setFormError(
          'Setup codes expire 7 days after approval and work only once. '
          + 'If yours has run out, use "Forgot password?" on the sign-in page to get a new one.',
        );
      } else {
        setFormError('We couldn\'t set your password just now. Please check your connection and try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  if (done) {
    return (
      <div className="onboard-page">
        <div className="onboard-card onboard-card--narrow">
          <div className="onboard-brand">FLASH</div>
          <div className="onboard-tick" aria-hidden="true">✓</div>
          <h1>You&apos;re all set</h1>
          <p className="onboard-lede">
            Your password is saved and your store is open. Taking you to sign in…
          </p>
          <Link className="onboard-link" to="/login">Go to sign in now</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="onboard-page">
      <form className="onboard-card onboard-card--narrow" onSubmit={handleSubmit} noValidate>
        <div className="onboard-brand">FLASH</div>
        <h1>Set your password</h1>
        <p className="onboard-lede">
          Your store has been approved. Paste the setup code from your approval email and choose a
          password — then you can sign in and start receiving orders.
        </p>

        <ol className="onboard-progress" aria-label="Steps to open your store">
          <li className="is-done"><span>✓</span>Apply</li>
          <li className="is-done"><span>✓</span>Flash reviews</li>
          <li className="is-current"><span>3</span>Set password</li>
        </ol>

        <div className="onboard-fields">
          <label className={fieldErrors.token ? 'has-error' : undefined}>
            <span className="onboard-label">Setup code</span>
            <input
              value={token}
              onChange={(e) => { setToken(e.target.value); setFieldErrors((p) => ({ ...p, token: undefined })); }}
              autoComplete="one-time-code"
              spellCheck="false"
              autoCapitalize="none"
              className="onboard-code-input"
              aria-invalid={fieldErrors.token ? 'true' : undefined}
              aria-describedby={fieldErrors.token ? 'err-token' : 'hint-token'}
              autoFocus
            />
            {fieldErrors.token ? (
              <span className="onboard-field-error" id="err-token">{fieldErrors.token}</span>
            ) : (
              <span className="onboard-hint" id="hint-token">
                The long code in your approval email. Valid for 7 days, and usable once.
              </span>
            )}
          </label>

          <label className={fieldErrors.password ? 'has-error' : undefined}>
            <span className="onboard-label">Choose a password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setFieldErrors((p) => ({ ...p, password: undefined })); }}
              autoComplete="new-password"
              aria-invalid={fieldErrors.password ? 'true' : undefined}
              aria-describedby={fieldErrors.password ? 'err-password' : 'hint-password'}
            />
            {fieldErrors.password ? (
              <span className="onboard-field-error" id="err-password">{fieldErrors.password}</span>
            ) : (
              <span className="onboard-hint" id="hint-password">
                At least {MIN_PASSWORD_LENGTH} characters. A short phrase you&apos;ll remember beats a
                short complicated word.
              </span>
            )}
          </label>

          <label className={fieldErrors.confirm ? 'has-error' : undefined}>
            <span className="onboard-label">Confirm password</span>
            <input
              type="password"
              value={confirm}
              onChange={(e) => { setConfirm(e.target.value); setFieldErrors((p) => ({ ...p, confirm: undefined })); }}
              autoComplete="new-password"
              aria-invalid={fieldErrors.confirm ? 'true' : undefined}
              aria-describedby={fieldErrors.confirm ? 'err-confirm' : undefined}
            />
            {fieldErrors.confirm && (
              <span className="onboard-field-error" id="err-confirm">{fieldErrors.confirm}</span>
            )}
          </label>
        </div>

        {formError && <p className="form-error" role="alert">{formError}</p>}

        <button type="submit" disabled={loading}>
          {loading ? 'Saving…' : 'Save password and continue'}
        </button>

        <p className="onboard-footer">
          <Link to="/login">Back to sign in</Link>
        </p>
      </form>
    </div>
  );
}
