/**
 * The candidate portal API — K9. Public: no employee actor, no sign-in.
 * Every op is gated by a magic-link token instead — the same shape
 * `apis/training.js`'s own `op=="verify"` route already established for a
 * public, no-actor operation.
 *
 * Operations:
 *  op - status              - the curated status view: pipeline, next interview, terminal reason
 *  op - withdraw            - one-click withdrawal, no justification required
 *  op - update_availability - timezone and what the candidate said works for them
 *  op - reschedule          - self-service, twice per panel, before it needs a conversation
 *  op - set_consent         - "keep my details for future roles"
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const recruitment = require(`${TELEWORKR_CONSTANTS.LIBDIR}/recruitment.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        switch (jsonReq.op) {
            case "status": {
                const result = await recruitment.portalStatusAsync(jsonReq.token);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "withdraw": {
                const result = await recruitment.portalWithdrawAsync({token: jsonReq.token, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "update_availability": {
                const result = await recruitment.portalUpdateAvailabilityAsync({token: jsonReq.token,
                    timezone: jsonReq.timezone, availability_notes: jsonReq.availability_notes});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "reschedule": {
                const result = await recruitment.portalRescheduleAsync({token: jsonReq.token,
                    panel_assignment_id: jsonReq.panel_assignment_id,
                    scheduled_start: jsonReq.scheduled_start, scheduled_end: jsonReq.scheduled_end});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "set_consent": {
                const result = await recruitment.portalSetConsentAsync({token: jsonReq.token, consent_retain: jsonReq.consent_retain});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Portal operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const OPS = ["status", "withdraw", "update_availability", "reschedule", "set_consent"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.token;
