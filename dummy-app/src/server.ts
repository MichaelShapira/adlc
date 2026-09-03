import express from "express";
import { addTodo, completeTodo, listTodos, searchTodos } from "./todos";

const app = express();
app.use(express.json());

app.get("/todos", (_req, res) => {
  res.json(listTodos());
});

app.post("/todos", (req, res) => {
  const title = req.body?.title;
  if (typeof title !== "string" || title.trim().length === 0) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  res.status(201).json(addTodo(title.trim()));
});

app.post("/todos/:id/complete", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const todo = completeTodo(id);
  if (!todo) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(todo);
});

app.get("/todos/search", (req, res) => {
  const term = String(req.query.q ?? "");
  res.json(searchTodos(term));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`todo-service listening on :${port}`);
});
