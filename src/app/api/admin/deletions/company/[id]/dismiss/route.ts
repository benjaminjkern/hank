import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";

export const dynamic = "force-dynamic";

// Clear the deletion recommendation on a Company. Row survives.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireAdmin();
  const { id } = await params;
  await prisma.company.updateMany({
    where: { id },
    data: { deletionRecommendedAt: null, deletionRecommendedReason: null },
  });
  return Response.json({ ok: true });
}
