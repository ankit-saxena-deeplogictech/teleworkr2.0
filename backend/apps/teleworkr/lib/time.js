/**
 * The C-section time domain — the append-only time ledger, the weekly timesheet
 * snapshot, and the approval signature.
 *
 * time_entry_event is the truth and it is append-only. "Recorded time is never
 * discarded" (A8) is expressed as an idempotency key: an offline client retries
 * with the same client_event_id and gets the same row back — never a duplicate,
 * never a rejection. An edit is a new event that supersedes the old one and
 * carries the reason; the original value survives (C5).
 *
 * The timesheet pins the entry events as they stood at submission, so a later
 * edit cannot silently change an approved week (C7). Totals are projected over
 * the events, never stored (A6).
 *
 * The manager mirror is enforced here, not only in the UI: the approver read
 * returns per-task totals, the billable split and the reconstructed flags — it
 * never returns per-entry start times. C5 says so, and the API must match what
 * the mirror promises.
 *
 * C6 guardrails are deliberately absent: the wireframe's Open field says which
 * jurisdictions ship first needs a legal and HR decision before build. What is
 * carried over from C6 now is its first principle — the ledger records the truth
 * regardless, and no business rule ever refuses to record time someone worked.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const events = require(`${TELEWORKR_CONSTANTS.LIBDIR}/events.js`);

const SOURCES = Object.freeze(["timer", "manual", "reconstructed", "calendar"]);
const STATUS = Object.freeze({OPEN: "open", SUBMITTED: "submitted", RETURNED: "returned",
    APPROVED: "approved", LOCKED: "locked"});
const DAY_SECONDS = 86400;

const EVENT_COLS = "entry_event_id, org_id, person_id, client_event_id, entry_date, task_ref, project, " +
    "client_code, note, billable, started_at, ended_at, duration_seconds, source, category, signal, " +
    "reconstructed, supersedes_entry_event_id, reason, recorded_at";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);

// ---------------------------------------------------------------------------
// the ledger
// ---------------------------------------------------------------------------

/**
 * Records a time entry event. The only refusal paths are data that cannot be
 * stored as time — a negative duration, a source we do not know, an end before
 * its start. Overlaps, gaps and long days are the person's truth and are stored
 * as such; C3 and C5 surface them, they do not block them.
 *
 * Idempotent on client_event_id for the offline sync contract (A8): a retry
 * returns the row the first attempt stored.
 *
 * @param {object} event {org_id, person_id, client_event_id, entry_date, task_ref,
 *      project, client_code, note, billable, started_at, ended_at, duration_seconds,
 *      source, category, signal, reconstructed}
 * @returns The stored event
 */
exports.recordEventAsync = async function(event) {
    const row = _prepareEvent(event, null);
    if (row.client_event_id) {
        const existing = await _byClientEventIdAsync(row.org_id, row.person_id, row.client_event_id);
        if (existing) return existing;
    }

    try {
        await dblayer.runCmdOrThrow(
            `INSERT INTO time_entry_event (${EVENT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            _eventParams(row));
    } catch (err) {
        // a concurrent retry may have won the race between lookup and insert — that is still the same event
        if (row.client_event_id) {
            const raced = await _byClientEventIdAsync(row.org_id, row.person_id, row.client_event_id);
            if (raced) return raced;
        }
        throw err;
    }

    try {await events.emitAsync({org_id: row.org_id, action: "time_entry.created", person_id: row.person_id,
        occurred_at: row.started_at || _now(), source: "web", detail: {source: row.source}});}
    catch (err) {LOG.error(`Could not record a time_entry.created event: ${err}`);}

    return row;
}

/**
 * The A11 reconnect path: replays events a device buffered offline. Each event
 * is matched by its client_event_id — replayed unchanged it reports
 * already_stored, changed it reports conflict (the recovery screen shows it),
 * new it stores. One bad event never blocks the rest of the batch.
 *
 * @param {string} org_id The org
 * @param {string} person_id The person whose clock it was
 * @param {array} events Buffered events as for recordEventAsync
 * @returns {array} Per-event results {client_event_id, result, ...}
 */
exports.syncEventsAsync = async function(org_id, person_id, events) {
    if (!Array.isArray(events)) throw new Error("sync needs an events array.");
    const results = [];
    for (const event of events) {
        const id = event?.client_event_id || null;
        try {
            const row = _prepareEvent({...event, org_id, person_id}, null);
            const existing = id ? await _byClientEventIdAsync(org_id, person_id, id) : null;
            if (existing) {
                results.push(_payloadEquals(existing, row) ?
                    {client_event_id: id, result: "already_stored", entry_event_id: existing.entry_event_id} :
                    {client_event_id: id, result: "conflict", entry_event_id: existing.entry_event_id,
                        stored: _syncSummary(existing)});
                continue;
            }
            try {
                await dblayer.runCmdOrThrow(
                    `INSERT INTO time_entry_event (${EVENT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    _eventParams(row));
                results.push({client_event_id: id, result: "stored", entry_event_id: row.entry_event_id});
            } catch (err) {
                // a concurrent retry may have won — that is still the same event
                const raced = id ? await _byClientEventIdAsync(org_id, person_id, id) : null;
                if (raced) results.push({client_event_id: id, result: "already_stored",
                    entry_event_id: raced.entry_event_id});
                else throw err;
            }
        } catch (err) {
            results.push({client_event_id: id, result: "invalid", reason: err.message});
        }
    }
    return results;
}

