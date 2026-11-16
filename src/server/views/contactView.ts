// The Prisma select behind ContactView (shared/views/contactView.ts) — a
// person, as every surface that renders one reads them.
//
// One list in two shapes: the payload type and the Prisma select. `satisfies`
// ties them together, so adding a field to ContactView is a compile error until
// the select fetches it. Because the select names exactly these columns, a
// selected row already IS a ContactView — there is no mapper to drift.

import type { ContactView } from "@/shared/views/contactView";

// Spread into any Contact select: `select: { ...CONTACT_SELECT }`.
export const CONTACT_SELECT = {
  id: true,
  name: true,
  role: true,
  agency: true,
  companyId: true,
  email: true,
  phone: true,
  linkedinUrl: true,
  channel: true,
  notes: true,
} as const satisfies Record<keyof ContactView, true>;
