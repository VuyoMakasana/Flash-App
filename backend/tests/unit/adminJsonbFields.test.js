'use strict';
/**
 * tests/unit/adminJsonbFields.test.js
 *
 * #96 (FI-115, FI-116): saving an edit to the Flash Closet store in the admin
 * panel failed with Postgres "cannot assign to field "maxLat" of column
 * "service_area_bounds" because its type jsonb is not a composite type".
 *
 * Reproduced through AdminJS's real edit action against the local test DB. The
 * edit form posts a jsonb ("key-value") field flattened
 * (service_area_bounds.maxLat, ...); AdminJS's prepareParams keeps those raw
 * keys next to the rebuilt object, and @adminjs/sql hands every key to knex,
 * which turns a dotted key into SET "service_area_bounds"."maxLat" = ... The
 * same happens to flash_inventory.sizes / stock_by_size on edit AND create, so
 * no product with sizes could be saved from the panel.
 *
 * The payloads below are the exact shape AdminJS posted in that reproduction.
 * The SQL assertions compile the update with knex, the query builder
 * @adminjs/sql itself uses (its own dependency; nothing is added).
 */
const knex = require('knex')({ client: 'pg' });
const {
  buildResources,
  prepareJsonbFields,
  dropFieldsHiddenFromEdit,
  JSONB_FIELDS,
} = require('../../src/adminPanel');

const run = (hook, payload) => hook({ payload: { ...payload } }, {}).payload;
const updateSql = (table, payload) => knex(table).update(payload).where('id', 'x').toString();

// Exactly what the edit form posted for Flash Closet (reproduction, #96).
const flashClosetEdit = {
  id: '91fff27c-c2bb-4f06-8147-c72cb9f8db7a',
  name: 'Flash Closet',
  address: '12B Mkele Street, Kwazakhele, 6205',
  lat: '-33.884221', lng: '25.5853185',
  'service_area_bounds.maxLat': '-33.76',
  'service_area_bounds.maxLng': '25.68',
  'service_area_bounds.minLat': '-34.03',
  'service_area_bounds.minLng': '25.55',
  description: 'edited',
  status: 'approved', is_active: 'true', reviewed_by: '', reviewed_at: '', rejection_reason: '',
};

