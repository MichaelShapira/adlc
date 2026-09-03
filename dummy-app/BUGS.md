# Open Bugs

## BUG-001 — Build is broken: `npm run build` fails with TS2345

Reported by: CI
Severity: High

Running `npm run build` fails:

```
src/todos.ts: error TS2345: Argument of type 'TodoRow | undefined' is not
assignable to parameter of type 'TodoRow'.
  Type 'undefined' is not assignable to type 'TodoRow'.
```

The project no longer compiles, which blocks every deployment. The failure
was introduced with the `completeTodo` change that made the row lookup
return an optional value.

Expected: `npm run build` succeeds and `completeTodo` returns `undefined`
for a non-existent todo id (the HTTP layer already handles that case with
a 404).

## BUG-002 — SQL injection in todo search endpoint

Reported by: Security review
Severity: Critical

The `GET /todos/search?q=...` endpoint builds its SQL query by string
concatenation with the raw user-supplied search term. A crafted `q`
parameter can change the query structure (classic SQL injection), e.g.
`q=%' OR '1'='1` returns every row regardless of the search term, and
more aggressive payloads are possible.

Expected: the search term is passed to the database as a bound parameter
(parameterized query), never concatenated into the SQL string. Search
behavior for normal terms must not change.
