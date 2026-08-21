/**
 * The calendar API — J6. The actor is the token's id (their email).
 *
 * Operations:
 *  op - board       - The E3 team board for a set of people on a date, leave wired in
 *  op - day_facts   - One person's labelled day (leave / holiday)
 *  op - week_target - The C5 weekly target with approved leave excluded and labelled
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const calendar = require(`${TELEWORKR_CONSTANTS.LIBDIR}/calendar.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "board": {
                if (!Array.isArray(jsonReq.person_ids)) return CONSTANTS.FALSE_RESULT;
                const board = await calendar.teamBoardAsync(jsonReq.org, jsonReq.person_ids, jsonReq.date);
                return {...CONSTANTS.TRUE_RESULT, ...board};
            }
            case "day_facts": {
                const facts = await calendar.dayFactsAsync(jsonReq.org,
                    jsonReq.person_id || actor.person_id, jsonReq.date);
                return {...CONSTANTS.TRUE_RESULT, ...facts};
            }
            case "week_target": {
                const target = await calendar.weekTargetAsync(jsonReq.org,
                    jsonReq.person_id || actor.person_id, jsonReq.week_start);
                return {...CONSTANTS.TRUE_RESULT, ...target};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Calendar operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq &&
    ["board", "day_facts", "week_target"].includes(jsonReq.op) && jsonReq.id && jsonReq.org;