function _payloadEquals(existing, row) {
    return (existing.started_at || null) == (row.started_at || null) &&
        (existing.ended_at || null) == (row.ended_at || null) &&
        existing.duration_seconds == row.duration_seconds &&
        existing.entry_date == row.entry_date &&
        (existing.task_ref || null) == (row.task_ref || null) &&
        (existing.category || null) == (row.category || null) &&
        existing.source == row.source;
}

function _syncSummary(event) {
    return {started_at: event.started_at, ended_at: event.ended_at,
        duration_seconds: event.duration_seconds, entry_date: event.entry_date,
        task_ref: event.task_ref, category: event.category};
}

/**
 * Edits your own entry. An edit never overwrites — it appends a new event that
 * supersedes the old one and carries the reason, so the original value, the
 * editor and the moment all survive into payroll export (C5).
 *
 * A submitted week is locked; a returned week allows only its unlocked dates;
 * an approved or payroll-locked week is read-only.
 *
 * @param {object} request {org_id, person_id, entry_event_id, reason, changes}
 * @returns The new event
 * @throws If the week is not editable, or the entry is not yours
 */
exports.editOwnAsync = async function(request) {
    if (!request.reason) throw new Error("An edit needs a reason. The edit trail shows it forever (C5).");
    const result = await dblayer.runInTransactionAsync(async exec => {
        const original = await _getEventViaAsync(exec, request.org_id, request.entry_event_id);
        if (!original || original.person_id != request.person_id)
            throw new Error("The entry to edit was not found, or it is not yours.");
        const timesheet = await _timesheetForDateViaAsync(exec, request.org_id, request.person_id, original.entry_date);
        _assertEditable(timesheet, original.entry_date);

        const next = await _appendEventViaAsync(exec, {..._applyChanges(original, request.changes),
            supersedes_entry_event_id: original.entry_event_id, reason: request.reason});
        await audit.insertEntryViaAsync(exec, {org_id: request.org_id, action: "time_entry.edited",
            object_type: "time_entry", object_ref: original.entry_event_id,
            actor_person_id: request.person_id, subject_person_id: request.person_id,
            reason: request.reason, detail: {from: _editSummary(original), to: _editSummary(next)}},
            await permissions.effectivePermissionsAsync(request.org_id, request.person_id, _today(), exec));
        return {next, post_submit: timesheet?.status === STATUS.RETURNED};
    });

    try {await events.emitAsync({org_id: request.org_id, action: "time_entry.edited", person_id: request.person_id,
        source: "web", detail: {post_submit: result.post_submit}});}
    catch (err) {LOG.error(`Could not record a time_entry.edited event: ${err}`);}

    return result.next;
}

/**
 * Edits someone else's entry — the HR correction power. Runs through the H4
 * wrapper, so the permission check, the reason and the audit entry all apply,
 * and the audit write failing rolls the edit back.
 *
 * @param {object} request {org_id, actor_person_id, subject_person_id,
 *      entry_event_id, reason, changes}
 * @returns The new event
 */
exports.editOtherAsync = async function(request) {
    if (!request.reason) throw new Error(
        "Editing someone else's time needs a reason. It is recorded in the audit entry (L2).");
    const result = await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "time_entry.edit_other", subject_person_id: request.subject_person_id,
        reason: request.reason,
        audit: {action: "time_entry.edited", object_type: "time_entry", object_ref: request.entry_event_id,
            subject_person_id: request.subject_person_id,
            detail: {changed: Object.keys(request.changes).sort()}},
        action: async exec => {
            const original = await _getEventViaAsync(exec, request.org_id, request.entry_event_id);
            if (!original || original.person_id != request.subject_person_id)
                throw new Error("The entry to edit was not found for that person.");
            const timesheet = await _timesheetForDateViaAsync(exec, request.org_id, request.subject_person_id, original.entry_date);
            _assertEditable(timesheet, original.entry_date);
            const next = await _appendEventViaAsync(exec, {..._applyChanges(original, request.changes),
                supersedes_entry_event_id: original.entry_event_id, reason: request.reason});
            return {next, post_submit: timesheet?.status === STATUS.RETURNED};
        }});

    try {await events.emitAsync({org_id: request.org_id, action: "time_entry.edited",
        person_id: request.subject_person_id, source: "web", detail: {post_submit: result.post_submit}});}
    catch (err) {LOG.error(`Could not record a time_entry.edited event: ${err}`);}

    return result.next;
}

