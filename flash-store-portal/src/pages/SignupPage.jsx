import { useState } from 'react';
import { Link } from 'react-router-dom';
import { storeApi } from '../services/api';

/**
 * Phase 3 — the public "apply to sell on Flash" page.
 *
 * Pairs with POST /api/store-onboarding/apply (storeOnboardingController.js).
 * This is a real boutique owner's first contact with Flash's back office, so
 * it is deliberately a marketing-quality page rather than an internal form.
 *
 * Three things here are security requirements, not styling choices:
 *
 *  1. The confirmation copy is IDENTICAL whether the application was new or
 *     the email was already registered. The endpoint answers 201 with the
 *     same message in both cases on purpose (its 23505 branch), so that it
 *     cannot be used to test which businesses have applied. A UI that said
 *     "you've already applied" would hand back exactly the oracle the
 *     backend refuses to give. See also ForgotPasswordPage, which holds the
 *     same line for password resets.
 *
 *  2. The copy never implies the store is live. An application creates an
 *     INACTIVE store and an INACTIVE owner account; only an admin approval
 *     turns either on. Telling an owner they are open for business when
 *     nothing has been reviewed yet would be a straightforward lie, and
 *     they would go looking for orders that cannot exist.
 *
 *  3. Validation is mirrored client-side before submitting. That is not
 *     duplicated logic for its own sake — the endpoint allows only 5
 *     applications per hour per IP, so letting a typo consume one of those
 *     five slots is a real cost to a real applicant. The server remains the
 *     authority; this only stops the obviously-invalid round trip.
 */

// Mirrors storeOnboardingRoutes.js's express-validator chain exactly. Kept
// beside the fields it describes so the two cannot drift silently.
const LIMITS = {
  store_name: { min: 2, max: 200 },
  owner_name: { min: 2, max: 200 },
  owner_phone: { max: 20 },
  address: { max: 500 },
};

const EMPTY = {
  store_name: '',
  owner_name: '',
  owner_email: '',
  owner_phone: '',
  address: '',
};

// Intentionally permissive: the server's isEmail() is the real check. This
// only catches input that obviously isn't an address yet, so it cannot
// reject a valid-but-unusual one the backend would have accepted.
function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function validateLocally(form) {
  const errors = {};

  const storeName = form.store_name.trim();
  if (!storeName) errors.store_name = 'Please enter your store name.';
  else if (storeName.length < LIMITS.store_name.min) errors.store_name = 'Please use at least 2 characters.';
  else if (storeName.length > LIMITS.store_name.max) errors.store_name = 'Please keep this under 200 characters.';

  const ownerName = form.owner_name.trim();
  if (!ownerName) errors.owner_name = 'Please enter your full name.';
  else if (ownerName.length < LIMITS.owner_name.min) errors.owner_name = 'Please use at least 2 characters.';
  else if (ownerName.length > LIMITS.owner_name.max) errors.owner_name = 'Please keep this under 200 characters.';

  if (!form.owner_email.trim()) errors.owner_email = 'Please enter your email address.';
  else if (!looksLikeEmail(form.owner_email)) errors.owner_email = 'Please enter a valid email address.';

  if (form.owner_phone.trim().length > LIMITS.owner_phone.max) {
    errors.owner_phone = 'Please keep this under 20 characters.';
  }
  if (form.address.trim().length > LIMITS.address.max) {
    errors.address = 'Please keep this under 500 characters.';
  }

  return errors;
}

// Friendly, human labels for the fields — used to describe which fields the
// server rejected without echoing express-validator's raw "Invalid value".
const FIELD_LABELS = {
  store_name: 'Store name',
  owner_name: 'Your name',
  owner_email: 'Email address',
  owner_phone: 'Phone number',
  address: 'Store address',
};

