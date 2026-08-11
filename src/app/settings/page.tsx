import { getCurrentUser } from "@/server/auth/currentUser";
import { prisma } from "@/server/db/prisma";
import {
  allowUserApiKeys,
  hasServerKeyAccess,
} from "@/server/platform/deployment";

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
  // The effective answer, matching what the key resolvers will actually do —
  // the raw column alone would tell a user they have no access on an instance
  // that shares its key with everyone.
  const serverKey = hasServerKeyAccess(row.canUseServerKey);
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
        canUseServerKey: serverKey,
      }}
      deepseekKey={{
        hint: row.deepseekKeyHint,
        updatedAt: row.deepseekKeyUpdatedAt
          ? row.deepseekKeyUpdatedAt.toISOString()
          : null,
        canUseServerKey: serverKey,
      }}
      allowUserApiKeys={allowUserApiKeys}
    />
  );
}
