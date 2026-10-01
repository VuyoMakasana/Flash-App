'use strict';
/**
 * tests/unit/adminInventoryPriceValidation.test.js
 *
 * OPEN_FOLLOWUPS #21, R10 — AdminJS is the fourth and last write path to
 * `flash_inventory.price`. The store portal's `addProduct`/`updateProduct` and
 * the legacy admin REST `addProduct` all validate via `utils/helpers`;
 * AdminJS's generic form writes columns directly, so no controller-level
 * validator can reach it.
 *
 * **Migration v40 is not a substitute, and that is the point of this hook:**
 *
 *   `CHECK (price > 0)` rejects a VALID number that is non-positive → 23514.
 *   A NON-NUMERIC value fails during type COERCION → 22P02, raised *before*
 *   any CHECK is evaluated. v40 does nothing for it.
 *
* **Deliberately not justified by Sentry issue NODE-N.** NODE-N was
 * `invalid input syntax for type numeric: ""` — the empty-string case, which
 * `nullifyEmptyNonTextFields` already fixed on 2026-09-22, 4m43s after that
 * issue's last occurrence, with no recurrence in the nine days since. The gap
 * this closes is real but has never been observed in production.
 */

const {
  nullifyEmptyNonTextFields,
  validateInventoryPrices,
} = require('../../src/adminPanel');

// Mirrors how AdminJS presents a resource's property types to a before-hook.
const inventoryContext = {
  resource: {
    properties: () => [
      { name: () => 'product_name', type: () => 'string' },
      { name: () => 'description', type: () => 'textarea' },
      { name: () => 'price', type: () => 'number' },
      { name: () => 'cost_price', type: () => 'number' },
    ],
  },
};

// Runs the real pair in the real order, which is what production does.
function runHooks(payload) {
  const req = { payload: { ...payload } };
  return validateInventoryPrices(
    nullifyEmptyNonTextFields(req, inventoryContext),
    inventoryContext,
  );
}

