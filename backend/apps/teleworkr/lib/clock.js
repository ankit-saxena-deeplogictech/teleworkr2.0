/**
 * C2 — clock control, breaks and idle.
 *
 * One button driven by state: what the person can do next is a function of what
 * the clock is doing now, so the API refuses the transitions that make no sense
 * rather than recording a second running entry and letting C5 discover it.
 *
 * The rule that governs the idle path, and that everything here is arranged
 * around: silent deletion of someone's time is the fastest way to lose them.
 * Idle resolution therefore defaults to keeping the time, a discard is an
 * explicit choice that supersedes rather than deletes, and the original interval
 * stays in the ledger where C5 will show it.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const calendar = require(`${TELEWORKR_CONSTANTS.LIBDIR}/calendar.js`);

const BREAK_COLS = "break_id, org_id, person_id, entry_date, started_at, ended_at, reason, source, supersedes_break_id, recorded_at";
const IDLE_DECISIONS = Object.freeze({KEEP: "keep", DISCARD: "discard", BREAK: "break"});

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);

// ---------------------------------------------------------------------------
// the one button, driven by state
// ---------------------------------------------------------------------------

/**
 * Starts the clock. Refuses if one is already running — two running entries is
 * not a state the timesheet can represent honestly.
 *
 * @param {object} request {org_id, person_id, task_ref, project, note, at, client_event_id, entry_date}
 * @returns {object} {entry, session}
 */
exports.clockInAsync = async function(request) {
    const {org_id, person_id} = request;
    const day = request.entry_date || _today();
    const at = request.at || _now();

    if (await exports.onBreakAsync(org_id, person_id, day)) throw new Error(
        "You are on a break. End the break to start the clock again.");

    const running = await time.runningEntryAsync(org_id, person_id, day);
    if (running) throw new Error(
        `The clock is already running${running.task_ref?` on ${running.task_ref}`:""}. Switch task or clock out instead.`);

    const entry = await time.recordEventAsync({org_id, person_id, entry_date: day,
        client_event_id: request.client_event_id, task_ref: request.task_ref || null,
        project: request.project || null, note: request.note || null,
        started_at: at, source: "timer"});

    return {entry, session: await exports.sessionAsync(org_id, person_id, day)};
}

/**
 * Stops the clock, and answers with what was recorded and what the person should
 * know before they walk away — C2's confirm needs both.
 *
 * @param {object} request {org_id, person_id, at, entry_date}
 * @returns {object} {entry, recorded_seconds, session}
 */
exports.clockOutAsync = async function(request) {
    const {org_id, person_id} = request;
    const day = request.entry_date || _today();
    const at = request.at || _now();

    const running = await time.runningEntryAsync(org_id, person_id, day);
    if (!running) throw new Error("The clock is not running, so there is nothing to clock out of.");

    const closed = await time.closeRunningEntryAsync({org_id, person_id, entry_date: day, ended_at: at});
    await exports.endBreakAsync({org_id, person_id, entry_date: day, at}).catch(_ => {});   // a break cannot outlive the day it paused

    return {entry: closed, recorded_seconds: closed.duration_seconds,
        session: await exports.sessionAsync(org_id, person_id, day)};
}

/**
 * What C2's clock-out confirm states before it offers the verb: the total that
 * will be recorded, and the things still open behind it.
 *
 * @param {object} request {org_id, person_id, at, entry_date}
 * @returns {object} {running, session_seconds, today_total_seconds, warnings}
 */
exports.clockOutPreviewAsync = async function(request) {
    const {org_id, person_id} = request;
    const day = request.entry_date || _today();
    const at = request.at || _now();

    const running = await time.runningEntryAsync(org_id, person_id, day);
    const status = await calendar.clockStatusAsync(org_id, person_id, day);

    const warnings = [];
    if (running) warnings.push({kind: "timer_running",
        message: `The timer is running${running.task_ref?` on ${running.task_ref}`:""}.`});

    // A person without task.read still gets a clock-out confirm; it just cannot
    // name their open tasks. The confirm degrades, the clock-out does not.
    let inProgress = {rows: [], total: 0};
    try {
        inProgress = await tasks.listTasksAsync({org_id, actor_person_id: person_id,
            filters: {status: tasks.STATUS.IN_PROGRESS, assignee_person_id: person_id}, page_size: 5});
    } catch (err) {LOG.warn(`Could not read open tasks for the clock-out confirm: ${err}`);}
    if (inProgress.total) warnings.push({kind: "tasks_in_progress", count: inProgress.total,
        message: `${inProgress.total} task${inProgress.total==1?" is":"s are"} still in progress.`,
        tasks: inProgress.rows.map(task => ({task_ref: task.task_ref, title: task.title}))});

    return {running: running || null, at,
        session_seconds: running ? Math.max(0, at - running.started_at) : 0,
        today_total_seconds: status.today_total_seconds, warnings};
}

