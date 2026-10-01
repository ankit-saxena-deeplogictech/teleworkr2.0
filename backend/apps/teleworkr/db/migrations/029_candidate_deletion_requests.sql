-- 029_candidate_deletion_requests.sql — K12 slice 2: a candidate's own
-- self-service deletion request. Same shape as withdrawn_at/withdrawn_reason
-- (025_candidate_portal.sql) — an out-of-band candidate action with no
-- actor_person_id to put on a stage_transition row, so _projectAsync
-- short-circuits on these columns instead. One request per application at a
-- time; no separate table needed. The decided-pair lets a decline resume the
-- application (an approval erases the row entirely, so it never reads its
-- own decided state back).

ALTER TABLE application ADD COLUMN deletion_requested_at integer;
ALTER TABLE application ADD COLUMN deletion_requested_reason varchar;
ALTER TABLE application ADD COLUMN deletion_decided_at integer;
ALTER TABLE application ADD COLUMN deletion_decided_by varchar;
ALTER TABLE application ADD COLUMN deletion_decision varchar;        -- approved | declined
ALTER TABLE application ADD COLUMN deletion_decision_reason varchar;

-- "Who viewed my record" (candidate-side) filters on object_type/object_ref,
-- which none of audit_event's existing indexes cover.
CREATE INDEX idx_audit_object ON audit_event(org_id, object_type, object_ref, occurred_at);
