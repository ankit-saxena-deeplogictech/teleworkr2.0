-- 007_tasks.sql — D1/D2 the task domain.
--
-- task is the mutable row. Everything else about it is an edge or an append-only
-- log, because "blocked 6 days" and "who changed this and when" are questions
-- the product must answer (D1 note 4, D2 activity).
--
-- task_relation is the A6 "edges are entities" pattern: blocks, subtask and
-- duplicate each carry their own timestamps and their own reason. Blocked
-- without a reason is just a colour (D1), so a blocks relation requires one.
--
-- task_comment and task_event are append-only. task_event carries status
-- transitions and field changes; the time log is NOT here — it is projected from
-- time_entry_event by task_ref, never duplicated.

CREATE TABLE task (
    task_id varchar not null primary key,
    org_id varchar not null,
    task_ref varchar not null,          -- TASK-1042 shape, unique per org
    title varchar not null,
    description varchar,
    project varchar,
    status varchar not null default 'to_do',   -- to_do | in_progress | in_review | done | blocked
    priority varchar not null default 'medium', -- high | medium | low
    assignee_person_id varchar,
    created_by varchar not null,
    created_at integer not null,
    updated_at integer not null,
    due_date varchar,                   -- ISO date
    due_time_minutes integer,           -- minutes from local midnight, nullable
    estimate_minutes integer,
    recurring_rule varchar,             -- a repeat rule, or NULL for once
    archived_at integer,
    FOREIGN KEY (org_id) REFERENCES org(org_id)
);
CREATE UNIQUE INDEX idx_task_ref ON task(org_id, task_ref);
CREATE INDEX idx_task_list ON task(org_id, status, assignee_person_id, project);

-- Edges with their own timestamps. blocks: from_task blocks to_task.
CREATE TABLE task_relation (
    task_relation_id varchar not null primary key,
    org_id varchar not null,
    from_task_id varchar not null,
    to_task_id varchar not null,
    relation_type varchar not null,     -- blocks | subtask | duplicate
    reason varchar,                     -- required for blocks
    created_at integer not null,
    created_by varchar,
    resolved_at integer,                -- when a block was lifted
    FOREIGN KEY (from_task_id) REFERENCES task(task_id),
    FOREIGN KEY (to_task_id) REFERENCES task(task_id)
);
CREATE INDEX idx_task_relation_from ON task_relation(org_id, from_task_id);
CREATE INDEX idx_task_relation_to ON task_relation(org_id, to_task_id);

CREATE TABLE task_watcher (
    task_watcher_id varchar not null primary key,
    org_id varchar not null,
    task_id varchar not null,
    person_id varchar not null,
    created_at integer not null,
    FOREIGN KEY (task_id) REFERENCES task(task_id)
);
CREATE UNIQUE INDEX idx_task_watcher ON task_watcher(org_id, task_id, person_id);

CREATE TABLE task_comment (
    task_comment_id varchar not null primary key,
    org_id varchar not null,
    task_id varchar not null,
    person_id varchar not null,
    body varchar not null,
    created_at integer not null,
    FOREIGN KEY (task_id) REFERENCES task(task_id)
);
CREATE INDEX idx_task_comment ON task_comment(task_id);

CREATE TABLE task_event (
    task_event_id varchar not null primary key,
    org_id varchar not null,
    task_id varchar not null,
    actor_person_id varchar,
    action varchar not null,            -- A10 object.action, past tense
    detail varchar,                     -- JSON: the before and after
    created_at integer not null,
    FOREIGN KEY (task_id) REFERENCES task(task_id)
);
CREATE INDEX idx_task_event ON task_event(task_id);
