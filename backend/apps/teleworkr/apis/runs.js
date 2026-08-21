/**
 * The scheduled runs API — J7. The actor is the token's id (their email).
 *
 * Operations:
 *  op - preview - The run's facts, computed read-only
 *  op - execute - Runs it: batch-tagged ledger rows + run record + audit, one transaction
 *  op - reverse - Negates the run's batch; the run row keeps the history
 *  op - list    - The run history, newest first
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const runs = require(`${TELEWORKR_CONSTANTS.LIBDIR}/runs.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "preview": {
                const preview = await runs.previewRunAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, kind: jsonReq.kind,
                    period: jsonReq.period, to_date: jsonReq.to_date});
                return {...CONSTANTS.TRUE_RESULT, ...preview};
            }
            case "execute": {
                const executed = await runs.executeRunAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, kind: jsonReq.kind,
                    period: jsonReq.period, to_date: jsonReq.to_date, batch_id: jsonReq.batch_id});
                return {...CONSTANTS.TRUE_RESULT, ...executed};
            }
            case "reverse": {
                const reversed = await runs.reverseRunAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, run_id: jsonReq.run_id});
                return {...CONSTANTS.TRUE_RESULT, ...reversed};
            }
            case "list": {
                return {...CONSTANTS.TRUE_RESULT, runs: await runs.runsAsync(jsonReq.org)};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Runs operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message,
            decision: err.decision?.outcome};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq &&
    ["preview", "execute", "reverse", "list"].includes(jsonReq.op) && jsonReq.id && jsonReq.org;
