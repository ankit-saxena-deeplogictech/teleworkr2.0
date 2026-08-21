/**
 * J7 — the scheduled runs. The policy defines five recurring jobs; three are
 * computable from the systems of record today:
 *
 *   accrual        materialises the monthly accrual rows owed, batch-tagged
 *   lapse          year-end: EL lapses above the carry cap, uncapped types lapse entirely
 *   absence_sweep  2+ consecutive working days with no clock-in and no request — detected and routed, never actioned
 *
 * Comp-off expiry waits for comp-off credits to exist, and the quarterly
 * attendance review waits for the payroll hand-off. Both are honest deferrals,
 * not silent omissions.
 *
 * Every run is preview-able before it executes, idempotent per period, writes
 * batch-tagged ledger rows inside its own transaction, and reverses by negating
 * the batch — never by editing balances (J7 #8).
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);

const DAY_MS = 86400000;
const RUN_KINDS = Object.freeze({ACCRUAL: "accrual", LAPSE: "lapse", ABSENCE_SWEEP: "absence_sweep"});
const RUN_STATUS = Object.freeze({EXECUTED: "executed", REVERSED: "reversed"});

const _now = () => Math.floor(Date.now()/1000);
const _assertISODate = (value, label="date") => {
    if (typeof value != "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new Error(`${label} must be an ISO date (YYYY-MM-DD).`);
    return value;
}
const _assertMonth = value => {
    if (typeof value != "string" || !/^\d{4}-\d{2}$/.test(value))
        throw new Error(`period must be a month (YYYY-MM).`);
    return value;
}
const _monthEnd = period => { const d = new Date(`${period}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return d.toISOString().substring(0, 10); }
const _weekdayOf = dateISO => ((new Date(`${dateISO}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const _datesBetween = (from, to) => {
    const dates = []; const d = new Date(`${from}T00:00:00Z`), end = new Date(`${to}T00:00:00Z`);
    while (d <= end) {dates.push(d.toISOString().substring(0, 10)); d.setUTCDate(d.getUTCDate() + 1);}
    return dates;
}

/** Who a run covers: everyone with employment in force on the as-of date. */
async function _scopePersonIdsAsync(org_id, asOf) {
    const rows = await dblayer.getQueryOrThrow(
        `SELECT DISTINCT person_id FROM employment WHERE org_id=? AND valid_from <= ?
            AND (valid_to IS NULL OR valid_to > ?) AND status NOT IN ('terminated','exited')`,
        [org_id, asOf, asOf]);
    return rows.map(row => row.person_id);
}

/** Accrual rows owed up to asOf that have no row yet. Read-only. */
async function _missingAccrualRowsAsync(org_id, person_id, asOf, batchId) {
    const rows = [];
    const {employment, version} = await leave.policyForPersonAsync(org_id, person_id, asOf);
    if (!employment || !version || ["terminated","exited"].includes(employment.status)) return rows;

    const policy = JSON.parse(version.policy);
    const existing = await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_ledger_entry WHERE org_id=? AND person_id=? AND kind='accrual'",
        [org_id, person_id]);
    const existingKeys = new Set(existing.map(entry => `${entry.leave_type}|${entry.entry_date}`));

    let month = new Date(`${employment.valid_from}T00:00:00Z`);
    const upTo = new Date(`${asOf}T00:00:00Z`);
    while (month <= upTo) {
        const entryDate = `${month.toISOString().substring(0, 7)}-01`;
        for (const type of policy.leave_types.filter(t => t?.accrual?.per_month > 0)) {
            if (existingKeys.has(`${type.code}|${entryDate}`)) continue;
            // no accrual during approved unpaid leave (LWP freezes, J1)
            const freezes = type.accrual.freezes_on || [];
            const frozen = await dblayer.getQueryOrThrow(
                `SELECT * FROM leave_request WHERE org_id=? AND person_id=? AND status='approved'
                    AND leave_type IN (${freezes.map(_ => "?").join(",") || "''"})
                    AND from_date <= ? AND to_date >= ? LIMIT 1`,
                [org_id, person_id, ...freezes, entryDate, entryDate]);
            if (frozen.length) continue;
            rows.push({org_id, person_id, leave_type: type.code, days: type.accrual.per_month,
                kind: "accrual", entry_date: entryDate, policy_version_id: version.policy_version_id,
                reason: "scheduled accrual run", source_request_id: null, recorded_by: null,
                batch_id: batchId});
        }
        month.setUTCMonth(month.getUTCMonth() + 1); month.setUTCDate(1);
    }
    return rows;
}

