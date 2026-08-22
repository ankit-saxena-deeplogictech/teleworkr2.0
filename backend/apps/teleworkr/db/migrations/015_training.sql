-- 015_training.sql — P, the training & certificates domain.
--
-- Nothing here is new machinery (P1): a versioned course definition with a
-- published pointer (A6 decision 3), an assignment edge that carries the
-- obligation's reason, an append-only progress ledger, and a certificate that
-- pins the version passed. Progress is projected over the ledger, never stored
-- (A6 decision 2).
--
-- The one decision the wireframe calls out as new is honoured here too:
-- training time is time. Completed modules write a time_entry_event with
-- category 'training', so the work lands on the timesheet (C5) and counts
-- toward contracted hours. The category column is added to the time ledger by
-- this migration for exactly that reason.
--
-- Erasure is declared per entity in entityshapes.js (P1 item 8): the course
-- definition is retained, certificates pseudonymise, the progress struggle
-- erases — only the pass survives it.

ALTER TABLE time_entry_event ADD COLUMN category varchar;

-- A course version. Immutable once published: supersession moves the pointer
-- and never edits a published version. The publisher declares, at publish,
-- what a material change does to existing certificates and enrolments.
CREATE TABLE course_version (
    course_version_id varchar not null primary key,
    org_id varchar not null,
    course_code varchar not null,
    version integer not null,
    status varchar not null default 'published',   -- draft | published | superseded | withdrawn
    title varchar not null,
    kind varchar not null default 'optional',      -- statutory | optional
    modules varchar not null,                      -- JSON: [{id, title, minutes, questions:[...]}]
    pass_mark integer,                             -- percentage; NULL = read-and-acknowledge only
    validity_years integer,                        -- certificate validity; NULL = does not expire
    jurisdictions varchar,                         -- JSON array of jurisdictions the course satisfies
    recommended_roles varchar,                     -- JSON array of role names the course is suggested for
    invalidates varchar not null default 'none',   -- none | minor | major — the publisher's choice at publish
    published_at integer,
    published_by varchar,
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_course_version ON course_version(org_id, course_code, version);

-- The published pointer: which version answers each course code today.
CREATE TABLE course_pointer (
    org_id varchar not null,
    course_code varchar not null,
    course_version_id varchar not null,
    updated_at integer not null,
    PRIMARY KEY (org_id, course_code)
);

-- An assignment edge: person × course × due date × reason. The reason matters —
-- "statutory" and "your lead suggested it" are different obligations and every
-- screen downstream must say which. Required courses are pre-enrolled; optional
-- courses enrol on start and can be abandoned without a record.
CREATE TABLE course_assignment (
    assignment_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    course_code varchar not null,
    course_version_id varchar,     -- pinned at assignment; NULL until first start
    due_date varchar,              -- ISO date; NULL for self-enrolled optional courses
    reason varchar not null,       -- statutory | policy | lead_suggested | manual | self_enrolled | course_reissued
    source_rule varchar,           -- the rule text, e.g. "statutory, India, refreshed annually"
    assigned_by varchar,
    assigned_at integer not null,
    completed_at integer,
    status varchar not null default 'assigned',    -- assigned | completed | cancelled
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_course_assignment_person ON course_assignment(org_id, person_id, status);
CREATE INDEX idx_course_assignment_code ON course_assignment(org_id, course_code, status);

-- The append-only progress ledger. "Resume where I left off" and "prove what
-- they completed in March" are the same mechanism. Save & resume IS the ledger:
-- each answer is a progress event, so resuming replays the ledger and the audit
-- trail is the same data.
CREATE TABLE course_progress_event (
    progress_event_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    course_code varchar not null,
    course_version_id varchar not null,
    assignment_id varchar,
    module_id varchar,             -- NULL for course-level events
    kind varchar not null,         -- module_started | module_completed | attempt_scored | course_passed
    payload varchar,               -- JSON: {answers, score, passed, elapsed_seconds}
    client_event_id varchar,       -- offline-sync idempotency, same contract as A8
    recorded_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_course_progress_person ON course_progress_event(org_id, person_id, course_code);
CREATE UNIQUE INDEX idx_course_progress_client ON course_progress_event(org_id, person_id, client_event_id)
    WHERE client_event_id IS NOT NULL;

-- A certificate is a record, not a file (P5): issued on pass, pinned to the
-- version passed, with an expiry. A PDF is rendered from it on demand; the
-- verification code proves a certificate exists and discloses nothing else.
CREATE TABLE certificate (
    certificate_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    course_code varchar not null,
    course_version_id varchar not null,
    issued_at integer not null,
    expires_on varchar,            -- ISO date; NULL = does not expire
    verification_code varchar not null,
    external integer not null default 0,   -- externally-earned, verified by a named person
    verified_by varchar,
    verified_at integer,
    status varchar not null default 'valid',   -- valid | expired | superseded | revoked
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_certificate_person ON certificate(org_id, person_id);
CREATE UNIQUE INDEX idx_certificate_code ON certificate(verification_code);
