/**
 * D1/D2 — the task domain.
 *
 * The task row is mutable; everything around it is an edge or an append-only
 * log. Blocks, subtasks and duplicates are relations with their own timestamps
 * and reasons — that is what makes "blocked 6 days" answerable. Blocked without
 * a reason is just a colour (D1), so a blocks relation requires one, and a task
 * cannot be put in the blocked status without an active block relation.
 *
 * The task time log is projected from the time ledger by task_ref — never
 * duplicated, always carrying each entry's source (D2). Logged totals count only
 * the current version of each entry, the same projection rule the timesheet uses.
 *
 * Reassignment and deletion run through the H4 wrapper: they are always-audited
 * capabilities, and a failed audit write rolls them back.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);

const STATUS = Object.freeze({TO_DO: "to_do", IN_PROGRESS: "in_progress", IN_REVIEW: "in_review",
    DONE: "done", BLOCKED: "blocked"});
const PRIORITIES = Object.freeze({HIGH: "high", MEDIUM: "medium", LOW: "low"});
const RELATIONS = Object.freeze({BLOCKS: "blocks", SUBTASK: "subtask", DUPLICATE: "duplicate"});
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const EDITABLE = ["title", "description", "project", "status", "priority",
    "due_date", "due_time_minutes", "estimate_minutes", "recurring_rule"];

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);

/** A permission check that refuses with the decision attached. */
async function _requireAsync(org_id, actor_person_id, capability) {
    const decision = await permissions.checkAsync({org_id, actor_person_id, capability});
    if (!decision.allowed) throw Object.assign(new Error(
        `${capability} refused: ${decision.reason} ${decision.who_can||""}`), {decision});
    return decision;
}

// ---------------------------------------------------------------------------
// creating
// ---------------------------------------------------------------------------

/**
 * Creates a task. The reference is sequential per org — TASK-1, TASK-2 — and is
 * assigned inside the same transaction as the insert, so the serialised queue
 * makes the sequence race-free.
 *
 * @param {object} task {org_id, actor_person_id, title, description, project,
 *      status, priority, assignee_person_id, due_date, due_time_minutes,
 *      estimate_minutes, recurring_rule}
 * @returns The created task
 */
exports.createTaskAsync = async function(task) {
    await _requireAsync(task.org_id, task.actor_person_id, "task.create");
    const row = _prepareTask(task, {created_by: task.actor_person_id,
        assignee_person_id: task.assignee_person_id || task.actor_person_id});

    return await dblayer.runInTransactionAsync(async exec => {
        row.task_ref = await _nextTaskRefViaAsync(exec, row.org_id);
        await _insertTaskViaAsync(exec, row);
        await _appendEventViaAsync(exec, row.org_id, row.task_id, row.created_by,
            "task.created", {title: row.title, task_ref: row.task_ref});
        return row;
    });
}

/**
 * Adds a subtask: a real task row plus a subtask relation from the parent.
 * @param {object} request {org_id, actor_person_id, parent_task_ref, ...task fields}
 * @returns {object} {parent, child, relation}
 */
exports.addSubtaskAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "task.create");
    return await dblayer.runInTransactionAsync(async exec => {
        const parent = await _taskByRefViaAsync(exec, request.org_id, request.parent_task_ref);
        if (!parent) throw new Error(`Parent task ${request.parent_task_ref} was not found.`);

        const child = _prepareTask({...request, assignee_person_id:
            request.assignee_person_id || request.actor_person_id},
            {created_by: request.actor_person_id});
        child.task_ref = await _nextTaskRefViaAsync(exec, child.org_id);
        await _insertTaskViaAsync(exec, child);
        await _appendEventViaAsync(exec, child.org_id, child.task_id, child.created_by,
            "task.created", {title: child.title, task_ref: child.task_ref});

        const relation = await _insertRelationViaAsync(exec, {org_id: request.org_id,
            from_task_id: parent.task_id, to_task_id: child.task_id,
            relation_type: RELATIONS.SUBTASK, created_by: request.actor_person_id});
        await _appendEventViaAsync(exec, request.org_id, parent.task_id, request.actor_person_id,
            "task.subtask_added", {subtask: child.task_ref});
        return {parent, child, relation};
    });
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * The task list with exact counts (D1: "5 of 41", never just five rows). Blocked
 * rows name their blocker, its reason and how long it has blocked them, inline.
 *
 * @param {object} request {org_id, actor_person_id, filters {status, project,
 *      assignee_person_id, overdue, due_date, q}, page, page_size}
 * @returns {object} {rows, total, page, page_size}
 */
