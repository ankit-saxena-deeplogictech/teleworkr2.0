/**
 * The leave API — J1/J3. The actor is the token's id (their email). Publishing
 * is gated on the leave_policy.publish capability in lib/leave.js; requesting
 * and balancing are the caller's own data.
 *
 * Operations:
 *  op - publish  - Publishes a policy version (HR; validated, step-up, audited)
 *  op - evaluate - The engine's working for a prospective request
 *  op - request  - Creates a request, pinning its evaluation
 *  op - balance  - The projected balance for a leave type
 *  op - requests - The caller's requests
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "publish": {
                const published = await leave.publishPolicyAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, step_up_verified: jsonReq.step_up_verified === true,
                    scope: jsonReq.scope, effective_from: jsonReq.effective_from,
                    policy: jsonReq.policy, dry_run: jsonReq.dry_run});
                return {...CONSTANTS.TRUE_RESULT, version: published.version,
                    superseded: published.superseded};
            }
            case "evaluate": {
                const evaluation = await leave.evaluateAsync({org_id: jsonReq.org,
                    person_id: actor.person_id, leave_type: jsonReq.leave_type,
                    from_date: jsonReq.from_date, to_date: jsonReq.to_date,
                    notice_days: jsonReq.notice_days});
                return {...CONSTANTS.TRUE_RESULT, ...evaluation};
            }
            case "request": {
                const result = await leave.requestLeaveAsync({org_id: jsonReq.org,
                    person_id: actor.person_id, leave_type: jsonReq.leave_type,
                    from_date: jsonReq.from_date, to_date: jsonReq.to_date,
                    notice_days: jsonReq.notice_days, reason: jsonReq.reason, fields: jsonReq.fields});
                return {...CONSTANTS.TRUE_RESULT, request: result.request, evaluation: result.evaluation};
            }
            case "balance": {
                const balance = await leave.balanceAsync({org_id: jsonReq.org,
                    person_id: actor.person_id, leave_type: jsonReq.leave_type, asOf: jsonReq.as_of});
                return {...CONSTANTS.TRUE_RESULT, ...balance};
            }
            case "requests": {
                const requests = await leave.requestsForPersonAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, requests};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Leave operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message,
            decision: err.decision?.outcome, rule_fired: err.evaluation?.rule_fired};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const validateRequest = jsonReq => jsonReq && ["publish", "evaluate", "request", "balance", "requests"]
    .includes(jsonReq.op) && jsonReq.id && jsonReq.org;
