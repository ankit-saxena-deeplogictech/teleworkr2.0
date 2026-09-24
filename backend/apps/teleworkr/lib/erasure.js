/**
 * L3 — data governance: legal holds, the DPO's request queue, and erasure
 * itself.
 *
 * The pseudonymisation design predates this module: person.pseudonymised_at,
 * declared in 001_spine.sql, "set by L3 erasure; the row survives only as a
 * pseudonym target." Erasure never deletes the person row — it clears its
 * three PII fields (display_name, email, home_timezone; no others exist in
 * this schema) and sets that column. Because the row survives, every other
 * table's person_id keeps resolving, which is why entityshapes.js's
 * PSEUDONYMISE-declared entities need no per-row action here at all: they
 * already point at a person_id that this module alone renders anonymous.
 * Erasure work is only needed for the register's ERASE-declared entities.
 *
 * Scoped to employee erasure. entityshapes.js's own note on `candidate` says
 * K12's consent-extended retention is "a later refinement of this baseline"
 * — candidate-side entities are deliberately outside the curated list below.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const entityshapes = require(`${TELEWORKR_CONSTANTS.LIBDIR}/entityshapes.js`);

const _uuid = _ => serverutils.generateUUID(false);
const _now = _ => Math.floor(Date.now()/1000);

/** Query/write on the supplied transaction executor when given, else on the serial queue — permissions.js's own pattern. */
const _query = (cmd, params, exec) => exec ? exec.getQuery(cmd, params) : dblayer.getQueryOrThrow(cmd, params);
const _run = (cmd, params, exec) => exec ? exec.runCmd(cmd, params) : dblayer.runCmdOrThrow(cmd, params);

const REQUEST_TYPES = Object.freeze(["access", "erasure", "rectification"]);

/**
 * The curated ERASE-declared entities in employee scope, and the column(s)
 * on each table that name the person. K's candidate-side entities and
 * `attachment` (no table yet — G2/Files does not exist) are deliberately
 * excluded; `task` is handled separately below since its erasure is
 * conditional rather than a plain match.
 */
const CURATED_ERASE = Object.freeze([
    {entity: "capability_grant", columns: ["person_id"]},
    {entity: "working_window", columns: ["person_id"]},
    {entity: "task_watcher", columns: ["person_id"]},
    {entity: "task_comment", columns: ["person_id"]},
    {entity: "signal_ledger_entry", columns: ["person_id"]},
    {entity: "signal_threshold_override", columns: ["person_id"]},
    {entity: "signal_mute", columns: ["person_id"]},
    {entity: "signal_share", columns: ["sharer_person_id", "recipient_person_id"]},
    {entity: "wiki_space_member", columns: ["person_id"]},
    {entity: "wiki_share_link", columns: ["created_by"]},
    {entity: "course_progress_event", columns: ["person_id"]},
    {entity: "survey_invitation", columns: ["person_id"]},
    {entity: "notification", columns: ["recipient_person_id"]},
    {entity: "notification_setting", columns: ["person_id"]}
]);

/** Most PSEUDONYMISE-declared tables use person_id; these name the person differently. */
const PSEUDONYMISE_COLUMN_OVERRIDE = Object.freeze({task_event: "actor_person_id", wiki_page: "owner_person_id"});
/** Declared PSEUDONYMISE but with no single person-scoped column to count against — a batch record or a join, not one person's row. */
const PSEUDONYMISE_SKIP = Object.freeze(new Set(["leave_run", "timesheet_entry"]));

// ---------------------------------------------------------------------------
// legal holds
// ---------------------------------------------------------------------------

/** @param {object} request {org_id, actor_person_id, person_id, entity, reason, owner_person_id} */
exports.placeLegalHoldAsync = async function(request) {
    if (!request.reason) throw new Error("A legal hold needs a reason.");
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "data.manage_requests",
        subject_person_id: request.person_id,
        audit: {action: "legal_hold.placed", object_type: "legal_hold", subject_person_id: request.person_id,
            reason: request.reason, detail: {entity: request.entity || null}},
        action: async exec => {
            const hold = {hold_id: _uuid(), org_id: request.org_id, person_id: request.person_id,
                entity: request.entity || null, reason: request.reason,
                owner_person_id: request.owner_person_id || request.actor_person_id,
                placed_at: _now(), placed_by: request.actor_person_id};
            await exec.runCmd(`INSERT INTO legal_hold (hold_id, org_id, person_id, entity, reason, owner_person_id,
                placed_at, placed_by) VALUES (?,?,?,?,?,?,?,?)`,
                [hold.hold_id, hold.org_id, hold.person_id, hold.entity, hold.reason, hold.owner_person_id,
                    hold.placed_at, hold.placed_by]);
            return hold;
        }});
}

