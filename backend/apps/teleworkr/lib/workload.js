/**
 * H1/H2 — the lead's view: a named per-person capacity board, and the
 * aggregate reports built from the same inputs. Capacity is declared hours
 * minus leave; committed is the open work already assigned. Neither number
 * is invented where the input doesn't exist — an undeclared window or a
 * task with no estimate says so, never a fabricated zero (H1's own States
 * line).
 *
 * The wireframe's fuller H1/H2 also wants a meetings time-split and a
 * recurring-meeting-cost report — no calendar-event entity exists anywhere
 * in this app (see dayboard.js's own module note), so neither is built.
 * Working-time compliance is likewise absent — C6 guardrails are themselves
 * deliberately absent (see time.js's own header) — so H2 carries three
 * reports, not five.
 *
 * The cohort is always the actor's own direct reports — the same answer
 * wellbeing.js's teamLoadAsync already gives for the identical SCOPES.TEAM
 * scope_ref limitation, reused rather than re-solved a third time.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);

const RAMP_DAYS = 14;             // excluded from capacity flagging, per H1's own States line
const ROOM_FOR_MORE_RATIO = 0.7;  // designed thresholds, stated plainly rather than hidden in a magic number
const _today = _ => new Date().toISOString().substring(0, 10);
const _nextDay = iso => {const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+1); return d.toISOString().substring(0,10);};

async function _cohortAsync(org_id, actor_person_id) {
    const grants = await permissions.activeGrantsAsync(org_id, actor_person_id, {capability: "workload.read"});
    if (!grants.length) throw new Error("workload.read is required to read the team board.");
    return await spine.directReportsAsOfAsync(org_id, actor_person_id);
}

/** The window's declared duration on a date, in seconds — a wrap (night-shift) window included. */
function _windowSeconds(window) {
    const minutes = window.end_minute <= window.start_minute ?
        (1440 - window.start_minute + window.end_minute) : (window.end_minute - window.start_minute);
    return minutes * 60;
}

/** Capacity over a range: declared-window seconds on workdays, minus days covered by approved leave. */
async function _capacityForRangeAsync(org_id, person_id, from_date, to_date) {
    const leaveRows = await leave.approvedLeaveForAsync(org_id, [person_id], from_date, to_date);
    const leaveDates = new Set();
    for (const row of leaveRows)
        for (let d = row.from_date < from_date ? from_date : row.from_date;
            d <= (row.to_date > to_date ? to_date : row.to_date); d = _nextDay(d)) leaveDates.add(d);

    let capacitySeconds = 0, leaveDays = 0, everDeclared = false;
    for (let d = from_date; d <= to_date; d = _nextDay(d)) {
        if (leaveDates.has(d)) {leaveDays++; continue;}
        const availability = await windows.availabilityForDateAsync(org_id, person_id, d);
        if (availability.window) everDeclared = true;
        if (availability.window && availability.workday) capacitySeconds += _windowSeconds(availability.window);
    }
    return {capacity_seconds: everDeclared ? capacitySeconds : null, leave_days: leaveDays};
}

/** Committed hours: the open work already assigned — sum of estimates, honest-null when none carry one. */
async function _committedForPersonAsync(org_id, actor_person_id, person_id) {
    const response = await tasks.listTasksAsync({org_id, actor_person_id,
        filters: {assignee_person_id: person_id}, page_size: 200});
    const open = response.rows.filter(task => task.status != "done");
    const withEstimate = open.filter(task => task.estimate_minutes != null);
    if (!withEstimate.length) return {committed_seconds: null, no_estimates: true};
    return {committed_seconds: withEstimate.reduce((sum, task) => sum + task.estimate_minutes*60, 0), no_estimates: false};
}

function _flagFor(committed_seconds, capacity_seconds, ramping) {
    if (ramping || committed_seconds == null || capacity_seconds == null || capacity_seconds == 0) return null;
    const ratio = committed_seconds / capacity_seconds;
    if (ratio > 1) return "over_capacity";
    if (ratio < ROOM_FOR_MORE_RATIO * 0.25) return "nothing_scheduled";
    if (ratio < ROOM_FOR_MORE_RATIO) return "room_for_more";
    return null;
}

/**
 * H1: the named per-person capacity board for the caller's direct reports.
 * @param {string} org_id The org
 * @param {string} actor_person_id The lead
 * @param {string} from_date ISO date
 * @param {string} to_date ISO date
 * @returns {object} {people, over_capacity_count, nothing_scheduled_count, blocked_percent}
 */
