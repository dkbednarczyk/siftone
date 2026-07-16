# Siftone Monorepo

Siftone is a Bun workspace with `server/`, `cli/`, and `packages/contracts/`.

Read the global README.md for an understanding of the global project scope before continuing with any implementation.

## General

- Keep changes scoped to one workspace unless a shared API contract requires coordination.
- The server must never mutate source music trees. It may write only its generated-library, cache, staging, state, and backup roots.
- `packages/contracts/` contains only shared schemas/types; do not put platform adapters, filesystem access, database access, or business logic there.
- Do not add playback, tag editing, Beets integration, or Electron APIs.

## Pre-release evolution

Until Siftone has a real point release used beyond this repository, favor a better design over backward compatibility. State formats, database schemas, configuration, and internal contracts may change freely; do not add compatibility layers or migrations unless explicitly requested.

## Code Style

**Always use braces, even for single-line for loops or if statements.**
Why? To prevent the following kinds of mistakes:

```ts
while (condition) 
    if (something)
        do_that();
```

Strive to write code like this:

```ts
while (condition) {
    if (something) {
        do_that();
    }
}
```

**Blocks of variable declarations require whitespace before/after them.**

**Control flow keywords like `continue` or `return` always require a newline before them.**