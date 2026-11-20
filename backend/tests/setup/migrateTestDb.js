'use strict';

// L0.1 (#69): run migrate.js against the LOCAL test database only.
//   npm run test:db:migrate
// Loads backend/.env.test (shell/CI values win), proves the target is local
// with the same guard every test run uses, then runs migrate.js as a child
// process with exactly that environment. It never reads backend/.env.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { assertLocalTestEnv } = require('./assertLocalTestEnv');

const backendDir = path.resolve(__dirname, '..', '..');
const envTestPath = path.join(backendDir, '.env.test');
if (fs.existsSync(envTestPath)) {
  require('dotenv').config({ path: envTestPath, override: false });
}

if (!process.env.DATABASE_URL) {
  console.error('[test-db] DATABASE_URL is not set. Copy backend/.env.test.example to backend/.env.test first.');
  process.exit(1);
}
assertLocalTestEnv(process.env); // throws (non-zero exit) unless local + test keys

const u = new URL(process.env.DATABASE_URL);
console.log(`[test-db] migrating LOCAL database host=${u.hostname} port=${u.port || 5432} db=${u.pathname.slice(1)}`);

const r = spawnSync(process.execPath, [path.join(backendDir, 'src', 'db', 'migrate.js')], {
  cwd: backendDir,
  env: process.env,
  stdio: 'inherit',
});
process.exit(r.status === null ? 1 : r.status);