exports.teamCapacityAsync = async function(org_id, actor_person_id, from_date, to_date) {
    const reports = await _cohortAsync(org_id, actor_person_id);
    const people = [];
    let blockedSeconds = 0, openSeconds = 0;

    for (const report of reports) {
        const [capacity, committed, blocked] = await Promise.all([
            _capacityForRangeAsync(org_id, report.person_id, from_date, to_date),
            _committedForPersonAsync(org_id, actor_person_id, report.person_id),
            tasks.blockedLoadForPersonAsync(org_id, report.person_id)]);
        const ramping = report.valid_from >= _addDays(_today(), -RAMP_DAYS);

        blockedSeconds += blocked.blocked_seconds; openSeconds += blocked.open_seconds;
        people.push({person_id: report.person_id, capacity_seconds: capacity.capacity_seconds,
            leave_days: capacity.leave_days, committed_seconds: committed.committed_seconds,
            no_estimates: committed.no_estimates, ramping,
            flag: _flagFor(committed.committed_seconds, capacity.capacity_seconds, ramping)});
    }

    return {people,
        over_capacity_count: people.filter(p => p.flag == "over_capacity").length,
        nothing_scheduled_count: people.filter(p => p.flag == "nothing_scheduled").length,
        blocked_percent: openSeconds ? Math.round((blockedSeconds/openSeconds)*100) : null};
}

/**
 * H2: three aggregate reports over the caller's direct reports — never a
 * per-person ranking, per the wireframe's own explicit rule.
 * @param {string} org_id The org
 * @param {string} actor_person_id The lead
 * @param {string} from_date ISO date
 * @param {string} to_date ISO date
 * @returns {object} {blocked, estimate_accuracy, utilisation}
 */
exports.teamReportsAsync = async function(org_id, actor_person_id, from_date, to_date) {
    const reports = await _cohortAsync(org_id, actor_person_id);
    const personIds = reports.map(r => r.person_id);
    if (!personIds.length) return {blocked: {blocked_seconds: 0, open_seconds: 0, percent: null},
        estimate_accuracy: {ratio: null, tasks_counted: 0},
        utilisation: {billable_seconds: 0, total_seconds: 0, capacity_seconds: 0, unaccounted_seconds: 0}};

    let blockedSeconds = 0, openSeconds = 0;
    let estimateSecondsSum = 0, loggedSecondsSum = 0, tasksCounted = 0;
    let capacitySecondsSum = 0;

    for (const personId of personIds) {
        const [blocked, allTasks, capacity] = await Promise.all([
            tasks.blockedLoadForPersonAsync(org_id, personId),
            tasks.listTasksAsync({org_id, actor_person_id, filters: {assignee_person_id: personId}, page_size: 200}),
            _capacityForRangeAsync(org_id, personId, from_date, to_date)]);
        blockedSeconds += blocked.blocked_seconds; openSeconds += blocked.open_seconds;
        capacitySecondsSum += capacity.capacity_seconds || 0;

        for (const task of allTasks.rows) {
            const logged = allTasks.logged_seconds[task.task_ref];
            if (task.estimate_minutes != null && logged) {
                estimateSecondsSum += task.estimate_minutes*60; loggedSecondsSum += logged; tasksCounted++;
            }
        }
    }

    const timeTotals = await _teamTimeTotalsAsync(org_id, personIds, from_date, to_date);

    return {
        blocked: {blocked_seconds: blockedSeconds, open_seconds: openSeconds,
            percent: openSeconds ? Math.round((blockedSeconds/openSeconds)*100) : null},
        estimate_accuracy: {ratio: estimateSecondsSum ? loggedSecondsSum/estimateSecondsSum : null, tasks_counted: tasksCounted},
        utilisation: {billable_seconds: timeTotals.billable_seconds, total_seconds: timeTotals.total_seconds,
            capacity_seconds: capacitySecondsSum,
            unaccounted_seconds: Math.max(0, capacitySecondsSum - timeTotals.total_seconds)}
    };
}

/** Billable/total seconds across a cohort's ledger in a range — the same supersession exclusion every read here uses. */
async function _teamTimeTotalsAsync(org_id, person_ids, from_date, to_date) {
    const placeholders = person_ids.map(_ => "?").join(",");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT SUM(duration_seconds) AS total, SUM(CASE WHEN billable=1 THEN duration_seconds ELSE 0 END) AS billable
            FROM time_entry_event
            WHERE org_id=? AND person_id IN (${placeholders}) AND entry_date >= ? AND entry_date <= ?
                AND entry_event_id NOT IN (SELECT supersedes_entry_event_id FROM time_entry_event
                    WHERE org_id=? AND supersedes_entry_event_id IS NOT NULL)`,
        [org_id, ...person_ids, from_date, to_date, org_id]);
    return {total_seconds: rows[0]?.total || 0, billable_seconds: rows[0]?.billable || 0};
}

function _addDays(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().substring(0, 10);
}
