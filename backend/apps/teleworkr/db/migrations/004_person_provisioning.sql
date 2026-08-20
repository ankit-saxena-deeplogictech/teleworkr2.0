-- 004_person_provisioning.sql — L1 provisioning state.
--
-- L1 States: an assertion missing a required attribute creates the account,
-- feature-flags it and notifies the admin — never silently defaults. The flag is
-- the comma-separated list of missing assertion attributes; NULL means complete.
-- It is cleared the moment a later assertion completes the employment.

ALTER TABLE person ADD COLUMN provisioning_status varchar;
