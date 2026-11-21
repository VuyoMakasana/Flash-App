'use strict';

// L0.3 (#75): the cron runner — every scheduled job goes through it.
// Registration happens once per process (FI-014), every run logs start and
// finish, a job never overlaps itself, and daily jobs live inside the awake
// window (06:45–19:45 SAST, founder launch decision 7) or catch up on startup.

const {
  createCronRunner,
  isInAwakeWindow,
  sastMinutes,
  dailySast,
  AWAKE_WINDOW,
} = require('../../src/jobs/cronRunner');

// 2026-11-20 is a Friday; SAST = UTC+2 (no DST).
const sast = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 20, h - 2, m, 0));
};

function makeFakes() {
  const scheduled = [];
  const cron = { schedule: jest.fn((expr, fn, options) => { scheduled.push({ expr, fn, options }); return { stop() {} }; }) };
  const lines = [];
  const log = {
    info: jest.fn((obj, msg) => lines.push(['info', msg, obj])),
    warn: jest.fn((obj, msg) => lines.push(['warn', msg, obj])),
    error: jest.fn((obj, msg) => lines.push(['error', msg, obj])),
  };
  return { cron, log, scheduled, lines };
}

describe('awake window', () => {
  test('is 06:45-19:45 SAST, inclusive', () => {
    expect(AWAKE_WINDOW).toEqual({ start: '06:45', end: '19:45', timezone: 'Africa/Johannesburg' });
    expect(isInAwakeWindow(sast('06:44'))).toBe(false);
    expect(isInAwakeWindow(sast('06:45'))).toBe(true);
    expect(isInAwakeWindow(sast('12:00'))).toBe(true);
    expect(isInAwakeWindow(sast('19:45'))).toBe(true);
    expect(isInAwakeWindow(sast('19:46'))).toBe(false);
    expect(isInAwakeWindow(sast('03:00'))).toBe(false);
  });

  test('SAST minutes wrap past midnight UTC correctly', () => {
    expect(sastMinutes(new Date(Date.UTC(2026, 10, 20, 23, 30)))).toBe(1 * 60 + 30); // 01:30 SAST next day
    expect(sastMinutes(new Date(Date.UTC(2026, 10, 20, 4, 45)))).toBe(6 * 60 + 45);
  });

  test('dailySast builds a SAST cron expression and refuses a slot outside the window', () => {
    expect(dailySast('06:50')).toEqual({ expr: '50 6 * * *', timezone: 'Africa/Johannesburg', dailyAtSast: '06:50', catchUpIf: null });
    expect(() => dailySast('05:00')).toThrow(/outside the awake window/);
    expect(() => dailySast('19:46')).toThrow(/outside the awake window/);
    expect(() => dailySast('7:5')).toThrow(/HH:MM/);
  });
});

describe('registration', () => {
  test('claimScheduler works once per runner; a second claim registers nothing and warns (FI-014)', () => {
    const { cron, log } = makeFakes();
    const runner = createCronRunner({ cron, log });
    const first = runner.claimScheduler();
    expect(typeof first).toBe('function');
    first('a', '*/5 * * * *', async () => {});
    const second = runner.claimScheduler();
    second('a', '*/5 * * * *', async () => {});
    second('b', '*/5 * * * *', async () => {});
    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/already registered/));
    expect(runner.listJobs().map((j) => j.name)).toEqual(['a']);
  });

  test('a duplicate job name throws', () => {
    const { cron, log } = makeFakes();
    const schedule = createCronRunner({ cron, log }).claimScheduler();
    schedule('a', '*/5 * * * *', async () => {});
    expect(() => schedule('a', '*/10 * * * *', async () => {})).toThrow(/registered twice/);
  });

  test('daily jobs are scheduled with the SAST timezone; interval jobs without one', () => {
    const { cron, log, scheduled } = makeFakes();
    const schedule = createCronRunner({ cron, log }).claimScheduler();
    schedule('daily', dailySast('06:50'), async () => {});
    schedule('interval', '*/15 * * * *', async () => {});
    expect(scheduled[0]).toMatchObject({ expr: '50 6 * * *', options: { timezone: 'Africa/Johannesburg' } });
    expect(scheduled[1].expr).toBe('*/15 * * * *');
    expect(scheduled[1].options).toBeUndefined();
  });
});

