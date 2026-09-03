# todo-service

A deliberately small TypeScript + Express + SQLite todo REST API.
This repository is the target codebase for the ADLC bug-fix PoC: coding
agents clone it, fix open bugs (see `BUGS.md`), and push fix branches.

## Endpoints

- `GET /todos` — list all todos
- `POST /todos` — create a todo (`{"title": "..."}`)
- `POST /todos/:id/complete` — mark a todo done
- `GET /todos/search?q=term` — search todos by title

## Development

```bash
npm ci
npm run build   # tsc — currently FAILS, see BUG-001
npm start
```
