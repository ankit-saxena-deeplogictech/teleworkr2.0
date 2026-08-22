/**
 * C1 — the Day board. One screen that answers now / next / how am I doing,
 * without a page change: the clock and what it is bound to, what is due today,
 * who needs you, a presence summary, and the week so far.
 *
 * Nothing here is stored (A6). Every field is projected from clock.js, tasks.js,
 * brief.js, windows.js and time.js on each read, the same discipline as overlap
 * and leave balance — a cached Day board would be wrong the moment a timer stops.
 *
 * What C1's wireframe shows that this does not build: meetings, a free-gap hour
 * spine, and the "block focus time" affordance. There is no calendar-event entity
 * yet — meetings are Phase 3 (F5), and inventing one here to fill a widget would
 * be exactly the failure A8 warns against, stating a fact the product cannot back.
 * Those fields report an honest zero/null and a reason, never a guess.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const clock = require(`${TELEWORKR_CONSTANTS.LIBDIR}/clock.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const calendar = require(`${TELEWORKR_CONSTANTS.LIBDIR}/calendar.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const brief = require(`${TELEWORKR_CONSTANTS.LIBDIR}/brief.js`);

const NEEDS_YOU_CAP = 5;          // C1: capped at five
const PRESENCE_SAMPLE = 8;        // C1: a summary, not a roster — E3 has the full list

const _today = _ => new Date().toISOString().substring(0, 10);

/**
 * Assembles the Day board for one person on one date.
 * @param {object} request {org_id, person_id, date}
 * @returns {object} The board
 */
exports.boardAsync = async function(request) {
    const {org_id, person_id} = request;
    const day = request.date || _today();

    const [session, dueToday, needsYou, presence, week] = await Promise.all([
        clock.sessionAsync(org_id, person_id, day),
        _dueTodayAsync(org_id, person_id, day),
        _needsYouAsync(org_id, person_id),
        _presenceAsync(org_id, person_id, day),
        _weekAsync(org_id, person_id, day)
    ]);

    return {
        date: day,
        clock: session,
        working_on: await _workingOnAsync(org_id, person_id, session),
        due_today: dueToday,
        // honest zero — no calendar-event entity exists yet (see module note)
        meetings: {count: 0, next: null, reason: "not_tracked"},
        focus: {minutes: null, reason: "not_tracked"},
        needs_you: needsYou,
        presence,
        week
    };
}

/**
 * Names the task the timer is bound to, if any — the strip under the clock.
 * @returns The task summary, or null if nothing is running or it carries no task
 */
async function _workingOnAsync(org_id, person_id, session) {
    const taskRef = session.running?.task_ref;
    if (!taskRef) return null;
    try {
        const task = await tasks.taskSummaryAsync({org_id, actor_person_id: person_id, task_ref: taskRef});
        if (!task) return null;
        return {task_ref: task.task_ref, title: task.title, project: task.project,
            due_date: task.due_date, assignee_person_id: task.assignee_person_id,
            estimate_minutes: task.estimate_minutes, logged_seconds: task.logged_seconds,
            session_seconds: session.running.elapsed_seconds};
    } catch (err) {
        // task.read may be denied or revoked mid-session; the clock keeps running
        // regardless (A8) and the strip degrades to naming the ref without detail.
        LOG.warn(`Could not resolve task ${taskRef} for the Day board strip: ${err}`);
        return {task_ref: taskRef, title: null, degraded: true};
    }
}

/**
 * Tasks assigned to this person due today, not yet done. Capped the way D1 caps —
 * an exact count first, a handful of rows to name.
 */
async function _dueTodayAsync(org_id, person_id, day) {
    const result = await tasks.listTasksAsync({org_id, actor_person_id: person_id,
        filters: {assignee_person_id: person_id, due_date: day}, page_size: 6});
    const overdue = await tasks.listTasksAsync({org_id, actor_person_id: person_id,
        filters: {assignee_person_id: person_id, overdue: true}, page_size: 1});
    return {count: result.total, overdue_count: overdue.total,
        rows: result.rows.filter(row => row.status != "done").map(row =>
            ({task_ref: row.task_ref, title: row.title, status: row.status, priority: row.priority}))};
}

/**
 * Reuses B4's ranked items — blocks you, needs a reply, moved, decided — the same
 * buckets, capped to five and reordered so the person whose window is open now
 * comes first. C1 and B4 read the same backlog; B4 opens the day with it, C1
 * keeps it visible without a page change.
 */
async function _needsYouAsync(org_id, person_id) {
    const assembled = await brief.briefAsync({org_id, person_id});
    if (assembled.state == "chronological") return {state: "chronological", items: assembled.items.slice(0, NEEDS_YOU_CAP)};

    const items = [...assembled.items].sort((a, b) => {
        const awake = Number(b.other_availability?.online_now) - Number(a.other_availability?.online_now);
        return awake !== 0 ? awake : b.at - a.at;
    }).slice(0, NEEDS_YOU_CAP);

    return {state: items.length ? "normal" : "quiet", items};
}

/**
 * Summarises rather than lists (the roster lives in E3): how many people with
 * employment in this org are inside their declared window right now, and a
 * handful of names to put faces to the count.
 *
 * There is no team entity yet, so the cohort is everyone employed in the org as
 * of today. Once teams or departments exist, this narrows to the person's own —
 * an org-wide count is a defensible default, not the intended long-run answer.
 */
async function _presenceAsync(org_id, person_id, day) {
    const roster = (await spine.rosterAsOfAsync(org_id, day)).filter(row => row.person_id != person_id);
    if (!roster.length) return {online: 0, total: 0, sample: []};

    const checks = await Promise.all(roster.map(async row => ({row,
        awake: (await windows.withinWindowAtAsync(org_id, row.person_id)).within})));
    const online = checks.filter(check => check.awake);

    return {online: online.length, total: roster.length,
        sample: online.slice(0, PRESENCE_SAMPLE).map(check =>
            ({person_id: check.row.person_id, display_name: check.row.display_name}))};
}

/**
 * The week so far against its target, for the footer link into C5.
 */
async function _weekAsync(org_id, person_id, day) {
    const weekStart = time.weekStartOf(day);
    const [sheet, target] = await Promise.all([
        time.timesheetForOwnerAsync(org_id, person_id, weekStart),
        calendar.weekTargetAsync(org_id, person_id, weekStart)]);
    return {week_start: weekStart, logged_seconds: sheet.totals.total_seconds,
        target_seconds: target.target_seconds, status: sheet.timesheet?.status || "open"};
}
