-- 018_recruitment_scheduling.sql — K6, panel scheduling across timezones.
--
-- Scheduling is the slowest step in most hiring processes, and it is slow
-- because nobody can see when four people in three timezones are free at
-- once. This product already holds that answer — declared working windows
-- (E4), the overlap projection (E3) and approved leave (J6) — so K6 adds no
-- availability model of its own. It adds the one thing none of those hold:
-- the panel itself, a record that a round will be (or was) held at a time,
-- with named interviewers.
--
-- A panel is not a stage transition. Scheduling one does not move a round;
-- only the engine's six transitions do that. Two consequences are handled in
-- lib/recruitment.js rather than here: rescheduling a panel ALSO writes the
-- `rescheduled` transition K1 already defines ("keeps the round, resets its
-- SLA") — the same real-world event, recorded once — and cancelling a panel
-- meeting is NOT the `cancelled` transition, which removes the round itself.
--
-- A completed panel writes one non-billable time entry per interviewer, in
-- the same transaction — interviewing is work, and the same discipline as
-- training's "training time is time" (P1 item 5).
--
-- The candidate gains a timezone and free-text availability. There is no
-- candidate portal yet (K9), so these are entered on the candidate's behalf;
-- the wireframe's "offer three slots, the candidate picks" waits for K9.
--
-- Erasure is declared in entityshapes.js: panel_assignment follows
-- application — erase, 6 months, anchored to the requisition closing.

ALTER TABLE candidate ADD COLUMN timezone varchar;              -- IANA zone, validated on write
ALTER TABLE candidate ADD COLUMN availability_notes varchar;    -- what the candidate said works for them

-- One scheduled interview for one round of one application. The round must
-- be open when the panel is scheduled; the times are absolute (unix
-- seconds), so no timezone is needed to interpret them — timezone_base only
-- records which zone the scheduler was looking at.
CREATE TABLE panel_assignment (
    panel_assignment_id varchar not null primary key,
    org_id varchar not null,
    application_id varchar not null,
    round_id varchar not null,
    interviewer_person_ids varchar not null,   -- JSON: [person_id, ...]
    scheduled_start integer not null,          -- unix seconds
    scheduled_end integer not null,            -- unix seconds
    timezone_base varchar,                     -- informational: the zone the slot was chosen in
    status varchar not null default 'scheduled',   -- scheduled | completed | cancelled | no_show
    reason varchar,                            -- reschedule, cancellation or no-show reason
    scheduled_by varchar not null,
    created_at integer not null,
    completed_at integer,
    client_event_id varchar,                   -- offline-sync idempotency, same contract as A8
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_panel_assignment_application ON panel_assignment(org_id, application_id);
CREATE INDEX idx_panel_assignment_start ON panel_assignment(org_id, scheduled_start);
CREATE UNIQUE INDEX idx_panel_assignment_client ON panel_assignment(org_id, client_event_id)
    WHERE client_event_id IS NOT NULL;