/** @param {object} request {org_id, actor_person_id, hold_id} */
exports.releaseLegalHoldAsync = async function(request) {
    const hold = (await dblayer.getQueryOrThrow("SELECT * FROM legal_hold WHERE org_id=? AND hold_id=?",
        [request.org_id, request.hold_id]))[0];
    if (!hold) throw new Error(`No legal hold ${request.hold_id}.`);
    if (hold.released_at) throw new Error("This legal hold was already released.");
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "data.manage_requests",
        subject_person_id: hold.person_id,
        audit: {action: "legal_hold.released", object_type: "legal_hold", object_ref: hold.hold_id,
            subject_person_id: hold.person_id, detail: {entity: hold.entity}},
        action: async exec => {
            const released_at = _now();
            await exec.runCmd("UPDATE legal_hold SET released_at=?, released_by=? WHERE org_id=? AND hold_id=?",
                [released_at, request.actor_person_id, request.org_id, request.hold_id]);
            return {...hold, released_at, released_by: request.actor_person_id};
        }});
}

/** Active holds for a person, or every hold for the org when person_id is omitted. */
exports.legalHoldsAsync = async function(org_id, actor_person_id, person_id) {
    await permissions.requireAsync({org_id, actor_person_id, capability: "data.manage_requests"});
    const sql = person_id ? "SELECT * FROM legal_hold WHERE org_id=? AND person_id=? ORDER BY placed_at DESC"
        : "SELECT * FROM legal_hold WHERE org_id=? ORDER BY placed_at DESC";
    return {holds: await dblayer.getQueryOrThrow(sql, person_id ? [org_id, person_id] : [org_id])};
}

async function _activeHoldsAsync(org_id, person_id, exec) {
    return await _query("SELECT * FROM legal_hold WHERE org_id=? AND person_id=? AND released_at IS NULL",
        [org_id, person_id], exec);
}

/** The first hold — entity-specific or person-wide — that blocks a given entity, or null. */
function _holdBlocking(holds, entity) {
    return holds.find(h => h.entity === null || h.entity === entity) || null;
}

// ---------------------------------------------------------------------------
// the DPO queue
// ---------------------------------------------------------------------------

