'use strict';

// L0.2 (#71): standalone migration files (backend/src/db/migrations/vNN_*.sql).
//
// One file is the single source of truth for a schema change:
//   - fresh/CI databases: migrate.js -> applyMigrationFile() (this module);
//   - production: scripts/prod-migrations/D-Apply.ps1 ->
//       psql -X -v ON_ERROR_STOP=1 --single-transaction -v file_sha=<sha> -f <file>
//
// THE HASH CONTRACT (tested in tests/unit/migrationFile.test.js):
//   file_sha = lowercase hex sha256 over the file's exact bytes as checked out
//   (.gitattributes forces LF, so every OS sees the same bytes). The production
//   runner computes it with PowerShell Get-FileHash (Get-FlashFileSha256) and
//   passes it as the psql variable; this module computes it with Node's crypto
//   and substitutes it for the single :'file_sha' placeholder, exactly as psql
//   would ('<hex>' as a quoted literal). Both must equal SHA256SUMS.
//
// Header lines every file carries:
//   -- flash-migration: v42
//   -- before-schema-sha256: <sha256 of the normalized production schema before>
//   -- after-schema-sha256:  <sha256 of the normalized production schema after>
// "Normalized" = normalize_schema.py --baseline over a prod_dump_schema.sh dump.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const CHECKSUMS_FILE = path.join(MIGRATIONS_DIR, 'SHA256SUMS');
const FILE_SHA_PLACEHOLDER = ":'file_sha'";
const HEX64 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^(v\d+)_[a-z0-9_]+\.sql$/;

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fileSha256(filePath) {
  return sha256Hex(fs.readFileSync(filePath));
}

function parseHeader(text) {
  const get = (key) => {
    const m = text.match(new RegExp(`^-- ${key}:\\s+(\\S+)\\s*$`, 'm'));
    return m ? m[1] : null;
  };
  return {
    version: get('flash-migration'),
    before: get('before-schema-sha256'),
    after: get('after-schema-sha256'),
  };
}

function bindFileSha(sql, sha) {
  if (typeof sha !== 'string' || !HEX64.test(sha)) {
    throw new Error('file_sha must be 64 lowercase hex characters');
  }
  const parts = sql.split(FILE_SHA_PLACEHOLDER);
  if (parts.length !== 2) {
    throw new Error(`expected exactly one ${FILE_SHA_PLACEHOLDER} placeholder, found ${parts.length - 1}`);
  }
  return parts.join(`'${sha}'`);
}

// SHA256SUMS uses sha256sum's format: "<64 hex>  <file name>" per line.
function readChecksums(file = CHECKSUMS_FILE) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = line.match(/^([0-9a-f]{64}) [ *](\S+)$/);
    if (!m) throw new Error(`malformed SHA256SUMS line: ${line}`);
    out[m[2]] = m[1];
  }
  return out;
}

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => FILE_NAME.test(f))
    .map((fileName) => {
      const bytes = fs.readFileSync(path.join(MIGRATIONS_DIR, fileName));
      return {
        fileName,
        version: fileName.match(FILE_NAME)[1],
        sha: sha256Hex(bytes),
        header: parseHeader(bytes.toString('utf8')),
      };
    })
    .sort((a, b) => Number(a.version.slice(1)) - Number(b.version.slice(1)));
}

function loadMigration(fileName, checksums = readChecksums()) {
  const filePath = path.join(MIGRATIONS_DIR, fileName);
  const bytes = fs.readFileSync(filePath);
  const sha = sha256Hex(bytes);
  if (checksums[fileName] !== sha) {
    throw new Error(`${fileName}: sha256 ${sha} does not match SHA256SUMS; the file was edited without updating its checksum`);
  }
  const text = bytes.toString('utf8');
  return { fileName, filePath, sha, header: parseHeader(text), sql: bindFileSha(text, sha) };
}

// Same semantics as psql --single-transaction -v ON_ERROR_STOP=1: the whole
// file in one transaction; any error rolls everything back.
async function applyMigrationFile(client, fileName) {
  const m = loadMigration(fileName);
  await client.query('BEGIN');
  try {
    await client.query(m.sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
  return m;
}

module.exports = {
  MIGRATIONS_DIR,
  CHECKSUMS_FILE,
  fileSha256,
  parseHeader,
  bindFileSha,
  readChecksums,
  listMigrations,
  loadMigration,
  applyMigrationFile,
};