describe('FI-115: jsonb fields are saved as one JSON value', () => {
  test('stores: flattened service_area_bounds become one jsonb value, with numbers, and no dotted keys', () => {
    const out = run(prepareJsonbFields(JSONB_FIELDS.stores), flashClosetEdit);
    expect(Object.keys(out).filter((k) => k.includes('.'))).toEqual([]);
    expect(JSON.parse(out.service_area_bounds)).toEqual({ maxLat: -33.76, maxLng: 25.68, minLat: -34.03, minLng: 25.55 });
    const sql = updateSql('stores', out);
    expect(sql).not.toMatch(/"service_area_bounds"\."/);
    expect(sql).toMatch(/"service_area_bounds" = '\{"maxLat":-33\.76/);
  });

  test('stores: before the fix, the same payload produced the failing SQL (control)', () => {
    expect(updateSql('stores', flashClosetEdit)).toMatch(/"service_area_bounds"\."maxLat"/);
  });

  test('flash_inventory: flattened sizes become a JSON array, stock a JSON object of whole numbers', () => {
    const out = run(prepareJsonbFields(JSONB_FIELDS.flash_inventory), {
      product_name: 'Tee', price: '50',
      'sizes.0': 'S', 'sizes.1': ' M ', 'stock_by_size.S': '1', 'stock_by_size.M': '5',
    });
    expect(Object.keys(out).filter((k) => k.includes('.'))).toEqual([]);
    expect(JSON.parse(out.sizes)).toEqual(['S', 'M']);
    expect(JSON.parse(out.stock_by_size)).toEqual({ S: 1, M: 5 });
    const sql = updateSql('flash_inventory', out);
    expect(sql).not.toMatch(/"(sizes|stock_by_size)"\."/);
    expect(sql).toMatch(/"sizes" = '\["S","M"\]'/);
  });

  test('array order follows the numeric index, not string order (sizes.10 after sizes.2)', () => {
    const payload = {};
    for (let i = 0; i <= 10; i += 1) payload[`sizes.${i}`] = `s${i}`;
    const out = run(prepareJsonbFields(JSONB_FIELDS.flash_inventory), payload);
    expect(JSON.parse(out.sizes)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10']);
  });

  test('emptied fields (AdminJS posts null, {} or []) are stored as the empty default', () => {
    const inv = run(prepareJsonbFields(JSONB_FIELDS.flash_inventory), { sizes: [], stock_by_size: {} });
    expect(inv.sizes).toBe('[]');
    expect(inv.stock_by_size).toBe('{}');
    const st = run(prepareJsonbFields(JSONB_FIELDS.stores), { service_area_bounds: null });
    expect(st.service_area_bounds).toBeNull();
  });

  test('a field that was not posted is left out of the update (not cleared)', () => {
    const out = run(prepareJsonbFields(JSONB_FIELDS.flash_inventory), { product_name: 'Tee' });
    expect(out).toEqual({ product_name: 'Tee' });
  });

  test('a JSON string (or an already-parsed value) is accepted too', () => {
    const out = run(prepareJsonbFields(JSONB_FIELDS.flash_inventory), { sizes: '["S","M"]', stock_by_size: { S: 2 } });
    expect(JSON.parse(out.sizes)).toEqual(['S', 'M']);
    expect(JSON.parse(out.stock_by_size)).toEqual({ S: 2 });
  });

  test.each([
    ['a negative stock', { 'stock_by_size.M': '-1' }, 'stock_by_size'],
    ['a fractional stock', { 'stock_by_size.M': '1.5' }, 'stock_by_size'],
    ['a non-numeric stock', { 'stock_by_size.M': 'lots' }, 'stock_by_size'],
    ['an empty size label', { 'sizes.0': 'S', 'sizes.1': '' }, 'sizes'],
    ['a duplicate size', { 'sizes.0': 'M', 'sizes.1': 'M' }, 'sizes'],
    ['invalid JSON text', { sizes: '[S, M' }, 'sizes'],
  ])('flash_inventory: %s is refused with a field error, never a 500', (_label, payload, field) => {
    let thrown;
    try { run(prepareJsonbFields(JSONB_FIELDS.flash_inventory), payload); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(thrown.name).toBe('ValidationError');
    expect(Object.keys(thrown.propertyErrors)).toEqual([field]);
  });

  test('stores: a non-numeric bound is refused with a field error', () => {
    expect(() => run(prepareJsonbFields(JSONB_FIELDS.stores), { 'service_area_bounds.minLat': 'south' }))
      .toThrow(expect.objectContaining({ name: 'ValidationError' }));
  });
});

describe('FI-116: fields hidden from the edit form are never written by it', () => {
  test('stores: status, is_active and the review columns are dropped from an edit', () => {
    const out = run(dropFieldsHiddenFromEdit(['status', 'is_active', 'reviewed_by', 'reviewed_at', 'rejection_reason']), flashClosetEdit);
    for (const f of ['status', 'is_active', 'reviewed_by', 'reviewed_at', 'rejection_reason']) expect(out).not.toHaveProperty(f);
    expect(out.name).toBe('Flash Closet');
    expect(out.description).toBe('edited');
  });
});

describe('#96: the hooks are wired into the resources that need them', () => {
  const fakeDb = { table: (tableName) => ({ tableName, properties: [] }) };
  const resources = buildResources(fakeDb);
  const actionsOf = (t) => resources.find((r) => r.resource.tableName === t).options.actions;
  const names = (hooks) => (hooks || []).map((h) => h.hookName || h.name);

  test('stores edit: hidden fields dropped, then jsonb prepared, BEFORE the generic empty-field hook', () => {
    expect(names(actionsOf('stores').edit.before)).toEqual(['dropFieldsHiddenFromEdit', 'prepareJsonbFields', 'nullifyEmptyNonTextFields']);
  });

  test('flash_inventory edit and new: jsonb prepared before the other hooks; edit also drops is_active', () => {
    expect(names(actionsOf('flash_inventory').edit.before)).toEqual(['dropFieldsHiddenFromEdit', 'prepareJsonbFields', 'nullifyEmptyNonTextFields', 'validateInventoryPrices']);
    expect(names(actionsOf('flash_inventory').new.before)).toEqual(['prepareJsonbFields', 'nullifyEmptyNonTextFields', 'validateInventoryPrices']);
  });

  test('drivers edit: status dropped (only the approve/reject actions change it)', () => {
    expect(names(actionsOf('drivers').edit.before)).toEqual(['dropFieldsHiddenFromEdit', 'nullifyEmptyNonTextFields']);
  });

  test('every jsonb column of an editable resource is covered', () => {
    expect(JSONB_FIELDS.stores).toEqual({ service_area_bounds: 'numberMap' });
    expect(JSONB_FIELDS.flash_inventory).toEqual({ sizes: 'labelList', stock_by_size: 'stockMap' });
  });
});
