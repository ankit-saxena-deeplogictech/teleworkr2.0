-- 009_leave.sql — J1/J3 the leave system of record.
--
-- The policy is a versioned, effective-dated record with a published pointer
-- (A6). Versions are immutable: supersession moves the pointer, it never edits
-- a published version, and every evaluated record pins the version that produced
-- it.
--
-- The ledger is append-only. Accruals, deductions, lapses and adjustments are
-- entries stamped with their policy version; the balance is projected over them,
-- never stored. Opening balances from B6 join the same projection.
--
-- leave_request pins its evaluation — the policy version, the rule outcomes and
-- the deduction working — so a republished policy never silently re-evaluates a
-- past request.

CREATE TABLE leave_policy_version (
    policy_version_id varchar not null primary key,
    org_id varchar not null,
    version integer not null,
    scope varchar not null,             -- JSON tags: jurisdiction, contract_type, status
    status varchar not null default 'draft',   -- draft | published | superseded
    effective_from varchar not null,    -- ISO date
    policy varchar not null,            -- the full policy document (JSON), the primitives are the schema
    published_at integer,
    published_by varchar,
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_leave_policy_version ON leave_policy_version(org_id, version);

-- The published pointer: which version answers each scope key today.
CREATE TABLE leave_policy_pointer (
    org_id varchar not null,
    scope_key varchar not null,         -- jurisdiction, or jurisdiction|contract|status
    policy_version_id varchar not null,
    updated_at integer not null,
    PRIMARY KEY (org_id, scope_key)
);

CREATE TABLE leave_ledger_entry (
    leave_ledger_entry_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    leave_type varchar not null,
    days real not null,                 -- positive accrues, negative deducts
    kind varchar not null,              -- accrual | deduction | lapse | adjustment | opening
    entry_date varchar not null,        -- ISO date the entry is effective on
    policy_version_id varchar,          -- pinned: the version that produced this entry
    reason varchar,
    source_request_id varchar,
    recorded_at integer not null,
    recorded_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_leave_ledger_person ON leave_ledger_entry(org_id, person_id, leave_type);

CREATE TABLE leave_request (
    leave_request_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    leave_type varchar not null,
    from_date varchar not null,
    to_date varchar not null,
    days_requested real not null,
    days_deducted real,
    status varchar not null default 'draft',    -- draft | pending | approved | declined | cancelled
    policy_version_id varchar,          -- pinned at evaluation
    evaluation varchar,                 -- JSON: the engine's working, rules, warnings
    notice_days integer,
    fields varchar,                     -- JSON: type-declared fields
    reason varchar,
    created_at integer not null,
    submitted_at integer,
    decided_by varchar,
    decided_at integer,
    decision_reason varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_leave_request_person ON leave_request(org_id, person_id);
