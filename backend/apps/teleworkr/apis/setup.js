/**
 * The setup API — B5/B6. The actor is the token's id (their email); imports and
 * rollbacks are gated on the people.import capability in lib/setup.js.
 *
 * Operations:
 *  op - status          - The standing setup panel: steps, health, the time-to-first-clock-in metric
 *  op - mark            - Marks a step done, deferred or in progress
 *  op - import_people   - Previews (commit:false) or commits a people import
 *  op - import_balances - Previews or commits opening leave balances as ledger entries
 *  op - rollback        - Rolls a committed import back within its window
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const setup = require(`${TELEWORKR_CONSTANTS.LIBDIR}/setup.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "status": {
                const status = await setup.setupStatusAsync(jsonReq.org);
                return {...CONSTANTS.TRUE_RESULT, ...status};
            }
            case "mark": {
                const marked = await setup.markStepAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, step: jsonReq.step, status: jsonReq.status,
                    marked_default: jsonReq.marked_default});
                return {...CONSTANTS.TRUE_RESULT, ...marked};
            }
            case "import_people": {
                const result = await setup.importPeopleAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, rows: jsonReq.rows || [],
                    source: jsonReq.source, commit: jsonReq.commit === true});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "import_balances": {
                const result = await setup.importBalancesAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, rows: jsonReq.rows || [],
                    source: jsonReq.source, cutover_date: jsonReq.cutover_date,
                    commit: jsonReq.commit === true});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "rollback": {
                const result = await setup.rollbackImportAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, import_batch_id: jsonReq.import_batch_id});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Setup operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message,
            decision: err.decision?.outcome, rule: err.decision?.rule};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq &&
    ["status", "mark", "import_people", "import_balances", "rollback"].includes(jsonReq.op) &&
    jsonReq.id && jsonReq.org;