/**
 * Closes the entry a timer left open, by superseding it with the same entry ended.
 *
 * This is deliberately not editOwnAsync. An edit changes a value the person
 * already recorded and C5 shows the trail forever, so it demands a reason. A
 * clock-out is the entry completing, which is the normal end of the thing the
 * timer started — asking "why did you stop working" is not a question the
 * product gets to ask.
 *
 * @param {object} request {org_id, person_id, ended_at, entry_event_id}
 * @returns The closing event, or null if nothing was running
 */
exports.closeRunningEntryAsync = async function(request) {
    const endedAt = request.ended_at || _now();
    return await dblayer.runInTransactionAsync(async exec => {
        const day = request.entry_date || _today();
        const events = _currentEvents(await _eventsForDayViaAsync(exec, request.org_id, request.person_id, day));
        const running = events.find(event => event.ended_at === null && event.started_at &&
            (!request.entry_event_id || event.entry_event_id == request.entry_event_id));
        if (!running) return null;
        if (endedAt < running.started_at) throw new Error(
            "A clock-out cannot land before the entry it closes started.");

        const timesheet = await _timesheetForDateViaAsync(exec, request.org_id, request.person_id, running.entry_date);
        _assertEditable(timesheet, running.entry_date);

        return await _appendEventViaAsync(exec, {..._applyChanges(running, {ended_at: endedAt,
            duration_seconds: endedAt - running.started_at}),
            supersedes_entry_event_id: running.entry_event_id, reason: request.reason || null});
    });
}

/**
 * The entry a timer has left open for this person today, or null.
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} entry_date ISO date
 * @returns The running event, or null
 */
exports.runningEntryAsync = async function(org_id, person_id, entry_date) {
    const events = _currentEvents(await exports.eventsForDayAsync(org_id, person_id, entry_date || _today()));
    return events.find(event => event.ended_at === null && event.started_at) || null;
}

/**
 * Every event for a person on a date, oldest first. The person's own view.
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} entry_date ISO date
 * @returns The events
 */
exports.eventsForDayAsync = async function(org_id, person_id, entry_date) {
    _assertISODate(entry_date, "entry_date");
    return await dblayer.getQueryOrThrow(
        `SELECT * FROM time_entry_event WHERE org_id=? AND person_id=? AND entry_date=? ORDER BY recorded_at ASC`,
        [org_id, person_id, entry_date]);
}

/**
 * The time log for a task — every entry whose task_ref names it, whatever its
 * source. This is the D2 time log: projected from the ledger, never duplicated.
 * @param {string} org_id The org
 * @param {string} task_ref The task reference, e.g. TASK-1042
 * @returns The events, oldest first, each carrying its source
 */
exports.eventsForTaskAsync = async function(org_id, task_ref) {
    if (!task_ref) return [];
    return await dblayer.getQueryOrThrow(
        `SELECT * FROM time_entry_event WHERE org_id=? AND task_ref=? ORDER BY recorded_at ASC`,
        [org_id, task_ref]);
}

