'use strict';
/**
 * tests/unit/productPriceValidation.test.js
 *
 * OPEN_FOLLOWUPS #21 — the shared price validators in utils/helpers.js.
 *
 * These matter more than their size suggests. `flash_inventory.price` feeds
 * subtotal → total → store_commission, and **nothing downstream re-validates
 * it**: for a Flash inventory item, Order.create reads the row and trusts it
 * (`serverPrice = parseFloat(invRow.rows[0].price)`), which is correct because
 * the value is server-owned. So the write path is the only place a bound can
 * be enforced, and these two functions are that place for three of the four
 * write paths (the fourth, AdminJS's generic form, is covered by migration
 * v40's CHECK constraint instead).
 *
 * One rule, three call sites — storeInventoryController's addProduct and
 * updateProduct, and inventoryController's legacy admin addProduct — so the
 * behaviour is pinned here once rather than three times.
 */

const {
  validateProductPrice,
  validateProductCostPrice,
  MAX_PRODUCT_PRICE,
} = require('../../src/utils/helpers');

describe('validateProductPrice — rejections', () => {
  test.each([
    ['zero', 0],
    ['negative', -10],
    ['negative cents', -0.01],
    ['a non-numeric string', 'free'],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['null', null],
    ['undefined', undefined],
    ['above the cap', 100000.01],
    ['far above the cap', 99999999.99],
    ['an empty string', ''],
    ['an object', {}],
    ['an array', []],
  ])('rejects %s', (_label, input) => {
    const result = validateProductPrice(input);
    expect(result.ok).toBe(false);
    expect(typeof result.msg).toBe('string');
    expect(result.value).toBeUndefined();
  });

  // `Number(null)` is 0 and `Number('')` is 0 — both must fail on the > 0
  // rule rather than slipping through as a valid zero.
  test('null and empty string fail via the > 0 rule, not by accident', () => {
    expect(validateProductPrice(null).ok).toBe(false);
    expect(validateProductPrice('').ok).toBe(false);
    expect(validateProductPrice(0).ok).toBe(false);
  });
});

describe('validateProductPrice — acceptances and rounding', () => {
  test('accepts a plain number', () => {
    expect(validateProductPrice(450)).toEqual({ ok: true, value: 450 });
  });

  // Form inputs submit strings, so this is the common case, not an edge one.
  test('accepts a numeric string', () => {
    expect(validateProductPrice('149.99')).toEqual({ ok: true, value: 149.99 });
  });

  test('accepts the smallest valid price', () => {
    expect(validateProductPrice(0.01)).toEqual({ ok: true, value: 0.01 });
  });

  test('accepts exactly the cap, and rejects one cent over', () => {
    expect(validateProductPrice(MAX_PRODUCT_PRICE).ok).toBe(true);
    expect(validateProductPrice(MAX_PRODUCT_PRICE + 0.01).ok).toBe(false);
  });

  // Rounded here rather than letting DECIMAL(10,2) truncate silently.
  test.each([
    [12.345, 12.35],
    [12.344, 12.34],
    [0.005, 0.01],
    [99.999, 100],
  ])('rounds %p to %p', (input, expected) => {
    expect(validateProductPrice(input).value).toBe(expected);
  });
});

describe('validateProductCostPrice', () => {
  // The distinction that was a live bug: addProduct used `cost_price || null`,
  // so a submitted 0 became NULL because 0 is falsy. NULL means "cost not
  // recorded", 0 means "free to us" — different inputs to any margin figure.
  test('zero is preserved as 0, never coerced to null', () => {
    expect(validateProductCostPrice(0)).toEqual({ ok: true, value: 0 });
    expect(validateProductCostPrice('0')).toEqual({ ok: true, value: 0 });
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('treats %s as not recorded', (_label, input) => {
    expect(validateProductCostPrice(input)).toEqual({ ok: true, value: null });
  });

  test.each([
    ['negative', -1],
    ['a non-numeric string', 'cheap'],
    ['NaN', NaN],
    ['above the cap', 100000.01],
  ])('rejects %s', (_label, input) => {
    expect(validateProductCostPrice(input).ok).toBe(false);
  });

  test('accepts a normal cost and rounds to cents', () => {
    expect(validateProductCostPrice('1200.005').value).toBe(1200.01);
  });

  // >= 0 here but > 0 for price: zero-cost stock is real and is never charged
  // to anyone, whereas a zero-price item would hand a customer free goods.
  test('cost_price allows 0 where price does not', () => {
    expect(validateProductCostPrice(0).ok).toBe(true);
    expect(validateProductPrice(0).ok).toBe(false);
  });
});

describe('migration v40 — shape guard only', () => {
  // These are SOURCE-TEXT assertions, and cannot be anything more here: the
  // integration suite needs a live Postgres and Docker will not start on this
  // machine, so v40 has never been executed locally. They do NOT prove the
  // constraints work; CI's postgres:15 run of `npm run migrate` does that.
  //
  // What they do protect is the two properties easiest to lose in an edit:
  // the exact bounds, and the idempotency guard that keeps `npm run migrate`
  // safe to re-run (ADD CONSTRAINT has no IF NOT EXISTS, so without the
  // pg_constraint check a second run fails with 42710).
  const fs = require('fs');
  const path = require('path');
  const src = () => fs.readFileSync(
    path.join(__dirname, '../../src/db/migrate.js'),
    'utf8',
  );

  test('constrains price > 0 and not >= 0', () => {
    expect(src()).toMatch(/flash_inventory_price_positive CHECK \(price > 0\)/);
    expect(src()).not.toMatch(/CHECK \(price >= 0\)/);
  });

  test('constrains cost_price as NULL-or-non-negative', () => {
    expect(src()).toMatch(/CHECK \(cost_price IS NULL OR cost_price >= 0\)/);
  });

  // Founder-confirmed: the 100_000 ceiling is application policy, not a schema
  // invariant, so it must NOT appear in the migration.
  test('does NOT put the price ceiling in the schema', () => {
    const v40 = src().slice(src().indexOf('async function migrateV40'));
    expect(v40).not.toMatch(/100000|100_000/);
  });

  test('both constraints are guarded so the migration stays re-runnable', () => {
    const v40 = src().slice(src().indexOf('async function migrateV40'));
    const guards = v40.match(/SELECT 1 FROM pg_constraint WHERE conname =/g) || [];
    expect(guards).toHaveLength(2);
  });

  test('v40 is wired into the runner and still ends the pool exactly once', () => {
    const s = src();
    expect(s).toMatch(/await migrateV40\(client40\)/);
    expect(s).toMatch(/migrateV40 \}/); // exported
    expect(s.match(/await pool\.end\(\)/g) || []).toHaveLength(1);
  });
});

describe('drift guard against Order.js', () => {
  // A SOURCE-TEXT check, not a behavioural one, and deliberately so:
  // validateExternalItemPrice is module-private in Order.js and cannot be
  // called from here. This asserts only that its literal bounds still read
  // > 0 / 100_000. If someone changes them, this fails and names the drift.
  //
  // It cannot prove the two functions behave identically. What it prevents is
  // the two halves of one business rule silently diverging — the external/
  // partner rule in Order.js and the inventory write rule in helpers.js.
  test('Order.js still bounds external item prices at > 0 and <= 100_000', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/models/Order.js'),
      'utf8',
    );

    expect(src).toMatch(/if\s*\(\s*price\s*<=\s*0\s*\)/);
    expect(src).toMatch(/if\s*\(\s*price\s*>\s*100_000\s*\)/);
    expect(MAX_PRODUCT_PRICE).toBe(100000);
  });
});
