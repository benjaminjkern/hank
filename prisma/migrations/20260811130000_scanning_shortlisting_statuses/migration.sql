-- Two company statuses for the stretch between entering a company and
-- committing its shortlist. APPLYING used to cover all of it, which claimed the
-- user was applying somewhere while the board was still being read.
ALTER TYPE "CompanyStatus" ADD VALUE IF NOT EXISTS 'SCANNING' BEFORE 'APPLYING';
ALTER TYPE "CompanyStatus" ADD VALUE IF NOT EXISTS 'SHORTLISTING' BEFORE 'APPLYING';
