-- Optional logo override on Company. When set, the UI uses this URL
-- directly; when null, [src/lib/companyLogo.ts] derives one from sourceUrl
-- (Google favicon of `{ats-slug}.com`). The derivation is wrong for
-- companies whose ATS slug doesn't match their real domain (Cognition Labs
-- on Ashby slug "cognition" → cognition.com favicon, not theirs). Agent
-- sets this via update_company_url when the user reports the wrong logo.

ALTER TABLE "Company" ADD COLUMN "logoUrl" TEXT;
