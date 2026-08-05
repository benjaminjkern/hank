"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";

export async function setCanUseServerKey(formData: FormData): Promise<void> {
  await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const enabled = formData.get("enabled") === "true";
  if (!userId) return;
  await prisma.user.update({
    where: { id: userId },
    data: { canUseServerKey: enabled },
  });
  revalidatePath("/admin/users");
}
