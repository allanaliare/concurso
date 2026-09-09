import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { migrate } from './migrations.js';
import { randomUUID } from 'node:crypto';
import { migrateUuids } from './uuid-migration.js';

export function database(path = 'data/concurso.sqlite') {
  if (path !== ':memory:') mkdirSync('data', { recursive: true });
  const db = new DatabaseSync(path);
  db.function('uuid', () => randomUUID());
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS contests (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, organizer TEXT NOT NULL, role TEXT NOT NULL,
      fee REAL NOT NULL CHECK(fee>=0), vacancies INTEGER NOT NULL CHECK(vacancies>=0), salary TEXT NOT NULL,
      location TEXT NOT NULL, arrival TEXT NOT NULL, starts TEXT NOT NULL, ends TEXT NOT NULL,
      deadline TEXT NOT NULL, official_url TEXT NOT NULL, notes TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS links (
      code TEXT PRIMARY KEY, contest_id INTEGER NOT NULL REFERENCES contests(id), group_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL REFERENCES links(code), visitor TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE INDEX IF NOT EXISTS idx_clicks_code ON clicks(code);
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY, contest_id INTEGER NOT NULL REFERENCES contests(id), name TEXT NOT NULL,
      cpf TEXT NOT NULL, phone TEXT NOT NULL, code TEXT REFERENCES links(code), source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(contest_id,cpf));
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, direction TEXT NOT NULL, phone TEXT NOT NULL, body TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    PRAGMA optimize;`);
  migrate(db);
  migrateUuids(db);
  return db;
}
