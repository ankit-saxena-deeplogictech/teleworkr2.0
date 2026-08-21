/**
 * The disclosure API — H5. Every operation is about the caller's own record:
 * the access log, the mirror of what a chosen viewer sees, the retention table,
 * and the self-service export. Asking about someone else's record through this
 * API is refused — that is not this surface.
 *
 * Operations:
 *  op - access_log - Who accessed the caller's record in the window, grouped
 *  op - mirror     - What the viewer (defaults to the caller) sees about the caller
 *  op - retention  - The retention table in concrete numbers
 *  op - export     - The caller's full record as a JSON bundle
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const disclosure = require(`${TELEWORKR_CONSTANTS.LIBDIR}/disclosure.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "access_log": {
                const log = await disclosure.accessLogAsync(
                    {org_id: jsonReq.org, person_id: actor.person_id, days: jsonReq.days});
                return {...CONSTANTS.TRUE_RESULT, ...log};
            }
            case "mirror": {
                const viewer = jsonReq.viewer_person_id || actor.person_id;
                const mirror = await disclosure.mirrorAsync(
                    {org_id: jsonReq.org, person_id: actor.person_id, viewer_person_id: viewer});
                return {...CONSTANTS.TRUE_RESULT, ...mirror};
            }
            case "retention": {
                return {...CONSTANTS.TRUE_RESULT, entities: await disclosure.retentionAsync()};
            }
            case "export": {
                const bundle = await disclosure.exportMyDataAsync(
                    {org_id: jsonReq.org, person_id: actor.person_id});
                return {...CONSTANTS.TRUE_RESULT, ...bundle};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Disclosure operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && ["access_log", "mirror", "retention", "export"].includes(jsonReq.op) &&
    jsonReq.id && jsonReq.org;
