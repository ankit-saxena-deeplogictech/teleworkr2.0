-- 005_timelog.sql — the C-section time domain.
--
-- time_entry_event is the truth: append-only, no update, no delete. "Recorded
-- time is never discarded" (A8) is expressed as an idempotency key — an offline
-- client retries with the same client_event_id and gets the same row back, never
-- a duplicate and never a rejection. An edit is a new event that supersedes an
-- old one, carrying the reason; the original value survives (C5).
--
-- timesheet is a period snapshot that pins the entry events as they stood at
-- submission through the timesheet_entry edges, so a later edit cannot silently
-- change an approved week (C7). Totals are projected over the events, never
-- stored (A6).
--
-- Conventions: instants are unix seconds (INTEGER); entry_date and week bounds
-- are ISO dates (TEXT); valid week is Monday-to-Sunday.

CREATE TABLE time_entry_event (
    entry_event_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    client_event_id varchar,            -- offline-sync idempotency; the one action that cannot fail
    entry_date varchar not null,        -- ISO date the time belongs to
    task_ref varchar,                   -- TASK-xxxx; the tasks module owns the task rows
    project varchar,
    client_code varchar,
    note varchar,
    billable integer not null default 1,
    started_at integer,                 -- unix seconds; NULL for pure-duration entries
    ended_at integer,                   -- NULL while a live timer is running
    duration_seconds integer,           -- as recorded; projected over started/ended when running
    source varchar not null default 'manual',  -- timer | manual | reconstructed | calendar
    signal varchar,                     -- JSON provenance for reconstructed entries (C3)
    reconstructed integer not null default 0,
    supersedes_entry_event_id varchar,  -- an edit points at the event it supersedes
    reason varchar,                     -- required for edits; shown on the edit trail (C5)
    recorded_at integer not null,       -- when we learned it — distinct from when it happened
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_time_event_day ON time_entry_event(org_id, person_id, entry_date);
CREATE UNIQUE INDEX idx_time_event_client ON time_entry_event(org_id, person_id, client_event_id) WHERE client_event_id IS NOT NULL;

-- One row per person per week. Status: open | submitted | returned | approved | locked.
-- A return unlocks named dates, not necessarily the whole week (C7).
CREATE TABLE timesheet (
    timesheet_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    week_start varchar not null,        -- ISO date, the Monday
    week_end varchar not null,          -- ISO date, the Sunday
    status varchar not null default 'open',
    submitted_at integer,
    submitted_by varchar,
    return_reason varchar,              -- pinned on the record, shown to the person (C5)
    unlocked_dates varchar,             -- JSON array of ISO dates editable after a return
    approved_at integer,
    approved_by varchar,
    locked_at integer,
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE UNIQUE INDEX idx_timesheet_week ON timesheet(org_id, person_id, week_start);

-- The pin: which entry events, and the values that mattered, as of submission.
CREATE TABLE timesheet_entry (
    timesheet_entry_id varchar not null primary key,
    org_id varchar not null,
    timesheet_id varchar not null,
    entry_event_id varchar not null,
    entry_date varchar not null,
    task_ref varchar,
    project varchar,
    client_code varchar,
    note varchar,
    billable integer not null default 1,
    duration_seconds integer not null,
    source varchar not null,
    reconstructed integer not null default 0,
    FOREIGN KEY (timesheet_id) REFERENCES timesheet(timesheet_id)
);
CREATE INDEX idx_timesheet_entry ON timesheet_entry(timesheet_id);