/**
 * Moves the clock from one task to another without stopping it. Binding time to
 * a task is what makes the timesheet and the task time-log agree, so a switch
 * closes one entry and opens the next in the same breath rather than leaving a
 * gap the person has to reconstruct later.
 *
 * @param {object} request {org_id, person_id, task_ref, project, at, entry_date, client_event_id}
 * @returns {object} {closed, entry, session}
 */
exports.switchTaskAsync = async function(request) {
    const {org_id, person_id} = request;
    const day = request.entry_date || _today();
    const at = request.at || _now();

    const running = await time.runningEntryAsync(org_id, person_id, day);
    if (!running) throw new Error("The clock is not running, so there is nothing to switch.");
    if ((running.task_ref||null) == (request.task_ref||null)) throw new Error(
        "The clock is already on that task.");

    const closed = await time.closeRunningEntryAsync({org_id, person_id, entry_date: day, ended_at: at});
    const entry = await time.recordEventAsync({org_id, person_id, entry_date: day,
        client_event_id: request.client_event_id, task_ref: request.task_ref || null,
        project: request.project || null, started_at: at, source: "timer"});

    return {closed, entry, session: await exports.sessionAsync(org_id, person_id, day)};
}

// ---------------------------------------------------------------------------
// breaks
// ---------------------------------------------------------------------------

/**
 * Starts a break. The clock stops, because a break is not worked time, and the
 * task the person was on is returned so the caller can offer it back afterwards.
 *
 * @param {object} request {org_id, person_id, at, entry_date, reason, source}
 * @returns {object} {break_id, resumes_task_ref, session}
 */
exports.startBreakAsync = async function(request) {
    const {org_id, person_id} = request;
    const day = request.entry_date || _today();
    const at = request.at || _now();

    if (await exports.onBreakAsync(org_id, person_id, day)) throw new Error("You are already on a break.");

    const running = await time.runningEntryAsync(org_id, person_id, day);
    const resumes = running?.task_ref || null;
    if (running) await time.closeRunningEntryAsync({org_id, person_id, entry_date: day, ended_at: at});

    const row = {break_id: serverutils.generateUUID(false), org_id, person_id, entry_date: day,
        started_at: at, ended_at: null, reason: request.reason || null,
        source: request.source || "clock", supersedes_break_id: null, recorded_at: _now()};
    await dblayer.runCmdOrThrow(`INSERT INTO clock_break (${BREAK_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [row.break_id, row.org_id, row.person_id, row.entry_date, row.started_at, row.ended_at,
            row.reason, row.source, row.supersedes_break_id, row.recorded_at]);

    return {break_id: row.break_id, resumes_task_ref: resumes,
        session: await exports.sessionAsync(org_id, person_id, day)};
}

/**
 * Ends the open break by superseding it, so the original interval survives.
 * @param {object} request {org_id, person_id, at, entry_date, resume_task_ref}
 * @returns {object} {break_id, seconds, resumed, session}
 */
exports.endBreakAsync = async function(request) {
    const {org_id, person_id} = request;
    const day = request.entry_date || _today();
    const at = request.at || _now();

    const open = await exports.onBreakAsync(org_id, person_id, day);
    if (!open) throw new Error("You are not on a break.");
    if (at < open.started_at) throw new Error("A break cannot end before it started.");

    const closed = {...open, break_id: serverutils.generateUUID(false), ended_at: at,
        supersedes_break_id: open.break_id, recorded_at: _now()};
    await dblayer.runCmdOrThrow(`INSERT INTO clock_break (${BREAK_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [closed.break_id, closed.org_id, closed.person_id, closed.entry_date, closed.started_at,
            closed.ended_at, closed.reason, closed.source, closed.supersedes_break_id, closed.recorded_at]);

    let resumed = null;
    if (request.resume_task_ref) resumed = (await exports.clockInAsync({org_id, person_id,
        entry_date: day, task_ref: request.resume_task_ref, at})).entry;

    return {break_id: closed.break_id, seconds: at - open.started_at, resumed,
        session: await exports.sessionAsync(org_id, person_id, day)};
}

/**
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} entry_date ISO date
 * @returns The open break, or null
 */
exports.onBreakAsync = async function(org_id, person_id, entry_date) {
    const current = await exports.breaksAsync(org_id, person_id, entry_date || _today());
    return current.find(row => row.ended_at === null) || null;
}

/**
 * The breaks in force for a day — superseded rows drop out, the same way the
 * ledger's do.
 * @returns {array} The current breaks, oldest first
 */
exports.breaksAsync = async function(org_id, person_id, entry_date) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM clock_break WHERE org_id=? AND person_id=? AND entry_date=? ORDER BY recorded_at ASC",
        [org_id, person_id, entry_date || _today()]);
    const superseded = new Set(rows.filter(row => row.supersedes_break_id).map(row => row.supersedes_break_id));
    return rows.filter(row => !superseded.has(row.break_id));
}

