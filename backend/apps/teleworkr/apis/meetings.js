/**
 * The meetings API — the minimal calendar-event entity E2/F1-F5 build on.
 * The actor is the token's id (their email). No capability gate: scheduling
 * a meeting is the caller's own data, same as officedays.js's set_status.
 *
 * Operations:
 *  op - create    - Creates a meeting owned by the actor
 *  op - cancel    - Cancels a meeting; refused unless the actor is the owner
 *  op - for_range - Scheduled meetings where the actor is owner or attendee, in a date range
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const meetings = require(`${TELEWORKR_CONSTANTS.LIBDIR}/meetings.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "create": {
                const meeting = await meetings.createAsync({org_id: jsonReq.org, owner_person_id: actor.person_id,
                    title: jsonReq.title, starts_at: jsonReq.starts_at, ends_at: jsonReq.ends_at,
                    attendee_person_ids: jsonReq.attendee_person_ids});
                return {...CONSTANTS.TRUE_RESULT, meeting};
            }
            case "cancel": {
                const result = await meetings.cancelAsync({org_id: jsonReq.org, meeting_id: jsonReq.meeting_id,
                    actor_person_id: actor.person_id});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "for_range": {
                const list = await meetings.forRangeAsync(jsonReq.org, actor.person_id,
                    jsonReq.from_date, jsonReq.to_date);
                return {...CONSTANTS.TRUE_RESULT, meetings: list};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Meetings operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && ["create", "cancel", "for_range"].includes(jsonReq.op) &&
    jsonReq.id && jsonReq.org;
