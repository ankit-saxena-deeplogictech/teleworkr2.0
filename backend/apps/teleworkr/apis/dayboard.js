/**
 * The Day board API — C1. One call, the whole screen: the clock, what it is
 * bound to, what is due today, who needs you, presence, and the week so far.
 *
 * Operations:
 *  op - board - The caller's Day board for a date, defaulting to today
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dayboard = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dayboard.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "board": {
                const board = await dayboard.boardAsync(
                    {org_id: jsonReq.org, person_id: actor.person_id, date: jsonReq.date});
                return {...CONSTANTS.TRUE_RESULT, ...board};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Day board operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && jsonReq.op == "board" && jsonReq.id && jsonReq.org;
