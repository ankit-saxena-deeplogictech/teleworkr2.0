/**
 * The activity & logs API — the admin day-level viewer. The actor is the token's id (their email).
 *
 * Operations:
 *  op - login_log    - the org-wide sign-in log (from, to, person_id, flagged_only)
 *  op - person_days  - one person's day-level activity (person_id, from, to)
 *  op - app_log      - per-app launches and distinct users per day (from, to, app_id)
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const activity = require(`${TELEWORKR_CONSTANTS.LIBDIR}/activity.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "login_log": {
                const result = await activity.loginLogAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    from: jsonReq.from, to: jsonReq.to, person_id: jsonReq.person_id, flagged_only: jsonReq.flagged_only});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "person_days": {
                const result = await activity.personDaysAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    person_id: jsonReq.person_id, from: jsonReq.from, to: jsonReq.to});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "app_log": {
                const result = await activity.appLogAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    from: jsonReq.from, to: jsonReq.to, app_id: jsonReq.app_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Activity operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["login_log", "person_days", "app_log"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
