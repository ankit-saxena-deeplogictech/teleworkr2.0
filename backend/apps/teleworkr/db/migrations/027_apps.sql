-- 027_apps.sql — G1, the app catalogue and bound launches.
--
-- Five small tables: the catalogue itself, who holds a seat, the requests
-- that grant one, the manual per-task deep link ("the apps you've connected
-- yourself"), and the launch log that is both the C3 attribution promise and
-- the raw material for the seat-usage view.
--
-- Narrowed, deliberately: no SSO/OAuth broker of any kind exists in this
-- app, so launch_url is a plain configured URL and a deep link is a person's
-- own manually-attached reference, never an API-discovered one. There is no
-- way for a thin launcher to observe whether the far end actually loaded, so
-- there is no "launch failed" state to store. The full H3 admin surface
-- (roles/people/policies/billing, notify-first reclaim) is not here — only
-- the catalogue and seat-usage slice that is this feature's own data.

CREATE TABLE app_catalogue (
    app_id varchar not null primary key,
    org_id varchar not null,
    name varchar not null,
    category varchar,
    launch_url varchar,
    launch_label varchar not null default 'Open',
    requires_request integer not null default 0,
    cost_per_seat_minor integer,
    cost_currency varchar,
    approver_person_id varchar,
    deprecated integer not null default 0,
    created_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_app_catalogue_org ON app_catalogue(org_id);

CREATE TABLE app_access (
    org_id varchar not null,
    app_id varchar not null,
    person_id varchar not null,
    granted_at integer not null,
    granted_by varchar,
    revoked_at integer,
    PRIMARY KEY (org_id, app_id, person_id)
);

CREATE TABLE app_access_request (
    request_id varchar not null primary key,
    org_id varchar not null,
    app_id varchar not null,
    requested_by varchar not null,
    reason varchar not null,
    approver_person_id varchar,
    status varchar not null default 'pending',
    decided_at integer,
    decision_reason varchar,
    created_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_app_access_request_org_status ON app_access_request(org_id, status);

-- "Deep-link titles come from apps you've connected yourself" — a person's
-- own manually-attached reference for one task, not a discovered one.
CREATE TABLE app_task_link (
    link_id varchar not null primary key,
    org_id varchar not null,
    app_id varchar not null,
    task_ref varchar not null,
    person_id varchar not null,
    label varchar not null,
    url varchar not null,
    created_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_app_task_link_task ON app_task_link(org_id, task_ref);

-- What gets recorded: that an app was opened, when, by whom, and which task
-- the timer was on. Not what happened inside it.
CREATE TABLE app_launch_event (
    event_id varchar not null primary key,
    org_id varchar not null,
    app_id varchar not null,
    person_id varchar not null,
    task_ref varchar,
    occurred_at integer not null,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE INDEX idx_app_launch_event_app ON app_launch_event(org_id, app_id, occurred_at);
CREATE INDEX idx_app_launch_event_person ON app_launch_event(org_id, person_id, occurred_at);
