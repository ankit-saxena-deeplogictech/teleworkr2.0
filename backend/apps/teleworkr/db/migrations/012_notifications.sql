-- 012_notifications.sql — A9 the notification spine, and B4's feed hooks.
--
-- One catalogue, one volume control, one rule: the working window (E4) is the
-- send window, and only two categories may breach it. Everything else waits in
-- a bucket — delivered in the window, brief (the clock-in brief, B4), digest,
-- or muted by the recipient's own volume setting. The notification row is
-- append-only history; the setting is the recipient's.

CREATE TABLE notification (
    notification_id varchar not null primary key,
    org_id varchar not null,
    recipient_person_id varchar not null,
    category varchar not null,
    status varchar not null,        -- delivered | brief | digest | muted
    payload varchar,
    object_ref varchar,
    actor_person_id varchar,
    raised_at integer not null,
    delivered_at integer
);
CREATE INDEX idx_notification_recipient ON notification(org_id, recipient_person_id, status);

CREATE TABLE notification_setting (
    org_id varchar not null,
    person_id varchar not null,
    category varchar not null,
    level varchar not null,         -- live | digest | off
    PRIMARY KEY (org_id, person_id, category)
);
