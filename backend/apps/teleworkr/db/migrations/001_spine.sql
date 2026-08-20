-- 001_spine.sql — the A6 entity spine.
--
-- Four entities everything else hangs off: org, person, employment, audit_event.
-- capability_grant joins them because L2 scopes are read on every request and
-- H4 pins the evaluated set into every audit row.
--
-- Conventions used throughout the schema:
--   * Validity periods are ISO dates (TEXT 'YYYY-MM-DD'). Employment starts on a
--     date, not a second, and J1/C6 ask date-shaped questions of it.
--   * Ledger and audit instants are unix seconds (INTEGER), as in the reference repo.
--   * valid_from is inclusive, valid_to is exclusive, NULL valid_to means open.
--   * Every table carries org_id. person is the one deliberate exception — it is
--     global, with org membership expressed as employment. See A6 open item 7b.

CREATE TABLE org (
    org_id varchar not null primary key,
    name varchar not null,
    home_jurisdiction varchar,
    created_at integer not null,
    status varchar not null default 'active'
);

-- A person is a human, not an employee. Candidates, contractors and external
-- wiki readers are all people with no employment. Global by decision, so one
-- human serving two client orgs is one person with two employments.
CREATE TABLE person (
    person_id varchar not null primary key,
    display_name varchar,
    email varchar,
    home_timezone varchar,          -- E4 seeds the working window from this; the person may override, the IdP may not
    created_at integer not null,
    pseudonymised_at integer        -- set by L3 erasure; the row survives only as a pseudonym target
);
CREATE UNIQUE INDEX idx_person_email ON person(email) WHERE email IS NOT NULL;

-- Effective-dated. Not fields on a person. J1 needs their status when the leave
-- was taken, C6 needs the jurisdiction that week, H4 needs to answer "who was
-- their approver in March" in September.
CREATE TABLE employment (
    employment_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    status varchar not null,            -- active | probation | notice | suspended | ended
    jurisdiction varchar not null,      -- drives C6 working-time rules. Not the office address.
    manager_person_id varchar,          -- approval routes for C7, J5, K3
    contract_type varchar not null,     -- employee | contractor | ... ; J2 policy scope tags read this
    contracted_pattern varchar,         -- JSON: contracted hours and days
    valid_from varchar not null,        -- ISO date, inclusive
    valid_to varchar,                   -- ISO date, exclusive; NULL = still in force
    recorded_at integer not null,       -- when we learned it, as distinct from when it took effect
    recorded_by varchar,
    source varchar not null,            -- idp | manual | migration
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_employment_asof ON employment(org_id, person_id, valid_from);
CREATE INDEX idx_employment_manager ON employment(org_id, manager_person_id);

-- An edge with its own validity, never an array on the person. A grant is a
-- capability plus a scope: "team lead" alone means nothing. Deny always wins,
-- which is why effect is a column rather than an absence.
CREATE TABLE capability_grant (
    grant_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    capability varchar not null,
    scope_type varchar not null,        -- self | direct_reports | reporting_line | team | project | location | jurisdiction | org
    scope_ref varchar,                  -- NULL for self and org
    effect varchar not null default 'allow',   -- allow | deny
    granted_by varchar,
    reason varchar,                     -- required for elevation; L2 shows it on the grant
    valid_from varchar not null,
    valid_to varchar,                   -- every elevation is time-boxed at grant, never open-ended
    source_role varchar,                -- the named bundle this came from, if any
    revoked_at integer,
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_grant_lookup ON capability_grant(org_id, person_id, capability);
CREATE INDEX idx_grant_reverse ON capability_grant(org_id, capability);

-- Append-only, seven years. Stores the effective permission set at the moment of
-- the action, not a pointer to today's — otherwise every historical entry
-- silently re-evaluates against current rules and the log becomes fiction.
CREATE TABLE audit_event (
    audit_id varchar not null primary key,
    org_id varchar not null,
    occurred_at integer not null,
    actor_person_id varchar,
    actor_kind varchar not null,        -- person | service | system
    action varchar not null,            -- object.action, past tense, lower snake (A10 naming)
    object_type varchar not null,
    object_ref varchar,
    subject_person_id varchar,          -- whom the entry is about; every person can read their own
    reason varchar,                     -- time edits and elevations carry one
    effective_permissions varchar not null,  -- JSON snapshot of the evaluated set
    detail varchar,                     -- JSON shapes and counts; never content a person typed
    retention_until varchar not null,   -- anchored to occurred_at, not to a calendar year end
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_audit_actor ON audit_event(org_id, actor_person_id, occurred_at);
CREATE INDEX idx_audit_subject ON audit_event(org_id, subject_person_id, occurred_at);
CREATE INDEX idx_audit_action ON audit_event(org_id, action, occurred_at);
