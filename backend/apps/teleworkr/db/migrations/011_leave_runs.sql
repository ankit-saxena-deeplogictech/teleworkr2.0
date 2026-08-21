-- 011_leave_runs.sql — J7 scheduled runs.
--
-- Five policy-defined recurring jobs; three are computable from the systems of
-- record today (accrual, year-end lapse, absence sweep). Every run is
-- preview-able before it executes, idempotent per period, batch-tagged on the
-- ledger, and reversible by negating its batch — never by editing balances.
-- The run itself is a record: who ran it, against which policy, how many were
-- in scope and how many were affected.

ALTER TABLE leave_ledger_entry ADD COLUMN batch_id varchar;

CREATE TABLE leave_run (
    run_id varchar primary key,
    org_id varchar not null,
    kind varchar not null,
    period varchar not null,
    status varchar not null,
    batch_id varchar,
    policy_version_id varchar,
    scope_count integer not null default 0,
    affected_count integer not null default 0,
    detail varchar,
    operator_person_id varchar not null,
    created_at integer not null,
    executed_at integer,
    reversed_at integer
);
