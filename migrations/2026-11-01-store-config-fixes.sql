-- Run once before the next scrape after deploying the store config fixes,
-- then reindex Solr (INDEX_EVERYTHING=true).

-- Krónan (storeId 11): the sku was taken from the url and stored as
-- https://kronan.is/vara/100273793, it now comes from JSON-LD as 100273793.
UPDATE webstorinator.products
SET sku = SUBSTRING_INDEX(sku, '/', -1)
WHERE storeId = 11 AND sku LIKE 'http%/vara/%';

-- Síminn (storeId 17): the sku selector returned the brand ("Apple"), so every
-- product of a brand was written to one row and its price history is mixed
-- across products. Products are now keyed by the numeric product id and will be
-- recreated on the next scrape. Deleting the merged rows also deletes their
-- prices and attributes (ON DELETE CASCADE), uncomment to run. Remove them from
-- Solr too: <delete><query>storeId:17 AND -sku:/[0-9]+/</query></delete>
-- DELETE FROM webstorinator.products
-- WHERE storeId = 17 AND sku NOT REGEXP '^[0-9]+$';