exports.listTasksAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "task.read");
    const filters = request.filters || {};
    const page = request.page || 1, pageSize = request.page_size || 50;

    let where = "org_id=?", params = [request.org_id];
    if (filters.status) {where += " AND status=?"; params.push(filters.status);}
    if (filters.project) {where += " AND project=?"; params.push(filters.project);}
    if (filters.assignee_person_id) {where += " AND assignee_person_id=?"; params.push(filters.assignee_person_id);}
    if (filters.overdue) {where += " AND due_date < ? AND status NOT IN ('done','blocked')"; params.push(_today());}
    if (filters.due_date) {where += " AND due_date=?"; params.push(filters.due_date);}
    if (filters.q) {where += " AND title LIKE ?"; params.push(`%${filters.q}%`);}

    const total = (await dblayer.getQueryOrThrow(`SELECT COUNT(*) AS c FROM task WHERE ${where}`, params))[0].c;
    const rows = await dblayer.getQueryOrThrow(
        `SELECT * FROM task WHERE ${where} ORDER BY created_at DESC, task_ref DESC LIMIT ? OFFSET ?`,
        [...params, pageSize, (page-1)*pageSize]);

    return {rows: await _withBlockedOnAsync(request.org_id, rows),
        logged_seconds: await _loggedByTaskRefAsync(request.org_id, rows),
        total, page, page_size: pageSize};
}

/**
 * Everything the D2 drawer needs: the task, its relations both ways, watchers,
 * comments, the activity trail, and the time log projected from the ledger.
 * @param {object} request {org_id, actor_person_id, task_ref}
 */
/**
 * The bare task row plus its live logged time, for a widget that needs to name a
 * task without pulling its relations, comments and events (taskDetailAsync).
 * The C1 clock strip is the reason this exists: it names the task the timer is
 * bound to, nothing more.
 * @param {object} request {org_id, actor_person_id, task_ref}
 * @returns The task, with logged_seconds, or null
 */
exports.taskSummaryAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "task.read");
    const task = await _taskByRefViaAsync(null, request.org_id, request.task_ref);
    if (!task) return null;
    const timeLog = await time.eventsForTaskAsync(request.org_id, task.task_ref);
    return {...task, logged_seconds: _currentLoggedSeconds(timeLog, _now())};
}

exports.taskDetailAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "task.read");
    const task = await _taskByRefViaAsync(null, request.org_id, request.task_ref);
    if (!task) throw new Error(`Task ${request.task_ref} was not found.`);

    const relations = await dblayer.getQueryOrThrow(
        "SELECT * FROM task_relation WHERE org_id=? AND (from_task_id=? OR to_task_id=?) ORDER BY created_at DESC",
        [request.org_id, task.task_id, task.task_id]);
    const blockers = [], blocks = [];
    for (const relation of relations) {
        if (relation.relation_type != RELATIONS.BLOCKS) continue;
        if (relation.to_task_id == task.task_id && !relation.resolved_at) blockers.push(relation);
        if (relation.from_task_id == task.task_id) blocks.push(relation);
    }
    const subtasks = [];
    for (const relation of relations) {
        if (relation.relation_type == RELATIONS.SUBTASK && relation.from_task_id == task.task_id)
            subtasks.push(await _taskByIdViaAsync(null, relation.to_task_id));
    }
    const enrich = async relation => ({
        ...relation, reason: relation.reason,
        task: await _taskByIdViaAsync(null,
            relation.from_task_id == task.task_id ? relation.to_task_id : relation.from_task_id)});
    const watchers = await dblayer.getQueryOrThrow(
        `SELECT w.*, p.display_name FROM task_watcher w LEFT JOIN person p ON p.person_id=w.person_id WHERE w.task_id=?`,
        [task.task_id]);
    const comments = await dblayer.getQueryOrThrow(
        `SELECT c.*, p.display_name FROM task_comment c LEFT JOIN person p ON p.person_id=c.person_id
            WHERE c.task_id=? ORDER BY c.created_at ASC`, [task.task_id]);
    const events = await dblayer.getQueryOrThrow(
        "SELECT * FROM task_event WHERE task_id=? ORDER BY created_at ASC", [task.task_id]);

    const timeLog = await time.eventsForTaskAsync(request.org_id, task.task_ref);
    return {task, blockers: await Promise.all(blockers.map(enrich)), blocks: await Promise.all(blocks.map(enrich)),
        subtasks, watchers, comments, events, time_log: timeLog,
        logged_seconds: _currentLoggedSeconds(timeLog, _now())};
}

