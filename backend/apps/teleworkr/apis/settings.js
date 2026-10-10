/**
 * The settings API — I1. Thin on purpose: notification preferences already
 * have their own API (notifications.js, ops "settings"/"set_volume"), and
 * the one real Clock & timer preference already has its own
 * (clock.js, ops "preferences"/"set_preference"). The only thing genuinely
 * new here is the self-service profile edit.
 *
 * Operations:
 *  op - update_profile - Updates the caller's own display_name/home_timezone
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "update_profile": {
                const person = await spine.updateOwnProfileAsync(actor.person_id,
                    {display_name: jsonReq.display_name, home_timezone: jsonReq.home_timezone});
                return {...CONSTANTS.TRUE_RESULT, person};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Settings operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && jsonReq.op == "update_profile" && jsonReq.id && jsonReq.org;
