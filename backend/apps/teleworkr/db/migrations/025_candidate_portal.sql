-- 025_candidate_portal.sql — K9, the candidate portal.
--
-- withdrawn_at/withdrawn_reason are deliberately not a stage_transition
-- kind: withdrawal is an out-of-band candidate decision, not a workflow
-- round decision, and can happen regardless of which round is "legal" to
-- transition next. _projectAsync (lib/recruitment.js) short-circuits on
-- these two columns; legalActionsAsync already refuses every further
-- transition once projected.terminal is set, so that one change is
-- enough to make withdrawal correct everywhere the engine is consulted.
--
-- candidate_portal_link is wiki_share_link's exact shape (token,
-- created_at/by, revoked_at/by) — reused deliberately, not reinvented —
-- except long-lived by design: a hiring process runs for weeks, not a
-- 14-day share, so there is no expires_at; revocation is the only way a
-- link stops working.

ALTER TABLE application ADD COLUMN withdrawn_at integer;
ALTER TABLE application ADD COLUMN withdrawn_reason varchar;

ALTER TABLE candidate ADD COLUMN consent_retain integer;        -- 0|1 — the one real hook K12 builds on
ALTER TABLE candidate ADD COLUMN consent_retain_at integer;

-- The wireframe's own rule: "rescheduling is self-service, twice, before
-- it needs a conversation." Counted per panel, not per application.
ALTER TABLE panel_assignment ADD COLUMN candidate_reschedule_count integer not null default 0;

CREATE TABLE candidate_portal_link (
    link_id varchar not null primary key,
    org_id varchar not null,
    application_id varchar not null,
    token varchar not null,
    created_at integer not null,
    created_by varchar not null,
    revoked_at integer,
    revoked_by varchar,
    last_used_at integer,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_portal_link_token ON candidate_portal_link(token);
CREATE INDEX idx_portal_link_application ON candidate_portal_link(org_id, application_id);
