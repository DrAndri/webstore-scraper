import cron, { ScheduledTask } from 'node-cron';
import { Pool } from 'mariadb';
import { ScheduledMode } from './types/index.js';
import { logger } from './logger.js';

const log = logger.child({ label: 'Scheduler' });

const SYNC_INTERVAL_MS = 30 * 1000;

interface ScheduleRow {
  storeId: number;
  mode: ScheduledMode;
  cron: string;
  enabled: number | boolean;
  scraperEnabled: number | boolean;
  lastError: string | null;
}

const taskKey = (storeId: number, mode: ScheduledMode) => `${storeId}:${mode}`;

// Runs the schedules of each store in storeSchedules, which are edited in the
// admin interface. A schedule runs while it, scraping for the store and
// schedulesEnabled of scraperSettings are on.
export default class Scheduler {
  pool: Pool;
  trigger: (storeId: number, mode: ScheduledMode) => Promise<void>;
  tasks = new Map<string, { cron: string; task: ScheduledTask }>();
  // Unknown until the first sync
  schedulesEnabled: boolean | undefined;

  constructor(
    pool: Pool,
    trigger: (storeId: number, mode: ScheduledMode) => Promise<void>
  ) {
    this.pool = pool;
    this.trigger = trigger;
  }

  async start() {
    await this.sync();
    setInterval(() => {
      this.sync().catch((e) => log.error('Syncing schedules failed', e));
    }, SYNC_INTERVAL_MS);
  }

  async sync() {
    // Fails when the scheduler switch migration has not been run. The row is
    // created by the job runner when it starts.
    const [settings] = await this.pool.query<
      { schedulesEnabled: number | boolean }[]
    >('SELECT schedulesEnabled FROM scraperSettings WHERE id = 1');
    const schedulesEnabled = !settings || !!settings.schedulesEnabled;
    if (schedulesEnabled !== this.schedulesEnabled)
      log.info(
        schedulesEnabled
          ? 'Scheduled scans are on'
          : 'Scheduled scans are off for every store'
      );
    this.schedulesEnabled = schedulesEnabled;

    const rows = await this.pool.query<ScheduleRow[]>(
      `SELECT ss.storeId, ss.mode, ss.cron, ss.enabled, s.scraperEnabled, ss.lastError
       FROM storeSchedules ss JOIN stores s ON s.id = ss.storeId`
    );

    const seen = new Set<string>();
    for (const row of rows) {
      const key = taskKey(row.storeId, row.mode);
      seen.add(key);
      const validation = cron.validateDetailed(row.cron);
      const lastError = validation.valid
        ? null
        : validation.errors
            .map((e) => e.message)
            .join(', ')
            .slice(0, 255);
      if (lastError !== row.lastError) {
        await this.pool.query(
          'UPDATE storeSchedules SET lastError = ? WHERE storeId = ? AND mode = ?',
          [lastError, row.storeId, row.mode]
        );
      }

      const wanted =
        schedulesEnabled &&
        row.enabled &&
        row.scraperEnabled &&
        validation.valid
          ? row.cron
          : undefined;
      const current = this.tasks.get(key);
      if (current?.cron === wanted) continue;
      if (current) await this.stop(key);
      if (wanted) {
        const task = cron.schedule(
          wanted,
          () => this.run(row.storeId, row.mode),
          { name: key, timezone: 'UTC' }
        );
        this.tasks.set(key, { cron: wanted, task });
        log.info(
          `Started ${row.mode} schedule ${wanted} of store ${row.storeId}`
        );
      }
    }

    // Schedules of stores that were deleted
    for (const key of this.tasks.keys()) {
      if (!seen.has(key)) await this.stop(key);
    }
  }

  async stop(key: string) {
    const current = this.tasks.get(key);
    if (!current) return;
    await current.task.destroy();
    this.tasks.delete(key);
    log.info(`Stopped schedule ${key} (${current.cron})`);
  }

  async run(storeId: number, mode: ScheduledMode) {
    try {
      await this.pool.query(
        'UPDATE storeSchedules SET lastRunAt = UTC_TIMESTAMP() WHERE storeId = ? AND mode = ?',
        [storeId, mode]
      );
      await this.trigger(storeId, mode);
    } catch (e) {
      log.error(`Running the ${mode} schedule of store ${storeId} failed`, e);
    }
  }
}
