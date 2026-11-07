-- Run before deploying the scraper and admin interface that reload the store
-- configs only when a reload is requested in the admin interface, instead of
-- checking GitHub every minute.
ALTER TABLE webstorinator.scraperStatus
    ADD COLUMN IF NOT EXISTS configLoadedAt DATETIME AFTER configCommit,
    ADD COLUMN IF NOT EXISTS storeConfigs JSON AFTER configErrors;
CREATE TABLE IF NOT EXISTS webstorinator.configReloads (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    -- NULL reloads every store config
    storeId TINYINT UNSIGNED,
    status ENUM('queued', 'succeeded', 'failed') NOT NULL DEFAULT 'queued',
    -- Email of the admin that requested the reload
    requestedBy VARCHAR(255),
    -- All times are UTC
    requestedAt DATETIME NOT NULL,
    finishedAt DATETIME,
    -- Commit the configs were read at
    configCommit VARCHAR(64),
    -- The configs that failed to load, they keep the version loaded before
    errorMessage TEXT,
    INDEX ix_status (status),
    CONSTRAINT fk_configReloads_store FOREIGN KEY (storeId) REFERENCES webstorinator.stores(id) ON DELETE CASCADE
);
GRANT INSERT ON webstorinator.configReloads TO 'webstore-admin'@'%';
FLUSH PRIVILEGES;
