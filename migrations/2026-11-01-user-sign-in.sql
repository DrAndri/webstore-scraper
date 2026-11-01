-- Sign in with Google for webstore-api. Users who sign in with the email of an
-- api user get its limits, and api users with the admin flag can use the admin
-- interface. Run before deploying the webstore-api version that uses next-auth.

ALTER TABLE webstorinator.apiUsers
    ADD COLUMN admin BOOLEAN NOT NULL DEFAULT FALSE AFTER anonymous,
    ADD UNIQUE INDEX uq_apiUsers_email (email),
    -- Admins are now recorded by email instead of GitHub login
    MODIFY createdBy VARCHAR(255),
    MODIFY updatedBy VARCHAR(255);
ALTER TABLE webstorinator.apiTokens MODIFY createdBy VARCHAR(255);
ALTER TABLE webstorinator.scrapeJobs MODIFY requestedBy VARCHAR(255);
ALTER TABLE webstorinator.scraperSchedules MODIFY updatedBy VARCHAR(255);

-- The first admin has to be added here, after that admins are managed under
-- API users in the admin interface. Use the address you sign in to Google with.
-- INSERT INTO webstorinator.apiUsers
--     (name, email, admin, enabled, requestsPerMinute, requestsPerDay, createdAt, createdBy)
-- VALUES
--     ('Your name', 'you@example.com', TRUE, TRUE, 120, 100000, UTC_TIMESTAMP(), 'migration');