/** @param {object} request {org_id, actor_person_id, request_type, subject_person_id, requested_by, due_date, notes} */
exports.createDataRequestAsync = async function(request) {
    if (!REQUEST_TYPES.includes(request.request_type)) throw new Error(
        `request_type must be one of ${REQUEST_TYPES.join(", ")}.`);
    if (!request.due_date) throw new Error("A data request needs a due_date — a queue without a deadline column is a queue that misses deadlines.");
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "data.manage_requests",
        subject_person_id: request.subject_person_id,
        audit: {action: "data_request.created", object_type: "data_request", subject_person_id: request.subject_person_id,
            detail: {request_type: request.request_type, due_date: request.due_date}},
        action: async exec => {
            const row = {request_id: _uuid(), org_id: request.org_id, request_type: request.request_type,
                subject_person_id: request.subject_person_id, requested_by: request.requested_by || null,
                status: "open", due_date: request.due_date, notes: request.notes || null,
                created_at: _now(), created_by: request.actor_person_id};
            await exec.runCmd(`INSERT INTO data_request (request_id, org_id, request_type, subject_person_id,
                requested_by, status, due_date, notes, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
                [row.request_id, row.org_id, row.request_type, row.subject_person_id, row.requested_by,
                    row.status, row.due_date, row.notes, row.created_at, row.created_by]);
            return row;
        }});
}

/** @param {object} request {org_id, actor_person_id, request_id, status, notes} status: completed | blocked */
exports.completeDataRequestAsync = async function(request) {
    const row = (await dblayer.getQueryOrThrow("SELECT * FROM data_request WHERE org_id=? AND request_id=?",
        [request.org_id, request.request_id]))[0];
    if (!row) throw new Error(`No data request ${request.request_id}.`);
    if (row.status != "open") throw new Error(`This request is already ${row.status}.`);
    const status = request.status || "completed";
    if (!["completed", "blocked"].includes(status)) throw new Error(`${status} is not a valid completion status.`);
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "data.manage_requests",
        subject_person_id: row.subject_person_id,
        audit: {action: "data_request.completed", object_type: "data_request", object_ref: row.request_id,
            subject_person_id: row.subject_person_id, detail: {status}},
        action: async exec => {
            const completed_at = _now(), notes = request.notes || row.notes;
            await exec.runCmd("UPDATE data_request SET status=?, notes=?, completed_at=?, completed_by=? WHERE org_id=? AND request_id=?",
                [status, notes, completed_at, request.actor_person_id, request.org_id, request.request_id]);
            return {...row, status, notes, completed_at, completed_by: request.actor_person_id};
        }});
}

/** @param {object} options {status} */
exports.dataRequestsAsync = async function(org_id, actor_person_id, options={}) {
    await permissions.requireAsync({org_id, actor_person_id, capability: "data.manage_requests"});
    let sql = "SELECT * FROM data_request WHERE org_id=?", params = [org_id];
    if (options.status) {sql += " AND status=?"; params.push(options.status);}
    sql += " ORDER BY due_date ASC";
    return {requests: await dblayer.getQueryOrThrow(sql, params)};
}

// ---------------------------------------------------------------------------
// erasure — preview and execute
// ---------------------------------------------------------------------------

/**
 * Tasks where the person is both creator and assignee (or the task is
 * unassigned) — the wireframe's "draft tasks... with no other participant"
 * candidate set. Split into erasable (nobody else has commented or is
 * watching) and retained (another participant is involved, so the task
 * stays and is named rather than silently kept without explanation).
 */
async function _taskCandidatesAsync(org_id, person_id, exec) {
    const candidates = await _query(
        `SELECT * FROM task WHERE org_id=? AND created_by=? AND (assignee_person_id=? OR assignee_person_id IS NULL)`,
        [org_id, person_id, person_id], exec);
    const erasable = [], retained = [];
    for (const task of candidates) {
        const otherComment = await _query(
            "SELECT 1 AS x FROM task_comment WHERE task_id=? AND person_id != ? LIMIT 1", [task.task_id, person_id], exec);
        const otherWatcher = await _query(
            "SELECT 1 AS x FROM task_watcher WHERE task_id=? AND person_id != ? LIMIT 1", [task.task_id, person_id], exec);
        if (otherComment.length || otherWatcher.length) retained.push(task); else erasable.push(task);
    }
    return {erasable, retained};
}

/** Counts (and, when not dryRun, deletes) every curated entity's matching rows, split by whether a hold blocks them. */
async function _processCuratedAsync(org_id, person_id, holds, exec, dryRun) {
    const erased = [], blocked = [];
    for (const {entity, columns} of CURATED_ERASE) {
        const where = columns.map(c => `${c}=?`).join(" OR ");
        const params = [org_id, ...columns.map(_ => person_id)];
        const count = (await _query(`SELECT COUNT(*) AS c FROM ${entity} WHERE org_id=? AND (${where})`, params, exec))[0].c;
        if (!count) continue;
        const hold = _holdBlocking(holds, entity);
        if (hold) {blocked.push({entity, count, reason: `Legal hold: ${hold.reason}`}); continue;}
        if (!dryRun) await _run(`DELETE FROM ${entity} WHERE org_id=? AND (${where})`, params, exec);
        erased.push({entity, count});
    }
    return {erased, blocked};
}

/** Same split for `task`, applying the creator+assignee+no-other-participant condition first. */
async function _processTaskAsync(org_id, person_id, holds, exec, dryRun) {
    const {erasable, retained} = await _taskCandidatesAsync(org_id, person_id, exec);
    const erased = [], blocked = [];
    if (retained.length) blocked.push({entity: "task", count: retained.length,
        reason: "Retained — another person has commented on or is watching these tasks."});
    if (erasable.length) {
        const hold = _holdBlocking(holds, "task");
        if (hold) blocked.push({entity: "task", count: erasable.length, reason: `Legal hold: ${hold.reason}`});
        else {
            if (!dryRun) for (const task of erasable) await _run(
                "DELETE FROM task WHERE org_id=? AND task_id=?", [org_id, task.task_id], exec);
            erased.push({entity: "task", count: erasable.length});
        }
    }
    return {erased, blocked};
}

async function _existingTablesAsync(exec) {
    const rows = await _query("SELECT name FROM sqlite_master WHERE type='table'", [], exec);
    return new Set(rows.map(row => row.name));
}

/**
 * Every PSEUDONYMISE-declared entity in the register, counted generically —
 * no hardcoded entity list, so a future module's PSEUDONYMISE entity is
 * picked up automatically as long as it follows the person_id convention.
 * Informational only: pseudonymisation happens by clearing the person row,
 * never by touching these rows.
 */
async function _pseudonymisedCountsAsync(org_id, person_id, exec) {
    const tables = await _existingTablesAsync(exec);
    const result = [];
    for (const [entity, declaration] of Object.entries(entityshapes.REGISTER)) {
        if (declaration.erasure != entityshapes.ERASURE.PSEUDONYMISE) continue;
        if (!tables.has(entity) || PSEUDONYMISE_SKIP.has(entity)) continue;
        const column = PSEUDONYMISE_COLUMN_OVERRIDE[entity] || "person_id";
        const count = (await _query(`SELECT COUNT(*) AS c FROM ${entity} WHERE org_id=? AND ${column}=?`,
            [org_id, person_id], exec))[0].c;
        if (count) result.push({entity, count});
    }
    return result;
}

/**
 * The three-way split the wireframe's erasure panel renders: what would be
 * erased, what is pseudonymised (informational — clearing the person row is
 * what does it), and what a legal hold or a task's other participants block.
 */
exports.previewErasureAsync = async function(org_id, actor_person_id, person_id) {
    await permissions.requireAsync({org_id, actor_person_id, capability: "data.erase"});
    const person = await spine.getPersonAsync(person_id);
    if (!person) throw new Error(`Person ${person_id} was not found.`);

    const holds = await _activeHoldsAsync(org_id, person_id);
    const curated = await _processCuratedAsync(org_id, person_id, holds, null, true);
    const taskResult = await _processTaskAsync(org_id, person_id, holds, null, true);
    const pseudonymised = await _pseudonymisedCountsAsync(org_id, person_id, null);

    return {person_id, already_pseudonymised: !!person.pseudonymised_at,
        erased: [...curated.erased, ...taskResult.erased],
        pseudonymised, blocked: [...curated.blocked, ...taskResult.blocked]};
}

/**
 * Executes the erasure — irreversible, step-up gated, reason required.
 * The precheck re-confirms the person isn't already pseudonymised, matching
 * N3's re-scan pattern: content can change between preview and execute. The
 * curated deletes and the person-row clear happen in one transaction with
 * the erasure_run record, so a failed write leaves nothing half-erased.
 *
 * @param {object} request {org_id, actor_person_id, person_id, reason, step_up_verified}
 */
exports.executeErasureAsync = async function(request) {
    const person = await spine.getPersonAsync(request.person_id);
    if (!person) throw new Error(`Person ${request.person_id} was not found.`);
    if (person.pseudonymised_at) throw new Error(`${request.person_id} was already erased.`);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "data.erase",
        subject_person_id: request.person_id, reason: request.reason, step_up_verified: request.step_up_verified,
        precheck: async () => {
            const current = await spine.getPersonAsync(request.person_id);
            return !!current && !current.pseudonymised_at;
        },
        audit: {action: "person.erased", object_type: "person", object_ref: request.person_id,
            subject_person_id: request.person_id, reason: request.reason, detail: {}},
        action: async exec => {
            const holds = await _activeHoldsAsync(request.org_id, request.person_id, exec);
            const curated = await _processCuratedAsync(request.org_id, request.person_id, holds, exec, false);
            const taskResult = await _processTaskAsync(request.org_id, request.person_id, holds, exec, false);
            const pseudonymised = await _pseudonymisedCountsAsync(request.org_id, request.person_id, exec);

            await exec.runCmd(
                "UPDATE person SET display_name=NULL, email=NULL, home_timezone=NULL, pseudonymised_at=? WHERE person_id=?",
                [_now(), request.person_id]);

            const erased = [...curated.erased, ...taskResult.erased];
            const blocked = [...curated.blocked, ...taskResult.blocked];
            const run = {erasure_run_id: _uuid(), org_id: request.org_id, person_id: request.person_id,
                operator_person_id: request.actor_person_id, reason: request.reason, executed_at: _now(),
                erased, pseudonymised, blocked};
            await exec.runCmd(`INSERT INTO erasure_run (erasure_run_id, org_id, person_id, operator_person_id,
                reason, executed_at, erased, pseudonymised, blocked) VALUES (?,?,?,?,?,?,?,?,?)`,
                [run.erasure_run_id, run.org_id, run.person_id, run.operator_person_id, run.reason, run.executed_at,
                    JSON.stringify(erased), JSON.stringify(pseudonymised), JSON.stringify(blocked)]);

            return run;
        }});
}