// ---------------------------------------------------------------------------
// idle
// ---------------------------------------------------------------------------

/**
 * Resolves an idle stretch the client noticed.
 *
 * Keep is the default and does nothing, because the time is already recorded and
 * the honest answer to "were you working" is usually yes. Discard supersedes the
 * running entry with a shorter one and records why. Break does the same and puts
 * the interval where it belongs, so the day still adds up.
 *
 * @param {object} request {org_id, person_id, decision, idle_seconds, at, entry_date}
 * @returns {object} {decision, entry, session}
 */
exports.resolveIdleAsync = async function(request) {
    const {org_id, person_id} = request;
    const day = request.entry_date || _today();
    const at = request.at || _now();
    const decision = request.decision || IDLE_DECISIONS.KEEP;
    if (!Object.values(IDLE_DECISIONS).includes(decision)) throw new Error(
        `${decision} is not an idle resolution. It is one of: ${Object.values(IDLE_DECISIONS).join(", ")}.`);

    if (decision == IDLE_DECISIONS.KEEP)    // the time stands; nothing to write
        return {decision, entry: null, session: await exports.sessionAsync(org_id, person_id, day)};

    const idleSeconds = Number(request.idle_seconds||0);
    if (!(idleSeconds > 0)) throw new Error("Removing idle time needs to know how much.");

    const running = await time.runningEntryAsync(org_id, person_id, day);
    if (!running) throw new Error("The clock is not running, so there is no idle time on it.");
    const idleStartedAt = at - idleSeconds;
    if (idleStartedAt <= running.started_at) throw new Error(
        "The idle stretch covers the whole entry. Clock out instead of trimming it to nothing.");

    // The entry is shortened to where the person stopped. The original stays in the
    // ledger with its reason, which is what makes this different from a deletion.
    const reason = decision == IDLE_DECISIONS.BREAK ?
        "Idle resolved as a break" : "Idle time removed by the person";
    const trimmed = await time.closeRunningEntryAsync({org_id, person_id, entry_date: day,
        ended_at: idleStartedAt, reason});

    if (decision == IDLE_DECISIONS.BREAK) {
        await exports.startBreakAsync({org_id, person_id, entry_date: day, at: idleStartedAt,
            reason: "Idle resolved as a break", source: "idle_resolution"});
        await exports.endBreakAsync({org_id, person_id, entry_date: day, at});
        await exports.clockInAsync({org_id, person_id, entry_date: day, at,
            task_ref: running.task_ref, project: running.project});    // the clock picks up where it left off
    }

    return {decision, entry: trimmed, session: await exports.sessionAsync(org_id, person_id, day)};
}

// ---------------------------------------------------------------------------
// the session summary behind the popover
// ---------------------------------------------------------------------------

/**
 * What C2's popover states: when the day started, how much is on the clock, how
 * much of it was break, and what the clock is bound to.
 *
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} entry_date ISO date
 * @returns {object} The session summary
 */
exports.sessionAsync = async function(org_id, person_id, entry_date) {
    const day = entry_date || _today();
    const status = await calendar.clockStatusAsync(org_id, person_id, day);
    const breaks = await exports.breaksAsync(org_id, person_id, day);
    const now = _now();

    const closedBreaks = breaks.filter(row => row.ended_at !== null);
    const openBreak = breaks.find(row => row.ended_at === null) || null;
    const breakSeconds = closedBreaks.reduce((total, row) => total + (row.ended_at - row.started_at), 0)
        + (openBreak ? Math.max(0, now - openBreak.started_at) : 0);

    const events = time.currentEvents(await time.eventsForDayAsync(org_id, person_id, day));
    const startedAt = events.filter(event => event.started_at)
        .reduce((earliest, event) => earliest === null ? event.started_at : Math.min(earliest, event.started_at), null);

    // The target is the declared window's length; an undeclared window has no target
    // to state, and guessing one is how a person ends up measured against a fiction.
    const window = status.window;
    const targetSeconds = window && status.workday ?
        ((status.window_ends_at_minute - window.start_minute) * 60) : null;

    return {date: day, running: status.running || null, on_break: openBreak,
        today_total_seconds: status.today_total_seconds, target_seconds: targetSeconds,
        clocked_in_at: startedAt, break_count: closedBreaks.length + (openBreak ? 1 : 0),
        break_seconds: breakSeconds, workday: status.workday, window: window || null,
        state: openBreak ? "break" : (status.running ? "running" : "not_clocked_in")};
}

exports.IDLE_DECISIONS = IDLE_DECISIONS;
