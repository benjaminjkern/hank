// A person, as every surface that renders one reads them — the opportunity
// detail page and the company page, both through the shared ContactCard.
//
// One list in two shapes: the payload type and the Prisma select. `satisfies`
// ties them together, so adding a field to ContactView is a compile error until
// the select fetches it. Because the select names exactly these columns, a
// selected row already IS a ContactView — there is no mapper to drift.

export type ContactView = {
  id: string;
  name: string;
  role: string | null;
  // The agency a recruiter works for, as a plain string. `companyId` is the
  // separate case: set when the contact is in-house at a Company we track.
  agency: string | null;
  companyId: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  // How the conversation started — "LinkedIn DM", "referral via Alex".
  channel: string | null;
  notes: string | null;
};

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
