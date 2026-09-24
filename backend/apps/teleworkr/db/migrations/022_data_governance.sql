-- 022_data_governance.sql — L3, data export, retention & erasure.
--
-- The pseudonymisation design was already settled before this module
-- existed: person.pseudonymised_at, declared in 001_spine.sql, "set by L3
-- erasure; the row survives only as a pseudonym target." Erasure clears
-- the person row's PII fields and sets that column — it never deletes the
-- row, which is what lets every other table's person_id keep resolving.
-- That single fact is why the thirteen PSEUDONYMISE-declared entities in
-- entityshapes.js's register (employment, time_entry_event,
-- leave_ledger_entry, certificate, and so on) need no table of their own
-- here and no per-row action at execution time: they already point at the
-- person_id that erasure alone renders anonymous.
--
-- Scoped to employee erasure, not candidate erasure — entityshapes.js's
-- own note on `candidate` already says K12 is "a later refinement of this
-- baseline" with its own consent model, so K's candidate-side entities are
-- deliberately outside what executeErasureAsync touches.

CREATE TABLE legal_hold (
    hold_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    entity varchar,                 -- NULL = blocks every curated entity for this person
    reason varchar not null,
    owner_person_id varchar not null,   -- named contact the erasure preview shows the requester
    placed_at integer not null,
    placed_by varchar not null,
    released_at integer,
    released_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_legal_hold_person ON legal_hold(org_id, person_id, released_at);

-- The DPO queue. "A queue without a deadline column is a queue that
-- misses deadlines" — due_date is not optional.
CREATE TABLE data_request (
    request_id varchar not null primary key,
    org_id varchar not null,
    request_type varchar not null,      -- access | erasure | rectification
    subject_person_id varchar not null,
    requested_by varchar,
    status varchar not null default 'open',   -- open | completed | blocked
    due_date varchar not null,
    notes varchar,
    created_at integer not null,
    created_by varchar,
    completed_at integer,
    completed_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_data_request_status ON data_request(org_id, status, due_date);

-- One row per executed erasure — the operator's name, what was erased,
-- pseudonymised and blocked, and why. The wireframe's own "irreversible,
-- logged with the operator's name" requirement, as a durable record.
CREATE TABLE erasure_run (
    erasure_run_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    operator_person_id varchar not null,
    reason varchar not null,
    executed_at integer not null,
    erased varchar not null,            -- JSON [{entity, count}]
    pseudonymised varchar not null,     -- JSON [{entity, count}]
    blocked varchar not null,           -- JSON [{entity, count, reason}]
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
