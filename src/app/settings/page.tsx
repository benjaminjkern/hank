import { getCurrentUser } from "@/server/auth/currentUser";
import { prisma } from "@/server/db/prisma";

import { SettingsView } from "./SettingsView";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getCurrentUser();
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: {
      anthropicKeyHint: true,
      anthropicKeyUpdatedAt: true,
      canUseServerKey: true,
      deepseekKeyHint: true,
      deepseekKeyUpdatedAt: true,
    },
  });
  return (
    <SettingsView
      identity={{
        name: user.name,
        email: user.email,
        image: user.image,
      }}
      anthropicKey={{
        hint: row.anthropicKeyHint,
        updatedAt: row.anthropicKeyUpdatedAt
          ? row.anthropicKeyUpdatedAt.toISOString()
          : null,
        canUseServerKey: row.canUseServerKey,
      }}
      deepseekKey={{
        hint: row.deepseekKeyHint,
        updatedAt: row.deepseekKeyUpdatedAt
          ? row.deepseekKeyUpdatedAt.toISOString()
          : null,
        canUseServerKey: row.canUseServerKey,
      }}
    />
  );
}
