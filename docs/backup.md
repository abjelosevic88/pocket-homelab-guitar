# Backup

One SQLite file: `DATA_DIR/pocket-guitar.db` (WAL mode). Take a consistent copy with `pocket-guitar backup` (writes `DATA_DIR/backups/pocket-guitar-<time>.db` with `VACUUM INTO`) or Settings → Backup & data → Download database (admin). Back up that copy, not the live file. `DATA_DIR/core.token*` is the Pocket Core registration. The tab files live in `DATA_DIR/tabs/<user>/<sha256>` (`FILES_DIR`): back that folder up too (tabs that came from a Pocket Files folder are also still in that folder).

Restore: stop the app, replace `pocket-guitar.db` (remove `-wal`/`-shm` files), start.

Every person can also export their own data as JSON (`/api/v1/export.json`, re-importable) with every song file inside, or the practice log as CSV.