// ---------------------------------------------------------------------------
// updating
// ---------------------------------------------------------------------------

/**
 * Updates task fields. A status change appends a task_event with the before and
 * after; the blocked status is refused without an active block relation, because
 * blocked without a blocker is just a colour (D1).
 *
 * @param {object} request {org_id, actor_person_id, task_ref, changes}
 * @returns The updated task
 */
exports.updateTaskAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "task.edit");
    const unknown = Object.keys(request.changes).filter(key => !EDITABLE.includes(key));
    if (unknown.length) throw new Error(`Unknown task fields: ${unknown.join(", ")}.`);

    return await dblayer.runInTransactionAsync(async exec => {
        const task = await _taskByRefViaAsync(exec, request.org_id, request.task_ref);
        if (!task) throw new Error(`Task ${request.task_ref} was not found.`);
        const changes = {...request.changes};

        if (changes.status !== undefined && !Object.values(STATUS).includes(changes.status)) throw new Error(
            `Unknown status ${JSON.stringify(changes.status)}. Known: ${Object.values(STATUS).join(", ")}.`);
        if (changes.status == STATUS.BLOCKED && task.status != STATUS.BLOCKED) {
            const activeBlocks = await exec.getQuery(
                `SELECT * FROM task_relation WHERE org_id=? AND to_task_id=? AND relation_type='blocks' AND resolved_at IS NULL`,
                [request.org_id, task.task_id]);
            if (!activeBlocks.length) throw new Error(
                "Blocked without a blocker is just a colour (D1). Create the block relation first.");
        }
        if (changes.priority !== undefined && !Object.values(PRIORITIES).includes(changes.priority))
            throw new Error(`Unknown priority ${JSON.stringify(changes.priority)}.`);
        if (changes.due_date !== undefined && !ISO_DATE.test(changes.due_date))
            throw new Error("due_date must be an ISO calendar date (YYYY-MM-DD).");

        const from = {}, to = {};
        for (const key of Object.keys(changes)) {from[key] = task[key]; to[key] = changes[key];}

        const assignments = []; let sql = "UPDATE task SET updated_at=?", params = [_now()];
        for (const key of Object.keys(changes)) {
            sql += `, ${key}=?`; params.push(changes[key] === undefined ? null : changes[key]);
            assignments.push(key);
        }
        sql += " WHERE task_id=?"; params.push(task.task_id);
        await exec.runCmd(sql, params);

        if (changes.status !== undefined && changes.status != task.status)
            await _appendEventViaAsync(exec, request.org_id, task.task_id, request.actor_person_id,
                "task.status_changed", {from: task.status, to: changes.status});
        const fieldChanges = Object.keys(changes).filter(key => key != "status" && (task[key] ?? null) != (changes[key] ?? null));
        if (fieldChanges.length)
            await _appendEventViaAsync(exec, request.org_id, task.task_id, request.actor_person_id,
                "task.updated", {changed: fieldChanges, from: Object.fromEntries(fieldChanges.map(k => [k, task[k]])),
                    to: Object.fromEntries(fieldChanges.map(k => [k, changes[k]]))});
        return await _taskByIdViaAsync(exec, task.task_id);
    });
}

/**
 * Assigns or reassigns a task. Always audited — assignment changes are the ones
 * people dispute — and the audit write failing rolls the assignment back.
 * @param {object} request {org_id, actor_person_id, task_ref, assignee_person_id}
 */
exports.assignTaskAsync = async function(request) {
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "task.assign",
        audit: {action: "task.assigned", object_type: "task", object_ref: request.task_ref,
            subject_person_id: request.assignee_person_id, detail: {to: request.assignee_person_id}},
        action: async exec => {
            const task = await _taskByRefViaAsync(exec, request.org_id, request.task_ref);
            if (!task) throw new Error(`Task ${request.task_ref} was not found.`);
            await exec.runCmd("UPDATE task SET assignee_person_id=?, updated_at=? WHERE task_id=?",
                [request.assignee_person_id, _now(), task.task_id]);
            await _appendEventViaAsync(exec, request.org_id, task.task_id, request.actor_person_id,
                "task.assigned", {from: task.assignee_person_id, to: request.assignee_person_id});
            return "assigned";
        }});
}

// ---------------------------------------------------------------------------
// relations
// ---------------------------------------------------------------------------

