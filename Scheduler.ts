import cron, { ScheduledTask } from 'node-cron';
import { Pool } from 'mariadb';
import { ScheduledMode } from './types/index.js';

const SYNC_INTERVAL_MS = 30 * 1000;
// Used for the rows created on the first start when the env variable is not set
const DEFAULT_SCHEDULES: Record<ScheduledMode, string> = {
  crawler: '0 1 * * 1',
  list: '0 4 * * *'
};
const ENV_SCHEDULES: Record<ScheduledMode, string | undefined> = {
  crawler: process.env.CRON_SCHEDULE,
  list: process.env.CRON_ACTIVE_SCHEDULE
};

interface ScheduleRow {
  mode: ScheduledMode;
  cron: string;
  enabled: number | boolean;
  lastError: string | null;
}

// Runs the schedules in scraperSchedules, which are edited in the admin interface
export default class Scheduler {
  pool: Pool;
  trigger: (mode: ScheduledMode) => Promise<void>;
  tasks = new Map<ScheduledMode, { cron: string; task: ScheduledTask }>();

  constructor(pool: Pool, trigger: (mode: ScheduledMode) => Promise<void>) {
    this.pool = pool;
    this.trigger = trigger;
  }

  async start() {
    for (const mode of Object.keys(DEFAULT_SCHEDULES) as ScheduledMode[]) {
      const envSchedule = ENV_SCHEDULES[mode];
      await this.pool.query(
        "INSERT IGNORE INTO scraperSchedules (mode, cron, enabled, updatedAt, updatedBy) VALUES (?, ?, ?, UTC_TIMESTAMP(), 'env')",
        [
          mode,
          envSchedule ?? DEFAULT_SCHEDULES[mode],
          envSchedule !== undefined
        ]
      );
    }
    await this.sync();
    setInterval(() => {
      this.sync().catch((e) => console.log('Syncing schedules failed', e));
    }, SYNC_INTERVAL_MS);
  }

  async sync() {
    const rows = await this.pool.query<ScheduleRow[]>(
      'SELECT mode, cron, enabled, lastError FROM scraperSchedules'
    );
    for (const row of rows) {
      const validation = cron.validateDetailed(row.cron);
      const lastError = validation.valid
        ? null
        : validation.errors
            .map((e) => e.message)
            .join(', ')
            .slice(0, 255);
      if (lastError !== row.lastError) {
        await this.pool.query(
          'UPDATE scraperSchedules SET lastError = ? WHERE mode = ?',
          [lastError, row.mode]
        );
      }

      const wanted = row.enabled && validation.valid ? row.cron : undefined;
      const current = this.tasks.get(row.mode);
      if (current?.cron === wanted) continue;
      if (current) {
        await current.task.destroy();
        this.tasks.delete(row.mode);
        console.log(`Stopped ${row.mode} schedule ${current.cron}`);
      }
      if (wanted) {
        const task = cron.schedule(wanted, () => this.run(row.mode), {
          name: row.mode,
          timezone: 'UTC'
        });
        this.tasks.set(row.mode, { cron: wanted, task });
        console.log(`Started ${row.mode} schedule ${wanted}`);
      }
    }
  }

  async run(mode: ScheduledMode) {
    try {
      await this.pool.query(
        'UPDATE scraperSchedules SET lastRunAt = UTC_TIMESTAMP() WHERE mode = ?',
        [mode]
      );
      await this.trigger(mode);
    } catch (e) {
      console.log(`Running the ${mode} schedule failed`, e);
    }
  }
}
