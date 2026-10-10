-- 034_clock_preference.sql — I1's one real "Clock & timer" setting: whether
-- switching the clock to another task asks first. Idle threshold, auto-pause
-- on away and end-of-day reminder stay unbuilt — none of their underlying
-- mechanisms exist (no automatic idle-detection loop, no scheduler anywhere
-- in this backend), so there is nothing real for a setting to control yet.
--
-- Absence of a row means the wireframe's own stated default: on.

CREATE TABLE clock_preference (
    org_id varchar not null,
    person_id varchar not null,
    confirm_before_switch integer not null,
    updated_at integer not null,
    PRIMARY KEY (org_id, person_id)
);
