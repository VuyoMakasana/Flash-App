'use strict';

/**
 * accountNameMatch.js
 *
 * Phase 2a — deciding whether the account-holder name a store owner typed is
 * plausibly the same person as the name the BANK returned for that account
 * number (via Paystack's /bank/resolve, paystackService.verifyBankAccount).
 *
 * This exists because neither extreme is acceptable:
 *
 *   - Exact string equality rejects most real, legitimate accounts. South
 *     African banks return names in whatever form they hold them: "MR JOHN
 *     DOE", "DOE JOHN", "J DOE", "JOHN M DOE". An owner typing "John Doe"
 *     would be refused their own account.
 *   - Skipping the check entirely means a mistyped digit silently sends a
 *     store's settlement money to a stranger's account, discovered only when
 *     the store asks where its money went.
 *
 * So the check is deliberately lenient about FORM and strict about SUBSTANCE:
 * every name component supplied must be accounted for, and at least one real
 * name component (not merely an initial) must match exactly.
 *
 * SECURITY NOTE, and the reason this returns a boolean rather than a diff:
 * the caller must never echo the bank-resolved name back to the client. Doing
 * so would turn "set my payout account" into an account-holder lookup oracle —
 * submit any account number with a deliberately wrong name, read the real
 * holder's name out of the error message. Paystack's own resolve endpoint is
 * such an oracle; Flash must not re-expose it. This function therefore tells
 * the caller only whether the names matched, never how they differed.
 */

// Stripped before comparison: banks frequently prefix these, owners rarely
// type them, and their presence or absence is not evidence of anything.
const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'PROF', 'REV', 'ADV', 'SIR']);

// Common company suffixes. A store's account is often in a business name, and
// "Threads (Pty) Ltd" vs "THREADS PTY LTD" should not be a mismatch.
const COMPANY_NOISE = new Set(['PTY', 'LTD', 'LIMITED', 'INC', 'CC', 'TRUST', 'THE', 'AND']);

function normalizeTokens(name) {
  return String(name == null ? '' : name)
    .toUpperCase()
    // Apostrophes and full stops are REMOVED rather than turned into
    // separators, so "O'Brien" becomes OBRIEN and "St. John" becomes STJOHN
    // instead of splitting into fragments like O + BRIEN that would then be
    // treated as initials.
    .replace(/['’.]/g, '')
    // Everything else non-alphabetic becomes a separator: "(Pty)", hyphenated
    // surnames, stray digits.
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !TITLES.has(t) && !COMPANY_NOISE.has(t));
}

// A single-character token is treated as an initial and matches any token
// beginning with it, which is what makes "J DOE" and "John Doe" comparable.
function tokensMatch(a, b) {
  if (a === b) return true;
  if (a.length === 1) return b.startsWith(a);
  if (b.length === 1) return a.startsWith(b);
  return false;
}

/**
 * @returns {boolean} true if the two names plausibly identify the same holder.
 */
function namesPlausiblyMatch(submitted, resolved) {
  const a = normalizeTokens(submitted);
  const b = normalizeTokens(resolved);
  if (!a.length || !b.length) return false;

  // Compare the shorter list against the longer one, so a bank holding extra
  // middle names does not cause a rejection.
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];

  // A one-token name is a special case. It happens legitimately — a business
  // account whose whole name reduces to "THREADS" once PTY/LTD are stripped —
  // but a single token matching ONE component of a longer name is weak: "JOHN"
  // is a common first name, and a mistyped account number returning any other
  // John would pass. So a single token is accepted only when the two
  // normalized names are IDENTICAL, which is the strongest possible evidence
  // rather than the weakest.
  if (shorter.length === 1) {
    return longer.length === 1 && shorter[0] === longer[0];
  }

  // Each token is consumed once, so "JOHN JOHN" cannot be satisfied twice by a
  // single "JOHN" in the other name.
  const pool = [...longer];
  let matched = 0;
  let strongMatches = 0;

  for (const token of shorter) {
    const idx = pool.findIndex((candidate) => tokensMatch(token, candidate));
    if (idx === -1) return false;
    // A full component matching a full component is real evidence; an initial
    // matching the start of a word is not, on its own.
    if (token.length > 1 && pool[idx] === token) strongMatches += 1;
    matched += 1;
    pool.splice(idx, 1);
  }

  // The strength floor, and the reason it is two-part. At least TWO components
  // must line up, so a shared first name alone is never sufficient; and at
  // least ONE of them must be a full exact match, so a string of initials
  // ("J M D" against "JOHN MICHAEL DOE") cannot pass either. Both are real
  // bypasses that a naive "every token found" rule would allow.
  return matched >= 2 && strongMatches >= 1;
}

module.exports = { namesPlausiblyMatch, normalizeTokens };
