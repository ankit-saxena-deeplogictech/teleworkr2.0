-- 013_policy_conflicts.sql — J8 the conflicts the engine can't resolve.
--
-- Seven ambiguities in the policy document. Conflicts marked "publish" are
-- structural: the validator refuses to publish until HR chooses a reading.
-- "Assumed" ones carry a working interpretation that HR confirms or overrides.
-- Every resolution is stored with the policy version, so in two years the
-- answer to "why does it behave like this" is on the record, not in someone's
-- memory.

ALTER TABLE leave_policy_version ADD COLUMN resolutions varchar;
