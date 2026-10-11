-- 037_meetings.sql — the minimal meeting/calendar-event entity E2/F1-F5 and
-- the meeting_starting notification all sit on top of. No task_ref column:
-- nothing in this slice reads or writes a task link, same "named, not
-- silently faked" discipline already used for I2's unread locale prefs.
-- Attendees are a JSON array, not a join table — small per-org datasets are
-- already read and filtered in JS elsewhere (officedays.js, calendar.js),
-- and no attendee-side query is needed yet.

CREATE TABLE meeting (
    meeting_id varchar not null primary key,
    org_id varchar not null,
    owner_person_id varchar not null,
    title varchar not null,
    starts_at integer not null,
    ends_at integer not null,
    attendees varchar not null,     -- JSON array of person_ids, owner included
    status varchar not null,        -- scheduled | cancelled
    created_at integer not null,
    updated_at integer not null
);
CREATE INDEX idx_meeting_owner ON meeting(org_id, owner_person_id, starts_at);
CREATE INDEX idx_meeting_org_time ON meeting(org_id, starts_at);
