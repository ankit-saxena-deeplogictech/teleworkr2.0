-- 003_audit_integrity.sql — hash chaining for the H4 audit log.
--
-- H4 requires the log to be tamper-evident as well as append-only. Each entry
-- hashes the previous entry's hash together with its own canonical fields, so a
-- row edited in place breaks every hash after it. The chain is ordered by rowid,
-- which is insertion order — occurred_at alone is ambiguous when two entries
-- share a second.
--
-- These columns are part of the append-only audit_event entity: written once at
-- insert, never updated. The register entry for audit_event (append-only, retain,
-- 7 years, anchored to occurred_at) already covers them.

ALTER TABLE audit_event ADD COLUMN prev_hash varchar;
ALTER TABLE audit_event ADD COLUMN entry_hash varchar;
