import { requireAdmin } from "@/server/auth/requireAdmin";
import { prisma } from "@/server/db/prisma";

export const dynamic = "force-dynamic";

// Hard delete a Job recommended for deletion. Cascade behavior is set on the
// schema: JobInteraction (and through it, Event) are deleted; MemoryNote loses
// its FK link but the row survives. See the
// 20260602201522_cascade_deletes_for_admin_delete migration.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  await requireAdmin();
  const { id } = await params;
  try {
    await prisma.job.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message =
      code === "P2025"
        ? "Job not found (already deleted?)"
        : code === "P2003"
          ? "Delete blocked by a foreign key constraint — check the schema cascade audit."
          : err instanceof Error
            ? err.message
            : "delete failed";
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}
