"use client";

// The client half of the widget registry: WidgetKind → React component. Kept
// SEPARATE from registry/index.ts because these components are "use client" +
// styled-components — importing them into the server (session.ts) or the node
// QA harness would drag React into those bundles. The def (index.ts) and the
// component (here) still live in the SAME registry/<kind>/ folder, so a widget
// is one folder; only the assembly splits on the client boundary.
//
// `satisfies Record<WidgetKind, ComponentType<never>>` gives the same
// exhaustiveness guarantee as WIDGET_DEFS: a new kind won't compile until it
// has a component here. `never` is the lint-clean base every component is
// assignable to regardless of its props (they differ — shortlist takes a
// toolUseId); props stay strict at each component definition and at the single
// call site in ../index.tsx.

import type { WidgetKind } from "@/lib/widgetKinds";

import { AddMoreCompaniesWidget } from "./addMoreCompanies/Widget";
import { CompanyDisambiguationWidget } from "./companyDisambiguation/Widget";
import { ConfirmApplicationSubmitWidget } from "./confirmApplicationSubmit/Widget";
import { ConfirmReviveCompanyWidget } from "./confirmReviveCompany/Widget";
import { NextCompanyPickerWidget } from "./nextCompanyPicker/Widget";
import { NextJobPickerWidget } from "./nextJobPicker/Widget";
import { ShortlistProposalWidget } from "./shortlistProposal/Widget";
import { ShortlistRegenGateWidget } from "./shortlistRegenGate/Widget";
import { ShortlistScanGateWidget } from "./shortlistScanGate/Widget";

import type { ComponentType } from "react";

export const WIDGET_COMPONENTS = {
  shortlist_proposal: ShortlistProposalWidget,
  company_checklist: () => null,
  add_more_companies: AddMoreCompaniesWidget,
  company_disambiguation: CompanyDisambiguationWidget,
  confirm_revive_company: ConfirmReviveCompanyWidget,
  confirm_application_submit: ConfirmApplicationSubmitWidget,
  next_company_picker: NextCompanyPickerWidget,
  next_job_picker: NextJobPickerWidget,
  shortlist_scan_gate: ShortlistScanGateWidget,
  shortlist_regen_gate: ShortlistRegenGateWidget,
} satisfies Record<WidgetKind, ComponentType<never>>;
