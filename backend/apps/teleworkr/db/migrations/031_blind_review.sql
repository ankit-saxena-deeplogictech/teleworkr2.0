-- 031_blind_review.sql — K12 slice 4: blind review, per requisition.
-- Name/email/phone/resume_ref are redacted in candidateRecordAsync and
-- pipelineBoardAsync while the requisition's resume_review round is still
-- unresolved — see lib/recruitment.js for the redaction itself.

ALTER TABLE requisition ADD COLUMN blind_review integer not null default 0;
