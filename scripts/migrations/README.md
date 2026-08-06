# One-shot data migrations

Scripts here run **once against a real database and are then deleted.** Nothing
in `src/` may import from this folder, and nothing here is part of any harness —
if you're skimming the repo, this is the one directory you can safely ignore.

The sibling of [prisma/migrations/](../../prisma/migrations/), for the cases SQL
can't express: a conversion that needs app code (decrypting with the master key,
re-running a parser, calling a sub-agent) rather than DDL. Schema changes still
go in `prisma/migrations/` — see AGENTS.md → "Prisma schema changes".

**If it can be written as SQL, it is not one of these** — and SQL can express far
more than it looks like. Postgres has `regexp_replace`, `jsonb_array_elements`,
`DISTINCT ON`, lateral joins, and `DO $$` blocks: string munging, JSON surgery,
dedup, and conditional logic are all in reach. A transform you'd write in
TypeScript because it's *more familiar* is still a `prisma/migrations/` entry —
then `pnpm db:migrate` applies it, `_prisma_migrations` records that it ran, and
there's one chain to track instead of two plus a gate plus an apply order that
bites when you get it wrong.

**Three things force a script; nothing else does.** Reaching for a **secret**
(decrypting with the master key), calling **out of process** (an LLM, an HTTP
fetch), or re-running a **parser** that only exists as app code. If you can't
name which one applies, write the SQL.

**"It has to match a TS function exactly" is not one of them.** Define the shared
expression once as a `pg_temp` function and call it on both sides of whatever
join needs it — then the two halves can't drift, which was the worry. Validate by
running the migration inside `BEGIN … ROLLBACK` against real data and diffing the
counts before shipping.

## Every script is paired with a gate migration

Prisma has no script-based migrations — the engine executes `migration.sql` and
nothing else (`migrations` config is only `path` / `initShadowDb` / `seed`,
verified against 7.8.0), and its `seed` is one global command, not a chain
entry. So a JS-only conversion would otherwise be invisible to
`prisma migrate status`, which is how you end up with two chains to track.

The fix is to split the work from the record. **The script does the work; a
paired entry in `prisma/migrations/` asserts the work landed** and raises
otherwise, with the exact command in the error:

```sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" WHERE "anthropicKeyEncrypted" NOT LIKE 'v1.%') THEN
    RAISE EXCEPTION 'Run `pnpm tsx scripts/migrations/…-keys-to-v1.ts --apply` first…';
  END IF;
END $$;
```

Now `pnpm exec prisma migrate status` answers "is everything applied?" for both
kinds, and the migration can't silently pass on a database where the script was
never run. Write the assertion against the same predicate the script re-measures
itself with — for keys-to-v1 that's `NOT LIKE 'v1.%'` returning zero rows.

Ordering: run the script, then `pnpm db:migrate`. If you do it the other way
round the gate fails (loudly, by design) and Prisma marks that migration failed,
so the retry needs `pnpm exec prisma migrate resolve --rolled-back <name>`
first — the error message says so.

## Conventions

- **Name it `<YYYY-MM-DD>-<what-it-does>.ts`.** Dated, so the order it ran in is
  obvious and two migrations never collide.
- **Dry-run by default; `--apply` writes.** Every `db:*` command and script in
  this repo hits whatever `DATABASE_URL` points at (prod in the reference
  deployment; AGENTS.md → "Which database are you hitting?"), so a bare run must
  be read-only.
- **Self-contained.** If the migration reads a format the app no longer supports,
  reproduce that reader *inside the script* rather than keeping a compatibility
  branch alive in `src/`. That's the point of the folder: the dead code is
  quarantined in the file that gets deleted.
- **Verify before persisting, and re-measure after.** Round-trip in memory first;
  finish by re-querying the DB for the count of un-migrated rows, so "it's done"
  is measured rather than inferred from a loop counter.
- **Delete the file once it reports 0 remaining**, and add a line to the ledger
  below. The ledger is the durable record; the script isn't.

## Applied

| Date | Migration | Rows | Notes |
| --- | --- | --- | --- |
| 2026-07-27 | `2026-07-27-keys-to-v1.ts` | 1 | Provider API keys → AAD-bound `v1.` ciphertext. Gate: `20260727130000_keys_to_v1` (applied; 0 non-`v1.` rows remain). Script deleted. |
| 2026-07-30 | `2026-07-30-resume-md-to-background.ts` | 4 notes / 4 files | Two-layer `resume.md` → the single full-detail background note: framing sections move to `profile.md`, the generated summary is dropped, and every stored résumé is re-parsed and merged in. Gate: `20260730120100_resume_md_to_background` (applied). Script deleted. |
