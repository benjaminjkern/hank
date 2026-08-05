import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient, Prisma } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Read operations are idempotent, so retrying one on a transient connection blip
// is safe. Writes are deliberately NOT retried — a timed-out insert may have
// already committed, and a retry would double-write (e.g. a duplicate TokenUsage
// row). This list is the read surface of the model delegates.
const READ_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

// Transient connection failures worth retrying. The hosting platform's proxy + a flaky
// network surface as P1008 (operation timed out) / P1017 (server closed the
// connection), or the pg driver's SocketTimeout / ECONNRESET — all of which are
// "try again" conditions, not real query errors. Retrying these keeps long
// audit sweeps from aborting mid-run on a single dropped connection.
function isTransient(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return err.code === "P1008" || err.code === "P1017";
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /SocketTimeout|ECONNRESET|Connection terminated|operation has timed out/i.test(
    msg,
  );
}

const RETRY_DELAYS_MS = [150, 300, 600];

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const base = new PrismaClient({ adapter });
  const extended = base.$extends({
    query: {
      async $allOperations({ operation, args, query }) {
        if (!READ_OPS.has(operation)) return await query(args);
        let lastErr: unknown;
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
          try {
            // eslint-disable-next-line no-await-in-loop -- a retry only happens BECAUSE the previous attempt failed
            return await query(args);
          } catch (err) {
            lastErr = err;
            if (!isTransient(err) || attempt === RETRY_DELAYS_MS.length)
              throw err;
            // eslint-disable-next-line no-await-in-loop -- backoff between retries — the whole point is to wait
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
          }
        }
        throw lastErr;
      },
    },
  });
  // The extension changes the static type but not the runtime surface — every
  // model delegate + $transaction still works. Cast back so the ~hundreds of
  // call sites typed against PrismaClient don't all need updating.
  return extended as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
