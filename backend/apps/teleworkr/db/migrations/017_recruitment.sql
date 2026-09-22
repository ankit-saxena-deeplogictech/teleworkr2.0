-- 017_recruitment.sql — K, the recruitment domain, Phase 1: the pipeline core.
--
-- Same architecture as leave, deliberately (K1): a versioned workflow
-- definition with a published pointer (A6 decision 3), an append-only
-- candidate event log, and status projected over that log — never stored.
-- The projection is the harder half: unlike a linear leave-request status,
-- a workflow's rounds can run in parallel and can be conditional on an
-- earlier round's score, so "where is this candidate now" is computed by
-- walking a small graph, not reading a column.
--
-- A candidate is pinned to the workflow version they applied under (K1 item
-- 4) — that pin lives on `application`, not on `requisition`, because a
-- requisition can outlive several workflow republishes while any one
-- candidate must keep the process they were told about.
--
-- Phase 1 deliberately narrows K's full ambition (see lib/recruitment.js's
-- header for the complete list): one approval step rather than a band/cost
-- matrix, no job-description/posting-channel tracking, no round-type
-- library (round_type is a plain tag), no drag-reorder (sequence is an
-- explicit integer), no resume/document storage beyond a text reference.
--
-- Erasure is declared in entityshapes.js. `application` and `stage_transition`
-- were already declared there (K12 anticipated them) — erase after 6 months,
-- anchored to the requisition closing. `candidate` follows the same shape:
-- personal data about someone with no employment relationship, which is why
-- it is its own entity rather than a reuse of `person`/`employment`.

-- A workflow version. Immutable once published: supersession moves the
-- pointer and never edits a published version. `rounds` is the graph the
-- engine walks — JSON: [{id, title, round_type, sequence, parallel_group,
-- condition: {round_id, operator, value} | null, owner_role, sla_days,
-- optional, skip_role, scorecard_criteria: [{id, label, description}]}].
-- A round with scorecard_criteria requires a submitted scorecard before it
-- can be passed; an empty list means the round advances on the transition
-- alone (K1 item 6 — "pass requires a submitted scorecard" only bites where
-- there is something to evaluate).
CREATE TABLE workflow_version (
    workflow_version_id varchar not null primary key,
    org_id varchar not null,
    workflow_code varchar not null,
    version integer not null,
    status varchar not null default 'published',   -- published | superseded | archived
    title varchar not null,
    job_family varchar,             -- e.g. "Engineering" — what this is the default for
    rounds varchar not null,        -- JSON, see above
    published_at integer,
    published_by varchar,
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_workflow_version ON workflow_version(org_id, workflow_code, version);

-- The published pointer per workflow code.
CREATE TABLE workflow_pointer (
    org_id varchar not null,
    workflow_code varchar not null,
    workflow_version_id varchar not null,
    updated_at integer not null,
    PRIMARY KEY (org_id, workflow_code)
);

-- A requisition: headcount, band and the workflow chosen up front. The
-- workflow version is pinned here too, so a requisition raised against v3
-- keeps offering v3 to new applicants until someone deliberately re-pins it
-- by raising a fresh requisition — republishing the workflow does not
-- silently change what an open requisition hands out.
CREATE TABLE requisition (
    requisition_id varchar not null primary key,
    org_id varchar not null,
    title varchar not null,
    team varchar,
    positions integer not null default 1,
    req_type varchar not null default 'new',        -- new | backfill
    location varchar,
    employment_type varchar,
    band varchar,
    target_start varchar,           -- ISO date
    workflow_code varchar not null,
    workflow_version_id varchar not null,
    status varchar not null default 'pending_approval',  -- pending_approval | approved | cancelled
    raised_by varchar not null,
    approved_at integer,
    approved_by varchar,
    cancelled_at integer,
    cancelled_reason varchar,
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_requisition_org ON requisition(org_id, status);

-- A candidate. Deliberately not `person`/`employment` — K12 is explicit that
-- candidate data is personal data about someone with no employment
-- relationship, and reusing the employee shape would conflate two different
-- retention regimes. `referrer_person_id` is an employee, so it does
-- reference `person`.
CREATE TABLE candidate (
    candidate_id varchar not null primary key,
    org_id varchar not null,
    full_name varchar not null,
    email varchar not null,
    phone varchar,
    source varchar not null default 'other',   -- referral | job_board | careers_page | internal | other
    referrer_person_id varchar,
    resume_ref varchar,             -- a link/reference; no attachment storage in Phase 1
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_candidate_org_email ON candidate(org_id, email);

-- candidate × requisition. Shape and erasure already declared in
-- entityshapes.js (EDGE, erase after 6 months, anchored to the requisition
-- closing). No status column — status is projected from stage_transition,
-- exactly as course progress and survey responses already are elsewhere in
-- this schema. workflow_version_id pins K1 item 4's rule.
CREATE TABLE application (
    application_id varchar not null primary key,
    org_id varchar not null,
    candidate_id varchar not null,
    requisition_id varchar not null,
    workflow_version_id varchar not null,
    applied_at integer not null,
    applied_via varchar,            -- the source channel, echoing candidate.source at apply time
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_application_requisition ON application(org_id, requisition_id);
CREATE INDEX idx_application_candidate ON application(org_id, candidate_id);

-- The append-only candidate event log (K1 item 3). Every advance, reject,
-- hold, skip, reschedule and cancel — with actor, reason and enough detail
-- to answer an unfair-process challenge months later (K5 item "activity").
-- Shape and erasure already declared in entityshapes.js.
CREATE TABLE stage_transition (
    stage_transition_id varchar not null primary key,
    org_id varchar not null,
    application_id varchar not null,
    round_id varchar not null,       -- the round id within the pinned workflow_version.rounds
    kind varchar not null,           -- advanced | rejected | held | skipped | rescheduled | cancelled
    reason varchar,
    review_date varchar,             -- ISO date; hold only — K4 item 4, hold without one is how pipelines rot
    detail varchar,                  -- JSON, kind-specific
    actor_person_id varchar not null,
    occurred_at integer not null,
    client_event_id varchar,         -- offline-sync idempotency, same contract as A8
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_stage_transition_application ON stage_transition(org_id, application_id, occurred_at);
CREATE UNIQUE INDEX idx_stage_transition_client ON stage_transition(org_id, client_event_id)
    WHERE client_event_id IS NOT NULL;

-- One interviewer's evaluation of one candidate in one round. Locked once
-- submitted — "invisible until submitted" (K7 item 3) is enforced by the
-- engine never surfacing another interviewer's row until the actor's own is
-- in, not by anything at this table's level.
CREATE TABLE scorecard (
    scorecard_id varchar not null primary key,
    org_id varchar not null,
    application_id varchar not null,
    round_id varchar not null,
    interviewer_person_id varchar not null,
    criteria_ratings varchar not null,   -- JSON: [{criterion_id, rating}]
    evidence varchar,
    recommendation varchar not null,     -- strong_no | no | lean_yes | yes | strong_yes
    submitted_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_scorecard_one_per_interviewer
    ON scorecard(org_id, application_id, round_id, interviewer_person_id);
CREATE INDEX idx_scorecard_application ON scorecard(org_id, application_id);
