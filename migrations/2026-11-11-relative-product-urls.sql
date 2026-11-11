-- Product urls are saved relative to the start url of the store, the rest of
-- the url after it (crawler/ProductUrl.ts). They were saved as the path from
-- the root of the site, which is the same for a start url without a path. For
-- the stores whose start url has a path, the path is removed from the urls under
-- it and the other urls are made absolute. Run before deploying the scraper and
-- admin interface that read urls relative to the start url, and run it
-- only once: a second run would break the urls the first one fixed.

-- https://vefverslun.ok.is/is/store
UPDATE webstorinator.products
SET url = CASE
    WHEN url LIKE '/is/store/%' OR url LIKE '/is/store?%' OR url LIKE '/is/store#%'
        THEN SUBSTRING(url, 10)
    ELSE CONCAT('https://vefverslun.ok.is', url)
END
WHERE storeId = 9 AND url LIKE '/%';

-- https://s4s.is/ellingsen
UPDATE webstorinator.products
SET url = CASE
    WHEN url LIKE '/ellingsen/%' OR url LIKE '/ellingsen?%' OR url LIKE '/ellingsen#%'
        THEN SUBSTRING(url, 11)
    ELSE CONCAT('https://s4s.is', url)
END
WHERE storeId = 26 AND url LIKE '/%';

-- https://s4s.is/skor
UPDATE webstorinator.products
SET url = CASE
    WHEN url LIKE '/skor/%' OR url LIKE '/skor?%' OR url LIKE '/skor#%'
        THEN SUBSTRING(url, 6)
    ELSE CONCAT('https://s4s.is', url)
END
WHERE storeId = 29 AND url LIKE '/%';

-- https://s4s.is/lindex
UPDATE webstorinator.products
SET url = CASE
    WHEN url LIKE '/lindex/%' OR url LIKE '/lindex?%' OR url LIKE '/lindex#%'
        THEN SUBSTRING(url, 8)
    ELSE CONCAT('https://s4s.is', url)
END
WHERE storeId = 30 AND url LIKE '/%';

-- https://s4s.is/air
UPDATE webstorinator.products
SET url = CASE
    WHEN url LIKE '/air/%' OR url LIKE '/air?%' OR url LIKE '/air#%'
        THEN SUBSTRING(url, 5)
    ELSE CONCAT('https://s4s.is', url)
END
WHERE storeId = 31 AND url LIKE '/%';

-- https://s4s.is/premium-outlet
UPDATE webstorinator.products
SET url = CASE
    WHEN url LIKE '/premium-outlet/%' OR url LIKE '/premium-outlet?%' OR url LIKE '/premium-outlet#%'
        THEN SUBSTRING(url, 16)
    ELSE CONCAT('https://s4s.is', url)
END
WHERE storeId = 32 AND url LIKE '/%';

-- https://brp.is/brp-ellingsen
UPDATE webstorinator.products
SET url = CASE
    WHEN url LIKE '/brp-ellingsen/%' OR url LIKE '/brp-ellingsen?%' OR url LIKE '/brp-ellingsen#%'
        THEN SUBSTRING(url, 15)
    ELSE CONCAT('https://brp.is', url)
END
WHERE storeId = 33 AND url LIKE '/%';

-- https://n1.is/is/vefverslun
UPDATE webstorinator.products
SET url = CASE
    WHEN url LIKE '/is/vefverslun/%' OR url LIKE '/is/vefverslun?%' OR url LIKE '/is/vefverslun#%'
        THEN SUBSTRING(url, 15)
    ELSE CONCAT('https://n1.is', url)
END
WHERE storeId = 34 AND url LIKE '/%';

-- https://www.nova.is/vefverslun
UPDATE webstorinator.products
SET url = CASE
    WHEN url LIKE '/vefverslun/%' OR url LIKE '/vefverslun?%' OR url LIKE '/vefverslun#%'
        THEN SUBSTRING(url, 12)
    ELSE CONCAT('https://www.nova.is', url)
END
WHERE storeId = 38 AND url LIKE '/%';

-- https://66north.com/is-is
UPDATE webstorinator.products
SET url = CASE
    WHEN url LIKE '/is-is/%' OR url LIKE '/is-is?%' OR url LIKE '/is-is#%'
        THEN SUBSTRING(url, 7)
    ELSE CONCAT('https://66north.com', url)
END
WHERE storeId = 55 AND url LIKE '/%';
