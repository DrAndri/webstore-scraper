-- Tables for the admin interface in webstore-api. Run once before deploying the
-- job runner. storeScans is no longer written to, its rows are copied to
-- scrapeJobs and it can be dropped once the copy has been checked.

CREATE TABLE IF NOT EXISTS webstorinator.scrapeJobs (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    -- NULL for test jobs of stores that have not been created yet
    storeId TINYINT UNSIGNED,
    -- crawler: full crawl, list: re-scrape the urls of active products,
    -- test: scrape testUrl with testConfig without writing to the database
    mode ENUM('crawler', 'list', 'test') NOT NULL,
    source ENUM('cron', 'manual', 'startup') NOT NULL,
    status ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
    cancelRequested BOOLEAN NOT NULL DEFAULT FALSE,
    -- GitHub login of the admin that queued the job
    requestedBy VARCHAR(64),

    -- All times are UTC
    queuedAt DATETIME NOT NULL,
    startedAt DATETIME,
    finishedAt DATETIME,
    heartbeatAt DATETIME,

    -- Commit of the store configs the job ran with
    configCommit VARCHAR(64),

    totalRequests INT UNSIGNED NOT NULL DEFAULT 0,
    totalProcessed INT UNSIGNED NOT NULL DEFAULT 0,
    totalErrored INT UNSIGNED NOT NULL DEFAULT 0,
    descriptionError INT UNSIGNED NOT NULL DEFAULT 0,
    attributeError INT UNSIGNED NOT NULL DEFAULT 0,
    imageError INT UNSIGNED NOT NULL DEFAULT 0,
    brandError INT UNSIGNED NOT NULL DEFAULT 0,
    nameError INT UNSIGNED NOT NULL DEFAULT 0,
    inStockError INT UNSIGNED NOT NULL DEFAULT 0,
    categoriesError INT UNSIGNED NOT NULL DEFAULT 0,
    -- StoreUpdateResult counters
    updateResult JSON,
    errorMessage TEXT,

    testUrl VARCHAR(2048),
    testConfig JSON,
    testResult JSON,

    INDEX ix_status (status),
    INDEX ix_store_queued (storeId, queuedAt),
    INDEX ix_queued (queuedAt),
    CONSTRAINT fk_scrapeJobs_store FOREIGN KEY (storeId) REFERENCES webstorinator.stores(id) ON DELETE CASCADE
);

-- One row per mode, seeded from CRON_SCHEDULE and CRON_ACTIVE_SCHEDULE on the
-- first start of the scraper, after that the admin interface owns them.
-- Expressions are evaluated in UTC.
CREATE TABLE IF NOT EXISTS webstorinator.scraperSchedules (
    mode ENUM('crawler', 'list') PRIMARY KEY,
    cron VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updatedAt DATETIME,
    updatedBy VARCHAR(64),
    lastRunAt DATETIME,
    lastError VARCHAR(255)
);

-- Heartbeat of the scraper, a single row
CREATE TABLE IF NOT EXISTS webstorinator.scraperStatus (
    id TINYINT UNSIGNED PRIMARY KEY,
    startedAt DATETIME NOT NULL,
    lastSeenAt DATETIME NOT NULL,
    hostname VARCHAR(255),
    concurrency TINYINT UNSIGNED,
    configSource VARCHAR(255),
    configCommit VARCHAR(64),
    -- JSON array of { file, message } for store configs that failed to load
    configErrors JSON
);

INSERT INTO webstorinator.scrapeJobs (
    storeId, mode, source, status, queuedAt, startedAt, finishedAt,
    totalRequests, totalProcessed, totalErrored, descriptionError, attributeError,
    imageError, brandError, nameError, inStockError, categoriesError
)
SELECT
    storeId, IF(crawler, 'crawler', 'list'), 'cron', 'succeeded', date, date, date,
    IFNULL(totalRequests, 0), IFNULL(totalProcessed, 0), IFNULL(totalErrored, 0),
    IFNULL(descriptionError, 0), IFNULL(attributeError, 0), IFNULL(imageError, 0),
    IFNULL(brandError, 0), IFNULL(nameError, 0), IFNULL(inStockError, 0),
    IFNULL(categoriesError, 0)
FROM webstorinator.storeScans
ORDER BY date, storeId;

-- Database user for the admin interface. It can read everything but only
-- write to the tables the admin interface manages. Change the password.
CREATE USER IF NOT EXISTS 'webstore-admin'@'%' IDENTIFIED BY 'change-me';
GRANT SELECT ON webstorinator.* TO 'webstore-admin'@'%';
GRANT INSERT, UPDATE ON webstorinator.stores TO 'webstore-admin'@'%';
GRANT INSERT, UPDATE ON webstorinator.scrapeJobs TO 'webstore-admin'@'%';
GRANT UPDATE ON webstorinator.scraperSchedules TO 'webstore-admin'@'%';
FLUSH PRIVILEGES;
