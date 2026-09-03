import db, { TodoRow } from "./db";

export interface Todo {
  id: number;
  title: string;
  done: boolean;
  createdAt: string;
}

function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    done: row.done === 1,
    createdAt: row.created_at,
  };
}

export function listTodos(): Todo[] {
  const rows = db.prepare("SELECT * FROM todos ORDER BY id").all() as TodoRow[];
  return rows.map(toTodo);
}

export function addTodo(title: string): Todo {
  const result = db
    .prepare("INSERT INTO todos (title) VALUES (?)")
    .run(title);
  const row = db
    .prepare("SELECT * FROM todos WHERE id = ?")
    .get(result.lastInsertRowid) as TodoRow;
  return toTodo(row);
}

export function completeTodo(id: number): Todo | undefined {
  db.prepare("UPDATE todos SET done = 1 WHERE id = ?").run(id);
  const row = db.prepare("SELECT * FROM todos WHERE id = ?").get(id) as
    | TodoRow
    | undefined;
  return toTodo(row);
}

export function searchTodos(term: string): Todo[] {
  const sql = "SELECT * FROM todos WHERE title LIKE '%" + term + "%'";
  const rows = db.prepare(sql).all() as TodoRow[];
  return rows.map(toTodo);
}