/** Year-end lapse rows: above the carry cap for capped types, everything for the rest. Read-only. */
async function _lapseRowsAsync(org_id, person_id, asOf, batchId) {
    const rows = [];
    const {employment, version} = await leave.policyForPersonAsync(org_id, person_id, asOf);
    if (!employment || !version || ["terminated","exited"].includes(employment.status)) return rows;

    const policy = JSON.parse(version.policy);
    for (const type of policy.leave_types.filter(t => t.quantum || t.accrual)) {
        const balance = await leave.balanceAsync({org_id, person_id, leave_type: type.code, asOf});
        const cap = type.carry_forward?.cap_days;
        const lapseDays = cap != null ? Math.max(0, balance.available - cap) : balance.available;
        if (lapseDays <= 0) continue;
        rows.push({org_id, person_id, leave_type: type.code, days: -lapseDays, kind: "lapse",
            entry_date: asOf, policy_version_id: balance.policy_version_id,
            reason: `year-end lapse${cap != null ? ` (carry cap ${cap})` : ""}`,
            source_request_id: null, recorded_by: null, batch_id: batchId});
    }
    return rows;
}

/**
 * Absence flags: 2+ consecutive working days with no clock-in and no active
 * leave request. Detection only — the product's job is to detect and route to a
 * human, never to action (J7 #5).
 */
async function _sweepFlagsAsync(org_id, from, to) {
    const persons = await _scopePersonIdsAsync(org_id, to);
    const flags = [];
    for (const person_id of persons) {
        let streak = []; const absent = [];
        for (const date of _datesBetween(from, to)) {
            const window = await windows.windowAsOfAsync(org_id, person_id, date);
            const working = Boolean(window) && JSON.parse(window.days).includes(_weekdayOf(date));
            if (!working) {if (streak.length >= 2) absent.push(...streak); streak = []; continue;}

            const events = await time.eventsForDayAsync(org_id, person_id, date);
            const requests = await dblayer.getQueryOrThrow(
                `SELECT * FROM leave_request WHERE org_id=? AND person_id=? AND status IN ('pending','approved')
                    AND from_date <= ? AND to_date >= ?`,
                [org_id, person_id, date, date]);
            if (!events.some(event => event.started_at) && !requests.length) streak.push(date);
            else {if (streak.length >= 2) absent.push(...streak); streak = [];}
        }
        if (streak.length >= 2) absent.push(...streak);
        if (absent.length) flags.push({person_id, days: [...new Set(absent)].sort()});
    }
    return {scope_count: persons.length, flags};
}

/** The run's facts, computed read-only. batchId tags would-be rows for the executed path. */
async function _computeAsync(request, batchId) {
    const {org_id, kind} = request;
    if (kind == RUN_KINDS.ACCRUAL) {
        const period = _assertMonth(request.period);
        const asOf = _monthEnd(period);
        const persons = await _scopePersonIdsAsync(org_id, asOf);
        const rows = [];
        for (const person_id of persons)
            rows.push(...await _missingAccrualRowsAsync(org_id, person_id, asOf, batchId));
        return {kind, period, as_of: asOf, scope_count: persons.length, affected_count: rows.length,
            policy_version_id: rows[0]?.policy_version_id || null, rows,
            detail: {rows: rows.map(({batch_id, ...rest}) => rest)}};
    }
    if (kind == RUN_KINDS.LAPSE) {
        const asOf = _assertISODate(request.period);
        const persons = await _scopePersonIdsAsync(org_id, asOf);
        const rows = [];
        for (const person_id of persons) rows.push(...await _lapseRowsAsync(org_id, person_id, asOf, batchId));
        return {kind, period: asOf, as_of: asOf, scope_count: persons.length,
            affected_count: rows.length, policy_version_id: rows[0]?.policy_version_id || null, rows,
            detail: {lapses: rows.map(({batch_id, ...rest}) => rest)}};
    }
    if (kind == RUN_KINDS.ABSENCE_SWEEP) {
        const from = _assertISODate(request.period);
        const to = _assertISODate(request.to_date || from, "to_date");
        const sweep = await _sweepFlagsAsync(org_id, from, to);
        return {kind, period: from, to_date: to, scope_count: sweep.scope_count,
            affected_count: sweep.flags.length, policy_version_id: null, rows: [],
            detail: {flags: sweep.flags}};
    }
    throw new Error(`Unknown run kind ${kind}.`);
}

/**
 * The run's facts without writing anything — what J7 shows before "run it".
 * @param {object} request {org_id, actor_person_id, kind, period, to_date}
 * @returns {object} {kind, period, to_date, scope_count, affected_count, detail}
 */
exports.previewRunAsync = async function(request) {
    await permissions.requireAsync({org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "leave_run.operate"});
    const computed = await _computeAsync(request, null);
    return {kind: computed.kind, period: computed.period, to_date: computed.to_date,
        scope_count: computed.scope_count, affected_count: computed.affected_count,
        detail: computed.detail};
}

/**
 * Executes the run: its ledger rows and its run record commit together with the
 * audit entry (A8). Idempotent per period — a second execution is refused until
 * the first is reversed.
 *
 * @param {object} request {org_id, actor_person_id, kind, period, to_date, batch_id}
 * @returns {object} {run_id, kind, period, scope_count, affected_count, batch_id}
 */
