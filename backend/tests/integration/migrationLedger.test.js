'use strict';

// L0.2 (#71): migrate.js (Node) and the production runner (psql -v file_sha=...)
// must record the SAME sha256 for the same file, and v42 must be idempotent
// and refuse a changed file. Runs against the LOCAL test database only
// (tests/setup/testEnv.js refuses anything else), after migrate.js has run.

const path = require('path');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');
const { MIGRATIONS_DIR, fileSha256, applyMigrationFile } = require('../../src/db/migrationFile');

const FILE = 'v42_schema_migrations_ledger.sql';
const FILE_PATH = path.join(MIGRATIONS_DIR, FILE);
const hasDb = Boolean(process.env.DATABASE_URL);
const d = hasDb ? describe : describe.skip;

function psqlAvailable() {
  return spawnSync('psql', ['--version'], { encoding: 'utf8' }).status === 0;
}

// Exactly the command apply_migration.sh runs (step D), against the local DB.
function psqlApply(fileSha) {
  return spawnSync('psql', [process.env.DATABASE_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-v', `file_sha=${fileSha}`, '-f', FILE_PATH], { encoding: 'utf8' });
}

d('schema_migrations_ledger (v42)', () => {
  let pool;
  const sha = fileSha256(FILE_PATH);

  beforeAll(() => { pool = new Pool({ connectionString: process.env.DATABASE_URL }); });
  afterAll(async () => { await pool.end(); });

  const rows = async () => (await pool.query("SELECT version, sha256, applied_at FROM public.schema_migrations_ledger ORDER BY version")).rows;

  test('migrate.js recorded v42 with sha256 of the file bytes', async () => {
    const r = await rows();
    expect(r.map((x) => x.version)).toEqual(['v42']);
    expect(r[0].sha256).toBe(sha);
  });

  test('applying again through migrate.js (Node) is a no-op', async () => {
    const before = await rows();
    const client = await pool.connect();
    try {
      await applyMigrationFile(client, FILE);
    } finally {
      client.release();
    }
    expect(await rows()).toEqual(before);
  });

  test('the psql runner (step D command) records the same sha256: re-apply is a no-op', async () => {
    if (!psqlAvailable()) {
      if (process.env.CI) throw new Error('psql is required in CI for the runner-parity test');
      return;
    }
    const before = await rows();
    const r = psqlApply(sha);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(await rows()).toEqual(before);
  });

  test('the psql runner refuses a different file_sha and changes nothing', async () => {
    if (!psqlAvailable()) {
      if (process.env.CI) throw new Error('psql is required in CI for the runner-parity test');
      return;
    }
    const before = await rows();
    const r = psqlApply('f'.repeat(64));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/different sha256 for v42/);
    expect(await rows()).toEqual(before);
  });

  test('the psql runner refuses when file_sha is not passed at all', async () => {
    if (!psqlAvailable()) {
      if (process.env.CI) throw new Error('psql is required in CI for the runner-parity test');
      return;
    }
    const r = spawnSync('psql', [process.env.DATABASE_URL, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', FILE_PATH], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(await rows()).toHaveLength(1);
  });
});
