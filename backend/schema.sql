PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
 display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','user')), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf_token TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS venues (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL, address TEXT NOT NULL,
 longitude REAL NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 latitude REAL NOT NULL CHECK(latitude BETWEEN -85 AND 85), description TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY, title TEXT NOT NULL, venue_id INTEGER NOT NULL REFERENCES venues(id),
 start_date TEXT NOT NULL, end_date TEXT NOT NULL CHECK(end_date >= start_date),
 organizer TEXT NOT NULL, race_distances TEXT NOT NULL, description TEXT NOT NULL,
 cover_image TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','published')),
 is_demo INTEGER NOT NULL DEFAULT 0 CHECK(is_demo IN (0,1)),
 created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS favorites (
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL, PRIMARY KEY(user_id,event_id)
);
CREATE TABLE IF NOT EXISTS rules (
 id INTEGER PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT NOT NULL,
 source_label TEXT NOT NULL, is_demo INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
 id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 content TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assistant_logs (
 id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), engine TEXT NOT NULL,
 elapsed_ms INTEGER NOT NULL, event_count INTEGER NOT NULL, source_count INTEGER NOT NULL,
 token_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_status_dates ON events(status,start_date,end_date);
CREATE INDEX IF NOT EXISTS venues_city ON venues(city);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
