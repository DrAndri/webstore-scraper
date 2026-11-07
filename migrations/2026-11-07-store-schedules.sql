-- Run before deploying the scraper and admin interface where each store has its
-- own scan schedules. Every store starts with the schedules that applied to all
-- stores before, then the old table is dropped.
CREATE TABLE IF NOT EXISTS webstorinator.storeSchedules (
    storeId TINYINT UNSIGNED NOT NULL,
    mode ENUM('crawler', 'list') NOT NULL,
    cron VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updatedAt DATETIME,
    -- Email of the admin that changed the schedule
    updatedBy VARCHAR(255),
    lastRunAt DATETIME,
    -- Why the scraper rejected the expression
    lastError VARCHAR(255),
    PRIMARY KEY (storeId, mode),
    CONSTRAINT fk_storeSchedules_store FOREIGN KEY (storeId) REFERENCES webstorinator.stores(id) ON DELETE CASCADE
);
INSERT IGNORE INTO webstorinator.storeSchedules
    (storeId, mode, cron, enabled, updatedAt, updatedBy, lastRunAt)
SELECT s.id, g.mode, g.cron, g.enabled, g.updatedAt, g.updatedBy, g.lastRunAt
FROM webstorinator.stores s CROSS JOIN webstorinator.scraperSchedules g;

GRANT INSERT, UPDATE ON webstorinator.storeSchedules TO 'webstore-admin'@'%';
REVOKE UPDATE ON webstorinator.scraperSchedules FROM 'webstore-admin'@'%';
DROP TABLE webstorinator.scraperSchedules;
FLUSH PRIVILEGES;