/** @returns ISO Monday for the week containing the given ISO date */
exports.weekStartOf = function(isoDate) {
    _assertISODate(isoDate, "date");
    const d = new Date(`${isoDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().substring(0, 10);
}

// ---------------------------------------------------------------------------
// C3 — the day-reconstruction gap-finder
// ---------------------------------------------------------------------------

/**
 * The day's unaccounted gaps: the declared working window, minus whatever the
 * timer ledger already covers. Never a gap out of time that hasn't happened
 * yet — a gap only exists up to now, not up to the window's stated end.
 *
 * Takes the window span already resolved rather than requiring windows.js
 * itself (windows.js already requires this file, for driftAsync's own read of
 * the ledger — resolving the span at the caller avoids the cycle entirely).
 *
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} date ISO date
 * @param {object|null} windowSpan {start_epoch, end_epoch, window_id}, or null
 *      when nothing is declared for this date (windows.windowSpanForDateAsync)
 * @returns {object} {window, gaps, covered_seconds, window_seconds}
 */
exports.dayGapsAsync = async function(org_id, person_id, date, windowSpan) {
    _assertISODate(date, "date");
    if (!windowSpan) return {window: null, gaps: [], covered_seconds: 0, window_seconds: 0};

    const end = Math.min(windowSpan.end_epoch, _now());
    if (end <= windowSpan.start_epoch) return {window: windowSpan.window_id, gaps: [], covered_seconds: 0, window_seconds: 0};

    const events = _currentEvents(await exports.eventsForDayAsync(org_id, person_id, date));
    const intervals = events
        .filter(event => event.started_at != null)
        .map(event => [Math.max(event.started_at, windowSpan.start_epoch), Math.min(event.ended_at ?? _now(), end)])
        .filter(([from, to]) => to > from)
        .sort((a, b) => a[0] - b[0]);

    const merged = [];
    for (const [from, to] of intervals) {
        const last = merged[merged.length-1];
        if (last && from <= last[1]) last[1] = Math.max(last[1], to);
        else merged.push([from, to]);
    }

    const gaps = [];
    let cursor = windowSpan.start_epoch;
    for (const [from, to] of merged) {
        if (from > cursor) gaps.push({start_epoch: cursor, end_epoch: from});
        cursor = Math.max(cursor, to);
    }
    if (cursor < end) gaps.push({start_epoch: cursor, end_epoch: end});

    return {window: windowSpan.window_id, gaps,
        covered_seconds: merged.reduce((sum, [from, to]) => sum + (to-from), 0),
        window_seconds: end - windowSpan.start_epoch};
}

/**
 * Fills one gap: a real entry, marked reconstructed, keeping the signal it
 * came from — never a fabricated calendar/app-session provenance this app
 * cannot back. Refused on an already-submitted/approved/locked week, the one
 * explicit gate C3's own spec asks for (recordEventAsync itself has none — no
 * business rule ever refuses to record time someone worked — so this is a
 * gate specific to this tool, not a change to that primitive).
 *
 * @param {object} request {org_id, person_id, entry_date, started_at,
 *      ended_at, task_ref, category, note, recorded_by}
 * @returns The recorded entry
 * @throws If the week is already submitted, approved or locked
 */
exports.fillGapAsync = async function(request) {
    const {org_id, person_id, entry_date} = request;
    const weekStart = exports.weekStartOf(entry_date);
    const sheet = await _timesheetAsync(null, org_id, person_id, weekStart);
    if (sheet && [STATUS.SUBMITTED, STATUS.APPROVED, STATUS.LOCKED].includes(sheet.status)) throw new Error(
        `This week is already ${sheet.status}. Reconstructed entries can't be added to it.`);

    return await exports.recordEventAsync({org_id, person_id, entry_date,
        started_at: request.started_at, ended_at: request.ended_at,
        task_ref: request.task_ref || null, category: request.category || null,
        note: request.note || null, billable: !["break", "other"].includes(request.category),
        source: "manual", reconstructed: true,
        signal: JSON.stringify({type: "gap_fill", name: "self-assigned from a declared-window gap"})});
}

// ---------------------------------------------------------------------------
// the timesheet
// ---------------------------------------------------------------------------

/**
 * The owner's view of a week — every entry with its times, the sheet state, and
 * the return reason when there is one. This shape never leaves the person.
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} week_start ISO Monday
 * @returns {object} {timesheet, events, totals}
 */
exports.timesheetForOwnerAsync = async function(org_id, person_id, week_start) {
    const weekStart = exports.weekStartOf(week_start);
    const timesheet = await _timesheetAsync(null, org_id, person_id, weekStart);
    const events = await _eventsForWeekViaAsync(null, org_id, person_id, weekStart);
    return {timesheet, events, totals: _summarise(events, _now())};
}

/**
 * The approver's view — what C5's mirror says a manager sees, and nothing more:
 * per-task totals, the billable split, the reconstructed count, and the note.
 * Per-entry start times are absent from this shape by construction.
 *
 * @param {string} org_id The org
 * @param {string} actor_person_id The reader — a lead, HR, or an admin
 * @param {string} subject_person_id Whose week it is
 * @param {string} week_start ISO Monday
 * @returns {object} {timesheet, totals}
 * @throws If the reader's timesheet.read grant does not cover this person
 */
exports.timesheetForApproverAsync = async function(org_id, actor_person_id, subject_person_id, week_start) {
    const decision = await permissions.checkAsync({org_id, actor_person_id,
        capability: "timesheet.read", subject_person_id, asOf: _today()});
    if (!decision.allowed) throw Object.assign(new Error(
        `Reading this week is refused: ${decision.reason} ${decision.who_can||""}`), {decision});

    const weekStart = exports.weekStartOf(week_start);
    const timesheet = await _timesheetAsync(null, org_id, subject_person_id, weekStart);
    const events = await _eventsForWeekViaAsync(null, org_id, subject_person_id, weekStart);
    const totals = _summarise(events, _now());
    delete totals.by_task_start_times;    // defensive: this shape never carries per-entry times
    return {timesheet: timesheet && {...timesheet, unlocked_dates: undefined, submitted_by: undefined},
        totals};
}

/**
 * The C7 queue: every direct report's submitted week still waiting on this
 * actor. `permissions.checkAsync`'s DIRECT_REPORTS scope needs an explicit
 * subject to resolve at all, so this walks the org chart first rather than
 * asking the permission engine for a list it cannot produce — the same
 * existence check `wellbeing.js`'s `teamLoadAsync` already established for
 * exactly this shape (a cohort, not a single subject).
 *
 * @param {string} org_id The org
 * @param {string} actor_person_id The approver
 * @param {string} asOf ISO date, defaults to today — who counts as a direct report
 * @returns {array} [{person_id, timesheet_id, week_start, week_end, submitted_at,
 *      total_seconds, reconstructed_count}]
 * @throws If the actor holds no timesheet.approve grant at all
 */
exports.pendingApprovalsForAsync = async function(org_id, actor_person_id, asOf) {
    const grants = await permissions.activeGrantsAsync(org_id, actor_person_id, {capability: "timesheet.approve"});
    if (!grants.length) throw new Error("timesheet.approve is required to read the approval queue.");

    const reports = await spine.directReportsAsOfAsync(org_id, actor_person_id, asOf || _today());
    const queue = [];
    for (const report of reports) {
        const submitted = await dblayer.getQueryOrThrow(
            "SELECT * FROM timesheet WHERE org_id=? AND person_id=? AND status=? ORDER BY week_start",
            [org_id, report.person_id, STATUS.SUBMITTED]);
        for (const sheet of submitted) {
            const events = await _eventsForWeekViaAsync(null, org_id, report.person_id, sheet.week_start);
            const totals = _summarise(events, _now());
            queue.push({person_id: report.person_id, timesheet_id: sheet.timesheet_id,
                week_start: sheet.week_start, week_end: sheet.week_end, submitted_at: sheet.submitted_at,
                total_seconds: totals.total_seconds, reconstructed_count: totals.reconstructed_count});
        }
    }
    return queue;
}

/**
 * The C7 "not yet submitted" list: direct reports with no submitted (or
 * later) week on record for the given week — a missing row is neither a
 * decision waiting nor a closed one.
 *
 * @param {string} org_id The org
 * @param {string} actor_person_id The approver
 * @param {string} week_start ISO date inside the week, defaults to today
 * @param {string} asOf ISO date, defaults to today — who counts as a direct report
 * @returns {array} [{person_id, week_start, week_end}]
 * @throws If the actor holds no timesheet.approve grant at all
 */
exports.missingSubmissionsForAsync = async function(org_id, actor_person_id, week_start, asOf) {
    const grants = await permissions.activeGrantsAsync(org_id, actor_person_id, {capability: "timesheet.approve"});
    if (!grants.length) throw new Error("timesheet.approve is required to read the approval queue.");

    const weekStart = exports.weekStartOf(week_start || _today());
    const weekEnd = _weekEndOf(weekStart);
    const reports = await spine.directReportsAsOfAsync(org_id, actor_person_id, asOf || _today());
    const missing = [];
    for (const report of reports) {
        const sheet = await _timesheetAsync(null, org_id, report.person_id, weekStart);
        if (!sheet || [STATUS.OPEN, STATUS.RETURNED].includes(sheet.status))
            missing.push({person_id: report.person_id, week_start: weekStart, week_end: weekEnd});
    }
    return missing;
}

/**
 * Submits the week. The submission pins the entry events as they stood through
 * the timesheet_entry edges, so a later edit cannot silently change what was
 * submitted. Resubmitting after a return re-pins.
 *
 * @param {object} request {org_id, person_id, week_start}
 * @returns {object} {timesheet, totals}
 */
exports.submitTimesheetAsync = async function(request) {
    const {org_id, person_id} = request;
    const weekStart = exports.weekStartOf(request.week_start);
    const weekEnd = _weekEndOf(weekStart);

    return await dblayer.runInTransactionAsync(async exec => {
        const existing = await _timesheetAsync(exec, org_id, person_id, weekStart);
        if (existing && ![STATUS.OPEN, STATUS.RETURNED].includes(existing.status))
            throw new Error(`Week ${weekStart} is ${existing.status} and cannot be resubmitted.`);

        const events = await _eventsForWeekViaAsync(exec, org_id, person_id, weekStart);
        const totals = _summarise(events, _now());

        const timesheet = {timesheet_id: existing?.timesheet_id || serverutils.generateUUID(false),
            org_id, person_id, week_start: weekStart, week_end: weekEnd,
            status: STATUS.SUBMITTED, submitted_at: _now(), submitted_by: person_id};
        if (existing) await exec.runCmd(
            `UPDATE timesheet SET status='submitted', submitted_at=?, submitted_by=?, return_reason=NULL, unlocked_dates=NULL,
                approved_at=NULL, approved_by=NULL WHERE timesheet_id=?`,
            [timesheet.submitted_at, person_id, timesheet.timesheet_id]);
        else await exec.runCmd(
            `INSERT INTO timesheet (timesheet_id, org_id, person_id, week_start, week_end, status, submitted_at, submitted_by)
                VALUES (?,?,?,?,?,?,?,?)`,
            [timesheet.timesheet_id, org_id, person_id, weekStart, weekEnd, STATUS.SUBMITTED,
                timesheet.submitted_at, person_id]);
        await exec.runCmd("DELETE FROM timesheet_entry WHERE timesheet_id=?", [timesheet.timesheet_id]);
        for (const event of _currentEvents(events)) await exec.runCmd(
            `INSERT INTO timesheet_entry (timesheet_entry_id, org_id, timesheet_id, entry_event_id, entry_date,
                task_ref, project, client_code, note, billable, duration_seconds, source, reconstructed)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [serverutils.generateUUID(false), org_id, timesheet.timesheet_id, event.entry_event_id,
                event.entry_date, event.task_ref, event.project, event.client_code, event.note,
                event.billable, event.duration_seconds, event.source, event.reconstructed]);

        await audit.insertEntryViaAsync(exec, {org_id, action: "timesheet.submitted",
            object_type: "timesheet", object_ref: timesheet.timesheet_id,
            actor_person_id: person_id, subject_person_id: person_id,
            detail: {week_start: weekStart, total_seconds: totals.total_seconds}},
            await permissions.effectivePermissionsAsync(org_id, person_id, _today(), exec));
        return {timesheet, totals};
    });
}

/**
 * Returns a submitted week, with a reason pinned to the record and named dates
 * unlocked — not necessarily the whole week (C7). The approver side of the
 * approval loop, so it runs through the H4 wrapper as an audited signature.
 *
 * @param {object} request {org_id, actor_person_id, subject_person_id,
 *      week_start, reason, unlock_dates}
 */
exports.returnTimesheetAsync = async function(request) {
    if (!request.reason) throw new Error(
        "A return carries a reason. It is shown to the person and kept on the record (C7).");
    const weekStart = exports.weekStartOf(request.week_start);
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "timesheet.approve", subject_person_id: request.subject_person_id,
        reason: request.reason,
        audit: {action: "timesheet.returned", object_type: "timesheet", object_ref: weekStart,
            subject_person_id: request.subject_person_id, reason: request.reason,
            detail: {week_start: weekStart, unlock_dates: request.unlock_dates || []}},
        action: async exec => {
            const sheet = await _timesheetAsync(exec, request.org_id, request.subject_person_id, weekStart);
            if (!sheet || sheet.status != STATUS.SUBMITTED)
                throw new Error(`Week ${weekStart} is not awaiting approval, so it cannot be returned.`);
            await exec.runCmd(
                "UPDATE timesheet SET status='returned', return_reason=?, unlocked_dates=? WHERE timesheet_id=?",
                [request.reason, JSON.stringify(request.unlock_dates || []), sheet.timesheet_id]);
            return "returned";
        }});
}

/**
 * Approves a submitted week. Approving is a signature (C7): the audit entry pins
 * the actor's name and the totals as they stood, and it lands in the same
 * transaction as the status change.
 *
 * @param {object} request {org_id, actor_person_id, subject_person_id, week_start}
 */
exports.approveTimesheetAsync = async function(request) {
    const weekStart = exports.weekStartOf(request.week_start);
    const seen = await exports.timesheetForApproverAsync(
        request.org_id, request.actor_person_id, request.subject_person_id, weekStart);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "timesheet.approve", subject_person_id: request.subject_person_id,
        audit: {action: "timesheet.approved", object_type: "timesheet", object_ref: weekStart,
            subject_person_id: request.subject_person_id,
            detail: {week_start: weekStart, total_seconds: seen.totals.total_seconds,
                by_task: seen.totals.by_task, billable_seconds: seen.totals.billable_seconds,
                reconstructed_count: seen.totals.reconstructed_count}},
        action: async exec => {
            const sheet = await _timesheetAsync(exec, request.org_id, request.subject_person_id, weekStart);
            if (!sheet || sheet.status != STATUS.SUBMITTED)
                throw new Error(`Week ${weekStart} is not awaiting approval.`);
            await exec.runCmd("UPDATE timesheet SET status='approved', approved_at=?, approved_by=? WHERE timesheet_id=?",
                [_now(), request.actor_person_id, sheet.timesheet_id]);
            return "approved";
        }});
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function _assertISODate(date, label="date") {
    if ((typeof date != "string") || (!ISO_DATE.test(date))) throw new Error(
        `${label} must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(date)}.`);
    return date;
}

function _weekEndOf(weekStart) {
    const d = new Date(`${weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 6);
    return d.toISOString().substring(0, 10);
}

/**
 * Validates and normalises a new event. Never refuses on business grounds — only
 * on values that cannot be stored as time.
 */
function _prepareEvent(event, reason) {
    const {org_id, person_id} = event;
    if (!org_id || !person_id) throw new Error("A time entry needs both an org_id and a person_id.");
    const entry_date = _assertISODate(event.entry_date, "entry_date");
    const source = event.source || "manual";
    if (!SOURCES.includes(source)) throw new Error(`Unknown entry source ${JSON.stringify(source)}. Known: ${SOURCES.join(", ")}.`);

    let {started_at, ended_at, duration_seconds} = event;
    if (started_at !== undefined && started_at !== null && !Number.isInteger(started_at)) throw new Error("started_at must be unix seconds.");
    if (ended_at !== undefined && ended_at !== null && !Number.isInteger(ended_at)) throw new Error("ended_at must be unix seconds.");
    // An entry that starts and stops in the same second is a true statement, and a
    // clock-out is the one action that is not allowed to fail. Only time running
    // backwards is refused.
    if (started_at && ended_at && ended_at < started_at) throw new Error(
        `ended_at (${ended_at}) cannot be before started_at (${started_at}).`);
    if (duration_seconds === undefined || duration_seconds === null) {
        if (started_at && ended_at) duration_seconds = ended_at - started_at;
        else duration_seconds = 0;    // a running timer (started only) projects on read; a no-time entry is zero
    }
    if (!Number.isInteger(duration_seconds) || duration_seconds < 0) throw new Error(
        `duration_seconds must be a non-negative integer, got ${JSON.stringify(duration_seconds)}.`);

    if (event.reconstructed && !event.signal) throw new Error(
        "A reconstructed entry keeps the signal it came from (C3). Supply signal when reconstructed is set.");
    if (event.signal && !event.reconstructed) LOG.warn(`Entry ${event.client_event_id||""} carries a signal but is not marked reconstructed.`);

    return {entry_event_id: serverutils.generateUUID(false), org_id, person_id,
        client_event_id: event.client_event_id || null, entry_date,
        task_ref: event.task_ref || null, project: event.project || null,
        client_code: event.client_code || null, note: event.note || null,
        billable: event.billable === undefined ? 1 : (event.billable ? 1 : 0),
        started_at: started_at || null, ended_at: ended_at || null,
        duration_seconds, source, category: event.category || null,
        signal: event.signal || null,
        reconstructed: event.reconstructed ? 1 : 0,
        supersedes_entry_event_id: event.supersedes_entry_event_id || null,
        reason: reason || null, recorded_at: _now()};
}

function _eventParams(row) {
    return [row.entry_event_id, row.org_id, row.person_id, row.client_event_id, row.entry_date,
        row.task_ref, row.project, row.client_code, row.note, row.billable,
        row.started_at, row.ended_at, row.duration_seconds, row.source, row.category,
        row.signal, row.reconstructed, row.supersedes_entry_event_id, row.reason, row.recorded_at];
}

async function _byClientEventIdAsync(org_id, person_id, client_event_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM time_entry_event WHERE org_id=? AND person_id=? AND client_event_id=?",
        [org_id, person_id, client_event_id]);
    return rows.length ? rows[0] : null;
}

async function _appendEventViaAsync(exec, event) {
    const row = _prepareEvent(event, event.reason);
    await exec.runCmd(`INSERT INTO time_entry_event (${EVENT_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        _eventParams(row));
    return row;
}

/**
 * The exec-aware write for modules that must land a time entry inside their own
 * transaction (training, P1 — a completed module writes its time in the same
 * transaction as its progress event, so neither can exist without the other).
 *
 * @param {object} exec The transaction executor from runInTransactionAsync
 * @param {object} event As for recordEventAsync
 * @returns The stored event
 */
exports.insertEventViaAsync = function(exec, event) {
    return _appendEventViaAsync(exec, event);
}

async function _getEventViaAsync(exec, org_id, entry_event_id) {
    const rows = await exec.getQuery("SELECT * FROM time_entry_event WHERE org_id=? AND entry_event_id=?",
        [org_id, entry_event_id]);
    return rows.length ? rows[0] : null;
}

function _applyChanges(original, changes) {
    const editable = ["duration_seconds", "task_ref", "project", "client_code", "note", "billable",
        "started_at", "ended_at", "entry_date", "category"];
    const unknown = Object.keys(changes).filter(key => !editable.includes(key));
    if (unknown.length) throw new Error(`Unknown change fields: ${unknown.join(", ")}.`);

    return {org_id: original.org_id, person_id: original.person_id,
        entry_date: changes.entry_date || original.entry_date,
        task_ref: changes.task_ref !== undefined ? changes.task_ref : original.task_ref,
        project: changes.project !== undefined ? changes.project : original.project,
        client_code: changes.client_code !== undefined ? changes.client_code : original.client_code,
        note: changes.note !== undefined ? changes.note : original.note,
        billable: changes.billable !== undefined ? changes.billable : original.billable,
        started_at: changes.started_at !== undefined ? changes.started_at : original.started_at,
        ended_at: changes.ended_at !== undefined ? changes.ended_at : original.ended_at,
        // changing the times recomputes the duration unless the caller supplied one
        duration_seconds: changes.duration_seconds !== undefined ? changes.duration_seconds :
            ((changes.started_at !== undefined || changes.ended_at !== undefined) ? undefined : original.duration_seconds),
        category: changes.category !== undefined ? changes.category : original.category,
        source: original.source, signal: original.signal, reconstructed: original.reconstructed};
}

function _editSummary(event) {
    return {duration_seconds: event.duration_seconds, task_ref: event.task_ref, note: event.note};
}

/**
 * The week's gate. No timesheet means the person owns their time freely. A
 * submitted, approved or payroll-locked week is closed; a returned week opens
 * exactly its unlocked dates.
 */
function _assertEditable(timesheet, entry_date) {
    if (!timesheet || timesheet.status == STATUS.OPEN) return;
    if (timesheet.status == STATUS.RETURNED) {
        const unlocked = JSON.parse(timesheet.unlocked_dates || "[]");
        if (unlocked.includes(entry_date)) return;
        throw new Error(
            `This entry is in a returned week. Only these dates are unlocked: ${unlocked.length ? unlocked.join(", ") : "none"}.`);
    }
    throw new Error(timesheet.status == STATUS.SUBMITTED ?
        `This entry is in a submitted week. The week is locked until a manager returns it.` :
        `This entry is in a ${timesheet.status} week. Edits become adjustments once a week is approved or payroll-locked.`);
}

async function _timesheetAsync(exec, org_id, person_id, week_start) {
    const rows = exec ? await exec.getQuery(
        "SELECT * FROM timesheet WHERE org_id=? AND person_id=? AND week_start=?", [org_id, person_id, week_start]) :
        await dblayer.getQueryOrThrow(
        "SELECT * FROM timesheet WHERE org_id=? AND person_id=? AND week_start=?", [org_id, person_id, week_start]);
    return rows.length ? rows[0] : null;
}

async function _timesheetForDateViaAsync(exec, org_id, person_id, entry_date) {
    const weekStart = exports.weekStartOf(entry_date);
    return await _timesheetAsync(exec, org_id, person_id, weekStart);
}

async function _eventsForDayViaAsync(exec, org_id, person_id, entry_date) {
    const sql = `SELECT * FROM time_entry_event WHERE org_id=? AND person_id=? AND entry_date=?
        ORDER BY recorded_at ASC`;
    return exec ? await exec.getQuery(sql, [org_id, person_id, entry_date]) :
        await dblayer.getQueryOrThrow(sql, [org_id, person_id, entry_date]);
}

async function _eventsForWeekViaAsync(exec, org_id, person_id, week_start) {
    const weekEnd = _weekEndOf(week_start);
    const sql = `SELECT * FROM time_entry_event WHERE org_id=? AND person_id=? AND entry_date >= ? AND entry_date <= ?
        ORDER BY entry_date ASC, recorded_at ASC`;
    return exec ? await exec.getQuery(sql, [org_id, person_id, week_start, weekEnd]) :
        await dblayer.getQueryOrThrow(sql, [org_id, person_id, week_start, weekEnd]);
}

/**
 * Projects the week's numbers over the events. Never stored (A6) — recomputed
 * every read, with running entries measured to now.
 *
 * An event that has been superseded by an edit stays in the ledger and the edit
 * trail (C5), but it does not count here — its latest version does. Counting both
 * would double the week.
 * @returns {object} {total_seconds, billable_seconds, reconstructed_count, by_task}
 */
function _summarise(events, nowSeconds) {
    const by_task = {}, total = {total_seconds: 0, billable_seconds: 0, reconstructed_count: 0};
    for (const event of _currentEvents(events)) {
        let seconds = event.duration_seconds;
        if (event.ended_at === null && event.started_at) seconds = Math.max(0, nowSeconds - event.started_at);
        seconds = seconds || 0;

        total.total_seconds += seconds;
        if (event.billable) total.billable_seconds += seconds;
        if (event.reconstructed) total.reconstructed_count++;

        const key = event.task_ref || "(no task)";
        const row = by_task[key] || (by_task[key] = {task_ref: event.task_ref || null, seconds: 0,
            billable_seconds: 0, reconstructed: false, entries: 0});
        row.seconds += seconds;
        if (event.billable) row.billable_seconds += seconds;
        row.reconstructed = row.reconstructed || Boolean(event.reconstructed);
        row.entries++;
    }
    return {...total, by_task: Object.values(by_task)};
}

/** The entries in their latest state — superseded originals stay in the trail, not in the projection. */
function _currentEvents(events) {
    const superseded = new Set(events.filter(event => event.supersedes_entry_event_id)
        .map(event => event.supersedes_entry_event_id));
    return events.filter(event => !superseded.has(event.entry_event_id));
}

exports.STATUS = STATUS;
exports.SOURCES = SOURCES;
exports.currentEvents = _currentEvents;
