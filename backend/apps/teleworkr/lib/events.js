/**
 * A10 — the event catalogue and instrumentation. I3 names eight numbers to
 * measure from day one; this is what makes them emittable.
 *
 * Deliberately a separate system from audit.js (H4): that table is
 * append-only, hash-chained, 7-year, per-person — right for a compliance
 * obligation, wrong for disposable product analytics. `product_event` holds
 * no person_id at all, only a derived, non-reversible `person_ref`
 * (sha256 of org_id + person_id + a module-level pepper — not a managed
 * secret, because none exists anywhere in this app layer, and this one
 * doesn't need to be: its job is to keep this table un-joinable to a person
 * by accident, not to defeat an engineer with source access). That absence
 * of a person_id column is also why this table is structurally outside the
 * person-erasure cascade (entityshapes.js/candidateretention.js) — there is
 * nothing in it to delete per person.
 *
 * `emitAsync` must never be called from inside a
 * `dblayer.runInTransactionAsync`/`audit.performAsync` callback — it writes
 * via `dblayer.runCmdBestEffortAsync`, a plain accessor on dblayer's single
 * serial queue, and calling one of those from inside a transaction's own
 * callback is the self-deadlock this session has hit before (K12 slice 1's
 * `executeRetentionRunAsync`; see also wellbeing.js's own note on the same
 * class of bug). Every call site in this app adds the emit call after the
 * surrounding transaction resolves, wrapped in its own try/catch — the same
 * discipline every existing `notifications.notifyAsync` call site already
 * follows, so a failed event write can never fail the real action it
 * measures.
 *
 * `KNOWN_ACTIONS` is A10's own "a metric with no source event is an
 * aspiration" rule, enforced as code: `emitAsync` refuses anything not in
 * it. Retention — 90 days raw, then rolled into `product_event_daily_agg`
 * with the person reference dropped — follows the same on-demand
 * preview/execute shape as every other "run" in this app (J7,
 * `candidateretention.js`): no scheduler exists anywhere in this backend.
 *
 * Narrowed, deliberately: "weekly active use of the overlap board" needs
 * `screen.viewed`, which A10's own "Open" note flags as an unresolved
 * disclosure question ("the thin end of session-level behavioural
 * tracking... needs the same treatment as M1") — not yet resolved anywhere
 * in this app, so it is not emitted. The other 7 of 8 metrics are built in
 * full below.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const crypto = require("crypto");
const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);

const ACTION_NAME = /^[a-z0-9_]+\.[a-z0-9_]+$/;      // A10 object.action naming, lower snake, past tense
const SOURCES = Object.freeze(["web", "mobile", "api", "system"]);
const SCHEMA_VERSION = 1;
const RAW_RETENTION_DAYS = 90;
const DAY_SECONDS = 86400;

// Not a managed secret — none exists anywhere in this app layer. Its only
// job is to keep product_event un-joinable to person by accident.
const PEPPER = "teleworkr-a10-product-events-v1";

/** The mapping table from A10's spec, enforced rather than left as prose. */
const KNOWN_ACTIONS = Object.freeze([
    "account.activated", "timer.started", "time_entry.created", "time_entry.edited",
    "approval.requested", "approval.decided", "task.blocked", "task.unblocked",
    "signal.shown", "signal.muted", "page.published", "page.reviewed"
]);

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);
const _dateOf = epochSeconds => new Date(epochSeconds*1000).toISOString().substring(0, 10);

function _personRef(org_id, person_id) {
    if (!person_id) return null;
    return crypto.createHash("sha256").update(`${org_id}:${person_id}:${PEPPER}`).digest("hex");
}

function _median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length/2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid])/2;
}

async function _requireAsync(org_id, actor_person_id, capability, what) {
    const decision = await permissions.checkAsync({org_id, actor_person_id, capability});
    if (!decision.allowed) throw Object.assign(new Error(`${capability} is required to ${what}.`), {decision});
}

// ---------------------------------------------------------------------------
// emitting
// ---------------------------------------------------------------------------

/**
 * Records one product-analytics event. See the module header for the
 * transaction-boundary rule this depends on.
 * @param {object} event {org_id, action, person_id, occurred_at, source, detail}
 * @throws If the event is invalid, or the write failed
 */
