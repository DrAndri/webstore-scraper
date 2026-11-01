-- API tokens and request limits for webstore-api, and least privilege grants
-- for its database user. Run before deploying the webstore-api version that
-- requires tokens.

CREATE TABLE IF NOT EXISTS webstorinator.apiUsers (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    note TEXT,
    -- The single anonymous row holds the limits of the tokens that website
    -- visitors get automatically
    anonymous BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    -- Limits of each token of the user
    requestsPerMinute INT UNSIGNED NOT NULL DEFAULT 60,
    requestsPerDay INT UNSIGNED NOT NULL DEFAULT 10000,
    -- All times are UTC
    createdAt DATETIME NOT NULL,
    createdBy VARCHAR(64),
    updatedAt DATETIME,
    updatedBy VARCHAR(64)
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
    createdBy VARCHAR(64),
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
    (1, 'Website visitors', 'Each visitor of the website gets a token with these limits', TRUE, TRUE, 60, 3000, UTC_TIMESTAMP(), 'migration');

-- The api user only reads what the public api serves and writes usage
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'webstore-api'@'%';
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

-- The admin interface manages users and tokens
GRANT INSERT, UPDATE ON webstorinator.apiUsers TO 'webstore-admin'@'%';
GRANT INSERT, UPDATE ON webstorinator.apiTokens TO 'webstore-admin'@'%';
FLUSH PRIVILEGES;
