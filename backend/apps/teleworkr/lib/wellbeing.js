/**
 * M — wellbeing & load.
 *
 * Same architecture as J1 and K1, deliberately (M1): a versioned signal
 * definition with a published pointer, one evaluator, an append-only signal
 * ledger — status is never stored, only what the evaluator wrote each night.
 *
 * The module's one hard constraint is "no new collection": every signal
 * below reads data this schema already holds for another reason —
 * timesheets and clock (`time.js`), declared windows (`windows.js`), the
 * leave ledger (`leave.js`), task dependencies (`tasks.js`). Two signals the
 * wireframe specifies are not built here because nothing in this app
 * produces their input: fragmentation (no focus-block/calendar-event system
 * exists) and guardrail breaches (C6 statutory rest/break rules are
 * themselves deliberately absent — see `time.js`'s own header: "needs a
 * legal and HR decision before build"). Building either would mean
 * inventing the very data a signal is supposed to read — the thing M1 exists
 * to refuse ("a proposed signal with no source in that column is a proposal
 * for new surveillance").
 *
 * Two things this module needed that nothing else had defined:
 *   - `employment.contracted_pattern` is opaque JSON nothing else parses.
 *     This module reads `{hours_per_week}`, defaulting to 40 when absent or
 *     unparseable — a documented assumption, not a silent one.
 *   - No "leave year" anchor exists anywhere. "Leave not taken" uses the
 *     calendar year, the same convention `leave.js`'s own
 *     `_clubbingWindowId` already uses for `per_calendar_year` clubbing.
 *
 * The escalation ladder (M4) is two real steps and a third that is a plain
 * fact, not a notification: "show" is always true once lit (surfaced by
 * `myLoadAsync`); "suggest" is the one `wellbeing_signal` notification fired
 * on the night a signal newly lights (the category was already stubbed in
 * `notifications.js`'s catalogue, unused, before this module existed);
 * "offer" is derived at read time once a signal has stayed lit past its
 * definition's `offer_after_days` — routed to HR by name
 * (`hrContactsAsync`), never a fictional EAP integration. The system never
 * advances past that on its own: consent (sharing a summary) is always a
 * person's own action (`shareSummaryAsync`).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const notifications = require(`${TELEWORKR_CONSTANTS.LIBDIR}/notifications.js`);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MINIMUM_COHORT = 5;
const DEFAULT_HOURS_PER_WEEK = 40;
const DAY_SECONDS = 86400;

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);
const _uuid = _ => serverutils.generateUUID(false);

// ---------------------------------------------------------------------------
// the 5 real signals — definition, and the "primary" key an override tightens
// ---------------------------------------------------------------------------

const SIGNAL_SPECS = Object.freeze({
    sustained_load: {label: "Sustained load", primary_key: "percent_over",
        default_threshold: {percent_over: 15, window_weeks: 3}, threshold_keys: ["percent_over", "window_weeks"]},
    no_recovery: {label: "No recovery", primary_key: "consecutive_days",
        default_threshold: {consecutive_days: 12}, threshold_keys: ["consecutive_days"]},
    out_of_window: {label: "Out-of-window work", primary_key: "days_per_fortnight",
        default_threshold: {days_per_fortnight: 4}, threshold_keys: ["days_per_fortnight"]},
    leave_not_taken: {label: "Leave not taken", primary_key: "unused_percent",
        default_threshold: {unused_percent: 60, check_after_day_of_year: 182}, threshold_keys: ["unused_percent", "check_after_day_of_year"]},
    blocked_drag: {label: "Blocked drag", primary_key: "percent",
        default_threshold: {percent: 20}, threshold_keys: ["percent"]}
});
const SIGNAL_CODES = Object.freeze(Object.keys(SIGNAL_SPECS));
const DEFAULT_LADDER = Object.freeze({offer_after_days: 14});

// never-measured list (M1 item 5) — published in-product, not a policy paragraph
const NEVER_MEASURED = Object.freeze([
    "Keystrokes", "Mouse movement", "Screen contents or screenshots",
    "Camera or attention detection", "Sentiment or tone analysis of anything written",
    "Message content of any kind", "Health, fitness or wearable data",
    "Anything typed into a mood tracker"
]);

const _assertISODate = (date, label="date") => {
    if (typeof date != "string" || !ISO_DATE.test(date)) throw new Error(
        `${label} must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(date)}.`);
    return date;
}

async function _requireReadOwnAsync(org_id, actor_person_id, what) {
    // SELF-scoped coverage needs a subject to compare against, even though the
    // subject here is always the actor themselves — `checkAsync` with no
    // subject_person_id can never satisfy SCOPES.SELF's coverage test.
    const decision = await permissions.checkAsync({org_id, actor_person_id,
        subject_person_id: actor_person_id, capability: "wellbeing.read_own"});
    if (!decision.allowed) throw Object.assign(new Error(`wellbeing.read_own is required to ${what}.`), {decision});
}

// ---------------------------------------------------------------------------
// M1 — signal definitions: versioned, HR-owned, mirrors publishWorkflowAsync
// ---------------------------------------------------------------------------

function _validateDefinition(signal_code, threshold, ladder) {
    const spec = SIGNAL_SPECS[signal_code];
    if (!spec) throw new Error(`Unknown signal_code ${JSON.stringify(signal_code)}. Known: ${SIGNAL_CODES.join(", ")}.`);
    const unknownKeys = Object.keys(threshold||{}).filter(key => !spec.threshold_keys.includes(key));
    if (unknownKeys.length) throw new Error(
        `${signal_code}'s threshold does not use ${unknownKeys.join(", ")}. Known: ${spec.threshold_keys.join(", ")}.`);
    for (const key of spec.threshold_keys) if (threshold?.[key] === undefined) throw new Error(
        `${signal_code}'s threshold needs ${key}.`);
    if (!Number.isInteger(ladder?.offer_after_days) || ladder.offer_after_days <= 0) throw new Error(
        "ladder.offer_after_days must be a positive integer.");
}

/**
 * Publishes a signal definition version. Versions are immutable; supersession
 * moves the pointer and never edits a published version — same discipline as
 * `recruitment.publishWorkflowAsync`.
 *
 * @param {object} request {org_id, actor_person_id, signal_code, threshold, ladder}
 * @returns {object} {signal_definition_id, version}
 */