describe('runJob', () => {
  test('logs start and finish with the job name, trigger and duration', async () => {
    const { cron, log, scheduled, lines } = makeFakes();
    const runner = createCronRunner({ cron, log });
    runner.claimScheduler()('prune', '*/5 * * * *', async () => {});
    await scheduled[0].fn();
    expect(lines.map(([lvl, msg]) => `${lvl}:${msg}`)).toEqual(['info:cron start', 'info:cron finish']);
    expect(lines[1][2]).toMatchObject({ job: 'prune', trigger: 'schedule', durationMs: expect.any(Number) });
  });

  test('a job that throws is logged as failed and never throws out of the runner', async () => {
    const { cron, log, scheduled, lines } = makeFakes();
    const runner = createCronRunner({ cron, log });
    runner.claimScheduler()('boom', '*/5 * * * *', async () => { throw new Error('db down'); });
    await expect(scheduled[0].fn()).resolves.toEqual({ ok: false });
    expect(lines[1]).toEqual(['error', 'cron failed', expect.objectContaining({ job: 'boom', error: 'db down' })]);
  });

  test('a run that is still in progress is not started again (no overlap)', async () => {
    const { cron, log, scheduled } = makeFakes();
    const runner = createCronRunner({ cron, log });
    let release;
    const fn = jest.fn(() => new Promise((r) => { release = r; }));
    runner.claimScheduler()('slow', '*/5 * * * *', fn);
    const firstRun = scheduled[0].fn();
    await expect(scheduled[0].fn()).resolves.toEqual({ skipped: true });
    expect(fn).toHaveBeenCalledTimes(1);
    release();
    await expect(firstRun).resolves.toEqual({ ok: true });
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ job: 'slow' }), expect.stringMatching(/still in progress/));
  });
});

describe('startup catch-up (daily jobs only, inside the window, after their slot)', () => {
  function runnerWithJobs(nowDate) {
    const { cron, log } = makeFakes();
    const runner = createCronRunner({ cron, log, now: () => nowDate });
    const schedule = runner.claimScheduler();
    const ran = [];
    schedule('daily-0650', dailySast('06:50'), async () => { ran.push('daily-0650'); });
    schedule('daily-0700-open-only', dailySast('07:00', { catchUpIf: () => false }), async () => { ran.push('daily-0700-open-only'); });
    schedule('interval', '*/5 * * * *', async () => { ran.push('interval'); });
    return { runner, ran };
  }

  test('a start at 12:00 SAST catches up a daily job whose slot passed; never interval jobs', async () => {
    const { runner, ran } = runnerWithJobs(sast('12:00'));
    expect(runner.dueForCatchUp()).toEqual(['daily-0650']);
    await runner.runStartupCatchUp();
    expect(ran).toEqual(['daily-0650']);
  });

  test('a start before the slot catches up nothing (the schedule will run it)', () => {
    expect(runnerWithJobs(sast('06:46')).runner.dueForCatchUp()).toEqual([]);
  });

  test('a start outside the awake window catches up nothing', () => {
    expect(runnerWithJobs(sast('22:00')).runner.dueForCatchUp()).toEqual([]);
    expect(runnerWithJobs(sast('05:00')).runner.dueForCatchUp()).toEqual([]);
  });

  test('a job-specific condition (e.g. operating hours) can veto catch-up', () => {
    expect(runnerWithJobs(sast('12:00')).runner.dueForCatchUp()).not.toContain('daily-0700-open-only');
  });

  test('catch-up runs are logged with trigger startup-catch-up', async () => {
    const { cron, log } = makeFakes();
    const runner = createCronRunner({ cron, log, now: () => sast('12:00') });
    runner.claimScheduler()('daily', dailySast('06:50'), async () => {});
    await runner.runStartupCatchUp();
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ job: 'daily', trigger: 'startup-catch-up' }), 'cron start');
  });
});
