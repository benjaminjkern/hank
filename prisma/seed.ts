import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

// Seeds the admin user. On fresh DBs, creates them with `isAdmin: true`. On a
// DB that already has a row matching SEED_ADMIN_EMAIL, just promotes them.
// SEED_ADMIN_ID is optional and only honored on `create` — useful when you
// want to pin a specific User.id (e.g. migrating from a non-cuid seed).
async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  if (!email) {
    throw new Error("SEED_ADMIN_EMAIL env var required to seed.");
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (!existing.isAdmin) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          isAdmin: true,
          emailVerified: existing.emailVerified ?? new Date(),
        },
      });
    }
    console.log(`✓ admin user ${existing.id} (${email})`);
    return;
  }

  const created = await prisma.user.create({
    data: {
      id: process.env.SEED_ADMIN_ID,
      email,
      emailVerified: new Date(),
      isAdmin: true,
    },
  });
  console.log(`✓ seeded admin user ${created.id} (${email})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
