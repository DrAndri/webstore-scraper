-- Run before deploying the scraper and admin interface where scan logging is
-- turned on per store instead of with ENABLE_SCRAPER_LOGGING. Every store
-- starts with logging off.
ALTER TABLE webstorinator.stores
    ADD COLUMN IF NOT EXISTS loggingEnabled BOOLEAN NOT NULL DEFAULT FALSE;
