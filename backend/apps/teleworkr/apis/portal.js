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
 *  op - my_record           - K12: the candidate's own submitted fields
 *  op - update_record       - K12: corrects those same fields
 *  op - request_deletion    - K12: pauses the application pending an HR decision
 *  op - access_log          - K12: who's viewed this candidate record
 *  op - diversity           - K12 slice 3: the candidate's own self-reported diversity data
 *  op - set_diversity       - K12 slice 3: sets it — collected optionally, stored apart
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const recruitment = require(`${TELEWORKR_CONSTANTS.LIBDIR}/recruitment.js`);
const diversity = require(`${TELEWORKR_CONSTANTS.LIBDIR}/diversity.js`);

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
            case "my_record": {
                const result = await recruitment.portalMyRecordAsync(jsonReq.token);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "update_record": {
                const result = await recruitment.portalUpdateRecordAsync({token: jsonReq.token,
                    full_name: jsonReq.full_name, email: jsonReq.email, phone: jsonReq.phone,
                    resume_ref: jsonReq.resume_ref});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "request_deletion": {
                const result = await recruitment.portalRequestDeletionAsync({token: jsonReq.token, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "access_log": {
                const result = await recruitment.portalAccessLogAsync(jsonReq.token);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "diversity": {
                const result = await diversity.portalGetDiversityAsync(jsonReq.token);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "set_diversity": {
                const result = await diversity.portalSetDiversityAsync({token: jsonReq.token,
                    gender: jsonReq.gender, ethnicity: jsonReq.ethnicity, disability_status: jsonReq.disability_status});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Portal operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const OPS = ["status", "withdraw", "update_availability", "reschedule", "set_consent",
    "my_record", "update_record", "request_deletion", "access_log", "diversity", "set_diversity"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.token;
