-- Run before deploying the scraper and admin interface that queue Solr
-- reindexing as a job from the admin interface.
ALTER TABLE webstorinator.scrapeJobs
MODIFY mode ENUM('crawler', 'list', 'test', 'index') NOT NULL;