/**
 * Blocks one task on another, with a reason. The blocked task moves to the
 * blocked status automatically — a block that changes nothing is invisible.
 * @param {object} request {org_id, actor_person_id, blocker_task_ref,
 *      blocked_task_ref, reason}
 * @returns The relation
 */
exports.addBlockAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "task.edit");
    if (!request.reason) throw new Error(
        "A block needs a reason. Blocked without a reason is just a colour (D1).");
    return await dblayer.runInTransactionAsync(async exec => {
        const blocker = await _taskByRefViaAsync(exec, request.org_id, request.blocker_task_ref);
        const blocked = await _taskByRefViaAsync(exec, request.org_id, request.blocked_task_ref);
        if (!blocker || !blocked) throw new Error("Both tasks of a block must exist.");
        if (blocker.task_id == blocked.task_id) throw new Error("A task cannot block itself.");

        const existing = await exec.getQuery(
            `SELECT * FROM task_relation WHERE org_id=? AND from_task_id=? AND to_task_id=? AND relation_type='blocks' AND resolved_at IS NULL`,
            [request.org_id, blocker.task_id, blocked.task_id]);
        if (existing.length) return existing[0];     // idempotent

        const relation = await _insertRelationViaAsync(exec, {org_id: request.org_id,
            from_task_id: blocker.task_id, to_task_id: blocked.task_id,
            relation_type: RELATIONS.BLOCKS, reason: request.reason,
            created_by: request.actor_person_id});
        if (blocked.status != STATUS.BLOCKED) {
            await exec.runCmd("UPDATE task SET status='blocked', updated_at=? WHERE task_id=?",
                [_now(), blocked.task_id]);
            await _appendEventViaAsync(exec, request.org_id, blocked.task_id, request.actor_person_id,
                "task.status_changed", {from: blocked.status, to: STATUS.BLOCKED, reason: request.reason});
        }
        return relation;
    });
}

/**
 * Lifts a block. The relation keeps its timestamps — "blocked 6 days" stays
 * answerable — and the task's status is left for a person to move, because
 * unblocking is not the same as knowing what the task should be now.
 * @param {object} request {org_id, actor_person_id, blocker_task_ref, blocked_task_ref}
 */
exports.resolveBlockAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "task.edit");
    return await dblayer.runInTransactionAsync(async exec => {
        const blocker = await _taskByRefViaAsync(exec, request.org_id, request.blocker_task_ref);
        const blocked = await _taskByRefViaAsync(exec, request.org_id, request.blocked_task_ref);
        if (!blocker || !blocked) throw new Error("Both tasks of a block must exist.");
        const result = await exec.runCmd(
            `UPDATE task_relation SET resolved_at=? WHERE org_id=? AND from_task_id=? AND to_task_id=?
                AND relation_type='blocks' AND resolved_at IS NULL`,
            [_now(), request.org_id, blocker.task_id, blocked.task_id]);
        await _appendEventViaAsync(exec, request.org_id, blocked.task_id, request.actor_person_id,
            "task.unblocked", {blocker: blocker.task_ref});
        return "unblocked";
    });
}

// ---------------------------------------------------------------------------
// watchers, comments, deletion
// ---------------------------------------------------------------------------

/**
 * @param {object} request {org_id, actor_person_id, task_ref}
 * @returns The watcher edge
 */
exports.addWatcherAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "task.read");
    const task = await _taskByRefViaAsync(null, request.org_id, request.task_ref);
    if (!task) throw new Error(`Task ${request.task_ref} was not found.`);
    const row = {task_watcher_id: serverutils.generateUUID(false), org_id: request.org_id,
        task_id: task.task_id, person_id: request.actor_person_id, created_at: _now()};
    await dblayer.runCmdOrThrow(
        `INSERT INTO task_watcher (task_watcher_id, org_id, task_id, person_id, created_at) VALUES (?,?,?,?,?)`,
        [row.task_watcher_id, row.org_id, row.task_id, row.person_id, row.created_at]);
    return row;
}

/** @param {object} request {org_id, actor_person_id, task_ref} */
exports.removeWatcherAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "task.read");
    const task = await _taskByRefViaAsync(null, request.org_id, request.task_ref);
    if (!task) throw new Error(`Task ${request.task_ref} was not found.`);
    await dblayer.runCmdOrThrow("DELETE FROM task_watcher WHERE task_id=? AND person_id=?",
        [task.task_id, request.actor_person_id]);
    return "unwatched";
}