exports.publishSignalDefinitionAsync = async function(request) {
    _validateDefinition(request.signal_code, request.threshold, request.ladder);
    const spec = SIGNAL_SPECS[request.signal_code];

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "wellbeing.publish_signal",
        audit: {action: "wellbeing.signal_published", object_type: "signal_definition",
            object_ref: request.signal_code, detail: {threshold: request.threshold, ladder: request.ladder}},

        action: async exec => {
            const current = await exec.getQuery(
                "SELECT * FROM signal_definition_pointer WHERE org_id=? AND signal_code=?",
                [request.org_id, request.signal_code]);
            const versions = await exec.getQuery(
                "SELECT MAX(version) AS max FROM signal_definition WHERE org_id=? AND signal_code=?",
                [request.org_id, request.signal_code]);
            const versionNumber = (versions[0].max || 0) + 1;

            const row = {signal_definition_id: _uuid(), org_id: request.org_id, signal_code: request.signal_code,
                version: versionNumber, status: "published", label: spec.label,
                threshold: JSON.stringify(request.threshold), ladder: JSON.stringify(request.ladder),
                published_at: _now(), published_by: request.actor_person_id,
                created_at: _now(), created_by: request.actor_person_id};
            await exec.runCmd(`INSERT INTO signal_definition (signal_definition_id, org_id, signal_code, version,
                    status, label, threshold, ladder, published_at, published_by, created_at, created_by)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                [row.signal_definition_id, row.org_id, row.signal_code, row.version, row.status, row.label,
                    row.threshold, row.ladder, row.published_at, row.published_by, row.created_at, row.created_by]);
            if (current.length) await exec.runCmd(
                "UPDATE signal_definition SET status='superseded' WHERE signal_definition_id=?",
                [current[0].signal_definition_id]);
            await exec.runCmd(
                `INSERT INTO signal_definition_pointer (org_id, signal_code, signal_definition_id, updated_at)
                    VALUES (?,?,?,?)
                    ON CONFLICT (org_id, signal_code) DO UPDATE SET signal_definition_id=excluded.signal_definition_id,
                        updated_at=excluded.updated_at`,
                [request.org_id, request.signal_code, row.signal_definition_id, _now()]);

            return {signal_definition_id: row.signal_definition_id, version: versionNumber};
        }});
}

/** Current published definitions, every signal_code — publishes defaults for any not yet published. */
exports.signalDefinitionsAsync = async function(org_id, actor_person_id) {
    await _requireReadOwnAsync(org_id, actor_person_id, "read signal definitions");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT d.* FROM signal_definition_pointer p JOIN signal_definition d ON d.signal_definition_id = p.signal_definition_id
            WHERE p.org_id=?`, [org_id]);
    const bySignal = Object.fromEntries(rows.map(row => [row.signal_code, row]));
    return {signals: SIGNAL_CODES.map(signal_code => {
        const row = bySignal[signal_code];
        return row ? {signal_code, version: row.version, label: row.label,
                threshold: JSON.parse(row.threshold), ladder: JSON.parse(row.ladder), published_at: row.published_at} :
            {signal_code, version: 0, label: SIGNAL_SPECS[signal_code].label,
                threshold: SIGNAL_SPECS[signal_code].default_threshold, ladder: DEFAULT_LADDER, published_at: null};
    }), never_measured: NEVER_MEASURED};
}

async function _publishedDefinitionAsync(org_id, signal_code) {
    const pointer = await dblayer.getQueryOrThrow(
        "SELECT * FROM signal_definition_pointer WHERE org_id=? AND signal_code=?", [org_id, signal_code]);
    if (!pointer.length) return {signal_definition_id: null, version: 0,
        threshold: SIGNAL_SPECS[signal_code].default_threshold, ladder: DEFAULT_LADDER};
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM signal_definition WHERE signal_definition_id=?", [pointer[0].signal_definition_id]);
    const row = rows[0];
    return {signal_definition_id: row.signal_definition_id, version: row.version,
        threshold: JSON.parse(row.threshold), ladder: JSON.parse(row.ladder)};
}

/** The published threshold, tightened by the person's own override if one is stricter and present. */
async function _effectiveThresholdAsync(org_id, person_id, signal_code, published) {
    const overrides = await dblayer.getQueryOrThrow(
        "SELECT * FROM signal_threshold_override WHERE org_id=? AND person_id=? AND signal_code=?",
        [org_id, person_id, signal_code]);
    if (!overrides.length) return published;
    const overridden = JSON.parse(overrides[0].threshold);
    const spec = SIGNAL_SPECS[signal_code];
    return {...published, [spec.primary_key]: overridden[spec.primary_key]};
}

/**
 * Sets a personal threshold override — tighten only, never loosen (M1 item
 * 6). Only the signal's one "primary" number can be overridden; every other
 * threshold field stays the published default.
 * @param {object} request {org_id, person_id, signal_code, value}
 */
exports.setThresholdOverrideAsync = async function(request) {
    const spec = SIGNAL_SPECS[request.signal_code];
    if (!spec) throw new Error(`Unknown signal_code ${JSON.stringify(request.signal_code)}.`);
    if (!Number.isFinite(request.value) || request.value < 0) throw new Error(
        `${spec.primary_key} must be a non-negative number.`);
    const published = await _publishedDefinitionAsync(request.org_id, request.signal_code);
    if (request.value > published.threshold[spec.primary_key]) throw new Error(
        `A personal threshold can only be stricter than the published default (${spec.primary_key} ` +
        `${published.threshold[spec.primary_key]}) — tighten only, never loosen (M1).`);

    await dblayer.runCmdOrThrow(
        `INSERT INTO signal_threshold_override (override_id, org_id, person_id, signal_code, threshold, created_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT (org_id, person_id, signal_code) DO UPDATE SET threshold=excluded.threshold, created_at=excluded.created_at`,
        [_uuid(), request.org_id, request.person_id, request.signal_code,
            JSON.stringify({[spec.primary_key]: request.value}), _now()]);
    return {signal_code: request.signal_code, [spec.primary_key]: request.value};
}

exports.clearThresholdOverrideAsync = async function(org_id, person_id, signal_code) {
    await dblayer.runCmdOrThrow(
        "DELETE FROM signal_threshold_override WHERE org_id=? AND person_id=? AND signal_code=?",
        [org_id, person_id, signal_code]);
    return "cleared";
}

// ---------------------------------------------------------------------------
// M1 — the evaluator: nightly, idempotent per person per day (runs.js's J7 pattern)
// ---------------------------------------------------------------------------

/** {hours_per_week} — the shape this module defines for the opaque contracted_pattern JSON. */
function _contractedHoursPerWeek(employment) {
    if (!employment?.contracted_pattern) return DEFAULT_HOURS_PER_WEEK;
    try {
        const parsed = typeof employment.contracted_pattern == "string" ?
            JSON.parse(employment.contracted_pattern) : employment.contracted_pattern;
        return Number.isFinite(parsed?.hours_per_week) && parsed.hours_per_week > 0 ?
            parsed.hours_per_week : DEFAULT_HOURS_PER_WEEK;
    } catch (err) {return DEFAULT_HOURS_PER_WEEK;}
}

/** This person's time_entry_event rows in [fromISO, toISO], current versions only. */
async function _eventsInRangeAsync(org_id, person_id, fromISO, toISO) {
    const events = await dblayer.getQueryOrThrow(
        "SELECT * FROM time_entry_event WHERE org_id=? AND person_id=? AND entry_date >= ? AND entry_date <= ?",
        [org_id, person_id, fromISO, toISO]);
    return time.currentEvents(events);
}

function _isoDaysAgo(fromISO, days) {
    const d = new Date(`${fromISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().substring(0, 10);
}
function _isoAddDays(fromISO, days) {
    const d = new Date(`${fromISO}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().substring(0, 10);
}
function _dayOfYear(iso) {
    const start = Date.parse(`${iso.substring(0,4)}-01-01T00:00:00Z`);
    return Math.floor((Date.parse(`${iso}T00:00:00Z`) - start)/DAY_SECONDS/1000) + 1;
}

/** Weekly hour totals for the trailing N weeks ending on (and including) evaluated_for's week. */
async function _weeklyHoursAsync(org_id, person_id, evaluated_for, weeks) {
    const from = _isoDaysAgo(evaluated_for, weeks*7 - 1);
    const events = await _eventsInRangeAsync(org_id, person_id, from, evaluated_for);
    const byWeek = {};
    for (const event of events) {
        const weekStart = time.weekStartOf(event.entry_date);
        byWeek[weekStart] = (byWeek[weekStart] || 0) + (event.duration_seconds || 0);
    }
    return Object.entries(byWeek).sort(([a], [b]) => a < b ? -1 : 1)
        .map(([week_start, seconds]) => ({week_start, hours: Math.round(seconds/3600*10)/10}));
}

async function _evalSustainedLoad(org_id, person_id, employment, evaluated_for, threshold) {
    const weeks = await _weeklyHoursAsync(org_id, person_id, evaluated_for, threshold.window_weeks);
    if (!weeks.length) return {lit: false, inputs: {weeks: []}};
    const avg = weeks.reduce((sum, w) => sum + w.hours, 0) / weeks.length;
    const contracted = _contractedHoursPerWeek(employment);
    const lit = avg > contracted * (1 + threshold.percent_over/100);
    return {lit, inputs: {avg_weekly_hours: Math.round(avg*10)/10, contracted_hours_per_week: contracted, weeks}};
}

async function _evalNoRecovery(org_id, person_id, evaluated_for, threshold) {
    const lookback = threshold.consecutive_days + 14;   // enough runway to find where the streak actually started
    const events = await _eventsInRangeAsync(org_id, person_id, _isoDaysAgo(evaluated_for, lookback), evaluated_for);
    const daysWithTime = new Set(events.filter(e => (e.duration_seconds||0) > 0).map(e => e.entry_date));
    let streak = 0, cursor = evaluated_for;
    while (daysWithTime.has(cursor) && streak <= lookback) {streak++; cursor = _isoDaysAgo(cursor, 1);}
    return {lit: streak >= threshold.consecutive_days, inputs: {streak_days: streak, last_day_off: streak < lookback ? cursor : null}};
}

async function _evalOutOfWindow(org_id, person_id, evaluated_for, threshold) {
    const from = _isoDaysAgo(evaluated_for, 13);
    const events = (await _eventsInRangeAsync(org_id, person_id, from, evaluated_for)).filter(e => e.started_at);
    const outDays = new Set();
    for (const event of events) {
        const check = await windows.withinWindowAtAsync(org_id, person_id, event.started_at);
        if (!check.within) outDays.add(event.entry_date);
    }
    return {lit: outDays.size >= threshold.days_per_fortnight,
        inputs: {out_of_window_days: outDays.size, window_days: 14}};
}

async function _evalLeaveNotTaken(org_id, person_id, evaluated_for, threshold) {
    const {version} = await leave.policyForPersonAsync(org_id, person_id, evaluated_for);
    if (!version) return {lit: false, inputs: {reason: "no_policy"}};
    const policy = JSON.parse(version.policy);
    const type = policy.leave_types.find(t => t.quantum?.annual_days);
    if (!type) return {lit: false, inputs: {reason: "no_annual_type"}};
    const balance = await leave.balanceAsync({org_id, person_id, leave_type: type.code, asOf: evaluated_for});
    const unusedPercent = type.quantum.annual_days > 0 ? (balance.available/type.quantum.annual_days)*100 : 0;
    const dayOfYear = _dayOfYear(evaluated_for);
    const lit = unusedPercent > threshold.unused_percent && dayOfYear > threshold.check_after_day_of_year;
    return {lit, inputs: {leave_type: type.code, available: balance.available, annual_days: type.quantum.annual_days,
        unused_percent: Math.round(unusedPercent), day_of_year: dayOfYear}};
}

async function _evalBlockedDrag(org_id, person_id, threshold) {
    const load = await tasks.blockedLoadForPersonAsync(org_id, person_id);
    if (load.ratio == null) return {lit: false, inputs: {open_seconds: 0}};
    const percent = load.ratio*100;
    return {lit: percent > threshold.percent,
        inputs: {blocked_seconds: load.blocked_seconds, open_seconds: load.open_seconds, percent: Math.round(percent)}};
}

async function _evaluateOneAsync(org_id, person_id, employment, evaluated_for, signal_code, definition) {
    const threshold = await _effectiveThresholdAsync(org_id, person_id, signal_code, definition.threshold);
    if (signal_code == "sustained_load") return _evalSustainedLoad(org_id, person_id, employment, evaluated_for, threshold);
    if (signal_code == "no_recovery") return _evalNoRecovery(org_id, person_id, evaluated_for, threshold);
    if (signal_code == "out_of_window") return _evalOutOfWindow(org_id, person_id, evaluated_for, threshold);
    if (signal_code == "leave_not_taken") return _evalLeaveNotTaken(org_id, person_id, evaluated_for, threshold);
    if (signal_code == "blocked_drag") return _evalBlockedDrag(org_id, person_id, threshold);
    throw new Error(`No evaluator for ${signal_code}.`);
}

/** Shared by preview and execute — computes every person's every not-yet-evaluated signal, writes nothing. */
async function _computeNightAsync(org_id, evaluated_for) {
    const roster = await spine.rosterAsOfAsync(org_id, evaluated_for);
    const definitions = {};
    for (const signal_code of SIGNAL_CODES) definitions[signal_code] = await _publishedDefinitionAsync(org_id, signal_code);

    const already = await dblayer.getQueryOrThrow(
        "SELECT person_id, signal_code FROM signal_ledger_entry WHERE org_id=? AND evaluated_for=?",
        [org_id, evaluated_for]);
    const doneKeys = new Set(already.map(row => `${row.person_id}|${row.signal_code}`));

    const entries = [];
    for (const person of roster) {
        const employment = await spine.employmentAsOfAsync(org_id, person.person_id, evaluated_for);
        for (const signal_code of SIGNAL_CODES) {
            if (doneKeys.has(`${person.person_id}|${signal_code}`)) continue;
            const definition = definitions[signal_code];
            const {lit, inputs} = await _evaluateOneAsync(org_id, person.person_id, employment,
                evaluated_for, signal_code, definition);
            const previous = (await dblayer.getQueryOrThrow(
                `SELECT * FROM signal_ledger_entry WHERE org_id=? AND person_id=? AND signal_code=?
                    ORDER BY evaluated_for DESC LIMIT 1`, [org_id, person.person_id, signal_code]))[0];
            const wasLit = previous?.lit == 1;
            entries.push({person_id: person.person_id, signal_code, signal_definition_id: definition.signal_definition_id,
                lit, since: lit ? (wasLit ? previous.since : evaluated_for) : null, inputs, newly_lit: lit && !wasLit});
        }
    }
    return {roster: roster.length, entries};
}

/**
 * Computes the night's evaluation without writing anything — same contract
 * as `runs.previewRunAsync`.
 * @param {object} request {org_id, actor_person_id, evaluated_for}
 */
exports.previewSignalEvaluationAsync = async function(request) {
    await permissions.requireAsync({org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "wellbeing.publish_signal"});
    const evaluated_for = request.evaluated_for || _today();
    _assertISODate(evaluated_for, "evaluated_for");
    const computed = await _computeNightAsync(request.org_id, evaluated_for);
    return {evaluated_for, people: computed.roster, lit_count: computed.entries.filter(e => e.lit).length,
        new_lit_count: computed.entries.filter(e => e.newly_lit).length, entries: computed.entries};
}

/**
 * The nightly run, executed. Idempotent per (person, signal_code,
 * evaluated_for) — a re-trigger the same night writes nothing twice. On a
 * new lit transition (wasn't lit the previous evaluated night, is lit now)
 * and not muted, raises the already-catalogued `wellbeing_signal`
 * notification — M4's "Suggest" step. Ledger rows and the audit entry
 * commit together (A8), same discipline as `runs.executeRunAsync`.
 *
 * @param {object} request {org_id, actor_person_id, evaluated_for}
 * @returns {object} {evaluated_for, batch_tag, people, lit_count, new_lit_count}
 */
exports.evaluateSignalsAsync = async function(request) {
    const evaluated_for = request.evaluated_for || _today();
    _assertISODate(evaluated_for, "evaluated_for");
    const batch_tag = `${evaluated_for}-${_uuid().slice(0, 8)}`;

    const result = await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "wellbeing.publish_signal",
        audit: {action: "wellbeing.signals_evaluated", object_type: "signal_ledger_entry", object_ref: evaluated_for,
            detail: {evaluated_for, batch_tag}},
        action: async exec => {
            const computed = await _computeNightAsync(request.org_id, evaluated_for);
            for (const entry of computed.entries) {
                const id = _uuid();
                await exec.runCmd(
                    `INSERT INTO signal_ledger_entry (signal_ledger_entry_id, org_id, person_id, signal_code,
                        signal_definition_id, lit, since, inputs, evaluated_for, evaluated_at, batch_tag)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                    [id, request.org_id, entry.person_id, entry.signal_code, entry.signal_definition_id,
                        entry.lit ? 1 : 0, entry.since, JSON.stringify(entry.inputs), evaluated_for, _now(), batch_tag]);
            }
            return {people: computed.roster, lit_count: computed.entries.filter(e => e.lit).length,
                new_lit_count: computed.entries.filter(e => e.newly_lit).length,
                newly_lit: computed.entries.filter(e => e.newly_lit)};
        }});

    for (const entry of result.newly_lit)
        if (!(await _isMutedAsync(request.org_id, entry.person_id, entry.signal_code, evaluated_for)))
            await notifications.notifyAsync({org_id: request.org_id, category: "wellbeing_signal",
                recipient_person_id: entry.person_id, object_ref: entry.signal_code,
                payload: {signal_code: entry.signal_code, label: SIGNAL_SPECS[entry.signal_code].label}});

    return {evaluated_for, batch_tag, people: result.people, lit_count: result.lit_count, new_lit_count: result.new_lit_count};
}

async function _isMutedAsync(org_id, person_id, signal_code, asOf) {
    const rows = await dblayer.getQueryOrThrow(
        `SELECT * FROM signal_mute WHERE org_id=? AND person_id=? AND muted_until >= ?
            AND (signal_code IS NULL OR signal_code=?)`, [org_id, person_id, asOf, signal_code]);
    return rows.length > 0;
}

// ---------------------------------------------------------------------------
// M2 — my load, private by default
// ---------------------------------------------------------------------------

const ACTION_FOR = Object.freeze({
    sustained_load: {label: "Book leave", screen: "leave"},
    no_recovery: {label: "Book leave", screen: "leave"},
    out_of_window: {label: "Edit your window", screen: "calendar"},
    leave_not_taken: {label: "Book leave", screen: "leave"},
    blocked_drag: {label: "Review your blocked tasks", screen: "tasks"}
});

/**
 * The person's own view: last 4 weeks of hours, lit signals with their
 * causes and one real action link each, and the escalation step each lit
 * signal has reached. "Not enough history" below 4 weeks of employment.
 *
 * Composition is narrower than the wireframe's meetings/focused/blocked/
 * out-of-window four-way split — this app has no generic "meeting" category
 * on a time entry (only recruitment panels and training modules are
 * tagged), so a "meetings" bucket would be fabricated. What's shown instead
 * is what the data actually distinguishes: total hours, out-of-window
 * hours, and blocked-task time (a task state, not a slice of logged time,
 * so it is reported alongside rather than folded into the same total).
 *
 * @param {string} org_id The org
 * @param {string} person_id The person (self only — the caller's own id)
 * @returns {object} {enough_history, weeks, out_of_window_seconds, blocked,
 *      signals: [{signal_code, label, lit, since, days_lit, ladder_step,
 *          inputs, action, offer}], shares_received, muted}
 */
exports.myLoadAsync = async function(org_id, person_id) {
    await _requireReadOwnAsync(org_id, person_id, "read your own load");
    const today = _today();
    const employment = await spine.getOpenEmploymentAsync(org_id, person_id);
    const weeksOfHistory = employment ? Math.floor((_now() - Date.parse(`${employment.valid_from}T00:00:00Z`)/1000)/(7*DAY_SECONDS)) : 0;
    if (weeksOfHistory < 4) return {enough_history: false, weeks: [], signals: []};

    const weeks = await _weeklyHoursAsync(org_id, person_id, today, 4);
    const events = (await _eventsInRangeAsync(org_id, person_id, _isoDaysAgo(today, 27), today)).filter(e => e.started_at);
    let outOfWindowSeconds = 0;
    for (const event of events) {
        const check = await windows.withinWindowAtAsync(org_id, person_id, event.started_at);
        if (!check.within) outOfWindowSeconds += event.duration_seconds || 0;
    }
    const blocked = await tasks.blockedLoadForPersonAsync(org_id, person_id);

    const latestBySignal = await dblayer.getQueryOrThrow(
        `SELECT * FROM signal_ledger_entry WHERE org_id=? AND person_id=? AND evaluated_for=(
            SELECT MAX(evaluated_for) FROM signal_ledger_entry WHERE org_id=? AND person_id=? AND signal_code=signal_ledger_entry.signal_code)`,
        [org_id, person_id, org_id, person_id]);
    const definitions = {};
    for (const signal_code of SIGNAL_CODES) definitions[signal_code] = await _publishedDefinitionAsync(org_id, signal_code);

    const signals = latestBySignal.filter(row => row.lit).map(row => {
        const daysLit = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.since}T00:00:00Z`))/(DAY_SECONDS*1000));
        const offerAfter = definitions[row.signal_code].ladder.offer_after_days;
        return {signal_code: row.signal_code, label: SIGNAL_SPECS[row.signal_code].label,
            since: row.since, days_lit: daysLit, ladder_step: daysLit >= offerAfter ? "offer" : "suggest",
            inputs: JSON.parse(row.inputs), action: ACTION_FOR[row.signal_code]};
    });

    const muted = await dblayer.getQueryOrThrow(
        "SELECT * FROM signal_mute WHERE org_id=? AND person_id=? AND muted_until >= ?", [org_id, person_id, today]);
    const sharesReceived = await exports.sharesReceivedAsync(org_id, person_id);

    return {enough_history: true, weeks, out_of_window_seconds: outOfWindowSeconds, blocked, signals,
        muted: muted.map(m => ({signal_code: m.signal_code, muted_until: m.muted_until, reason: m.reason})),
        shares_received: sharesReceived};
}

