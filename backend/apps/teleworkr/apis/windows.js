/**
 * The windows API — E3/E4. The actor is the token's id (their email).
 *
 * Operations:
 *  op - set           - Declares or changes the caller's working window
 *  op - travel        - Sets a dated travel period, resuming the base after it
 *  op - asof          - The caller's window in force on a date
 *  op - availability  - The caller's availability for one date
 *  op - team_overlap  - The shared window for a set of people on a date
 *  op - dst           - DST transition flags for a set of people in the coming week
 *  op - drift         - How the caller's clock-ins compare to their declared window
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "set": {
                const window = await windows.setWindowAsync({org_id: jsonReq.org, person_id: actor.person_id,
                    timezone: jsonReq.timezone, start_minute: jsonReq.start_minute,
                    end_minute: jsonReq.end_minute, days: jsonReq.days,
                    valid_from: jsonReq.valid_from, note: jsonReq.note, recorded_by: actor.person_id});
                return {...CONSTANTS.TRUE_RESULT, window};
            }
            case "travel": {
                const travel = await windows.setTravelAsync({org_id: jsonReq.org, person_id: actor.person_id,
                    timezone: jsonReq.timezone, valid_from: jsonReq.valid_from, valid_to: jsonReq.valid_to,
                    start_minute: jsonReq.start_minute, end_minute: jsonReq.end_minute,
                    note: jsonReq.note, recorded_by: actor.person_id});
                return {...CONSTANTS.TRUE_RESULT, travel};
            }
            case "asof": {
                const window = await windows.windowAsOfAsync(jsonReq.org, actor.person_id,
                    jsonReq.as_of || jsonReq.date);
                return {...CONSTANTS.TRUE_RESULT, window};
            }
            case "availability": {
                const availability = await windows.availabilityForDateAsync(
                    jsonReq.org, actor.person_id, jsonReq.date);
                return {...CONSTANTS.TRUE_RESULT, ...availability};
            }
            case "team_overlap": {
                if (!Array.isArray(jsonReq.person_ids)) return CONSTANTS.FALSE_RESULT;
                const overlap = await windows.teamOverlapAsync(jsonReq.org, jsonReq.person_ids, jsonReq.date);
                return {...CONSTANTS.TRUE_RESULT, ...overlap};
            }
            case "dst": {
                const flags = await windows.dstTransitionFlagsAsync(
                    jsonReq.org, jsonReq.person_ids || [actor.person_id], jsonReq.date);
                return {...CONSTANTS.TRUE_RESULT, flags};
            }
            case "drift": {
                const drift = await windows.driftAsync(jsonReq.org, actor.person_id,
                    {days: jsonReq.days, grace_minutes: jsonReq.grace_minutes});
                return {...CONSTANTS.TRUE_RESULT, ...drift};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Windows operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq &&
    ["set", "travel", "asof", "availability", "team_overlap", "dst", "drift"].includes(jsonReq.op) &&
    jsonReq.id && jsonReq.org;
