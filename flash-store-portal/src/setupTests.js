import '@testing-library/jest-dom/vitest';
import { configure } from '@testing-library/react';

// testing-library's default waitFor/findBy timeout is 1000ms, which these
// tests cannot reliably meet once several files run in parallel: userEvent
// types character by character, and a single form fill legitimately takes
// 2-4 seconds under load. That produced a genuine intermittent failure —
// SetPasswordPage's paste-trimming test failed in one full-suite run and
// passed in the next, with no code change between them.
//
// Raising the ceiling weakens nothing. An assertion that would never become
// true still fails; it just fails five seconds later instead of one. The
// alternative — a suite that goes red on a busy CI runner for reasons
// unrelated to the change under test — is how a real failure gets waved
// through as "probably just flaky."
configure({ asyncUtilTimeout: 5000 });