/** Mutes one signal (or every signal, with signal_code null) until a date. Statutory signals don't exist yet in this phase, so nothing here is exempt from muting. */
exports.muteAsync = async function(request) {
    if (!request.muted_until) throw new Error("A mute needs an end date.");
    _assertISODate(request.muted_until, "muted_until");
    await dblayer.runCmdOrThrow(
        `INSERT INTO signal_mute (mute_id, org_id, person_id, signal_code, muted_until, reason, created_at)
            VALUES (?,?,?,?,?,?,?)`,
        [_uuid(), request.org_id, request.person_id, request.signal_code || null, request.muted_until,
            request.reason || null, _now()]);
    return "muted";
}

exports.unmuteAsync = async function(org_id, person_id, signal_code) {
    await dblayer.runCmdOrThrow(
        signal_code ? "DELETE FROM signal_mute WHERE org_id=? AND person_id=? AND signal_code=?" :
            "DELETE FROM signal_mute WHERE org_id=? AND person_id=? AND signal_code IS NULL",
        signal_code ? [org_id, person_id, signal_code] : [org_id, person_id]);
    return "unmuted";
}

// ---------------------------------------------------------------------------
// M2/M4 — a deliberate, scoped share: hours and composition, never signal names
// ---------------------------------------------------------------------------

