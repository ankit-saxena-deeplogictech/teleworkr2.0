/**
 * The identity admin API — L1. The actor is the token's id (their email).
 *
 * Operations:
 *  op - overview          - the one real provider's status, the attribute-impact map, the MFA policy
 *  op - flagged           - every person currently flagged with an incomplete assertion
 *  op - resolve_flagged    - an admin supplies what a flagged person's assertion didn't
 *  op - movement           - joiners, movers and leavers
 *  op - update_mfa_policy  - declare the MFA strength expected for a role tier
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const identity = require(`${TELEWORKR_CONSTANTS.LIBDIR}/identity.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "overview": {
                const [provider, mfa] = await Promise.all([
                    identity.providerStatusAsync(jsonReq.org),
                    identity.mfaPolicyAsync(jsonReq.org, actor.person_id)]);
                return {...CONSTANTS.TRUE_RESULT, provider, attribute_map: identity.attributeMap(), mfa_policy: mfa.policy};
            }
            case "flagged": {
                const result = await identity.flaggedPeopleAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "resolve_flagged": {
                const employment = await identity.resolveFlaggedPersonAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    person_id: jsonReq.person_id, employment_status: jsonReq.employment_status, jurisdiction: jsonReq.jurisdiction,
                    manager: jsonReq.manager, start_date: jsonReq.start_date, contract_type: jsonReq.contract_type});
                return {...CONSTANTS.TRUE_RESULT, employment};
            }
            case "movement": {
                const result = await identity.joinersMoversLeaversAsync(jsonReq.org, actor.person_id, {days: jsonReq.days});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "update_mfa_policy": {
                const result = await identity.updateMfaPolicyAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    role_tier: jsonReq.role_tier, strength: jsonReq.strength});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Identity operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["overview", "flagged", "resolve_flagged", "movement", "update_mfa_policy"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