exports.executeRunAsync = async function(request) {
    const {org_id, actor_person_id, kind} = request;
    await permissions.requireAsync({org_id, actor_person_id, capability: "leave_run.operate"});
    const batchId = request.batch_id || `run-${serverutils.generateUUID(false)}`;
    const runId = serverutils.generateUUID(false);
    const computed = await _computeAsync(request, batchId);

    return await audit.performAsync({
        org_id, actor_person_id, capability: "leave_run.operate",
        audit: {action: "leave_run.executed", object_type: "leave_run", object_ref: runId,
            detail: {kind, period: computed.period, scope_count: computed.scope_count,
                affected_count: computed.affected_count, batch_id: batchId}},
        action: async exec => {
            const existing = await exec.getQuery(
                "SELECT * FROM leave_run WHERE org_id=? AND kind=? AND period=? AND status='executed'",
                [org_id, kind, computed.period]);
            if (existing.length) throw new Error(
                `A ${kind} run for ${computed.period} is already executed. Reverse it before running it again.`);

            let inserted = 0;
            for (const row of computed.rows || []) {
                if (kind == RUN_KINDS.ACCRUAL) {       // the month may have materialised since the preview
                    const duplicate = await exec.getQuery(
                        `SELECT * FROM leave_ledger_entry WHERE org_id=? AND person_id=? AND leave_type=?
                            AND kind='accrual' AND entry_date=?`,
                        [org_id, row.person_id, row.leave_type, row.entry_date]);
                    if (duplicate.length) continue;
                }
                await leave.insertLedgerEntryAsync(exec, row);
                inserted++;
            }

            const affected = kind == RUN_KINDS.ABSENCE_SWEEP ? computed.affected_count : inserted;
            const detail = {...(computed.detail || {})};
            if (computed.to_date) detail.to_date = computed.to_date;
            await exec.runCmd(`INSERT INTO leave_run (run_id, org_id, kind, period, status, batch_id,
                policy_version_id, scope_count, affected_count, detail, operator_person_id,
                created_at, executed_at, reversed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [runId, org_id, kind, computed.period, RUN_STATUS.EXECUTED, batchId,
                    computed.policy_version_id, computed.scope_count, affected,
                    JSON.stringify(detail), actor_person_id, _now(), _now(), null]);
            return {run_id: runId, kind, period: computed.period, scope_count: computed.scope_count,
                affected_count: affected, batch_id: batchId};
        }});
}

/**
 * Reverses a run by undoing its batch: accrual rows are removed as a unit (the
 * months return to owed-but-unmaterialised, so a later run materialises them
 * again), lapse rows are negated with new entries — never an edit to an
 * existing balance. The run row keeps the history (J7 #8).
 *
 * @param {object} request {org_id, actor_person_id, run_id}
 * @returns {object} {run_id, reversed_entries}
 */
exports.reverseRunAsync = async function(request) {
    const {org_id, actor_person_id, run_id} = request;
    const run = (await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_run WHERE org_id=? AND run_id=?", [org_id, run_id]))[0];
    if (!run) throw new Error(`No run ${run_id}.`);
    if (run.status == RUN_STATUS.REVERSED) throw new Error(`Run ${run_id} is already reversed.`);

    return await audit.performAsync({
        org_id, actor_person_id, capability: "leave_run.operate",
        audit: {action: "leave_run.reversed", object_type: "leave_run", object_ref: run_id,
            detail: {kind: run.kind, period: run.period, batch_id: run.batch_id}},
        action: async exec => {
            const rows = await exec.getQuery(
                `SELECT * FROM leave_ledger_entry WHERE org_id=? AND batch_id=? AND kind IN ('accrual','lapse')`,
                [org_id, run.batch_id]);
            for (const row of rows.filter(row => row.kind == "accrual"))
                await exec.runCmd("DELETE FROM leave_ledger_entry WHERE leave_ledger_entry_id=?",
                    [row.leave_ledger_entry_id]);
            for (const row of rows.filter(row => row.kind == "lapse"))
                await leave.insertLedgerEntryAsync(exec, {
                    org_id: row.org_id, person_id: row.person_id, leave_type: row.leave_type,
                    days: -row.days, kind: "reversal", entry_date: row.entry_date,
                    policy_version_id: row.policy_version_id, reason: "run reversed",
                    source_request_id: null, batch_id: row.batch_id, recorded_by: actor_person_id});
            await exec.runCmd("UPDATE leave_run SET status=?, reversed_at=? WHERE run_id=?",
                [RUN_STATUS.REVERSED, _now(), run_id]);
            return {run_id, reversed_entries: rows.length};
        }});
}

/** The run history, newest first. */
exports.runsAsync = async function(org_id) {
    return await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_run WHERE org_id=? ORDER BY created_at DESC", [org_id]);
}

exports.RUN_KINDS = RUN_KINDS;
exports.RUN_STATUS = RUN_STATUS;
