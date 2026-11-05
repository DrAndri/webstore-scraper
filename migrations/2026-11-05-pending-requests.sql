-- Run before deploying the scraper and admin interface that show the size of
-- the request queue of a scan.
ALTER TABLE webstorinator.scrapeJobs
ADD COLUMN IF NOT EXISTS pendingRequests INT UNSIGNED AFTER categoriesError;
