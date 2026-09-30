import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/setupTests.js',
    // vitest's default 5s per-test budget is the real ceiling here, and it is
    // too tight for this suite: userEvent types character by character, so a
    // single form fill legitimately costs 2-4s, and once several jsdom files
    // run in parallel a test tips over. Raising asyncUtilTimeout alone cannot
    // help — waitFor never gets its budget if the test is killed first.
    //
    // This weakens nothing. A test asserting something untrue still fails; it
    // just fails later. What it removes is the failure mode where CI goes red
    // for reasons unrelated to the change under test, which is how a genuine
    // regression gets dismissed as "probably just flaky".
    testTimeout: 20000,
  },
});
