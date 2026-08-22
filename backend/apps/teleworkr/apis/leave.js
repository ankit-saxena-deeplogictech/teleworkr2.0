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
                    policy: jsonReq.policy, resolutions: jsonReq.resolutions, dry_run: jsonReq.dry_run});
                return {...CONSTANTS.TRUE_RESULT, version: published.version,
                    superseded: published.superseded, conflicts: published.conflicts,
                    resolutions: published.resolutions};
            }
            case "conflicts": {
                const conflicts = await leave.policyConflictsAsync(jsonReq.org, jsonReq.policy_version_id);
                return {...CONSTANTS.TRUE_RESULT, conflicts};
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
            case "approve": {
                const approved = await leave.approveLeaveRequestAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, leave_request_id: jsonReq.leave_request_id,
                    approve_as_exception: jsonReq.approve_as_exception === true});
                return {...CONSTANTS.TRUE_RESULT, result: approved.result, step: approved.step,
                    final: approved.final, balance_after: approved.balance_after};
            }
            case "decline": {
                const declined = await leave.declineLeaveRequestAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, leave_request_id: jsonReq.leave_request_id,
                    reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, result: declined};
            }
            case "cancel": {
                const cancelled = await leave.cancelLeaveRequestAsync({org_id: jsonReq.org,
                    person_id: actor.person_id, leave_request_id: jsonReq.leave_request_id});
                return {...CONSTANTS.TRUE_RESULT, ...cancelled};
            }
            case "pending": {
                const queue = await leave.pendingApprovalsForAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id});
                return {...CONSTANTS.TRUE_RESULT, queue};
            }
            case "escalations": {
                const due = await leave.escalationsDueAsync(jsonReq.org);
                return {...CONSTANTS.TRUE_RESULT, escalations: due};
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

const validateRequest = jsonReq => jsonReq &&
    ["publish", "conflicts", "evaluate", "request", "balance", "policy", "requests", "approve", "decline", "cancel", "pending", "escalations"]
        .includes(jsonReq.op) && jsonReq.id && jsonReq.org;
