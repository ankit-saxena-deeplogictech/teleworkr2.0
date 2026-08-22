-- 014_clock_breaks.sql — C2 breaks.
--
-- A break is not worked time, so it cannot live in time_entry_event without
-- polluting every total that sums it. It is its own record with its own
-- interval, which is also what makes "1 break (12 min)" answerable in the clock
-- popover rather than inferred from a gap.
--
-- Append-only, like the ledger it sits beside: ending a break supersedes the
-- open row rather than updating it, so the original interval survives a
-- correction. Breaks are pseudonymised on erasure and kept as long as the time
-- they sit between, because a timesheet without its breaks is not the record.

CREATE TABLE clock_break (
    break_id varchar not null primary key,
    org_id varchar not null,
    person_id varchar not null,
    entry_date varchar not null,        -- ISO date, the day the break belongs to
    started_at integer not null,        -- unix seconds
    ended_at integer,                   -- NULL while the person is still on the break
    reason varchar,
    source varchar not null default 'clock',   -- clock | idle_resolution
    supersedes_break_id varchar,
    recorded_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id),
    FOREIGN KEY (person_id) REFERENCES person(person_id)
);
CREATE INDEX idx_clock_break_day ON clock_break(org_id, person_id, entry_date);
