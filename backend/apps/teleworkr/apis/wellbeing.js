/**
 * The wellbeing API — M. The actor is the token's id (their email).
 *
 * Operations:
 *  op - publish_signal      - M1: publish or supersede a signal definition
 *  op - signal_definitions  - M1: the catalogue, current versions, plus the never-measured list
 *  op - preview_evaluation  - M1: compute a night's run without writing it
 *  op - evaluate            - M1: run and write the night's evaluation
 *  op - my_load             - M2: the caller's own last 4 weeks, lit signals and shares received
 *  op - set_threshold       - M1/M2: a personal override — tighten only, never loosen
 *  op - clear_threshold     - M2: drop a personal override, back to the published default
 *  op - mute                - M2: mute one signal, or every signal, until a date
 *  op - unmute              - M2: undo a mute
 *  op - share_summary       - M2/M4: share a composition snapshot with one named recipient
 *  op - revoke_share        - M2: revoke a share you made
 *  op - team_load           - M3: the caller's own cohort as a distribution, cohort-floor enforced
 *  op - hr_contacts         - M4: who to route "talk to HR" to
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const wellbeing = require(`${TELEWORKR_CONSTANTS.LIBDIR}/wellbeing.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "publish_signal": {
                const result = await wellbeing.publishSignalDefinitionAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, signal_code: jsonReq.signal_code,
                    threshold: jsonReq.threshold, ladder: jsonReq.ladder});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "signal_definitions": {
                const result = await wellbeing.signalDefinitionsAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "preview_evaluation": {
                const result = await wellbeing.previewSignalEvaluationAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, evaluated_for: jsonReq.evaluated_for});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "evaluate": {
                const result = await wellbeing.evaluateSignalsAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, evaluated_for: jsonReq.evaluated_for});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "my_load": {
                const result = await wellbeing.myLoadAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "set_threshold": {
                const result = await wellbeing.setThresholdOverrideAsync({org_id: jsonReq.org,
                    person_id: actor.person_id, signal_code: jsonReq.signal_code, value: jsonReq.value});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "clear_threshold": {
                const result = await wellbeing.clearThresholdOverrideAsync(jsonReq.org, actor.person_id, jsonReq.signal_code);
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "mute": {
                const result = await wellbeing.muteAsync({org_id: jsonReq.org, person_id: actor.person_id,
                    signal_code: jsonReq.signal_code, muted_until: jsonReq.muted_until, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "unmute": {
                const result = await wellbeing.unmuteAsync(jsonReq.org, actor.person_id, jsonReq.signal_code);
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "share_summary": {
                const result = await wellbeing.shareSummaryAsync({org_id: jsonReq.org,
                    sharer_person_id: actor.person_id, recipient_person_id: jsonReq.recipient_person_id,
                    period_from: jsonReq.period_from, period_to: jsonReq.period_to,
                    expires_in_days: jsonReq.expires_in_days});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "revoke_share": {
                const result = await wellbeing.revokeShareAsync(jsonReq.org, actor.person_id, jsonReq.share_id);
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "team_load": {
                const result = await wellbeing.teamLoadAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "hr_contacts": {
                const result = await wellbeing.hrContactsAsync(jsonReq.org);
                return {...CONSTANTS.TRUE_RESULT, contacts: result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Wellbeing operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["publish_signal", "signal_definitions", "preview_evaluation", "evaluate", "my_load",
    "set_threshold", "clear_threshold", "mute", "unmute", "share_summary", "revoke_share",
    "team_load", "hr_contacts"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
