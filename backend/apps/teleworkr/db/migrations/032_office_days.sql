-- 032_office_days.sql — E5, narrowed to office-day status. Desk booking,
-- capacity, proximity and auto-release are dropped outright: no desk/office
-- entity exists anywhere in this app to attach them to.
--
-- Deliberately not a working_window row: a day's status (home/office/
-- elsewhere + an optional free-text location) is a one-day fact, corrected
-- in place, not an effective-dated recurring pattern — working_window's own
-- shape. One row per person per day.

CREATE TABLE office_day_status (
    org_id varchar not null,
    person_id varchar not null,
    status_date varchar not null,   -- ISO date
    status varchar not null,        -- home | office | elsewhere
    location varchar,               -- free text, e.g. "SF", "LDN" — no office taxonomy to constrain it to
    updated_at integer not null,
    PRIMARY KEY (org_id, person_id, status_date)
);
