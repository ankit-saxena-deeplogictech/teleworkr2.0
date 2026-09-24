/**
 * The data governance API — L3. The actor is the token's id (their email).
 *
 * Operations:
 *  op - place_hold        - place a legal hold on a person, optionally scoped to one entity
 *  op - release_hold       - release a legal hold
 *  op - legal_holds        - active holds for a person, or every hold for the org
 *  op - create_request     - open a DSAR (access/erasure/rectification) on the DPO queue
 *  op - complete_request    - close a DSAR as completed or blocked
 *  op - requests           - the DPO queue, sorted by due date
 *  op - preview_erasure     - the three-way split: erased / pseudonymised / blocked
 *  op - execute_erasure     - execute the erasure — irreversible, step-up gated
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const erasure = require(`${TELEWORKR_CONSTANTS.LIBDIR}/erasure.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "place_hold": {
                const result = await erasure.placeLegalHoldAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    person_id: jsonReq.person_id, entity: jsonReq.entity, reason: jsonReq.reason,
                    owner_person_id: jsonReq.owner_person_id});
                return {...CONSTANTS.TRUE_RESULT, hold: result};
            }
            case "release_hold": {
                const result = await erasure.releaseLegalHoldAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    hold_id: jsonReq.hold_id});
                return {...CONSTANTS.TRUE_RESULT, hold: result};
            }
            case "legal_holds": {
                const result = await erasure.legalHoldsAsync(jsonReq.org, actor.person_id, jsonReq.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "create_request": {
                const result = await erasure.createDataRequestAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    request_type: jsonReq.request_type, subject_person_id: jsonReq.subject_person_id,
                    requested_by: jsonReq.requested_by, due_date: jsonReq.due_date, notes: jsonReq.notes});
                return {...CONSTANTS.TRUE_RESULT, request: result};
            }
            case "complete_request": {
                const result = await erasure.completeDataRequestAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    request_id: jsonReq.request_id, status: jsonReq.status, notes: jsonReq.notes});
                return {...CONSTANTS.TRUE_RESULT, request: result};
            }
            case "requests": {
                const result = await erasure.dataRequestsAsync(jsonReq.org, actor.person_id, {status: jsonReq.status});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "preview_erasure": {
                const result = await erasure.previewErasureAsync(jsonReq.org, actor.person_id, jsonReq.person_id);
                return {...CONSTANTS.TRUE_RESULT, preview: result};
            }
            case "execute_erasure": {
                const result = await erasure.executeErasureAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    person_id: jsonReq.person_id, reason: jsonReq.reason, step_up_verified: jsonReq.step_up_verified});
                return {...CONSTANTS.TRUE_RESULT, run: result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Data governance operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["place_hold", "release_hold", "legal_holds", "create_request", "complete_request", "requests",
    "preview_erasure", "execute_erasure"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
