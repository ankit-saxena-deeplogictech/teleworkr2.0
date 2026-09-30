/**
 * The time API — the C-section surface. The actor is the token's id (their
 * email); every permission the wireframes care about is enforced in lib/time.js,
 * not here.
 *
 * Operations:
 *  op - record      - Appends a time entry event (idempotent on client_event_id)
 *  op - day         - The caller's own events for a date
 *  op - week        - The caller's own week, with the timesheet state
 *  op - submit      - Submits the caller's week
 *  op - read_other  - Another person's week, at the caller's read level
 *  op - return      - Returns a submitted week, with a reason and unlocked dates
 *  op - approve     - Approves a submitted week, as a signature
 *  op - pending     - C7: the caller's direct reports' submitted weeks
 *  op - missing     - C7: the caller's direct reports with nothing submitted for a week
 *  op - approve_many - C7: approves several weeks, each its own signature
 *  op - return_many  - C7: returns several weeks with one shared reason
 *  op - gaps        - C3: the caller's unaccounted gaps for a date
 *  op - fill_gap    - C3: fills one gap, marked reconstructed with its signal
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        return await _dispatch(jsonReq);
    } catch (err) {
        LOG.error(`Time operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message,
            decision: err.decision?.outcome, rule: err.decision?.rule};
    }
}

const _dispatch = async jsonReq => {
    const actor = await _actorAsync(jsonReq);
    switch (jsonReq.op) {
        case "record": {
            const entry = await time.recordEventAsync({org_id: jsonReq.org, person_id: actor.person_id,
                client_event_id: jsonReq.client_event_id, entry_date: jsonReq.entry_date,
                task_ref: jsonReq.task_ref, project: jsonReq.project, client_code: jsonReq.client_code,
                note: jsonReq.note, billable: jsonReq.billable, started_at: jsonReq.started_at,
                ended_at: jsonReq.ended_at, duration_seconds: jsonReq.duration_seconds,
                source: jsonReq.source, signal: jsonReq.signal, reconstructed: jsonReq.reconstructed});
            return {...CONSTANTS.TRUE_RESULT, entry_event_id: entry.entry_event_id, entry};
        }
        case "day": {
            const events = await time.eventsForDayAsync(jsonReq.org, actor.person_id, jsonReq.entry_date);
            return {...CONSTANTS.TRUE_RESULT, events};
        }
        case "week": {
            const week = await time.timesheetForOwnerAsync(jsonReq.org, actor.person_id, jsonReq.week_start);
            return {...CONSTANTS.TRUE_RESULT, ...week};
        }
        case "edit": {
            const edited = await time.editOwnAsync({org_id: jsonReq.org, person_id: actor.person_id,
                entry_event_id: jsonReq.entry_event_id, reason: jsonReq.reason, changes: jsonReq.changes});
            return {...CONSTANTS.TRUE_RESULT, entry: edited};
        }
        case "submit": {
            const submitted = await time.submitTimesheetAsync(
                {org_id: jsonReq.org, person_id: actor.person_id, week_start: jsonReq.week_start});
            return {...CONSTANTS.TRUE_RESULT, timesheet: submitted.timesheet, totals: submitted.totals};
        }
        case "read_other": {
            const view = await time.timesheetForApproverAsync(jsonReq.org, actor.person_id,
                jsonReq.subject_person_id, jsonReq.week_start);
            return {...CONSTANTS.TRUE_RESULT, ...view};
        }
        case "return": {
            await time.returnTimesheetAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                subject_person_id: jsonReq.subject_person_id, week_start: jsonReq.week_start,
                reason: jsonReq.reason, unlock_dates: jsonReq.unlock_dates});
            return CONSTANTS.TRUE_RESULT;
        }
        case "approve": {
            await time.approveTimesheetAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                subject_person_id: jsonReq.subject_person_id, week_start: jsonReq.week_start});
            return CONSTANTS.TRUE_RESULT;
        }
        case "pending": {
            const queue = await time.pendingApprovalsForAsync(jsonReq.org, actor.person_id, jsonReq.as_of);
            return {...CONSTANTS.TRUE_RESULT, queue};
        }
        case "missing": {
            const missing = await time.missingSubmissionsForAsync(jsonReq.org, actor.person_id,
                jsonReq.week_start, jsonReq.as_of);
            return {...CONSTANTS.TRUE_RESULT, missing};
        }
        case "approve_many": {
            if (!Array.isArray(jsonReq.items)) return CONSTANTS.FALSE_RESULT;
            const succeeded = [], failed = [];
            for (const item of jsonReq.items) try {
                await time.approveTimesheetAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    subject_person_id: item.subject_person_id, week_start: item.week_start});
                succeeded.push(item);
            } catch (err) {failed.push({...item, reason: err.message});}
            return {...CONSTANTS.TRUE_RESULT, succeeded, failed};
        }
        case "return_many": {
            if (!Array.isArray(jsonReq.items)) return CONSTANTS.FALSE_RESULT;
            const succeeded = [], failed = [];
            for (const item of jsonReq.items) try {
                // Each item's own week, whole, unless it names its own dates — a
                // shared unlock_dates array can't mean the same thing across items
                // whose weeks differ, so bulk return defaults to coarse: the whole
                // week, per item, not the single-item op's granular per-date unlock.
                await time.returnTimesheetAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    subject_person_id: item.subject_person_id, week_start: item.week_start,
                    reason: jsonReq.reason, unlock_dates: item.unlock_dates || _weekDates(item.week_start)});
                succeeded.push(item);
            } catch (err) {failed.push({...item, reason: err.message});}
            return {...CONSTANTS.TRUE_RESULT, succeeded, failed};
        }
        case "gaps": {
            const span = await windows.windowSpanForDateAsync(jsonReq.org, actor.person_id, jsonReq.entry_date);
            const gaps = await time.dayGapsAsync(jsonReq.org, actor.person_id, jsonReq.entry_date, span);
            return {...CONSTANTS.TRUE_RESULT, ...gaps};
        }
        case "fill_gap": {
            const entry = await time.fillGapAsync({org_id: jsonReq.org, person_id: actor.person_id,
                entry_date: jsonReq.entry_date, started_at: jsonReq.started_at, ended_at: jsonReq.ended_at,
                task_ref: jsonReq.task_ref, category: jsonReq.category, note: jsonReq.note});
            return {...CONSTANTS.TRUE_RESULT, entry};
        }
        default: return CONSTANTS.FALSE_RESULT;
    }
}

/** Resolves the token's id (an email) to the person acting. */
const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && ["record", "day", "week", "edit", "submit", "read_other", "return",
    "approve", "pending", "missing", "approve_many", "return_many", "gaps", "fill_gap"]
    .includes(jsonReq.op) && jsonReq.id && jsonReq.org;

/** The week's seven ISO dates, Monday first — return_many's whole-week default. */
const _weekDates = weekStart => {
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(`${weekStart}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
        dates.push(d.toISOString().substring(0, 10));
    }
    return dates;
}
