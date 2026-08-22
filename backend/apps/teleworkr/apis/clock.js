/**
 * The clock API — A11. The actor is the token's id (their email).
 *
 * Operations:
 *  op - status         - Today's clock: total, the running entry, the window's local end
 *  op - sync           - Replays events buffered offline, idempotently by client_event_id
 *  op - session        - C2's popover: clocked in at, breaks, target, what it is bound to
 *  op - in             - Starts the clock, optionally bound to a task
 *  op - out            - Stops the clock and answers with what was recorded
 *  op - out_preview    - What the clock-out confirm states before it offers the verb
 *  op - switch         - Moves the clock to another task without stopping it
 *  op - break_start    - Starts a break; the clock stops because a break is not worked time
 *  op - break_end      - Ends the break, optionally resuming the task it paused
 *  op - idle           - Resolves an idle stretch: keep, discard or break
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const calendar = require(`${TELEWORKR_CONSTANTS.LIBDIR}/calendar.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const clock = require(`${TELEWORKR_CONSTANTS.LIBDIR}/clock.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "status": {
                const status = await calendar.clockStatusAsync(jsonReq.org, actor.person_id, jsonReq.date);
                return {...CONSTANTS.TRUE_RESULT, ...status};
            }
            case "sync": {
                if (!Array.isArray(jsonReq.events)) return CONSTANTS.FALSE_RESULT;
                const results = await time.syncEventsAsync(jsonReq.org, actor.person_id, jsonReq.events);
                return {...CONSTANTS.TRUE_RESULT, results};
            }
            case "session": {
                return {...CONSTANTS.TRUE_RESULT,
                    ...await clock.sessionAsync(jsonReq.org, actor.person_id, jsonReq.date)};
            }
            case "in": {
                const started = await clock.clockInAsync({org_id: jsonReq.org, person_id: actor.person_id,
                    task_ref: jsonReq.task_ref, project: jsonReq.project, note: jsonReq.note,
                    at: jsonReq.at, entry_date: jsonReq.date, client_event_id: jsonReq.client_event_id});
                return {...CONSTANTS.TRUE_RESULT, ...started};
            }
            case "out": {
                const stopped = await clock.clockOutAsync({org_id: jsonReq.org, person_id: actor.person_id,
                    at: jsonReq.at, entry_date: jsonReq.date});
                return {...CONSTANTS.TRUE_RESULT, ...stopped};
            }
            case "out_preview": {
                return {...CONSTANTS.TRUE_RESULT, ...await clock.clockOutPreviewAsync(
                    {org_id: jsonReq.org, person_id: actor.person_id, at: jsonReq.at, entry_date: jsonReq.date})};
            }
            case "switch": {
                const switched = await clock.switchTaskAsync({org_id: jsonReq.org, person_id: actor.person_id,
                    task_ref: jsonReq.task_ref, project: jsonReq.project, at: jsonReq.at,
                    entry_date: jsonReq.date, client_event_id: jsonReq.client_event_id});
                return {...CONSTANTS.TRUE_RESULT, ...switched};
            }
            case "break_start": {
                return {...CONSTANTS.TRUE_RESULT, ...await clock.startBreakAsync({org_id: jsonReq.org,
                    person_id: actor.person_id, at: jsonReq.at, entry_date: jsonReq.date, reason: jsonReq.reason})};
            }
            case "break_end": {
                return {...CONSTANTS.TRUE_RESULT, ...await clock.endBreakAsync({org_id: jsonReq.org,
                    person_id: actor.person_id, at: jsonReq.at, entry_date: jsonReq.date,
                    resume_task_ref: jsonReq.resume_task_ref})};
            }
            case "idle": {
                return {...CONSTANTS.TRUE_RESULT, ...await clock.resolveIdleAsync({org_id: jsonReq.org,
                    person_id: actor.person_id, decision: jsonReq.decision, idle_seconds: jsonReq.idle_seconds,
                    at: jsonReq.at, entry_date: jsonReq.date})};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Clock operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && jsonReq.id && jsonReq.org &&
    ["status", "sync", "session", "in", "out", "out_preview", "switch",
        "break_start", "break_end", "idle"].includes(jsonReq.op);