/**
 * Comments are append-only: there is no edit path. A correction is a new comment.
 * @param {object} request {org_id, actor_person_id, task_ref, body}
 * @returns The comment
 */
exports.addCommentAsync = async function(request) {
    await _requireAsync(request.org_id, request.actor_person_id, "task.read");
    if (!request.body?.trim()) throw new Error("A comment needs a body.");
    const task = await _taskByRefViaAsync(null, request.org_id, request.task_ref);
    if (!task) throw new Error(`Task ${request.task_ref} was not found.`);
    const row = {task_comment_id: serverutils.generateUUID(false), org_id: request.org_id,
        task_id: task.task_id, person_id: request.actor_person_id, body: request.body, created_at: _now()};
    await dblayer.runCmdOrThrow(
        `INSERT INTO task_comment (task_comment_id, org_id, task_id, person_id, body, created_at) VALUES (?,?,?,?,?,?)`,
        [row.task_comment_id, row.org_id, row.task_id, row.person_id, row.body, row.created_at]);
    return row;
}

/**
 * Deletes a task and everything attached to it, audited — H4 logs deletions
 * always, and the audit write failing rolls the deletion back.
 * @param {object} request {org_id, actor_person_id, task_ref}
 */
exports.deleteTaskAsync = async function(request) {
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "task.delete",
        audit: {action: "task.deleted", object_type: "task", object_ref: request.task_ref,
            detail: {task_ref: request.task_ref}},
        action: async exec => {
            const task = await _taskByRefViaAsync(exec, request.org_id, request.task_ref);
            if (!task) throw new Error(`Task ${request.task_ref} was not found.`);
            for (const table of ["task_relation", "task_watcher", "task_comment", "task_event"])
                await exec.runCmd(`DELETE FROM ${table} WHERE ${table == "task_relation" ?
                    "(from_task_id=? OR to_task_id=?)" : "task_id=?"}`,
                    table == "task_relation" ? [task.task_id, task.task_id] : [task.task_id]);
            await exec.runCmd("DELETE FROM task WHERE task_id=?", [task.task_id]);
            return "deleted";
        }});
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function _prepareTask(task, overrides) {
    const row = {task_id: serverutils.generateUUID(false), org_id: task.org_id,
        title: task.title, description: task.description || null, project: task.project || null,
        status: task.status || STATUS.TO_DO, priority: task.priority || PRIORITIES.MEDIUM,
        assignee_person_id: overrides.assignee_person_id ?? task.assignee_person_id ?? null,
        created_by: overrides.created_by, created_at: _now(), updated_at: _now(),
        due_date: task.due_date || null, due_time_minutes: task.due_time_minutes ?? null,
        estimate_minutes: task.estimate_minutes ?? null,
        recurring_rule: task.recurring_rule || null, archived_at: null};

    if (!row.title?.trim()) throw new Error("A task needs a title.");
    if (!Object.values(STATUS).includes(row.status)) throw new Error(
        `Unknown status ${JSON.stringify(row.status)}. Known: ${Object.values(STATUS).join(", ")}.`);
    if (!Object.values(PRIORITIES).includes(row.priority)) throw new Error(
        `Unknown priority ${JSON.stringify(row.priority)}. Known: ${Object.values(PRIORITIES).join(", ")}.`);
    if (row.due_date && !ISO_DATE.test(row.due_date)) throw new Error("due_date must be an ISO calendar date (YYYY-MM-DD).");
    return row;
}

/** TASK-N, sequential per org. Runs inside a transaction, so the serial queue makes it race-free. */
async function _nextTaskRefViaAsync(exec, org_id) {
    const rows = await exec.getQuery("SELECT task_ref FROM task WHERE org_id=?", [org_id]);
    const highest = rows.reduce((max, row) => {
        const n = parseInt(String(row.task_ref).replace("TASK-", ""), 10);
        return Number.isInteger(n) ? Math.max(max, n) : max;
    }, 0);
    return `TASK-${highest + 1}`;
}

