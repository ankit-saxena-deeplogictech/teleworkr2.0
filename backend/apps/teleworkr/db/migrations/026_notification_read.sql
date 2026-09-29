-- A9: the recipient's own read watermark. A cursor, not a per-row flag —
-- notification itself stays append-only, so "read" lives here instead.
CREATE TABLE notification_read (
    org_id varchar not null,
    person_id varchar not null,
    read_until integer not null,
    PRIMARY KEY (org_id, person_id)
);
