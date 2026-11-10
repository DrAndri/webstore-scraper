-- Run before deploying the scraper and admin interface where the scheduler can
-- be turned off for every store under Settings. The scheduler stays on.
ALTER TABLE webstorinator.scraperSettings
    ADD COLUMN IF NOT EXISTS schedulesEnabled BOOLEAN NOT NULL DEFAULT TRUE AFTER concurrency;
