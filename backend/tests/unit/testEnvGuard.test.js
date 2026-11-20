'use strict';

// L0.1 (#69) — the test bootstrap must refuse anything that is not a local,
// test-only environment, BEFORE any test can open a database connection or
// call Paystack. These tests exercise the guard function directly with
// explicit env objects, so they never touch the real process environment.

const { assertLocalTestEnv } = require('../setup/assertLocalTestEnv');

describe('assertLocalTestEnv', () => {
  test('accepts the exact CI environment (localhost Postgres + sk_test placeholder)', () => {
    expect(() => assertLocalTestEnv({
      DATABASE_URL: 'postgresql://flash_test:flash_test@localhost:5432/flash_test',
      PAYSTACK_SECRET_KEY: 'sk_test_placeholder',
    })).not.toThrow();
  });

  test('accepts the local docker-compose.test.yml database on 127.0.0.1:55432', () => {
    expect(() => assertLocalTestEnv({
      DATABASE_URL: 'postgresql://flash_test:flash_test@127.0.0.1:55432/flash_test',
    })).not.toThrow();
  });

  test('accepts IPv6 loopback', () => {
    expect(() => assertLocalTestEnv({ DATABASE_URL: 'postgresql://u:p@[::1]:5432/db' })).not.toThrow();
  });

  test('accepts no DATABASE_URL at all (unit tests mock the database)', () => {
    expect(() => assertLocalTestEnv({})).not.toThrow();
  });

  test('refuses a remote database host', () => {
    expect(() => assertLocalTestEnv({
      DATABASE_URL: 'postgresql://u:p@db.example-remote-host.com:5432/postgres',
    })).toThrow(/not a local database/);
  });

  test('refuses a Supabase pooler host', () => {
    expect(() => assertLocalTestEnv({
      DATABASE_URL: 'postgresql://postgres.abc:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres',
    })).toThrow(/not a local database/);
  });

  test('refuses a host that merely starts with "localhost"', () => {
    expect(() => assertLocalTestEnv({
      DATABASE_URL: 'postgresql://u:p@localhost.attacker.example:5432/db',
    })).toThrow(/not a local database/);
  });

  test('refuses an unparseable DATABASE_URL instead of guessing', () => {
    expect(() => assertLocalTestEnv({ DATABASE_URL: 'not a url' })).toThrow(/could not be parsed/);
  });

  test('refuses a live Paystack secret key', () => {
    expect(() => assertLocalTestEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      PAYSTACK_SECRET_KEY: 'sk_live_0000000000000000',
    })).toThrow(/live Paystack key/);
  });

  test('refuses a live Paystack PUBLIC key too', () => {
    expect(() => assertLocalTestEnv({ PAYSTACK_PUBLIC_KEY: 'pk_live_0000000000000000' })).toThrow(/live Paystack key/);
  });

  test('is wired into jest: jest.config.js setupFiles loads tests/setup/testEnv.js', () => {
    const config = require('../../jest.config');
    expect(config.setupFiles).toContain('<rootDir>/tests/setup/testEnv.js');
  });

  test('the bootstrap itself aborts when run with a remote DATABASE_URL (child process)', () => {
    const { spawnSync } = require('child_process');
    const path = require('path');
    const bootstrap = path.resolve(__dirname, '..', 'setup', 'testEnv.js');
    const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://u:p@remote.example.com:5432/db' };
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(bootstrap)})`], { env, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not a local database/);
  });

  test('the bootstrap lets a local DATABASE_URL through (child process)', () => {
    const { spawnSync } = require('child_process');
    const path = require('path');
    const bootstrap = path.resolve(__dirname, '..', 'setup', 'testEnv.js');
    const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:55432/db' };
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(bootstrap)})`], { env, encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  test('never echoes the secret or password in its error message', () => {
    let msg = '';
    try {
      assertLocalTestEnv({ DATABASE_URL: 'postgresql://u:SuperSecretPw@remote.example.com:5432/db' });
    } catch (e) { msg = e.message; }
    expect(msg).toMatch(/remote\.example\.com/);
    expect(msg).not.toMatch(/SuperSecretPw/);
  });
});
