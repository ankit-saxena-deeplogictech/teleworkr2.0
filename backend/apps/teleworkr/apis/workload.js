/**
 * The workload API — H1/H2. The actor is the token's id (their email).
 *
 * Operations:
 *  op - board    - H1: the caller's direct reports' capacity board
 *  op - reports  - H2: the caller's team aggregate reports
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const workload = require(`${TELEWORKR_CONSTANTS.LIBDIR}/workload.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "board": {
                const board = await workload.teamCapacityAsync(jsonReq.org, actor.person_id,
                    jsonReq.from_date, jsonReq.to_date);
                return {...CONSTANTS.TRUE_RESULT, ...board};
            }
            case "reports": {
                const reports = await workload.teamReportsAsync(jsonReq.org, actor.person_id,
                    jsonReq.from_date, jsonReq.to_date);
                return {...CONSTANTS.TRUE_RESULT, ...reports};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Workload operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && ["board", "reports"].includes(jsonReq.op) &&
    jsonReq.id && jsonReq.org && jsonReq.from_date && jsonReq.to_date;
