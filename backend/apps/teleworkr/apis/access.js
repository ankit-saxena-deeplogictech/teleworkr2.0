/**
 * The permissions API — L2. The actor is the token's id (their email).
 *
 * Operations:
 *  op - catalogue        - the static capability catalogue, ceiling, scopes, built-in roles, SOD rules
 *  op - roles             - every role for the org, built-in and custom, with holder counts
 *  op - create_role        - compose a custom role from capabilities
 *  op - assign_role        - assign a role to a person
 *  op - grant_elevation    - a time-boxed, reasoned direct grant
 *  op - revoke_grant       - close a grant
 *  op - access_review      - every non-role-derived grant, with the propose-removal flag
 *  op - who_can            - the reverse lookup: who holds a capability, and through what
 *  op - person_grants      - one person's full effective grant list
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const access = require(`${TELEWORKR_CONSTANTS.LIBDIR}/access.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "catalogue": {
                const result = await access.catalogueAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "roles": {
                const result = await access.rolesAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "create_role": {
                const result = await access.createRoleAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    name: jsonReq.name, description: jsonReq.description, capabilities: jsonReq.capabilities});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "assign_role": {
                const result = await access.assignRoleAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    person_id: jsonReq.person_id, role_name: jsonReq.role_name, valid_from: jsonReq.valid_from,
                    valid_to: jsonReq.valid_to});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "grant_elevation": {
                const result = await access.grantElevationAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    person_id: jsonReq.person_id, capability: jsonReq.capability, scope_type: jsonReq.scope_type,
                    scope_ref: jsonReq.scope_ref, valid_from: jsonReq.valid_from, valid_to: jsonReq.valid_to,
                    reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "revoke_grant": {
                const result = await access.revokeGrantAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    grant_id: jsonReq.grant_id});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "access_review": {
                const result = await access.accessReviewAsync(jsonReq.org, actor.person_id, {unused_days: jsonReq.unused_days});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "who_can": {
                const result = await access.whoCanAsync(jsonReq.org, actor.person_id, jsonReq.capability, jsonReq.subject_person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "person_grants": {
                const result = await access.personGrantsAsync(jsonReq.org, actor.person_id, jsonReq.subject_person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Permissions operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["catalogue", "roles", "create_role", "assign_role", "grant_elevation", "revoke_grant",
    "access_review", "who_can", "person_grants"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
