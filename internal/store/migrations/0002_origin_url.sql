-- Where a tab first came from (a Songsterr address), kept when its file moves into a Pocket Files folder.
ALTER TABLE tabs ADD COLUMN origin_url TEXT NOT NULL DEFAULT '';
UPDATE tabs SET origin_url = source_ref WHERE source = 'songsterr';
