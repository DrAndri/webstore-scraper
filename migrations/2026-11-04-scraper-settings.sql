-- Run before deploying the scraper and admin interface that set the number of
-- stores scanned at a time in the admin interface instead of
-- STORE_CONCURRENCY_LIMIT. Set concurrency to the old STORE_CONCURRENCY_LIMIT
-- if it was not 5.
CREATE TABLE IF NOT EXISTS webstorinator.scraperSettings (
    id TINYINT UNSIGNED PRIMARY KEY,
    -- Stores scanned at a time
    concurrency TINYINT UNSIGNED NOT NULL DEFAULT 5,
    updatedAt DATETIME,
    updatedBy VARCHAR(255)
);
INSERT IGNORE INTO webstorinator.scraperSettings (id, concurrency) VALUES (1, 5);
GRANT UPDATE ON webstorinator.scraperSettings TO 'webstore-admin'@'%';
FLUSH PRIVILEGES;
