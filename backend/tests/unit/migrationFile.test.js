'use strict';

// L0.2 (#71): the production migration contract.
//
// A schema change ships as ONE standalone SQL file in backend/src/db/migrations/.
// Fresh/CI databases get it through migrate.js (applyMigrationFile); production
// gets the SAME bytes through scripts/prod-migrations/D-Apply.ps1, which runs
//   psql -X -v ON_ERROR_STOP=1 --single-transaction -v file_sha=<sha> -f <file>
// The ledger row records sha256(file bytes). These tests pin down that every
// runner computes that hash identically, and that the header fingerprints and
// SHA256SUMS agree with the committed files.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const {
  MIGRATIONS_DIR,
  fileSha256,
  parseHeader,
  bindFileSha,
  readChecksums,
  listMigrations,
  loadMigration,
} = require('../../src/db/migrationFile');

const REPO = path.resolve(__dirname, '..', '..', '..');
const BASELINE = path.join(REPO, 'scripts', 'schema-baseline', 'production_schema_baseline.sql');
const PS_MODULE = path.join(REPO, 'scripts', 'prod-migrations', 'FlashMigration.psm1');
const PS_DIR = path.join(REPO, 'scripts', 'prod-migrations');

// The committed baseline before v42 (docs/SCHEMA_BASELINE.md §10: 72,732 bytes, 66 tables).
const BASELINE_BEFORE_V42 = '697134afc4a774331a0c34cf2e11fb37d140ddd5d65a95f4795e664280a6962d';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function findPowerShell() {
  for (const exe of ['pwsh', 'powershell']) {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return exe;
  }
  return null;
}

describe('migration files: format', () => {
  const migrations = listMigrations();

  test('there is at least v42, and versions are consecutive from v42', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    migrations.forEach((m, i) => expect(m.version).toBe(`v${42 + i}`));
  });

  test.each(listMigrations().map((m) => [m.fileName]))('%s: LF only, no BEGIN/COMMIT, no psql meta-commands, one file_sha placeholder', (fileName) => {
    const text = fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), 'utf8');
    expect(text.includes('\r')).toBe(false);
    // Transaction control statements only (PL/pgSQL's `BEGIN` inside DO $$ is fine).
    expect(text).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\s*(TRANSACTION|WORK)?\s*;/im);
    expect(text).not.toMatch(/^\s*\\/m);
    expect(text.split(":'file_sha'").length).toBe(2);
    expect(text).toMatch(/^SET LOCAL lock_timeout = '5s';$/m);
    expect(text).toMatch(/^SET LOCAL statement_timeout = '60s';$/m);
  });

  test.each(listMigrations().map((m) => [m.fileName]))('%s: header names its own version and has both fingerprints', (fileName) => {
    const h = parseHeader(fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), 'utf8'));
    expect(fileName.startsWith(`${h.version}_`)).toBe(true);
    expect(h.before).toMatch(/^[0-9a-f]{64}$/);
    expect(h.after).toMatch(/^[0-9a-f]{64}$/);
    expect(h.before).not.toBe(h.after);
  });

  test('fingerprints chain: v42 BEFORE = the pre-v42 baseline; each BEFORE = the previous AFTER', () => {
    expect(migrations[0].header.before).toBe(BASELINE_BEFORE_V42);
    for (let i = 1; i < migrations.length; i++) {
      expect(migrations[i].header.before).toBe(migrations[i - 1].header.after);
    }
  });

  test('the latest AFTER fingerprint equals sha256 of the committed baseline', () => {
    const latest = migrations[migrations.length - 1];
    const bytes = fs.readFileSync(BASELINE);
    expect(bytes.includes(0x0d)).toBe(false);
    expect(sha(bytes)).toBe(latest.header.after);
  });
});

describe('file hash: every runner computes the same value', () => {
  const migrations = listMigrations();

  test('SHA256SUMS lists exactly the migration and rollback files, with their current hashes', () => {
    const sums = readChecksums();
    const rollbackDir = path.join(MIGRATIONS_DIR, 'rollback');
    const rollbacks = fs.existsSync(rollbackDir)
      ? fs.readdirSync(rollbackDir).filter((f) => f.endsWith('.rollback.sql')).map((f) => `rollback/${f}`)
      : [];
    const expected = [...migrations.map((m) => m.fileName), ...rollbacks].sort();
    expect(Object.keys(sums).sort()).toEqual(expected);
    for (const f of expected) {
      const bytes = fs.readFileSync(path.join(MIGRATIONS_DIR, f));
      expect(bytes.includes(0x0d)).toBe(false);
      expect(sums[f]).toBe(sha(bytes));
    }
  });

  test('every migration has a rollback file that names the same version', () => {
    for (const m of migrations) {
      const p = path.join(MIGRATIONS_DIR, 'rollback', m.fileName.replace(/\.sql$/, '.rollback.sql'));
      expect(fs.existsSync(p)).toBe(true);
      expect(fs.readFileSync(p, 'utf8')).toMatch(new RegExp(`^-- flash-rollback: ${m.version}$`, 'm'));
    }
  });

  test('fileSha256 = sha256 over the raw bytes (no decoding, no newline changes)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-sha-'));
    const p = path.join(dir, 'x.sql');
    const bytes = Buffer.from('SELECT 1;\r\né\n', 'utf8');
    fs.writeFileSync(p, bytes);
    expect(fileSha256(p)).toBe(sha(bytes));
    expect(fileSha256(p)).not.toBe(sha(Buffer.from('SELECT 1;\né\n', 'utf8')));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('sha256sum (GNU coreutils) agrees with fileSha256', () => {
    const probe = spawnSync('sha256sum', ['--version'], { encoding: 'utf8' });
    if (probe.status !== 0) {
      if (process.env.CI) throw new Error('sha256sum is required in CI');
      return;
    }
    for (const m of migrations) {
      const r = spawnSync('sha256sum', [m.fileName], { cwd: MIGRATIONS_DIR, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout.split(/\s+/)[0]).toBe(m.sha);
    }
  });

  test('PowerShell Get-FlashFileSha256 (the founder runner) agrees with fileSha256', () => {
    const exe = findPowerShell();
    if (!exe) {
      if (process.env.CI) throw new Error('PowerShell (pwsh) is required in CI for the runner-parity test');
      return;
    }
    for (const m of migrations) {
      const file = path.join(MIGRATIONS_DIR, m.fileName);
      const cmd = `Import-Module '${PS_MODULE.replace(/'/g, "''")}' -Force; Get-FlashFileSha256 -Path '${file.replace(/'/g, "''")}'`;
      const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(m.sha);
    }
  });
});

