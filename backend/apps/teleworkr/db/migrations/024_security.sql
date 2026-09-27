-- 024_security.sql — L4, sessions/devices & incidents.
--
-- No geo-location, no MDM, no real token revocation, no outbound SIEM
-- webhooks, no per-scope API keys: none of that exists anywhere in this
-- app, so none of it is faked here. What's real: a session written on
-- every actual sign-in, self-service visibility symmetrical with what
-- containment can do, and an incident object with a real timeline.

CREATE TABLE session (
    session_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    ip varchar,
    user_agent varchar,
    device_label varchar not null,       -- parsed browser · OS, "Unknown" rather than guessed
    first_seen_for_person integer not null,   -- 0|1 — this ip+user_agent pair, for this person
    signals varchar,                     -- JSON array, pinned at sign-in time
    signed_in_at integer not null,
    last_seen_at integer not null,
    revoked_at integer,
    revoked_by varchar,
    revoke_reason varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_session_person ON session(org_id, person_id, signed_in_at);

CREATE TABLE security_incident (
    incident_id varchar not null primary key,
    org_id varchar not null,
    title varchar not null,
    status varchar not null default 'open',   -- open | closed
    opened_at integer not null, opened_by varchar not null,
    awareness_at integer not null,       -- the 72h regulatory clock starts here, not at opened_at
    closed_at integer, conclusion varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);

-- The timeline the wireframe's "Record" phase asks for: contain/assess/notify/note,
-- one row each, detail shaped per kind. Same treatment as audit_event — this IS the
-- exportable-for-the-regulator record.
CREATE TABLE security_incident_action (
    action_id varchar not null primary key,
    org_id varchar not null, incident_id varchar not null,
    kind varchar not null,                -- contain_sessions | assess | notify | note
    detail varchar not null,              -- JSON, shaped per kind
    actor_person_id varchar not null,
    occurred_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_incident_action ON security_incident_action(org_id, incident_id, occurred_at);
