-- Inbound opportunities & contacts.
-- Adds two user-scoped entities (Contact, Opportunity) plus an OpportunityEvent
-- timeline and a join table for the M:M between contacts and opportunities.
-- ChatSession gains a third sticky-focus slot (focusedOpportunityId) so the
-- agent can `set_focus` on an opportunity the same way it does for company/job.

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('INBOUND', 'SCREENING', 'AWAITING', 'CONVERTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "OpportunityEventType" AS ENUM ('INBOUND_RECEIVED', 'CALL_SCHEDULED', 'CALL_HAPPENED', 'NEXT_STEP_RECEIVED', 'STATUS_CHANGED', 'CONVERTED', 'CLOSED', 'NOTE');

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "agency" TEXT,
    "companyId" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "linkedinUrl" TEXT,
    "channel" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'INBOUND',
    "companyId" TEXT,
    "convertedJobInteractionId" TEXT,
    "primaryContactId" TEXT,
    "nextStepAt" TIMESTAMP(3),
    "notes" TEXT,
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpportunityContact" (
    "opportunityId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityContact_pkey" PRIMARY KEY ("opportunityId","contactId")
);

-- CreateTable
CREATE TABLE "OpportunityEvent" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "type" "OpportunityEventType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "source" "EventSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityEvent_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ChatSession" ADD COLUMN "focusedOpportunityId" TEXT;

-- CreateIndex
CREATE INDEX "Contact_userId_name_idx" ON "Contact"("userId", "name");

-- CreateIndex
CREATE INDEX "Contact_companyId_idx" ON "Contact"("companyId");

-- CreateIndex
CREATE INDEX "Opportunity_userId_status_idx" ON "Opportunity"("userId", "status");

-- CreateIndex
CREATE INDEX "Opportunity_userId_nextStepAt_idx" ON "Opportunity"("userId", "nextStepAt");

-- CreateIndex
CREATE INDEX "OpportunityContact_contactId_idx" ON "OpportunityContact"("contactId");

-- CreateIndex
CREATE INDEX "OpportunityEvent_opportunityId_occurredAt_idx" ON "OpportunityEvent"("opportunityId", "occurredAt");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_convertedJobInteractionId_fkey" FOREIGN KEY ("convertedJobInteractionId") REFERENCES "JobInteraction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_primaryContactId_fkey" FOREIGN KEY ("primaryContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityContact" ADD CONSTRAINT "OpportunityContact_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityContact" ADD CONSTRAINT "OpportunityContact_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpportunityEvent" ADD CONSTRAINT "OpportunityEvent_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