export default function SignupPage() {
  const [form, setForm] = useState(EMPTY);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
    // Clear that field's error as soon as the applicant starts fixing it —
    // leaving a stale red message under a field they've already corrected
    // reads as though the form is broken.
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);

    const localErrors = validateLocally(form);
    if (Object.keys(localErrors).length) {
      setFieldErrors(localErrors);
      return;
    }
    setFieldErrors({});
    setLoading(true);

    try {
      await storeApi.applyForStore(form);
      setSubmitted(true);
    } catch (err) {
      if (err.status === 429) {
        setFormError(
          'We\'ve had several applications from your network in the last hour. '
          + 'Please try again a little later — nothing you typed has been lost.',
        );
      } else if (err.fieldErrors && Object.keys(err.fieldErrors).length) {
        // The server found something our local check let through. Show it
        // against the field itself, translating express-validator's generic
        // "Invalid value" into the label the applicant actually sees.
        const translated = Object.entries(err.fieldErrors).reduce((acc, [field, msg]) => {
          acc[field] = /invalid value/i.test(msg)
            ? `Please check the ${(FIELD_LABELS[field] || field).toLowerCase()} field.`
            : msg;
          return acc;
        }, {});
        setFieldErrors(translated);
        setFormError('Please correct the highlighted fields and try again.');
      } else if (err.status >= 500 || !err.status) {
        setFormError('We couldn\'t submit your application just now. Please check your connection and try again.');
      } else {
        setFormError(err.message || 'We couldn\'t submit your application. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <div className="onboard-page">
        <div className="onboard-card onboard-card--narrow">
          <div className="onboard-brand">FLASH</div>
          <div className="onboard-tick" aria-hidden="true">✓</div>
          <h1>Application received</h1>
          {/* Wording matches the endpoint's own response for BOTH the new
              and already-registered cases — see this file's header note. */}
          <p className="onboard-lede">
            Thanks{form.owner_name.trim() ? `, ${form.owner_name.trim().split(' ')[0]}` : ''}. Our team will
            review your application and email <strong>{form.owner_email.trim()}</strong> with the next steps.
          </p>
          <div className="onboard-next">
            <h2>What happens next</h2>
            <ol className="onboard-steps">
              <li>
                <strong>We review your store.</strong> A person at Flash checks the details you sent.
                This usually takes a couple of business days.
              </li>
              <li>
                <strong>You get an email either way.</strong> If you&apos;re approved, it includes a
                single-use setup code for choosing your password.
              </li>
              <li>
                <strong>You set your password and sign in.</strong> That&apos;s when your store goes
                live and can start receiving orders.
              </li>
            </ol>
            <p className="onboard-note">
              Your store isn&apos;t live yet, and you won&apos;t be able to sign in until it&apos;s approved.
              If you don&apos;t hear from us within a week, reply to any Flash email and we&apos;ll chase it up.
            </p>
          </div>
          <Link className="onboard-link" to="/login">Back to sign in</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="onboard-page">
      <form className="onboard-card" onSubmit={handleSubmit} noValidate>
        <div className="onboard-brand">FLASH</div>
        <h1>Sell on Flash</h1>
        <p className="onboard-lede">
          Same-day clothing delivery for your customers. Tell us about your store and we&apos;ll
          review your application — it takes about two minutes.
        </p>

        <ol className="onboard-progress" aria-label="Steps to open your store">
          <li className="is-current"><span>1</span>Apply</li>
          <li><span>2</span>Flash reviews</li>
          <li><span>3</span>Set password</li>
        </ol>

        <div className="onboard-fields">
          <label className={fieldErrors.store_name ? 'has-error' : undefined}>
            <span className="onboard-label">Store name</span>
            <input
              value={form.store_name}
              onChange={(e) => update('store_name', e.target.value)}
              autoComplete="organization"
              maxLength={LIMITS.store_name.max}
              aria-invalid={fieldErrors.store_name ? 'true' : undefined}
              aria-describedby={fieldErrors.store_name ? 'err-store_name' : undefined}
              autoFocus
            />
            {fieldErrors.store_name && (
              <span className="onboard-field-error" id="err-store_name">{fieldErrors.store_name}</span>
            )}
          </label>

          <label className={fieldErrors.owner_name ? 'has-error' : undefined}>
            <span className="onboard-label">Your full name</span>
            <input
              value={form.owner_name}
              onChange={(e) => update('owner_name', e.target.value)}
              autoComplete="name"
              maxLength={LIMITS.owner_name.max}
              aria-invalid={fieldErrors.owner_name ? 'true' : undefined}
              aria-describedby={fieldErrors.owner_name ? 'err-owner_name' : undefined}
            />
            {fieldErrors.owner_name && (
              <span className="onboard-field-error" id="err-owner_name">{fieldErrors.owner_name}</span>
            )}
          </label>

          <label className={fieldErrors.owner_email ? 'has-error' : undefined}>
            <span className="onboard-label">Email address</span>
            <input
              type="email"
              inputMode="email"
              value={form.owner_email}
              onChange={(e) => update('owner_email', e.target.value)}
              autoComplete="email"
              aria-invalid={fieldErrors.owner_email ? 'true' : undefined}
              aria-describedby={fieldErrors.owner_email ? 'err-owner_email' : 'hint-owner_email'}
            />
            {fieldErrors.owner_email ? (
              <span className="onboard-field-error" id="err-owner_email">{fieldErrors.owner_email}</span>
            ) : (
              <span className="onboard-hint" id="hint-owner_email">
                This is where we send your approval and setup code, and the address you&apos;ll sign in with.
              </span>
            )}
          </label>

          <label className={fieldErrors.owner_phone ? 'has-error' : undefined}>
            <span className="onboard-label">
              Phone number <span className="onboard-optional">optional</span>
            </span>
            <input
              type="tel"
              inputMode="tel"
              value={form.owner_phone}
              onChange={(e) => update('owner_phone', e.target.value)}
              autoComplete="tel"
              maxLength={LIMITS.owner_phone.max}
              placeholder="e.g. 082 123 4567"
              aria-invalid={fieldErrors.owner_phone ? 'true' : undefined}
              aria-describedby={fieldErrors.owner_phone ? 'err-owner_phone' : undefined}
            />
            {fieldErrors.owner_phone && (
              <span className="onboard-field-error" id="err-owner_phone">{fieldErrors.owner_phone}</span>
            )}
          </label>

          <label className={fieldErrors.address ? 'has-error' : undefined}>
            <span className="onboard-label">
              Store address <span className="onboard-optional">optional</span>
            </span>
            <textarea
              rows={2}
              value={form.address}
              onChange={(e) => update('address', e.target.value)}
              autoComplete="street-address"
              maxLength={LIMITS.address.max}
              placeholder="Street, suburb, city"
              aria-invalid={fieldErrors.address ? 'true' : undefined}
              aria-describedby={fieldErrors.address ? 'err-address' : 'hint-address'}
            />
            {fieldErrors.address ? (
              <span className="onboard-field-error" id="err-address">{fieldErrors.address}</span>
            ) : (
              <span className="onboard-hint" id="hint-address">
                Where drivers will collect orders. You can add this later if you&apos;re not sure yet.
              </span>
            )}
          </label>
        </div>

        {/* role="alert" so a screen reader announces a submit failure the
            applicant didn't scroll to. */}
        {formError && <p className="form-error" role="alert">{formError}</p>}

        <button type="submit" disabled={loading}>
          {loading ? 'Sending application…' : 'Submit application'}
        </button>

        <p className="onboard-note onboard-note--tight">
          Applying doesn&apos;t open your store straight away — a person at Flash reviews every
          application, and we&apos;ll email you either way.
        </p>

        <p className="onboard-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
