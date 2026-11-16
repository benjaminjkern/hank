// A person, as every surface that renders one reads them — the opportunity
// detail page and the company page, both through the shared ContactCard. The
// Prisma select that fetches exactly these columns is CONTACT_SELECT in
// server/views/contactView.ts.

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
