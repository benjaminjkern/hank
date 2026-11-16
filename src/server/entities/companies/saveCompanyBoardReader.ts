// Save a learned board reader for a company's board, and point the company at
// it. The reader itself is a board-level fact owned by platform/scrape; what
// makes it THIS company's is the `Company.boardReaderId` link, written here so
// no caller can save a reader and forget to attach it.

import { prisma } from "@/server/db/prisma";
import { saveBoardReader } from "@/server/platform/scrape/recipe/recordReaderRun";

export async function saveCompanyBoardReader(
  args: Omit<Parameters<typeof saveBoardReader>[0], "companyName"> & {
    companyId: string;
  },
): Promise<string | null> {
  const { companyId, ...reader } = args;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { name: true },
  });
  const readerId = await saveBoardReader({
    ...reader,
    companyName: company?.name ?? "",
  });
  if (readerId) {
    await prisma.company.update({
      where: { id: companyId },
      data: { boardReaderId: readerId },
    });
  }
  return readerId;
}
