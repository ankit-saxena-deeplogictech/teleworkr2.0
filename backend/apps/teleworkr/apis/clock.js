/**
 * The clock API — A11. The actor is the token's id (their email).
 *
 * Operations:
 *  op - status - Today's clock: total, the running entry, the window's local end
 *  op - sync   - Replays events buffered offline, idempotently by client_event_id
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const calendar = require(`${TELEWORKR_CONSTANTS.LIBDIR}/calendar.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);

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

const validateRequest = jsonReq => jsonReq &&
    ["status", "sync"].includes(jsonReq.op) && jsonReq.id && jsonReq.org;
