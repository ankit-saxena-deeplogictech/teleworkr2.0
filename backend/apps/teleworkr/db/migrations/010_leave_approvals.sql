-- 010_leave_approvals.sql — J5 approval routing.
--
-- Routing is policy data: the request's approval_route array becomes sequential
-- steps, and approval_step records where the request sits. A two-step route
-- (manager, then HR) leaves the request pending with approval_step advanced;
-- approval_exceptions records explicit calls like a manager-approved
-- short-notice exception — which the policy requires by email today and the
-- product records by design.

ALTER TABLE leave_request ADD COLUMN approval_step integer not null default 0;
ALTER TABLE leave_request ADD COLUMN approval_exceptions varchar;
