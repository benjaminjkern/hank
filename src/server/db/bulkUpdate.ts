// Write DIFFERENT values to many rows in ONE statement — the one thing Prisma
// has no API for, and the reason multi-row writes kept blowing the transaction
// timeout.
//
// The measurement that forced this (against the hosting Postgres):
//
//   50 × findFirst, sequential awaits ......... 1733 ms
//   50 × findFirst, `$transaction([...])` ..... 1971 ms   <- NOT a batch
//   50 × findFirst, Promise.all ................ 193 ms   <- capped by pool size
//   1  × findMany({where:{id:{in:[50]}}}) ....... 39 ms
//
// Two things to take from it. `$transaction([...])` reads like a batch and is
// not one: with the pg driver adapter each operation is still its own round
// trip, so it is linear in statement count (marginally worse than sequential,
// for the transaction overhead). And Promise.all is not the fix either — it is
// bounded by the connection pool, so N concurrent queries cost ceil(N/pool)
// waves, and it cannot be used inside a transaction at all (one connection).
// Only ONE STATEMENT is flat in N. That is the target for every bulk write.
//
// Prisma already reaches one statement for the uniform cases — `createMany`,
// `createManyAndReturn`, `updateMany`, `deleteMany`, `findMany({where:{in}})` —
// so those stay Prisma. This covers the case it can't express: per-row values.
//
// Kysely compiles the statement and never executes it. That is deliberate:
// executing would mean a second client on a second connection, which could not
// join the Prisma transaction the atomicity rule depends on (event insert +
// status flip must commit together). So Kysely is a typed SQL *builder* whose
// output runs through the caller's Prisma transaction, and the column names it
// checks come from Prisma's own generated model types — nothing to keep in sync.

import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";

import type {
  Company,
  CompanyEvent,
  CompanyInteraction,
  Job,
  JobEvent,
  JobInteraction,
  Opportunity,
  OpportunityEvent,
  Prisma,
} from "@/generated/prisma/client";

import { prisma } from "./prisma";

// Keys are PHYSICAL table names (what SQL sees). Since schema.prisma carries no
// @@map, those are identical to the Prisma model names.
export interface Database {
  Company: Company;
  CompanyEvent: CompanyEvent;
  CompanyInteraction: CompanyInteraction;
  Job: Job;
  JobEvent: JobEvent;
  JobInteraction: JobInteraction;
  Opportunity: Opportunity;
  OpportunityEvent: OpportunityEvent;
}

// Compiler only — DummyDriver makes "it accidentally ran a query" impossible
// rather than merely discouraged.
const qb = new Kysely<Database>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

// Anything that can run a raw statement: the Prisma client or a transaction
// handle from it. Callers inside a `$transaction` pass `tx` so the bulk write
// commits with the rest of their batch.
export type RawExecutor = Pick<
  Prisma.TransactionClient,
  "$executeRawUnsafe" | "$queryRawUnsafe"
>;

// Postgres column types, read from the catalog once per table and cached.
//
// `json_to_recordset` needs an explicit type for every column it projects, and
// hand-listing them would be a second copy of the schema that rots silently (a
// `text` where the column is an enum fails at runtime, not at build). Asking the
// database is the only version that cannot disagree with the database.
const columnTypeCache = new Map<string, Map<string, string>>();

async function columnTypes(table: string): Promise<Map<string, string>> {
  const cached = columnTypeCache.get(table);
  if (cached) return cached;
  const rows = await prisma.$queryRaw<
    Array<{ attname: string; pg_type: string }>
  >`
    SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS pg_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = ${table}
      AND a.attnum > 0
      AND NOT a.attisdropped
  `;
  const map = new Map(rows.map((r) => [r.attname, r.pg_type]));
  if (map.size === 0) throw new Error(`unknown table "${table}"`);
  columnTypeCache.set(table, map);
  return map;
}

export type BulkUpdateRow<T> = {
  // Value identifying the row to patch (matched against `keyColumn`).
  key: string;
  patch: Partial<T>;
};

// ONE statement per distinct patch SHAPE, regardless of how many rows carry it.
//
// The shape grouping is what keeps it bounded: a real batch differs in VALUES
// but agrees on which COLUMNS it sets (26 closes all write
// status/closeReason/closeNote), so it is one statement in practice.
// A caller mixing genuinely different column sets pays one statement per set —
// still not one per row.
//
// Values ride as a single json parameter and come back out through
// `json_to_recordset`, so dates, nulls and enums round-trip with no per-column
// cast at the call site.
export async function bulkUpdate<T extends keyof Database>(
  table: T,
  keyColumn: keyof Database[T] & string,
  rows: Array<BulkUpdateRow<Database[T]>>,
  executor: RawExecutor = prisma,
): Promise<void> {
  if (rows.length === 0) return;
  const types = await columnTypes(table);

  // Prisma applies `@updatedAt` in the client, so raw SQL would silently leave
  // the column stale. Stamped here rather than at every call site — the caller
  // that forgets is exactly the bug this prevents. An explicit updatedAt in the
  // patch still wins (a backfill correcting history needs to say so).
  const stampedAt = types.has("updatedAt") ? new Date() : null;
  const patched = stampedAt
    ? rows.map((r) => ({
        key: r.key,
        patch: { updatedAt: stampedAt, ...r.patch },
      }))
    : rows;

  // Grouped by which COLUMNS the patch sets. The column list is carried on the
  // group rather than re-derived from the key, so there is no delimiter to pick
  // and nothing to split back apart.
  const byShape = new Map<
    string,
    { columns: string[]; rows: Array<BulkUpdateRow<Database[T]>> }
  >();
  for (const row of patched) {
    const columns = Object.keys(row.patch).sort();
    if (columns.length === 0) continue;
    const shape = columns.join(",");
    const group = byShape.get(shape);
    if (group) group.rows.push(row);
    else byShape.set(shape, { columns, rows: [row] });
  }

  const keyType = types.get(keyColumn);
  if (!keyType) throw new Error(`${table}.${keyColumn} does not exist`);

  const statements: Array<{ sql: string; payload: string }> = [];
  for (const { columns, rows: group } of byShape.values()) {
    for (const c of columns) {
      if (!types.get(c)) throw new Error(`${table}.${c} does not exist`);
    }

    // Column names go through sql.ref/sql.table so Kysely quotes them; the TYPE
    // names come from the catalog read above, so sql.raw is safe here (they are
    // never caller-supplied).
    const recordsetColumns = sql.join(
      [
        sql`${sql.ref(keyColumn)} ${sql.raw(keyType)}`,
        ...columns.map((c) => sql`${sql.ref(c)} ${sql.raw(types.get(c)!)}`),
      ],
      sql`, `,
    );
    const assignments = sql.join(
      columns.map((c) => sql`${sql.ref(c)} = v.${sql.ref(c)}`),
      sql`, `,
    );
    const compiled = sql`
      UPDATE ${sql.table(table)} AS t
      SET ${assignments}
      FROM json_to_recordset(CAST($1 AS json)) AS v(${recordsetColumns})
      WHERE t.${sql.ref(keyColumn)} = v.${sql.ref(keyColumn)}
    `.compile(qb);
    statements.push({
      sql: compiled.sql,
      payload: JSON.stringify(
        group.map((r) => ({ [keyColumn]: r.key, ...r.patch })),
      ),
    });
  }

  for (const s of statements) {
    // eslint-disable-next-line no-await-in-loop -- one statement per distinct patch shape (normally exactly one), never per row
    await executor.$executeRawUnsafe(s.sql, s.payload);
  }
}
