-- 028_candidate_retention.sql — K12 (slice 1): the candidate retention
-- clock, policy-versioned like leave, and the J7-shaped run that executes
-- it. One org-wide policy (no jurisdiction scope yet — the wireframe's own
-- numbers are placeholders pending a legal read, not a scoping need).

CREATE TABLE candidate_retention_policy_version (
    policy_version_id varchar not null primary key,
    org_id varchar not null,
    version integer not null,
    status varchar not null default 'published',   -- published | superseded
    no_consent_days integer not null,
    consent_days integer not null,
    withdrawn_days integer not null,
    published_at integer,
    published_by varchar,
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_candidate_retention_policy_version ON candidate_retention_policy_version(org_id, version);

-- The published pointer: one row per org, the version in force today.
CREATE TABLE candidate_retention_policy_pointer (
    org_id varchar not null primary key,
    policy_version_id varchar not null,
    updated_at integer not null
);

CREATE TABLE candidate_retention_run (
    run_id varchar not null primary key,
    org_id varchar not null,
    policy_version_id varchar not null,
    operator_person_id varchar not null,
    erased_count integer not null default 0,
    detail varchar,
    created_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