/**
 * Shares a summary of the sharer's own last N days with one recipient.
 * Time-boxed, revocable, content-limited to composition numbers — no signal
 * names, thresholds or ledger history (M2 item 5).
 * @param {object} request {org_id, sharer_person_id, recipient_person_id, period_from, period_to, expires_in_days}
 */
exports.shareSummaryAsync = async function(request) {
    _assertISODate(request.period_from, "period_from"); _assertISODate(request.period_to, "period_to");
    if (!request.recipient_person_id) throw new Error("A share needs a recipient.");
    const weeks = await _weeklyHoursAsync(request.org_id, request.sharer_person_id, request.period_to,
        Math.max(1, Math.ceil((Date.parse(`${request.period_to}T00:00:00Z`) - Date.parse(`${request.period_from}T00:00:00Z`))/(7*DAY_SECONDS*1000))));
    const blocked = await tasks.blockedLoadForPersonAsync(request.org_id, request.sharer_person_id);
    const summary = {total_hours: Math.round(weeks.reduce((sum, w) => sum + w.hours, 0)*10)/10,
        weeks, blocked_seconds: blocked.blocked_seconds};

    const row = {share_id: _uuid(), org_id: request.org_id, sharer_person_id: request.sharer_person_id,
        recipient_person_id: request.recipient_person_id, period_from: request.period_from, period_to: request.period_to,
        summary: JSON.stringify(summary), created_at: _now(),
        expires_at: _now() + (request.expires_in_days || 14)*DAY_SECONDS, revoked_at: null};
    await dblayer.runCmdOrThrow(
        `INSERT INTO signal_share (share_id, org_id, sharer_person_id, recipient_person_id, period_from,
            period_to, summary, created_at, expires_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [row.share_id, row.org_id, row.sharer_person_id, row.recipient_person_id, row.period_from,
            row.period_to, row.summary, row.created_at, row.expires_at, row.revoked_at]);
    return {...row, summary};
}

exports.revokeShareAsync = async function(org_id, sharer_person_id, share_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM signal_share WHERE org_id=? AND share_id=?", [org_id, share_id]);
    if (!rows.length || rows[0].sharer_person_id != sharer_person_id) throw new Error(
        `Share ${share_id} was not found, or it is not yours to revoke.`);
    await dblayer.runCmdOrThrow("UPDATE signal_share SET revoked_at=? WHERE share_id=?", [_now(), share_id]);
    return "revoked";
}

/** M4's recipient-side view — active (unexpired, unrevoked) shares made to this person. */
exports.sharesReceivedAsync = async function(org_id, recipient_person_id) {
    const rows = await dblayer.getQueryOrThrow(
        `SELECT s.*, p.display_name AS sharer_name FROM signal_share s
            LEFT JOIN person p ON p.person_id = s.sharer_person_id
            WHERE s.org_id=? AND s.recipient_person_id=? AND s.revoked_at IS NULL AND s.expires_at > ?
            ORDER BY s.created_at DESC`,
        [org_id, recipient_person_id, _now()]);
    return rows.map(row => ({share_id: row.share_id, sharer_name: row.sharer_name || row.sharer_person_id,
        period_from: row.period_from, period_to: row.period_to, summary: JSON.parse(row.summary),
        expires_at: row.expires_at}));
}

// ---------------------------------------------------------------------------
// M3 — team load: aggregate only, by construction
// ---------------------------------------------------------------------------

const HOUR_BINS = Object.freeze([{max: 35}, {min: 35, max: 42}, {min: 42, max: 48}, {min: 48}]);

/**
 * The lead's own cohort (direct reports, plus the lead — "the lead is inside
 * the cohort they're reading"). Refuses below MINIMUM_COHORT rather than
 * rendering an empty or a de-facto per-person chart. Never returns a
 * person_id or a name anywhere in the response — enforced by the shape,
 * not by a screen choosing not to show a column.
 *
 * @param {string} org_id The org
 * @param {string} actor_person_id The lead (or HR, at ORG scope — see hrTeamLoadAsync)
 * @returns {object} {cohort_size, bins, causes}
 */
exports.teamLoadAsync = async function(org_id, actor_person_id) {
    // Existence, not `checkAsync`'s subject-coverage test — there is no single
    // "subject" here (the cohort is the actor's own direct reports, whatever
    // scope the grant carries: direct_reports for a lead, org for HR). A grant
    // scoped to direct_reports can never cover a check with no named subject
    // (`_scopeCoversAsync`'s DIRECT_REPORTS case returns false without one),
    // so this reads the same way `recruitment.js`'s `_requireReadAsync` does.
    const grants = await permissions.activeGrantsAsync(org_id, actor_person_id, {capability: "wellbeing.read_aggregate"});
    if (!grants.length) throw new Error("wellbeing.read_aggregate is required to read team load.");

    const reports = await spine.directReportsAsOfAsync(org_id, actor_person_id);
    const cohort = [actor_person_id, ...reports.map(r => r.person_id)];
    if (cohort.length < MINIMUM_COHORT) throw new Error(
        `This cohort is ${cohort.length} — below the minimum of ${MINIMUM_COHORT}. Below that, a distribution is a list of individuals wearing a chart (M3), so this refuses rather than rendering.`);

    return await _aggregateAsync(org_id, cohort);
}

async function _aggregateAsync(org_id, cohort) {
    const today = _today();
    const bins = HOUR_BINS.map(bin => ({...bin, count: 0}));
    let unusedOver66 = 0, leaveEvaluable = 0, totalBlocked = 0, totalOpen = 0;

    for (const person_id of cohort) {
        const weeks = await _weeklyHoursAsync(org_id, person_id, today, 4);
        const avgHours = weeks.length ? weeks.reduce((sum, w) => sum + w.hours, 0)/weeks.length : 0;
        const bin = bins.find(b => (b.min === undefined || avgHours >= b.min) && (b.max === undefined || avgHours < b.max));
        if (bin) bin.count++;

        const leaveResult = await _evalLeaveNotTaken(org_id, person_id, today, SIGNAL_SPECS.leave_not_taken.default_threshold);
        if (leaveResult.inputs.unused_percent !== undefined) {
            leaveEvaluable++;
            if (leaveResult.inputs.unused_percent > 66) unusedOver66++;
        }
        const blocked = await tasks.blockedLoadForPersonAsync(org_id, person_id);
        totalBlocked += blocked.blocked_seconds; totalOpen += blocked.open_seconds;
    }

    return {cohort_size: cohort.length, bins: bins.map(({count, min, max}) => ({min: min??null, max: max??null, count})),
        causes: {
            leave: leaveEvaluable ? {evaluable: leaveEvaluable, under_a_third_used: unusedOver66,
                day_of_year: _dayOfYear(today)} : null,
            blocked: totalOpen ? {percent: Math.round((totalBlocked/totalOpen)*100)} : null
        }};
}

// ---------------------------------------------------------------------------
// M4 step 3 — "talk to HR", named, no fictional EAP
// ---------------------------------------------------------------------------

/** Who currently holds wellbeing.read_aggregate at ORG scope — that's HR, not a lead. */
exports.hrContactsAsync = async function(org_id) {
    const holders = await permissions.whoCanAsync(org_id, "wellbeing.read_aggregate");
    const orgHolders = holders.filter(h => h.through?.scope_type == "org");
    const names = await spine.rosterAsOfAsync(org_id);
    const nameOf = id => names.find(row => row.person_id == id)?.display_name || id;
    return orgHolders.map(h => ({person_id: h.person_id, name: nameOf(h.person_id)}));
}

exports.SIGNAL_CODES = SIGNAL_CODES;
exports.SIGNAL_SPECS = SIGNAL_SPECS;
exports.NEVER_MEASURED = NEVER_MEASURED;
exports.MINIMUM_COHORT = MINIMUM_COHORT;
