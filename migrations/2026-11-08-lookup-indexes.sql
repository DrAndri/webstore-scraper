-- Indexes for the lookups by name a scan makes for every product it saves.
-- Categories are looked up by name, and by name and parent. Attributes by name
-- and group. Without them each lookup reads the whole table.
ALTER TABLE webstorinator.categories
    ADD INDEX IF NOT EXISTS ix_name_parent (name, parentId);
ALTER TABLE webstorinator.attributes
    ADD INDEX IF NOT EXISTS ix_name_group (name, groupId);
