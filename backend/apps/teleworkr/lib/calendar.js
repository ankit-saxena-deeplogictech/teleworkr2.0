/**
 * J6 — the org calendar projection. The one module that reads leave, windows
 * and time together. It answers the E3 board's "person on leave" state and the
 * C5 close's "leave day (excluded from target, labelled)" without any of those
 * modules depending on each other beyond their existing edges.
 *
 * Nothing here is stored: every answer is recomputed from the system of record
 * on each read (A6).
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);

const MINUTES_IN_DAY = 1440;

/**
 * Who among these people has approved leave covering the date. The facts come
 * straight from the leave system of record — pending, declined and cancelled
 * requests are not here.
 *
 * @param {string} org_id The org
 * @param {array} person_ids The people
 * @param {string} date ISO date
 * @returns {array} [{person_id, leave_type, from_date, to_date, leave_request_id}]
 */
exports.onLeaveAsync = async function(org_id, person_ids, date) {
    return await leave.approvedLeaveForAsync(org_id, person_ids, date, date);
}

/**
 * The labelled facts about one person's day — what C5 prints next to the day
 * and what E3 prints under the person's bar. Public holidays stay null until
 * the org holiday calendar exists (a deliberate, honest absence).
 *
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} date ISO date
 * @returns {object} {date, leave, public_holiday}
 */
exports.dayFactsAsync = async function(org_id, person_id, date) {
    const leaveFacts = await leave.approvedLeaveForAsync(org_id, [person_id], date, date);
    return {date, leave: leaveFacts.length ? leaveFacts : null, public_holiday: null};
}

/**
 * The E3 team board with leave wired in: the windows overlap projection plus
 * the on-leave people, who are excluded from the shared span and named instead
 * of being treated as working (their bar is a leave label, not hours).
 * Travelling already flows through the window's own kind.
 *
 * @param {string} org_id The org
 * @param {array} person_ids The people
 * @param {string} date ISO date
 * @returns {object} The teamOverlapAsync shape plus on_leave
 */
exports.teamBoardAsync = async function(org_id, person_ids, date) {
    const onLeave = await exports.onLeaveAsync(org_id, person_ids, date);
    const firstByPerson = new Map();
    for (const fact of onLeave) if (!firstByPerson.has(fact.person_id)) firstByPerson.set(fact.person_id, fact);

    const unavailable = [...firstByPerson.values()].map(fact =>
        ({person_id: fact.person_id, reason: "on_leave"}));
    const board = await windows.teamOverlapAsync(org_id, person_ids, date, {unavailable});
    return {...board, on_leave: [...firstByPerson.values()]};
}

/**
 * The C5 weekly target: the working time the week asks for, per day, with
 * approved leave days excluded and labelled. The target is the declared window
 * span on each working day — the same projection E3 shows, so the two screens
 * can never disagree about what a day was worth.
 *
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} week_start Any date inside the week; Monday is derived
 * @returns {object} {week_start, target_seconds, working_days, per_day, excluded_days}
 */
exports.weekTargetAsync = async function(org_id, person_id, week_start) {
    const start = time.weekStartOf(week_start);
    const per_day = [], excluded_days = [];
    let targetSeconds = 0, workingDays = 0;

    for (let i = 0; i < 7; i++) {
        const d = new Date(`${start}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + i);
        const date = d.toISOString().substring(0, 10);

        const leaveFacts = await leave.approvedLeaveForAsync(org_id, [person_id], date, date);
        if (leaveFacts.length) {
            const exclusion = {date, reason: "leave", leave_type: leaveFacts[0].leave_type,
                leave_request_id: leaveFacts[0].leave_request_id};
            per_day.push({date, target_seconds: 0, excluded: exclusion});
            excluded_days.push(exclusion); continue;
        }

        const availability = await windows.availabilityForDateAsync(org_id, person_id, date);
        if (!availability.window) {
            const exclusion = {date, reason: "undeclared"};
            per_day.push({date, target_seconds: 0, excluded: exclusion});
            excluded_days.push(exclusion); continue;
        }
        if (!availability.workday) {
            const exclusion = {date, reason: "off_day"};
            per_day.push({date, target_seconds: 0, excluded: exclusion});
            excluded_days.push(exclusion); continue;
        }

        const window = availability.window;
        const end = window.end_minute <= window.start_minute ?
            window.end_minute + MINUTES_IN_DAY : window.end_minute;
        const seconds = (end - window.start_minute) * 60;
        per_day.push({date, target_seconds: seconds, excluded: null});
        targetSeconds += seconds; workingDays++;
    }

    return {week_start: start, target_seconds: targetSeconds, working_days: workingDays,
        per_day, excluded_days};
}

/**
 * The A11 clock screen's single read: today's total with the running entry
 * projected to now, the open window's local end, and the day's label. Everything
 * is recomputed from the ledger and the window on every read — the phone shows
 * the same numbers the timesheet will (C5).
 *
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} date ISO date, defaults to today
 * @returns {object} {date, today_total_seconds, running, window, workday, reason, window_ends_at_minute}
 */
exports.clockStatusAsync = async function(org_id, person_id, date) {
    const day = date || new Date().toISOString().substring(0, 10);
    const availability = await windows.availabilityForDateAsync(org_id, person_id, day);
    const events = time.currentEvents(await time.eventsForDayAsync(org_id, person_id, day));
    const nowSeconds = Math.floor(Date.now()/1000);

    let total = 0, running = null;
    for (const event of events) {
        let seconds = event.duration_seconds;
        if (event.ended_at === null && event.started_at)
            seconds = Math.max(0, nowSeconds - event.started_at);
        total += seconds || 0;
        if (event.ended_at === null && event.started_at)
            running = {entry_event_id: event.entry_event_id, task_ref: event.task_ref,
                started_at: event.started_at, source: event.source, elapsed_seconds: seconds};
    }

    const window = availability.window;
    return {date: day, today_total_seconds: total, running,
        window: window ? {window_id: window.window_id, timezone: window.timezone,
            start_minute: window.start_minute, end_minute: window.end_minute, kind: window.kind} : null,
        workday: availability.workday, reason: availability.reason,
        window_ends_at_minute: window && availability.workday ?
            (window.end_minute <= window.start_minute ? window.end_minute + MINUTES_IN_DAY : window.end_minute)
            : null};
}
