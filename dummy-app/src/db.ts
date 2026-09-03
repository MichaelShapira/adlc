import Database from "better-sqlite3";

export interface TodoRow {
  id: number;
  title: string;
  done: number;
  created_at: string;
}

const db = new Database(process.env.DB_PATH ?? "todos.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export default db;
