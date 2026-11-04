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
    -- test: scrape testUrl with testConfig without writing to the database,
    -- index: reindex everything in the database to Solr, storeId is NULL
    mode ENUM('crawler', 'list', 'test', 'index') NOT NULL,
    source ENUM('cron', 'manual', 'startup') NOT NULL,
    status ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled') NOT NULL DEFAULT 'queued',
    cancelRequested BOOLEAN NOT NULL DEFAULT FALSE,
    -- GitHub login of the admin that queued the job
    requestedBy VARCHAR(255),

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

-- One row per mode, created turned off on the first start of the scraper and
-- edited in the admin interface. Expressions are evaluated in UTC.
CREATE TABLE IF NOT EXISTS webstorinator.scraperSchedules (
    mode ENUM('crawler', 'list') PRIMARY KEY,
    cron VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updatedAt DATETIME,
    updatedBy VARCHAR(255),
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

-- Settings of the scraper edited in the admin interface, one row with id 1.
-- The job runner reads them every 5 seconds.
CREATE TABLE IF NOT EXISTS webstorinator.scraperSettings (
    id TINYINT UNSIGNED PRIMARY KEY,
    -- Stores scanned at a time
    concurrency TINYINT UNSIGNED NOT NULL DEFAULT 5,
    updatedAt DATETIME,
    updatedBy VARCHAR(255)
);
INSERT IGNORE INTO webstorinator.scraperSettings (id) VALUES (1);

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

CREATE TABLE IF NOT EXISTS webstorinator.apiUsers (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    note TEXT,
    -- The single anonymous row holds the limits of the tokens that website
    -- visitors get automatically
    anonymous BOOLEAN NOT NULL DEFAULT FALSE,
    -- Can sign in to the admin interface with the email address
    admin BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    -- Limits of each token of the user
    requestsPerMinute INT UNSIGNED NOT NULL DEFAULT 60,
    requestsPerDay INT UNSIGNED NOT NULL DEFAULT 10000,
    -- All times are UTC
    createdAt DATETIME NOT NULL,
    createdBy VARCHAR(255),
    updatedAt DATETIME,
    updatedBy VARCHAR(255),
    UNIQUE INDEX uq_apiUsers_email (email)
);

CREATE TABLE IF NOT EXISTS webstorinator.apiTokens (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    userId INT UNSIGNED NOT NULL,
    name VARCHAR(255),
    -- The start of the token, to tell tokens apart
    prefix VARCHAR(16) NOT NULL,
    -- SHA-256 of the token, the token itself is only shown when it is created
    hash CHAR(64) NOT NULL UNIQUE,
    createdAt DATETIME NOT NULL,
    createdBy VARCHAR(255),
    lastUsedAt DATETIME,
    revokedAt DATETIME,
    CONSTRAINT fk_apiTokens_user FOREIGN KEY (userId) REFERENCES webstorinator.apiUsers(id) ON DELETE CASCADE
);

-- Requests per token and UTC day. tokenId 0 counts all anonymous visitors.
CREATE TABLE IF NOT EXISTS webstorinator.apiUsage (
    userId INT UNSIGNED NOT NULL,
    tokenId INT UNSIGNED NOT NULL,
    day DATE NOT NULL,
    requests INT UNSIGNED NOT NULL DEFAULT 0,
    rejected INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (userId, tokenId, day),
    INDEX ix_day (day)
);

INSERT IGNORE INTO webstorinator.apiUsers
    (id, name, note, anonymous, enabled, requestsPerMinute, requestsPerDay, createdAt, createdBy)
VALUES
    (1, 'Website visitors', 'Each visitor of the website gets a token with these limits', TRUE, TRUE, 60, 3000, UTC_TIMESTAMP(), 'init-db');

-- The first admin signs in to the admin interface with Google using this email
-- address, after that admins are managed under API users. Fill in and uncomment.
-- INSERT INTO webstorinator.apiUsers
--     (name, email, admin, enabled, requestsPerMinute, requestsPerDay, createdAt, createdBy)
-- VALUES
--     ('Your name', 'you@example.com', TRUE, TRUE, 120, 100000, UTC_TIMESTAMP(), 'init-db');

-- The passwords below are placeholders. Change them after the first start with
-- ALTER USER, so the real ones are not committed.

-- Create scraper user
CREATE USER 'webstore-scraper'@'%' IDENTIFIED BY 'pass1';
GRANT ALL PRIVILEGES ON webstorinator.* TO 'webstore-scraper'@'%';

-- Create api user, it only reads what the public api serves and writes usage
CREATE USER 'webstore-api'@'%' IDENTIFIED BY 'pass2';
GRANT SELECT ON webstorinator.stores TO 'webstore-api'@'%';
GRANT SELECT ON webstorinator.products TO 'webstore-api'@'%';
GRANT SELECT ON webstorinator.prices TO 'webstore-api'@'%';
GRANT SELECT ON webstorinator.salePrices TO 'webstore-api'@'%';
GRANT SELECT ON webstorinator.manufacturers TO 'webstore-api'@'%';
GRANT SELECT ON webstorinator.categories TO 'webstore-api'@'%';
GRANT SELECT ON webstorinator.attributes TO 'webstore-api'@'%';
GRANT SELECT ON webstorinator.attributeGroups TO 'webstore-api'@'%';
GRANT SELECT ON webstorinator.attributeToProducts TO 'webstore-api'@'%';
GRANT SELECT ON webstorinator.apiUsers TO 'webstore-api'@'%';
GRANT SELECT, UPDATE (lastUsedAt) ON webstorinator.apiTokens TO 'webstore-api'@'%';
GRANT SELECT, INSERT, UPDATE ON webstorinator.apiUsage TO 'webstore-api'@'%';

-- Create admin user, it only writes to the tables the admin interface manages
CREATE USER 'webstore-admin'@'%' IDENTIFIED BY 'pass3';
GRANT SELECT ON webstorinator.* TO 'webstore-admin'@'%';
GRANT INSERT, UPDATE ON webstorinator.stores TO 'webstore-admin'@'%';
GRANT INSERT, UPDATE ON webstorinator.scrapeJobs TO 'webstore-admin'@'%';
GRANT UPDATE ON webstorinator.scraperSchedules TO 'webstore-admin'@'%';
GRANT UPDATE ON webstorinator.scraperSettings TO 'webstore-admin'@'%';
GRANT INSERT, UPDATE ON webstorinator.apiUsers TO 'webstore-admin'@'%';
GRANT INSERT, UPDATE ON webstorinator.apiTokens TO 'webstore-admin'@'%';

FLUSH PRIVILEGES;