async function _insertTaskViaAsync(exec, row) {
    await exec.runCmd(`INSERT INTO task (task_id, org_id, task_ref, title, description, project, status,
        priority, assignee_person_id, created_by, created_at, updated_at, due_date, due_time_minutes,
        estimate_minutes, recurring_rule, archived_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.task_id, row.org_id, row.task_ref, row.title, row.description, row.project, row.status,
            row.priority, row.assignee_person_id, row.created_by, row.created_at, row.updated_at,
            row.due_date, row.due_time_minutes, row.estimate_minutes, row.recurring_rule, row.archived_at]);
}

async function _insertRelationViaAsync(exec, relation) {
    const row = {task_relation_id: serverutils.generateUUID(false), org_id: relation.org_id,
        from_task_id: relation.from_task_id, to_task_id: relation.to_task_id,
        relation_type: relation.relation_type, reason: relation.reason || null,
        created_at: _now(), created_by: relation.created_by || null, resolved_at: null};
    await exec.runCmd(`INSERT INTO task_relation (task_relation_id, org_id, from_task_id, to_task_id,
        relation_type, reason, created_at, created_by, resolved_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [row.task_relation_id, row.org_id, row.from_task_id, row.to_task_id, row.relation_type,
            row.reason, row.created_at, row.created_by, row.resolved_at]);
    return row;
}

async function _appendEventViaAsync(exec, org_id, task_id, actor, action, detail) {
    await exec.runCmd(`INSERT INTO task_event (task_event_id, org_id, task_id, actor_person_id, action, detail, created_at)
        VALUES (?,?,?,?,?,?,?)`,
        [serverutils.generateUUID(false), org_id, task_id, actor || null, action,
            detail ? JSON.stringify(detail) : null, _now()]);
}

async function _taskByRefViaAsync(exec, org_id, task_ref) {
    const rows = exec ? await exec.getQuery("SELECT * FROM task WHERE org_id=? AND task_ref=?",
        [org_id, task_ref]) : await dblayer.getQueryOrThrow("SELECT * FROM task WHERE org_id=? AND task_ref=?",
        [org_id, task_ref]);
    return rows.length ? rows[0] : null;
}

async function _taskByIdViaAsync(exec, task_id) {
    const rows = exec ? await exec.getQuery("SELECT * FROM task WHERE task_id=?", [task_id]) :
        await dblayer.getQueryOrThrow("SELECT * FROM task WHERE task_id=?", [task_id]);
    return rows.length ? rows[0] : null;
}

/** Blocked rows name their blocker, its reason, and how long the block has held. */
async function _withBlockedOnAsync(org_id, rows) {
    const blockedRows = rows.filter(row => row.status == STATUS.BLOCKED);
    if (!blockedRows.length) return rows;
    const placeholders = blockedRows.map(_ => "?").join(",");
    const relations = await dblayer.getQueryOrThrow(
        `SELECT r.*, b.task_ref AS blocker_ref, b.title AS blocker_title, b.assignee_person_id AS blocker_assignee
            FROM task_relation r JOIN task b ON b.task_id=r.from_task_id
            WHERE r.org_id=? AND r.to_task_id IN (${placeholders}) AND r.relation_type='blocks' AND r.resolved_at IS NULL`,
        [org_id, ...blockedRows.map(row => row.task_id)]);
    return rows.map(row => row.status == STATUS.BLOCKED ? {...row,
        blocked_on: relations.filter(relation => relation.to_task_id == row.task_id).map(relation => ({
            blocker: relation.blocker_ref, title: relation.blocker_title,
            reason: relation.reason, since: relation.created_at,
            blocked_seconds: _now() - relation.created_at}))} : row);
}

/** Logged totals by task_ref, counting only the current version of each entry. */
async function _loggedByTaskRefAsync(org_id, rows) {
    const refs = rows.map(row => row.task_ref);
    if (!refs.length) return {};
    const placeholders = refs.map(_ => "?").join(",");
    const sums = await dblayer.getQueryOrThrow(
        `SELECT task_ref, SUM(duration_seconds) AS seconds FROM time_entry_event
            WHERE org_id=? AND task_ref IN (${placeholders})
                AND entry_event_id NOT IN (SELECT supersedes_entry_event_id FROM time_entry_event
                    WHERE org_id=? AND supersedes_entry_event_id IS NOT NULL)
            GROUP BY task_ref`,
        [org_id, ...refs, org_id]);
    return Object.fromEntries(sums.map(row => [row.task_ref, row.seconds]));
}

function _currentLoggedSeconds(events, nowSeconds) {
    const superseded = new Set(events.filter(event => event.supersedes_entry_event_id)
        .map(event => event.supersedes_entry_event_id));
    return events.filter(event => !superseded.has(event.entry_event_id))
        .reduce((sum, event) => sum + event.duration_seconds, 0);
}

exports.STATUS = STATUS;
exports.PRIORITIES = PRIORITIES;
exports.RELATIONS = RELATIONS;
