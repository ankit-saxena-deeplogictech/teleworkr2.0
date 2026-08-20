-- 006_working_windows.sql — E3/E4 availability model.
--
-- One effective-dated record of when a person works. The calendar is not the
-- timezone: travel is a dated state (a window period with kind 'travel'), and
-- every change supersedes rather than edits, so an overlap board asked about a
-- past date answers with the window that was in force then (A6).
--
-- start_minute and end_minute are minutes from local midnight. end < start is a
-- night shift crossing midnight — a real shift shape, not an error (E4 edge
-- cases). days is a JSON array of ISO weekday numbers, 1=Mon..7=Sun.

CREATE TABLE working_window (
    window_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    kind varchar not null default 'declared',   -- declared | travel
    timezone varchar not null,                  -- IANA name; offsets are derived per date, never stored
    start_minute integer not null,
    end_minute integer not null,
    days varchar not null,                      -- JSON [1..7]
    valid_from varchar not null,                -- ISO date, inclusive
    valid_to varchar,                           -- ISO date, exclusive; NULL = open
    note varchar,
    recorded_at integer not null,
    recorded_by varchar,
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_working_window_asof ON working_window(org_id, person_id, valid_from);
