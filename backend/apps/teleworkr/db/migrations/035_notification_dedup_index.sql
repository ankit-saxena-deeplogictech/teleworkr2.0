-- 035_notification_dedup_index.sql — supports the lazy, read-time notification
-- checks (page_past_review, approval_sla): "has this exact (org, recipient,
-- category, object) already been raised recently" needs to be cheap on a hot
-- read path (a wiki page open, an approvals-queue load), not an unindexed scan.

CREATE INDEX idx_notification_dedup ON notification(org_id, recipient_person_id, category, object_ref);
