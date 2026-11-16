// Advancement presentation: the color, tooltip summary, and day-list lines for
// each advancement category.

import type {
  Advancement,
  AdvancementCategory,
} from "@/server/views/analytics";

import type { DefaultTheme } from "styled-components";

export function categoryColor(
  theme: DefaultTheme,
  c: AdvancementCategory,
): string {
  switch (c) {
    case "APPLIED":
      return theme.colors.accent;
    case "RESPONDED":
      return theme.colors.watching;
    case "INTERVIEW":
      return theme.colors.resting;
    case "OFFER":
      return theme.colors.agingYellow;
    case "REJECTED":
      return theme.colors.closed;
  }
}

// Tooltip summary: a day's advancements grouped by CATEGORY (not company).
export function categorySummary(items: Advancement[]): string {
  const counts = {
    APPLIED: 0,
    RESPONDED: 0,
    INTERVIEW: 0,
    OFFER: 0,
    REJECTED: 0,
  } as Record<AdvancementCategory, number>;
  for (const a of items) counts[a.type]++;
  const parts: string[] = [];
  if (counts.APPLIED) parts.push(`${counts.APPLIED} applied`);
  if (counts.RESPONDED)
    parts.push(
      `${counts.RESPONDED} response${counts.RESPONDED > 1 ? "s" : ""}`,
    );
  if (counts.INTERVIEW)
    parts.push(
      `${counts.INTERVIEW} interview${counts.INTERVIEW > 1 ? "s" : ""}`,
    );
  if (counts.OFFER)
    parts.push(`${counts.OFFER} offer${counts.OFFER > 1 ? "s" : ""}`);
  if (counts.REJECTED)
    parts.push(`${counts.REJECTED} rejection${counts.REJECTED > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

// One list line = a (category, company) group → lead text + (clickable) company.
type LineGroup = {
  cat: AdvancementCategory;
  company: string | null;
  companyId: string | null;
  lead: string;
};

function lineLead(
  cat: AdvancementCategory,
  hasCompany: boolean,
  count: number,
): string {
  switch (cat) {
    case "APPLIED":
      if (hasCompany)
        return count > 1
          ? `Applied to ${count} roles at `
          : "Applied to a role at ";
      return count > 1 ? `Applied to ${count} roles` : "Applied to a role";
    case "RESPONDED":
      return hasCompany ? "Heard back from " : "Heard back";
    case "INTERVIEW":
      if (hasCompany)
        return count > 1 ? `${count} interviews at ` : "Interview at ";
      return count > 1 ? `${count} interviews` : "Interview";
    case "OFFER":
      return hasCompany ? "Offer from " : "Offer";
    case "REJECTED":
      if (hasCompany)
        return count > 1 ? `${count} rejections from ` : "Rejected by ";
      return count > 1 ? `${count} rejections` : "Rejected";
  }
}

const CATEGORY_ORDER: AdvancementCategory[] = [
  "OFFER",
  "INTERVIEW",
  "RESPONDED",
  "APPLIED",
  "REJECTED",
];

export function groupDay(items: Advancement[]): LineGroup[] {
  const map = new Map<
    string,
    {
      cat: AdvancementCategory;
      company: string | null;
      companyId: string | null;
      count: number;
    }
  >();
  for (const a of items) {
    const key = `${a.type}|${a.companyId ?? a.company ?? ""}`;
    const ex = map.get(key);
    if (ex) ex.count++;
    else
      map.set(key, {
        cat: a.type,
        company: a.company,
        companyId: a.companyId,
        count: 1,
      });
  }
  return [...map.values()]
    .sort(
      (a, b) => CATEGORY_ORDER.indexOf(a.cat) - CATEGORY_ORDER.indexOf(b.cat),
    )
    .map((g) => ({
      cat: g.cat,
      company: g.company,
      companyId: g.companyId,
      lead: lineLead(g.cat, !!g.company, g.count),
    }));
}
