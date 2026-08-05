-- Add CANNOT_SCRAPE to CompanySkipReason for companies the agent can't scan
-- after exhausting the ATS hunt (Greenhouse / Lever / Ashby) and the
-- company's own careers page. Distinct from NO_MATCHING_ROLES — that's "we
-- could see the listings and nothing matched"; CANNOT_SCRAPE is "we couldn't
-- see the listings at all".
ALTER TYPE "CompanySkipReason" ADD VALUE IF NOT EXISTS 'CANNOT_SCRAPE';
