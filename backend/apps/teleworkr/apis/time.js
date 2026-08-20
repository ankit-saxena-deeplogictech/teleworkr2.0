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
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);

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
        default: return CONSTANTS.FALSE_RESULT;
    }
}

/** Resolves the token's id (an email) to the person acting. */
const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && ["record", "day", "week", "submit", "read_other", "return", "approve"]
    .includes(jsonReq.op) && jsonReq.id && jsonReq.org;
