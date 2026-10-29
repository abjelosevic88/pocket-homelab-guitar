CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'member',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL DEFAULT '',
  last_used_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Box-wide settings (title, setup flag); everything else is personal.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE user_settings (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, key)
);

CREATE TABLE cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL
);


-- One tab (a Guitar Pro, MusicXML or alphaTex file) in a person's library.
-- The file itself lives under DATA_DIR/tabs/<user>/<sha256>.<ext>; a tab from a
-- Pocket Files folder keeps a copy there too, so it plays when Files is away.
CREATE TABLE tabs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title          TEXT NOT NULL DEFAULT '',
  artist         TEXT NOT NULL DEFAULT '',
  album          TEXT NOT NULL DEFAULT '',
  tabber         TEXT NOT NULL DEFAULT '',
  names_from     TEXT NOT NULL DEFAULT 'file',    -- file | filename | person (who set title/artist)
  format         TEXT NOT NULL DEFAULT 'gp',      -- gp | gp3 | gp4 | gp5 | gpx | musicxml | alphatex
  file_name      TEXT NOT NULL DEFAULT '',
  size           INTEGER NOT NULL DEFAULT 0,
  sha256         TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'upload',  -- upload | files | songsterr | import | <pocket app slug>
  source_ref     TEXT NOT NULL DEFAULT '',        -- Pocket Files path or Songsterr address
  folder_id      INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  source_stamp   TEXT NOT NULL DEFAULT '',        -- size+mtime seen in the folder
  source_missing INTEGER NOT NULL DEFAULT 0,
  tempo          INTEGER NOT NULL DEFAULT 0,
  bars           INTEGER NOT NULL DEFAULT 0,
  duration_s     INTEGER NOT NULL DEFAULT 0,
  tracks         TEXT NOT NULL DEFAULT '[]',      -- JSON TabTrack[]
  tuning         TEXT NOT NULL DEFAULT '',
  analyzed       INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'to_learn', -- to_learn | learning | polishing | mastered
  mastered_at    TEXT NOT NULL DEFAULT '',
  difficulty     INTEGER NOT NULL DEFAULT 0,
  favorite       INTEGER NOT NULL DEFAULT 0,
  tags           TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',
  capo           INTEGER NOT NULL DEFAULT 0,
  goal_speed     INTEGER NOT NULL DEFAULT 100,
  best_speed     INTEGER NOT NULL DEFAULT 0,
  player         TEXT NOT NULL DEFAULT '{}',      -- JSON PlayerPrefs
  recording      TEXT NOT NULL DEFAULT '',        -- JSON Recording ('' = none)
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX tabs_user_sha ON tabs(user_id, sha256);
CREATE INDEX tabs_user_title ON tabs(user_id, artist, title);
CREATE INDEX tabs_user_folder ON tabs(user_id, folder_id);

-- A named part of a song practised as a loop, with its own speed trainer.
CREATE TABLE sections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tab_id     INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL DEFAULT '',
  start_bar  INTEGER NOT NULL DEFAULT 1,
  end_bar    INTEGER NOT NULL DEFAULT 1,
  speed      INTEGER NOT NULL DEFAULT 70,
  goal_speed INTEGER NOT NULL DEFAULT 100,
  best_speed INTEGER NOT NULL DEFAULT 0,
  color      TEXT NOT NULL DEFAULT '',
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX sections_user_tab ON sections(user_id, tab_id);

-- Time spent practising: on a tab (the player logs it as you play) or free
-- (scales, improvising), timed by the tools or added by hand.
CREATE TABLE practice (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tab_id          INTEGER REFERENCES tabs(id) ON DELETE SET NULL,
  section_id      INTEGER REFERENCES sections(id) ON DELETE SET NULL,
  title           TEXT NOT NULL DEFAULT '',
  kind            TEXT NOT NULL DEFAULT 'tab',     -- tab | free
  started_at      TEXT NOT NULL,                   -- RFC3339 with offset
  ended_at        TEXT NOT NULL DEFAULT '',
  date            TEXT NOT NULL,                   -- local date of started_at
  duration_s      INTEGER NOT NULL DEFAULT 0,
  speed           INTEGER NOT NULL DEFAULT 0,      -- top speed played, percent
  loops           INTEGER NOT NULL DEFAULT 0,
  note            TEXT NOT NULL DEFAULT '',
  source          TEXT NOT NULL DEFAULT 'app',     -- app | manual | import | <pocket app slug>
  external_id     TEXT NOT NULL DEFAULT '',
  habit_marked_at TEXT NOT NULL DEFAULT '',
  habit_error     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX practice_user_date ON practice(user_id, date);
CREATE INDEX practice_user_tab ON practice(user_id, tab_id);
CREATE UNIQUE INDEX practice_external ON practice(user_id, source, external_id) WHERE external_id <> '';

CREATE TABLE setlists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX setlists_user ON setlists(user_id);

CREATE TABLE setlist_items (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  setlist_id INTEGER NOT NULL REFERENCES setlists(id) ON DELETE CASCADE,
  tab_id     INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
  sort       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (setlist_id, tab_id)
);
CREATE INDEX setlist_items_user ON setlist_items(user_id, setlist_id);

-- Pocket Files folders whose tabs appear in the library.
CREATE TABLE folders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space        TEXT NOT NULL,
  space_name   TEXT NOT NULL DEFAULT '',
  path         TEXT NOT NULL DEFAULT '/',
  label        TEXT NOT NULL DEFAULT '',
  last_sync_at TEXT NOT NULL DEFAULT '',
  last_error   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX folders_user_path ON folders(user_id, space, path);

-- "A day with N minutes of guitar ticks my Practise guitar habit" (Pocket Habits).
CREATE TABLE habit_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  min_minutes REAL NOT NULL DEFAULT 0,
  habit_id    INTEGER NOT NULL,
  habit_name  TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX habit_rules_user ON habit_rules(user_id);

-- Days a rule already ticked its habit.
CREATE TABLE habit_marks (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_id   INTEGER NOT NULL REFERENCES habit_rules(id) ON DELETE CASCADE,
  date      TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (user_id, rule_id, date)
);
