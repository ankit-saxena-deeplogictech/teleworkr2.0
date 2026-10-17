-- 038_chat.sql — team chat: DMs, groups and channels.
--
-- Content is readable by a conversation's members only. There is no admin or
-- HR read path (message.read_content is in the capability CEILING), so nothing
-- here is exposed through an org-wide query.
--
-- seq is the per-conversation message counter: clients poll "after_seq", and
-- last_read_seq is a watermark (the same cursor idea as notification_read),
-- never a per-message read flag. next_seq is bumped inside the send transaction.

CREATE TABLE chat_conversation (
    conversation_id varchar not null primary key,
    org_id varchar not null,
    kind varchar not null,               -- dm | group | channel
    title varchar,                       -- groups and channels; a DM is titled by the other person
    task_ref varchar,                    -- optional link for a task channel
    dm_key varchar,                      -- DMs only: the two person ids, sorted, joined with ':'
    created_by varchar not null,
    created_at integer not null,
    archived_at integer,
    next_seq integer not null default 0,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_chat_dm ON chat_conversation(org_id, dm_key) WHERE dm_key IS NOT NULL;
CREATE UNIQUE INDEX idx_chat_channel_name ON chat_conversation(org_id, lower(title)) WHERE kind = 'channel';

CREATE TABLE chat_member (
    conversation_id varchar not null,
    person_id varchar not null,
    org_id varchar not null,
    role varchar not null default 'member',   -- owner | member
    joined_at integer not null,
    left_at integer,
    last_read_seq integer not null default 0,
    muted_until integer,                      -- NULL = not muted; 9999999999 = until further notice
    PRIMARY KEY (conversation_id, person_id),
    FOREIGN KEY (conversation_id) REFERENCES chat_conversation(conversation_id)
);
CREATE INDEX idx_chat_member_person ON chat_member(org_id, person_id);

CREATE TABLE chat_message (
    message_id varchar not null primary key,
    conversation_id varchar not null,
    org_id varchar not null,
    seq integer not null,
    sender_person_id varchar not null,
    body varchar not null,
    mentions varchar not null default '[]',   -- JSON array of person_ids
    created_at integer not null,
    edited_at integer,
    deleted_at integer,
    FOREIGN KEY (conversation_id) REFERENCES chat_conversation(conversation_id)
);
CREATE UNIQUE INDEX idx_chat_message_seq ON chat_message(conversation_id, seq);
CREATE INDEX idx_chat_message_sender ON chat_message(org_id, sender_person_id);

-- Orgs that already exist keep the role rows they were created with
-- (permissions.ensureBuiltinRolesAsync skips a role that is already there), so a
-- capability added to a built-in role later never reaches them. Backfill the
-- ones introduced since: chat for everyone but guests, channel creation for
-- lead/hr/admin, and the day-level activity viewer for admin. Idempotent: the
-- unique index on role_capability makes a repeat run a no-op.
INSERT OR IGNORE INTO role_capability (role_capability_id, org_id, role_id, capability, scope_type, scope_ref, effect, created_at)
    SELECT lower(hex(randomblob(16))), r.org_id, r.role_id, 'chat.use', 'org', NULL, 'allow', strftime('%s','now')
    FROM role r WHERE r.is_builtin = 1 AND r.name IN ('employee', 'lead', 'hr', 'admin');
INSERT OR IGNORE INTO role_capability (role_capability_id, org_id, role_id, capability, scope_type, scope_ref, effect, created_at)
    SELECT lower(hex(randomblob(16))), r.org_id, r.role_id, 'chat.channel.create', 'org', NULL, 'allow', strftime('%s','now')
    FROM role r WHERE r.is_builtin = 1 AND r.name IN ('lead', 'hr', 'admin');
INSERT OR IGNORE INTO role_capability (role_capability_id, org_id, role_id, capability, scope_type, scope_ref, effect, created_at)
    SELECT lower(hex(randomblob(16))), r.org_id, r.role_id, 'activity.read_daily', 'org', NULL, 'allow', strftime('%s','now')
    FROM role r WHERE r.is_builtin = 1 AND r.name = 'admin';
