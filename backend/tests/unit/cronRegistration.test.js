'use strict';

// L0.3 (#75) / FI-014 regression: production starts through the root
// server.js wrapper, which REQUIRES src/server.js (so require.main !== module)
// and then calls startServer(). Before this fix, requiring the module ran
// createApp() — registering all 16 crons — and startServer() ran createApp()
// again, registering all 16 a second time: every job ran twice.

jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../../src/config/database', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  connect: jest.fn(),
  on: jest.fn(),
  end: jest.fn(),
}));

const cron = require('node-cron');
const { AWAKE_WINDOW, sastMinutes } = require('../../src/jobs/cronRunner');

const toMinutes = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

describe('cron registration (FI-014)', () => {
  let server;
  beforeAll(() => {
    server = require('../../src/server');
  });

  test('requiring src/server.js registers no cron job', () => {
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  test('createApp() without the cron option (tests, importers) registers no cron job', () => {
    server.createApp();
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  test('reading the exported app does not register cron jobs either', () => {
    expect(server.app).toBeDefined();
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  test('createApp({ withCronJobs: true }) registers every job exactly once, even if called twice', () => {
    server.createApp({ withCronJobs: true });
    const once = cron.schedule.mock.calls.length;
    expect(once).toBe(16);
    server.createApp({ withCronJobs: true });
    expect(cron.schedule).toHaveBeenCalledTimes(once);
  });

  test('every job has a unique name, and every daily job is inside the awake window in SAST', () => {
    const jobs = server.cronJobs();
    expect(jobs).toHaveLength(16);
    expect(new Set(jobs.map((j) => j.name)).size).toBe(16);
    const daily = jobs.filter((j) => j.dailyAtSast);
    expect(daily.map((j) => j.name).sort()).toEqual([
      'morning-release',
      'prune-browsing-events',
      'prune-driver-locations',
      'purge-expired-tokens',
      'wallet-and-refund-reconciliation',
    ].sort());
    for (const j of daily) {
      expect(j.timezone).toBe('Africa/Johannesburg');
      const m = toMinutes(j.dailyAtSast);
      expect(m).toBeGreaterThanOrEqual(toMinutes(AWAKE_WINDOW.start));
      expect(m).toBeLessThanOrEqual(toMinutes(AWAKE_WINDOW.end));
    }
    // Every other job is an interval job, which runs whenever the process is awake.
    for (const j of jobs.filter((x) => !x.dailyAtSast)) expect(j.expr).toMatch(/^\*\/\d+ \* \* \* \*$/);
    expect(typeof sastMinutes).toBe('function');
  });

  test('morning release keeps 07:00 SAST and only catches up during operating hours', () => {
    const job = server.cronJobs().find((j) => j.name === 'morning-release');
    expect(job.dailyAtSast).toBe('07:00');
    expect(job.hasCatchUpCondition).toBe(true);
  });
});
