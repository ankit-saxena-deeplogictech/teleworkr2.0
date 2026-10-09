/**
 * The office-days API — E5. The actor is the token's id (their email); no
 * capability is needed, same as E4 — declaring your own day is the
 * caller's own data, and seeing a cohort's presence needs no special gate
 * either (E3's board already shows it with none).
 *
 * Operations:
 *  op - week_status - the caller's own week, plus their cohort's (Mon-Fri), and any co-location
 *  op - set_status   - sets the caller's own status for one day
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const officedays = require(`${TELEWORKR_CONSTANTS.LIBDIR}/officedays.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "week_status": {
                const result = await officedays.weekStatusAsync(jsonReq.org, actor.person_id, jsonReq.week_start);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "set_status": {
                const result = await officedays.setStatusAsync({org_id: jsonReq.org, person_id: actor.person_id,
                    status_date: jsonReq.status_date, status: jsonReq.status, location: jsonReq.location});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Office days operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && ["week_status", "set_status"].includes(jsonReq.op) &&
    jsonReq.id && jsonReq.org;
