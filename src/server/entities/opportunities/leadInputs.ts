// Agent-facing lead (Opportunity) vocabularies: the offered status list + the
// event-type list the tools show the model. Domain product decisions; the
// event → status auto-cache is logOpportunityEvent.ts.

import {
  OpportunityEventType,
  OpportunityStatus,
} from "@/generated/prisma/client";

// The four lead statuses the tools offer the model.
const ACTIVE_LEAD_STATUSES = [
  OpportunityStatus.OPEN,
  OpportunityStatus.SCREENING,
  OpportunityStatus.AWAITING,
  OpportunityStatus.CLOSED,
] as const;

export const ALL_LEAD_STATUSES =
  ACTIVE_LEAD_STATUSES as readonly OpportunityStatus[] as [
    OpportunityStatus,
    ...OpportunityStatus[],
  ];

export const ALL_EVENT_TYPES = Object.values(OpportunityEventType) as [
  OpportunityEventType,
  ...OpportunityEventType[],
];
