/**
 * The notifications API — A9 + B4. The actor is the token's id (their email).
 *
 * Operations:
 *  op - notify     - Raises a catalogue notification for a recipient
 *  op - brief      - The actor's clock-in brief (B4)
 *  op - set_volume - The actor's volume for one category
 *  op - settings   - The actor's whole volume map
 *  op - stats      - The org's send-and-mute picture (A9 #5)
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const notifications = require(`${TELEWORKR_CONSTANTS.LIBDIR}/notifications.js`);
const brief = require(`${TELEWORKR_CONSTANTS.LIBDIR}/brief.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "notify": {
                const raised = await notifications.notifyAsync({org_id: jsonReq.org,
                    category: jsonReq.category, recipient_person_id: jsonReq.recipient_person_id || actor.person_id,
                    actor_person_id: actor.person_id, payload: jsonReq.payload, object_ref: jsonReq.object_ref});
                return {...CONSTANTS.TRUE_RESULT, ...raised};
            }
            case "brief": {
                return {...CONSTANTS.TRUE_RESULT,
                    ...await brief.briefAsync({org_id: jsonReq.org, person_id: actor.person_id})};
            }
            case "set_volume": {
                const setting = await notifications.setVolumeAsync(jsonReq.org, actor.person_id,
                    jsonReq.category, jsonReq.level);
                return {...CONSTANTS.TRUE_RESULT, ...setting};
            }
            case "settings": {
                return {...CONSTANTS.TRUE_RESULT,
                    settings: await notifications.volumeMapAsync(jsonReq.org, actor.person_id)};
            }
            case "stats": {
                return {...CONSTANTS.TRUE_RESULT,
                    ...await notifications.volumeStatsAsync(jsonReq.org)};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Notifications operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq &&
    ["notify", "brief", "set_volume", "settings", "stats"].includes(jsonReq.op) &&
    jsonReq.id && jsonReq.org;
