-- 039_telemeet.sql — Telemeet video rooms.
--
-- Media never touches the server: audio and video are peer-to-peer WebRTC
-- between the browsers in the room, so nothing is recorded or stored here. These
-- tables hold only the room, who was invited and who was in it, the short-lived
-- signalling messages browsers use to find each other, and the shared notes.
--
-- room_signal rows are ephemeral (offers/answers/ICE candidates): clients poll
-- with "after signal_id", and rows older than 15 minutes are purged on write.
-- room_participant holds one row per join, so a rejoin is a new row and the
-- time written back to the ledger on leave is exactly joined_at..left_at.

CREATE TABLE meeting_room (
    room_id varchar not null primary key,
    org_id varchar not null,
    meeting_id varchar,                  -- the scheduled meeting this room belongs to, if any
    task_ref varchar,                    -- the task everything the call produces goes back to, if any
    title varchar not null,
    created_by varchar not null,
    created_at integer not null,
    started_at integer,                  -- first join
    ended_at integer,
    ended_by varchar,                    -- NULL when it ended because the last person left
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_meeting_room_org ON meeting_room(org_id, ended_at);
CREATE INDEX idx_meeting_room_meeting ON meeting_room(org_id, meeting_id);

CREATE TABLE room_invitee (
    room_id varchar not null,
    person_id varchar not null,
    org_id varchar not null,
    PRIMARY KEY (room_id, person_id),
    FOREIGN KEY (room_id) REFERENCES meeting_room(room_id)
);
CREATE INDEX idx_room_invitee_person ON room_invitee(org_id, person_id);

CREATE TABLE room_participant (
    participant_id varchar not null primary key,
    room_id varchar not null,
    org_id varchar not null,
    person_id varchar not null,
    joined_at integer not null,
    last_seen_at integer not null,       -- heartbeat; 30s without one reads as left
    left_at integer,
    time_logged integer not null default 0,   -- 1 once this stay was written back to the time ledger
    FOREIGN KEY (room_id) REFERENCES meeting_room(room_id)
);
CREATE INDEX idx_room_participant_room ON room_participant(room_id, left_at);

CREATE TABLE room_signal (
    signal_id integer primary key autoincrement,
    room_id varchar not null,
    org_id varchar not null,
    from_person_id varchar not null,
    to_person_id varchar not null,
    kind varchar not null,               -- offer | answer | ice
    payload varchar not null,            -- JSON, opaque to the server
    created_at integer not null
);
CREATE INDEX idx_room_signal_to ON room_signal(room_id, to_person_id, signal_id);

CREATE TABLE room_note_line (
    line_id varchar not null primary key,
    room_id varchar not null,
    org_id varchar not null,
    kind varchar not null,               -- note | action | decision
    text varchar not null,
    assignee_person_id varchar,          -- actions only
    created_by varchar not null,
    updated_by varchar not null,
    created_at integer not null,
    updated_at integer not null,
    deleted_at integer,
    task_ref_created varchar,            -- the task an action line became on finalise
    FOREIGN KEY (room_id) REFERENCES meeting_room(room_id)
);
CREATE INDEX idx_room_note_room ON room_note_line(room_id, created_at);

-- See 038_chat.sql: existing orgs keep their built-in role rows, so backfill the new capability.
INSERT OR IGNORE INTO role_capability (role_capability_id, org_id, role_id, capability, scope_type, scope_ref, effect, created_at)
    SELECT lower(hex(randomblob(16))), r.org_id, r.role_id, 'telemeet.join', 'org', NULL, 'allow', strftime('%s','now')
    FROM role r WHERE r.is_builtin = 1 AND r.name IN ('employee', 'lead', 'hr', 'admin');
