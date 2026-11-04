-- Run before deploying the scraper and admin interface that sync the Solr
-- schemas as a job from the admin interface instead of on start.
ALTER TABLE webstorinator.scrapeJobs
MODIFY mode ENUM('crawler', 'list', 'test', 'index', 'schema') NOT NULL,
ADD COLUMN IF NOT EXISTS options JSON;