exports.emitAsync = async function(event) {
    if (!event?.org_id) throw new Error("An event needs an org_id.");
    if (!event.action || !ACTION_NAME.test(event.action)) throw new Error(
        `Events use A10 object.action naming, lower snake, past tense — got ${JSON.stringify(event.action)}.`);
    if (!KNOWN_ACTIONS.includes(event.action)) throw new Error(
        `${event.action} is not in the known-events catalogue. A metric with no source event is an aspiration (A10) — register it first.`);
    if (!SOURCES.includes(event.source)) throw new Error(`source must be one of ${SOURCES.join(", ")}.`);

    const row = {event_id: serverutils.generateUUID(false), org_id: event.org_id, action: event.action,
        person_ref: _personRef(event.org_id, event.person_id), occurred_at: event.occurred_at || _now(),
        source: event.source, schema_version: SCHEMA_VERSION,
        detail: (event.detail === undefined || event.detail === null) ? "" : JSON.stringify(event.detail),
        created_at: _now()};

    const ok = await dblayer.runCmdBestEffortAsync(
        `INSERT INTO product_event (event_id, org_id, action, person_ref, occurred_at, source, schema_version, detail, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
        [row.event_id, row.org_id, row.action, row.person_ref, row.occurred_at, row.source,
            row.schema_version, row.detail, row.created_at]);
    if (!ok) throw new Error(`Could not record event ${event.action}.`);
}

// ---------------------------------------------------------------------------
// retention — on-demand preview/execute, like every other run in this app
// ---------------------------------------------------------------------------

/**
 * What a retention run would roll up, right now — no writes.
 * @param {string} org_id The org
 * @param {string} actor_person_id The caller
 * @returns {object} {cutoff_date, rows_to_aggregate, aggregate_preview}
 */
exports.previewRetentionRunAsync = async function(org_id, actor_person_id) {
    await _requireAsync(org_id, actor_person_id, "events.operate", "preview the event retention run");
    const cutoff = _now() - RAW_RETENTION_DAYS*DAY_SECONDS;
    const rows = await dblayer.getQueryOrThrow(
        "SELECT action, occurred_at FROM product_event WHERE org_id=? AND created_at < ?", [org_id, cutoff]);
    return {cutoff_date: _dateOf(cutoff), rows_to_aggregate: rows.length, aggregate_preview: _groupByDateAction(rows)};
}

/**
 * Executes the rollup: raw rows older than the 90-day cutoff are folded into
 * product_event_daily_agg (one row per org/date/action, counts added) and
 * deleted, in one transaction, audited like every other operate capability.
 * @param {string} org_id The org
 * @param {string} actor_person_id The caller
 * @returns {object} {rows_aggregated, run_id}
 */
exports.executeRetentionRunAsync = async function(org_id, actor_person_id) {
    await _requireAsync(org_id, actor_person_id, "events.operate", "execute the event retention run");
    const cutoff = _now() - RAW_RETENTION_DAYS*DAY_SECONDS;
    const run_id = serverutils.generateUUID(false);

    return await audit.performAsync({
        org_id, actor_person_id, capability: "events.operate",
        audit: {action: "events.retention_executed", object_type: "product_event", object_ref: run_id,
            detail: {cutoff_date: _dateOf(cutoff)}},
        action: async exec => {
            const rows = await exec.getQuery(
                "SELECT action, occurred_at FROM product_event WHERE org_id=? AND created_at < ?", [org_id, cutoff]);
            for (const group of _groupByDateAction(rows))
                await exec.runCmd(
                    `INSERT INTO product_event_daily_agg (org_id, event_date, action, event_count) VALUES (?,?,?,?)
                        ON CONFLICT (org_id, event_date, action) DO UPDATE SET event_count = event_count + excluded.event_count`,
                    [org_id, group.event_date, group.action, group.event_count]);
            await exec.runCmd("DELETE FROM product_event WHERE org_id=? AND created_at < ?", [org_id, cutoff]);
            LOG.info(`Event retention run ${run_id} aggregated ${rows.length} row(s) in ${org_id}.`);
            return {rows_aggregated: rows.length, run_id};
        }});
}

function _groupByDateAction(rows) {
    const counts = new Map();
    for (const row of rows) {
        const key = `${_dateOf(row.occurred_at)}|${row.action}`;
        counts.set(key, (counts.get(key)||0) + 1);
    }
    return [...counts.entries()].map(([key, event_count]) => {
        const [event_date, action] = key.split("|");
        return {event_date, action, event_count};
    });
}

// ---------------------------------------------------------------------------
// reading — the 7 built metrics, admin only
// ---------------------------------------------------------------------------

/**
 * I3's eight numbers, minus the one narrowed out above (see module header).
 * @param {string} org_id The org
 * @param {string} actor_person_id The caller
 * @param {object} request {from_date, to_date} — defaults to the last 30 days
 * @returns {object} one field per metric, plus from_date/to_date and a note
 *      on the narrowed metric
 */
exports.summaryAsync = async function(org_id, actor_person_id, request = {}) {
    await _requireAsync(org_id, actor_person_id, "events.read_aggregate", "read product metrics");
    const toDate = request.to_date || _today();
    const fromDate = request.from_date || _dateOf(Math.floor(Date.parse(`${toDate}T00:00:00Z`)/1000) - 29*DAY_SECONDS);
    const fromEpoch = Math.floor(Date.parse(`${fromDate}T00:00:00Z`)/1000);
    const toEpoch = Math.floor(Date.parse(`${toDate}T23:59:59Z`)/1000);

    await audit.writeAsync({org_id, actor_person_id, actor_kind: "person", action: "events.aggregate_read",
        object_type: "product_event", object_ref: org_id, detail: {from_date: fromDate, to_date: toDate}});

    return {from_date: fromDate, to_date: toDate,
        time_to_first_clockin: await _timeToFirstClockInAsync(org_id, fromEpoch, toEpoch),
        timer_vs_reconstructed: await _timerVsReconstructedAsync(org_id, fromEpoch, toEpoch),
        post_submit_edit_rate: await _postSubmitEditRateAsync(org_id, fromEpoch, toEpoch),
        median_approval_latency_seconds: await _approvalLatencyAsync(org_id, fromEpoch, toEpoch),
        median_blocked_duration_seconds: await _blockedDurationAsync(org_id, fromEpoch, toEpoch),
        wellbeing_mute_rate: await _wellbeingMuteRateAsync(org_id, fromEpoch, toEpoch),
        pages_in_review_window: await _pagesInReviewWindowAsync(org_id),
        weekly_overlap_board_use: {note: "No source event yet — screen.viewed is an open disclosure question in A10's own spec (same treatment as M1), not yet resolved."}};
}

async function _rangeRowsAsync(org_id, action, fromEpoch, toEpoch) {
    return await dblayer.getQueryOrThrow(
        "SELECT person_ref, occurred_at, detail FROM product_event WHERE org_id=? AND action=? AND occurred_at BETWEEN ? AND ?",
        [org_id, action, fromEpoch, toEpoch]);
}

async function _allRowsAsync(org_id, action) {
    return await dblayer.getQueryOrThrow(
        "SELECT person_ref, occurred_at, detail FROM product_event WHERE org_id=? AND action=?", [org_id, action]);
}

async function _timeToFirstClockInAsync(org_id, fromEpoch, toEpoch) {
    const activations = await _rangeRowsAsync(org_id, "account.activated", fromEpoch, toEpoch);
    if (!activations.length) return {median_seconds: null, sample_size: 0};
    const starts = await _allRowsAsync(org_id, "timer.started");
    const firstStartByRef = new Map();
    for (const row of starts) {
        if (!row.person_ref) continue;
        const current = firstStartByRef.get(row.person_ref);
        if (current === undefined || row.occurred_at < current) firstStartByRef.set(row.person_ref, row.occurred_at);
    }
    const gaps = [];
    for (const activation of activations) {
        const firstStart = firstStartByRef.get(activation.person_ref);
        if (firstStart !== undefined && firstStart >= activation.occurred_at) gaps.push(firstStart - activation.occurred_at);
    }
    return {median_seconds: _median(gaps), sample_size: gaps.length};
}

async function _timerVsReconstructedAsync(org_id, fromEpoch, toEpoch) {
    const rows = await _rangeRowsAsync(org_id, "time_entry.created", fromEpoch, toEpoch);
    const bySource = {};
    for (const row of rows) {
        const source = (row.detail ? JSON.parse(row.detail) : {}).source || "unknown";
        bySource[source] = (bySource[source]||0) + 1;
    }
    return {total: rows.length, by_source: bySource};
}

async function _postSubmitEditRateAsync(org_id, fromEpoch, toEpoch) {
    const rows = await _rangeRowsAsync(org_id, "time_entry.edited", fromEpoch, toEpoch);
    if (!rows.length) return {rate: null, sample_size: 0};
    const postSubmitCount = rows.filter(row => JSON.parse(row.detail||"{}").post_submit === true).length;
    return {rate: Math.round((postSubmitCount/rows.length)*1000)/1000, sample_size: rows.length};
}

async function _approvalLatencyAsync(org_id, fromEpoch, toEpoch) {
    const requested = await _allRowsAsync(org_id, "approval.requested");
    const requestedByRef = new Map();
    for (const row of requested) {
        const detail = JSON.parse(row.detail||"{}");
        if (detail.leave_request_id) requestedByRef.set(detail.leave_request_id, row.occurred_at);
    }
    const decided = await _rangeRowsAsync(org_id, "approval.decided", fromEpoch, toEpoch);
    const latencies = [];
    for (const row of decided) {
        const detail = JSON.parse(row.detail||"{}");
        const requestedAt = detail.leave_request_id ? requestedByRef.get(detail.leave_request_id) : undefined;
        if (requestedAt !== undefined && row.occurred_at >= requestedAt) latencies.push(row.occurred_at - requestedAt);
    }
    return {median_seconds: _median(latencies), sample_size: latencies.length};
}

async function _blockedDurationAsync(org_id, fromEpoch, toEpoch) {
    const blocked = await _allRowsAsync(org_id, "task.blocked");
    const unblocked = await _rangeRowsAsync(org_id, "task.unblocked", fromEpoch, toEpoch);

    const blockedByTask = new Map();
    for (const row of blocked) {
        const detail = JSON.parse(row.detail||"{}");
        if (!detail.task_id) continue;
        if (!blockedByTask.has(detail.task_id)) blockedByTask.set(detail.task_id, []);
        blockedByTask.get(detail.task_id).push(row.occurred_at);
    }
    for (const starts of blockedByTask.values()) starts.sort((a, b) => a - b);

    const durations = [];
    for (const row of unblocked) {
        const detail = JSON.parse(row.detail||"{}");
        const starts = detail.task_id ? blockedByTask.get(detail.task_id) : null;
        if (!starts) continue;
        let candidate = null;
        for (const startedAt of starts) {if (startedAt <= row.occurred_at) candidate = startedAt; else break;}
        if (candidate !== null) durations.push(row.occurred_at - candidate);
    }
    return {median_seconds: _median(durations), sample_size: durations.length};
}

async function _wellbeingMuteRateAsync(org_id, fromEpoch, toEpoch) {
    const shown = await _rangeRowsAsync(org_id, "signal.shown", fromEpoch, toEpoch);
    const muted = await _rangeRowsAsync(org_id, "signal.muted", fromEpoch, toEpoch);
    if (!shown.length) return {rate: null, shown: 0, muted: muted.length};
    return {rate: Math.round((muted.length/shown.length)*1000)/1000, shown: shown.length, muted: muted.length};
}

/**
 * Computed live against wiki_page state, not from the event log — more
 * accurate, and N4 already carries last_reviewed_at/review_cadence_months
 * there. 'published' mirrors wiki.js's own STATUS.PUBLISHED value.
 */
async function _pagesInReviewWindowAsync(org_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT review_cadence_months, last_reviewed_at FROM wiki_page WHERE org_id=? AND status='published'", [org_id]);
    if (!rows.length) return {rate: null, total_published: 0, in_window: 0};
    const now = _now();
    const inWindow = rows.filter(row => row.last_reviewed_at &&
        (now - row.last_reviewed_at) <= (row.review_cadence_months||0)*30*DAY_SECONDS).length;
    return {rate: Math.round((inWindow/rows.length)*1000)/1000, total_published: rows.length, in_window: inWindow};
}

exports.KNOWN_ACTIONS = KNOWN_ACTIONS;
