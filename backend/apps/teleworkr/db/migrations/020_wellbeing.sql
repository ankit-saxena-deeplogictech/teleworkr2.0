-- 020_wellbeing.sql — M, wellbeing & load.
--
-- Same architecture as J1 and K1, deliberately (M1): a versioned signal
-- definition with a published pointer, one evaluator, an append-only signal
-- ledger — status is never stored, only what the evaluator wrote each night.
--
-- The module's one hard constraint is "no new collection": every signal
-- reads data this schema already holds for another reason (time_entry_event,
-- working_window, leave_ledger_entry, task_relation). Two signals the
-- wireframe specifies have no real source anywhere in this app and are
-- deliberately not built: fragmentation (no focus-block/calendar-event
-- system exists) and guardrail breaches (C6 statutory rest/break rules are
-- themselves deliberately absent — see time.js's own header). Building
-- either would mean inventing the data a signal is supposed to read, which
-- is exactly the "proposal for new surveillance" M1 exists to refuse.
--
-- signal_ledger_entry's shape (APPEND_ONLY, erase 13 months, anchor
-- signal_evaluated) was already declared in entityshapes.js before this
-- module existed — this is that table.

CREATE TABLE signal_definition (
    signal_definition_id varchar not null primary key,
    org_id varchar not null,
    signal_code varchar not null,   -- sustained_load|no_recovery|out_of_window|leave_not_taken|blocked_drag
    version integer not null,
    status varchar not null default 'published',
    label varchar not null,
    threshold varchar not null,     -- JSON, signal-specific (e.g. {percent_over: 15, window_weeks: 3})
    ladder varchar not null,        -- JSON: {suggest_after_days, offer_after_days}
    published_at integer,
    published_by varchar,
    created_at integer not null,
    created_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_signal_definition ON signal_definition(org_id, signal_code, version);

CREATE TABLE signal_definition_pointer (
    org_id varchar not null,
    signal_code varchar not null,
    signal_definition_id varchar not null,
    updated_at integer not null,
    PRIMARY KEY (org_id, signal_code)
);

-- Append-only (M1 item 3): every night's evaluation for every person, kept
-- 13 months, readable by that person in full — "if a person can't see
-- their own signal history, this is monitoring wearing a wellbeing badge."
-- inputs carries the 2-3 raw values that moved it: causes, not a score.
CREATE TABLE signal_ledger_entry (
    signal_ledger_entry_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    signal_code varchar not null,
    signal_definition_id varchar not null,
    lit integer not null,           -- 0|1
    since varchar,                  -- ISO date first lit, carried forward while still lit
    inputs varchar not null,        -- JSON
    evaluated_for varchar not null, -- ISO date being evaluated — idempotency key component
    evaluated_at integer not null,
    batch_tag varchar not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_signal_ledger_once ON signal_ledger_entry(org_id, person_id, signal_code, evaluated_for);
CREATE INDEX idx_signal_ledger_person ON signal_ledger_entry(org_id, person_id, evaluated_for);

-- Tighten-only personal override (M1 item 6): "a raised threshold isn't"
-- visible the way a mute is, so loosening isn't offered at all — only a
-- stricter personal threshold, or muting the notification entirely below.
CREATE TABLE signal_threshold_override (
    override_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    signal_code varchar not null,
    threshold varchar not null,     -- JSON, validated stricter than the published default at write time
    created_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_signal_override ON signal_threshold_override(org_id, person_id, signal_code);

-- NULL signal_code mutes every wellbeing notification. The ledger keeps
-- writing regardless (M2: "signals keep being computed... you just stop
-- being told") — muting only gates the notifications.notifyAsync call in
-- the evaluator, never the write.
CREATE TABLE signal_mute (
    mute_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    signal_code varchar,
    muted_until varchar not null,   -- ISO date
    reason varchar,
    created_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_signal_mute_person ON signal_mute(org_id, person_id);

-- M2's "share a summary" / M4's "consented share, from the manager's side".
-- summary is a snapshot computed once at share time: hours, meeting/blocked
-- composition — never signal names, thresholds or ledger history (M2 item 5).
CREATE TABLE signal_share (
    share_id varchar not null primary key,
    org_id varchar not null,
    sharer_person_id varchar not null,
    recipient_person_id varchar not null,
    period_from varchar not null,
    period_to varchar not null,
    summary varchar not null,       -- JSON snapshot
    created_at integer not null,
    expires_at integer not null,
    revoked_at integer,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_signal_share_recipient ON signal_share(org_id, recipient_person_id);