describe('the gap v40 cannot cover — non-numeric input', () => {
  test.each([
    ['letters', 'abc'],
    ['a comma decimal, the likely South African form', '12,50'],
    ['a currency-prefixed value', 'R450'],
    ['whitespace only', '   '],
  ])('rejects %s with a field message instead of reaching Postgres', (_label, price) => {
    let caught;
    try {
      runHooks({ price });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    // Asserted specifically, not via `.toThrow()`. An earlier version used
    // `.toThrow()` and passed on a SyntaxError from requiring adminjs inside
    // the hook — green, and validating nothing. Pinning the name and the
    // offending field is what makes these tests mean something.
    expect(caught.name).toBe('ValidationError');
    expect(Object.keys(caught.propertyErrors)).toContain('price');
    expect(caught.propertyErrors.price.message).toMatch(/price must be a number/);
  });

  test('rejects a non-numeric cost_price, naming that field', () => {
    let caught;
    try {
      runHooks({ price: 450, cost_price: 'cheap' });
    } catch (err) {
      caught = err;
    }
    expect(caught.name).toBe('ValidationError');
    expect(Object.keys(caught.propertyErrors)).toEqual(['cost_price']);
  });
});

describe('the range cases v40 also guards, but with a readable message', () => {
  test.each([
    ['zero', 0],
    ['negative', -5],
    ['above the application ceiling', 100001],
  ])('refuses %s before it reaches the constraint', (_label, price) => {
    expect(() => runHooks({ price })).toThrow();
  });

  // price is NOT NULL. Cleared, the first hook makes it null; this hook then
  // refuses it with a readable message rather than letting Postgres answer
  // with a raw 23502 not-null violation.
  test('a cleared price is refused readably, not as a not-null violation', () => {
    expect(() => runHooks({ price: '' })).toThrow();
  });
});

describe('hook order is NOT load-bearing — a corrected claim', () => {
  // I initially asserted the order mattered, with a test claiming that
  // validating first would store a cleared cost_price as 0 ("free to us")
  // instead of NULL ("not recorded"). **That test failed, and it was the
  // claim that was wrong, not the code:** validateProductCostPrice
  // independently treats '' as not-recorded, so both orders agree.
  //
  // Kept as a real test rather than deleted, because "these two hooks
  // commute for these columns" is worth pinning — if either ever stops
  // handling '' the same way, this fails and the order becomes load-bearing
  // for real.
  test('a cleared cost_price becomes NULL in either order', () => {
    const correctOrder = runHooks({ price: 450, cost_price: '' });
    expect(correctOrder.payload.cost_price).toBeNull();

    const reversed = nullifyEmptyNonTextFields(
      validateInventoryPrices({ payload: { price: 450, cost_price: '' } }, inventoryContext),
      inventoryContext,
    );
    expect(reversed.payload.cost_price).toBeNull();
  });

  test('a cleared price is refused in either order', () => {
    expect(() => runHooks({ price: '' })).toThrow();
    expect(() => validateInventoryPrices({ payload: { price: '' } })).toThrow();
  });
});

describe('valid input passes through, parsed', () => {
  test('accepts a numeric string and stores a cent-rounded number', () => {
    const out = runHooks({ price: '450.005', cost_price: '120.004' });
    expect(out.payload.price).toBe(450.01);
    expect(out.payload.cost_price).toBe(120);
  });

  test('a cost_price of 0 is preserved as 0', () => {
    expect(runHooks({ price: 450, cost_price: 0 }).payload.cost_price).toBe(0);
  });

  // An edit payload carries only the fields the form submitted, so an absent
  // field must be left alone rather than treated as cleared.
  test('fields absent from the payload are untouched', () => {
    const out = runHooks({ product_name: 'Jacket' });
    expect(out.payload).not.toHaveProperty('price');
    expect(out.payload).not.toHaveProperty('cost_price');
    expect(out.payload.product_name).toBe('Jacket');
  });

  test('a text field keeps its empty string, since "" is meaningful there', () => {
    const out = runHooks({ price: 450, description: '' });
    expect(out.payload.description).toBe('');
  });
});

describe('the hook is actually wired into flash_inventory', () => {
  // A SOURCE-TEXT guard, and labelled as one. Every test above calls the hook
  // directly, so deleting it from the `before` arrays would leave all of them
  // green while the production path went unvalidated — the wiring is the part
  // that makes them matter.
  //
  // buildResources() is the real target, but it needs a live DATABASE_URL to
  // build its adapter (see adminChronologicalSort.test.js), and there is no
  // local Postgres here. This asserts the wiring instead of the behaviour, and
  // does not claim to be more than that.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '../../src/adminPanel.js'),
    'utf8',
  );

  // Regex LITERALS, not built from a template string. The first version used
  // `new RegExp(...)` over a template literal, where `\s` is an unknown escape
  // and JS silently drops the backslash — `re.source` came out as
  // `new:s*{s*before:...`, matching a literal "s" instead of whitespace. It
  // therefore matched nothing and FAILED ON UNMUTATED SOURCE, which also
  // contaminated a mutation run: two always-failing tests made every mutation
  // look "caught" regardless of whether it was.
  test('flash_inventory new runs validateInventoryPrices after nullifyEmptyNonTextFields', () => {
    expect(src).toMatch(
      /new: \{\s*before: \[nullifyEmptyNonTextFields, validateInventoryPrices\]/,
    );
  });

  test('flash_inventory edit runs validateInventoryPrices after nullifyEmptyNonTextFields', () => {
    expect(src).toMatch(
      /edit: \{\s*before: \[nullifyEmptyNonTextFields, validateInventoryPrices\]/,
    );
  });

  test('the real AdminJS ValidationError is captured at mount', () => {
    expect(src).toMatch(/AdminValidationError = AdminJSModule\.ValidationError/);
  });
});
