-- Create database
CREATE DATABASE IF NOT EXISTS webstorinator;

CREATE TABLE IF NOT EXISTS webstorinator.stores (
    id TINYINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    createdDate DATE DEFAULT CURRENT_DATE,
    lastScanDate DATE,
    scraperEnabled BOOLEAN NOT NULL DEFAULT FALSE,
    apiEnabled BOOLEAN NOT NULL DEFAULT FALSE
);

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

CREATE TABLE IF NOT EXISTS webstorinator.manufacturers (
    id SMALLINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(127) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS webstorinator.categories (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    parentId INT UNSIGNED,
    name VARCHAR(127) NOT NULL,
    CONSTRAINT fk_parentCategory FOREIGN KEY (parentId) REFERENCES webstorinator.categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webstorinator.products (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    storeId TINYINT UNSIGNED NOT NULL,
    manufacturerId SMALLINT UNSIGNED,
    categoryId INT UNSIGNED,
    sku VARCHAR(64) NOT NULL,
    name VARCHAR(127),
    image VARCHAR(255),
    ean VARCHAR(64),
    description TEXT,
    url VARCHAR(255),
    inStock BOOLEAN,
    firstSeenDate DATE NOT NULL,
    lastChangeDate DATE NOT NULL,
    CONSTRAINT uq_store_sku UNIQUE INDEX (storeId, sku),
    CONSTRAINT fk_products_store FOREIGN KEY (storeId) REFERENCES webstorinator.stores(id) ON DELETE CASCADE,
    CONSTRAINT fk_products_manufacturer FOREIGN KEY (manufacturerId) REFERENCES webstorinator.manufacturers(id) ON DELETE SET NULL,
    CONSTRAINT fk_products_category FOREIGN KEY (categoryId) REFERENCES webstorinator.categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS webstorinator.prices (
    productId INT UNSIGNED NOT NULL,
    price MEDIUMINT UNSIGNED NOT NULL,
    start DATE NOT NULL,
    end DATE NOT NULL,
    PRIMARY KEY (productId, start),
    INDEX ix_end (end),
    CONSTRAINT fk_prices_product FOREIGN KEY (productId) REFERENCES webstorinator.products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webstorinator.salePrices (
    productId INT UNSIGNED,
    price INT UNSIGNED NOT NULL,
    start DATE NOT NULL,
    end DATE NOT NULL,
    PRIMARY KEY (productId, start),
    INDEX ix_end (end),
    CONSTRAINT fk_salePrices_product FOREIGN KEY (productId) REFERENCES webstorinator.products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webstorinator.attributeGroups (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(127) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS webstorinator.attributes (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    groupId INT UNSIGNED,
    name VARCHAR(127) NOT NULL,
    CONSTRAINT fk_attributes_attributeGroup FOREIGN KEY (groupId) REFERENCES webstorinator.attributeGroups(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS webstorinator.attributeToProducts (
    attributeId INT UNSIGNED,
    productId INT UNSIGNED,
    value VARCHAR(255) NOT NULL,
    PRIMARY KEY (attributeId, productId),
    CONSTRAINT fk_attributeToProducts_attribute FOREIGN KEY (attributeId) REFERENCES webstorinator.attributes(id) ON DELETE CASCADE,
    CONSTRAINT fk_attributeToProducts_product FOREIGN KEY (productId) REFERENCES webstorinator.products(id) ON DELETE CASCADE
);

-- Create scraper user
CREATE USER 'webstore-scraper'@'%' IDENTIFIED BY 'pass1';
GRANT ALL PRIVILEGES ON webstorinator.* TO 'webstore-scraper'@'%';

-- Create api user
CREATE USER 'webstore-api'@'%' IDENTIFIED BY 'pass2';
GRANT SELECT ON webstorinator.* TO 'webstore-api'@'%';

-- Create admin user, it only writes to the tables the admin interface manages
CREATE USER 'webstore-admin'@'%' IDENTIFIED BY 'pass3';
GRANT SELECT ON webstorinator.* TO 'webstore-admin'@'%';
GRANT INSERT, UPDATE ON webstorinator.stores TO 'webstore-admin'@'%';
GRANT INSERT, UPDATE ON webstorinator.scrapeJobs TO 'webstore-admin'@'%';
GRANT UPDATE ON webstorinator.scraperSchedules TO 'webstore-admin'@'%';

FLUSH PRIVILEGES;