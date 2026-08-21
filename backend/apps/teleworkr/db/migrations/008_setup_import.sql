-- 008_setup_import.sql — B5 admin day one and B6 migration.
--
-- B5: the setup checklist persists as rows rather than a wizard that vanishes.
-- Steps marked by an admin override the derived state; everything else is
-- computed from the data itself, so the standing health panel cannot drift.
--
-- B6: an import is a batch with an id, provenance on every imported record, and
-- a rollback window that closes when something real has been built on it.
-- Opening balances are ledger entries, never a stored balance (A6): a single
-- dated assertion attributed to the source system, visible forever as exactly
-- what it is — a number the product did not compute.

CREATE TABLE org_setup_step (
    org_id varchar not null,
    step varchar not null,          -- org_jurisdictions | identity | import_people | leave_policy | opening_balances | working_windows | invite
    status varchar not null,        -- done | deferred | in_progress
    marked_default integer not null default 0,
    updated_at integer not null,
    updated_by varchar,
    PRIMARY KEY (org_id, step)
);

CREATE TABLE import_batch (
    import_batch_id varchar not null primary key,
    org_id varchar not null,
    kind varchar not null,          -- people | balances
    source varchar not null,        -- csv | idp | manual
    status varchar not null default 'preview',  -- preview | committed | rolled_back
    total_rows integer not null default 0,
    ok_rows integer not null default 0,
    failures varchar,               -- JSON
    warnings varchar,               -- JSON
    cutover_date varchar,
    created_at integer not null,
    created_by varchar,
    committed_at integer,
    rolled_back_at integer,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);

-- The B6 opening-balance resolution: one dated assertion per person per bucket.
CREATE TABLE opening_balance_entry (
    opening_balance_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    leave_type varchar not null,
    days real not null,
    cutover_date varchar not null,
    source varchar not null,
    note varchar,
    imported_at integer not null,
    import_batch_id varchar,
    recorded_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_opening_balance ON opening_balance_entry(org_id, person_id);

-- Provenance on every imported record (B6) and rollback linkage.
ALTER TABLE person ADD COLUMN source varchar;
ALTER TABLE person ADD COLUMN imported_at integer;
ALTER TABLE person ADD COLUMN import_batch_id varchar;
ALTER TABLE employment ADD COLUMN import_batch_id varchar;

-- Modules ship off until asked for (B5).
ALTER TABLE org ADD COLUMN modules varchar;
