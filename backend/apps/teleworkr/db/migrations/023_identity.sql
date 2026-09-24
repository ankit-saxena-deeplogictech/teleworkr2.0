-- 023_identity.sql — L1, identity provisioning status, mover sync & MFA policy.
--
-- Provisioning and mover-sync already had their engine (identity.js, since
-- 001_spine.sql/004_person_provisioning.sql) — this migration adds only what
-- was genuinely missing: a declared MFA-policy-per-role-tier record. This app
-- has exactly one real identity path (the JWT verify against tkmlogin_api)
-- and does not enforce MFA itself — the IdP does — so this is a governance
-- record HR/admin can see and edit, same treatment as signal_definition,
-- not a live control.

CREATE TABLE identity_mfa_policy (
    org_id varchar not null,
    role_tier varchar not null,       -- standard | elevated | critical
    strength varchar not null,        -- idp_enforced | phishing_resistant | hardware_key
    updated_at integer not null,
    updated_by varchar,
    PRIMARY KEY (org_id, role_tier)
);
