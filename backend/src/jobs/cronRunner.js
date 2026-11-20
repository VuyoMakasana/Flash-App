'use strict';

// L0.3 (#75): one runner for every scheduled job.
//
// - Registration happens ONCE per process. Before this, production
//   registered every cron twice (FI-014): the root server.js wrapper requires
//   src/server.js, whose require-time createApp() registered them, and then
//   startServer() ran createApp() again. claimScheduler() hands out the
//   scheduling function once; a second claim registers nothing and warns.
// - Every run logs `cron start` and `cron finish` (or `cron failed`) with the
//   job name, the trigger and the duration, so a missed or slow job is
//   visible in Render's logs.
// - A job never overlaps itself: if the previous run is still going, the
//   new tick is skipped and logged.
// - The awake window (founder launch decision 7): Render's free plan sleeps,
//   and the founder pings /health every 10 minutes from 06:45 to 19:45 SAST,
//   so only that window is guaranteed. Daily jobs are scheduled inside it
//   (dailySast() refuses a slot outside it), in Africa/Johannesburg time
//   rather than the server's UTC. If the process starts inside the window
//   after a daily job's slot has passed today (a restart or deploy, or a
//   late wake), that job runs once on startup ("catch-up"). Interval jobs
//   (every N minutes) need no catch-up: they run whenever the process is up.
//   There is no persisted last-run record, so a catch-up can re-run a daily
//   job that already ran earlier today in a previous process; every daily
//   job here is idempotent, which is what makes that acceptable.

const SAST_OFFSET_MINUTES = 120; // South Africa has no daylight saving time.
const TIMEZONE = 'Africa/Johannesburg';
const AWAKE_WINDOW = Object.freeze({ start: '06:45', end: '19:45', timezone: TIMEZONE });

function toMinutes(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!m) throw new Error(`time must be HH:MM (24h), got "${hhmm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const WINDOW_START = toMinutes(AWAKE_WINDOW.start);
const WINDOW_END = toMinutes(AWAKE_WINDOW.end);

function sastMinutes(now = new Date()) {
  return (now.getUTCHours() * 60 + now.getUTCMinutes() + SAST_OFFSET_MINUTES) % 1440;
}

function isInAwakeWindow(now = new Date()) {
  const m = sastMinutes(now);
  return m >= WINDOW_START && m <= WINDOW_END;
}

// A daily job at HH:MM SAST. `catchUpIf(now)` can veto a startup catch-up
// (e.g. the morning release catches up only during operating hours).
function dailySast(hhmm, { catchUpIf = null } = {}) {
  const minutes = toMinutes(hhmm);
  if (minutes < WINDOW_START || minutes > WINDOW_END) {
    throw new Error(`daily job at ${hhmm} SAST is outside the awake window ${AWAKE_WINDOW.start}-${AWAKE_WINDOW.end}`);
  }
  return {
    expr: `${minutes % 60} ${Math.floor(minutes / 60)} * * *`,
    timezone: TIMEZONE,
    dailyAtSast: hhmm,
    catchUpIf,
  };
}

function createCronRunner({ cron, log, now = () => new Date() }) {
  const jobs = new Map();
  const running = new Set();
  let claimed = false;

  async function runJob(name, trigger = 'schedule') {
    const job = jobs.get(name);
    if (!job) throw new Error(`unknown cron job "${name}"`);
    if (running.has(name)) {
      log.warn({ job: name, trigger }, 'cron skip: previous run still in progress');
      return { skipped: true };
    }
    running.add(name);
    const started = Date.now();
    log.info({ job: name, trigger }, 'cron start');
    try {
      await job.fn();
      log.info({ job: name, trigger, durationMs: Date.now() - started }, 'cron finish');
      return { ok: true };
    } catch (err) {
      log.error({ job: name, trigger, durationMs: Date.now() - started, error: err && err.message }, 'cron failed');
      return { ok: false };
    } finally {
      running.delete(name);
    }
  }

  function schedule(name, when, fn) {
    if (jobs.has(name)) throw new Error(`cron job "${name}" registered twice`);
    const spec = typeof when === 'string' ? { expr: when, timezone: null, dailyAtSast: null, catchUpIf: null } : when;
    jobs.set(name, { name, fn, ...spec });
    const tick = () => runJob(name, 'schedule');
    if (spec.timezone) cron.schedule(spec.expr, tick, { timezone: spec.timezone });
    else cron.schedule(spec.expr, tick);
  }

  function claimScheduler() {
    if (claimed) {
      log.warn({}, 'cron jobs already registered in this process; refusing to register them again (FI-014)');
      return () => {};
    }
    claimed = true;
    return schedule;
  }

  function dueForCatchUp(at = now()) {
    if (!isInAwakeWindow(at)) return [];
    const nowMinutes = sastMinutes(at);
    return [...jobs.values()]
      .filter((j) => j.dailyAtSast && nowMinutes > toMinutes(j.dailyAtSast))
      .filter((j) => (j.catchUpIf ? j.catchUpIf(at) : true))
      .map((j) => j.name);
  }

  async function runStartupCatchUp() {
    const names = dueForCatchUp();
    for (const name of names) await runJob(name, 'startup-catch-up');
    return names;
  }

  function listJobs() {
    return [...jobs.values()].map((j) => ({
      name: j.name,
      expr: j.expr,
      timezone: j.timezone || 'UTC',
      dailyAtSast: j.dailyAtSast,
      hasCatchUpCondition: Boolean(j.catchUpIf),
    }));
  }

  return { claimScheduler, runJob, dueForCatchUp, runStartupCatchUp, listJobs };
}

module.exports = { createCronRunner, dailySast, isInAwakeWindow, sastMinutes, AWAKE_WINDOW };