describe('bindFileSha: what migrate.js sends equals what psql -v file_sha=... sends', () => {
  const H = 'a'.repeat(64);

  test("replaces the single :'file_sha' with a quoted literal, exactly as psql does", () => {
    expect(bindFileSha("SET LOCAL flash.file_sha = :'file_sha';\nSELECT 1;", H)).toBe(`SET LOCAL flash.file_sha = '${H}';\nSELECT 1;`);
  });

  test('refuses a value that is not 64 lowercase hex characters', () => {
    for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}'`, 'g'.repeat(64)]) {
      expect(() => bindFileSha(":'file_sha'", bad)).toThrow(/64 lowercase hex/);
    }
  });

  test('refuses zero or two placeholders', () => {
    expect(() => bindFileSha('SELECT 1;', H)).toThrow(/exactly one/);
    expect(() => bindFileSha(":'file_sha' :'file_sha'", H)).toThrow(/exactly one/);
  });

  test('loadMigration binds the hash of the file itself', () => {
    for (const m of migrations()) {
      const loaded = loadMigration(m.fileName);
      expect(loaded.sha).toBe(fileSha256(path.join(MIGRATIONS_DIR, m.fileName)));
      expect(loaded.sql).toContain(`SET LOCAL flash.file_sha = '${loaded.sha}';`);
      expect(loaded.sql).not.toContain(":'file_sha'");
    }
  });

  test('loadMigration refuses a file whose hash is not the one in SHA256SUMS', () => {
    const m = migrations()[0];
    expect(() => loadMigration(m.fileName, { [m.fileName]: 'b'.repeat(64) })).toThrow(/does not match SHA256SUMS/);
  });

  function migrations() { return listMigrations(); }
});

describe('founder scripts: Windows PowerShell 5.1 and container safety', () => {
  const psFiles = fs.readdirSync(PS_DIR).filter((f) => /\.(ps1|psm1)$/.test(f));
  const shFiles = fs.readdirSync(PS_DIR).filter((f) => f.endsWith('.sh'));

  test('there is one PowerShell script per step A-E, plus the shared module', () => {
    for (const step of ['A-', 'B-', 'C-', 'D-', 'E-']) {
      expect(psFiles.filter((f) => f.startsWith(step) && f.endsWith('.ps1'))).toHaveLength(1);
    }
    expect(psFiles).toContain('FlashMigration.psm1');
  });

  test.each(psFiles.map((f) => [f]))('%s is ASCII-only (PowerShell 5.1 misreads UTF-8 without BOM)', (f) => {
    const bytes = fs.readFileSync(path.join(PS_DIR, f));
    expect([...bytes].every((b) => b < 0x80)).toBe(true);
  });

  test.each(psFiles.filter((f) => f.endsWith('.ps1')).map((f) => [f]))('%s never calls bash, wsl or host python', (f) => {
    const text = fs.readFileSync(path.join(PS_DIR, f), 'utf8');
    expect(text).not.toMatch(/(^|[\s;&|(])(bash|wsl|python3?|py)(\.exe)?\s/im);
  });

  test.each(psFiles.filter((f) => f.endsWith('.ps1')).map((f) => [f]))('%s reads the connection string with Read-Host -AsSecureString via the module and clears it', (f) => {
    const text = fs.readFileSync(path.join(PS_DIR, f), 'utf8');
    if (!/Read-FlashProdUrl/.test(text)) return; // step C is local-only and never asks for it
    expect(text).toMatch(/finally\s*\{[^}]*Clear-FlashProdUrl/);
  });

  test('the module reads the URL only with Read-Host -AsSecureString and never echoes it', () => {
    const text = fs.readFileSync(PS_MODULE, 'utf8');
    expect(text).toMatch(/Read-Host[^\n]*-AsSecureString/);
    expect(text).not.toMatch(/Write-(Host|Output)[^\n]*FLASH_PROD_DB_URL/);
  });

  test.each(shFiles.map((f) => [f]))('%s (runs inside the container) is LF-only', (f) => {
    expect(fs.readFileSync(path.join(PS_DIR, f)).includes(0x0d)).toBe(false);
  });
});
