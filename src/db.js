// db.js — single shared SQLite connection
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'degen.db');

let _db = null;
export function db() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('busy_timeout = 5000');
  console.log(`[db] opened ${DB_PATH}`);
  return _db;
}

export function close() {
  if (_db) { _db.close(); _db = null; }
}
