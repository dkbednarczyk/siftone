# Siftone Monorepo

Siftone is a Bun workspace with `server/`, `desktop/`, `cli/`, and `packages/contracts/`.

Read the global README.md for an understanding of the global project scope before continuing with any implementation.

## General

- Keep changes scoped to one workspace unless a shared API contract requires coordination.
- The server must never mutate source music trees. It may write only its generated-library, cache, staging, state, and backup roots.
- `packages/contracts/` contains only shared schemas/types; do not put platform adapters, filesystem access, database access, or business logic there.
- Do not add playback, tag editing, Beets integration, or Electron APIs.

## Desktop only

`desktop/` is an Electrobun + Svelte application. Electrobun is **not** Electron.

- Main process imports from `electrobun/bun`.
- Renderer imports from `electrobun/view`.
- Bundled view URLs use `views://` and must be configured in `desktop/electrobun.config.ts`.

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
