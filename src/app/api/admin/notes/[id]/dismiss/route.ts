import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireAdmin();
  const { id } = await params;
  await prisma.adminNote.updateMany({
    where: { id },
    data: { dismissed: true },
  });
  return Response.json({ ok: true });
}
