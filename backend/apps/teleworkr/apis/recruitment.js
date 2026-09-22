/**
 * The recruitment API — K, Phase 1. The actor is the token's id (their email).
 *
 * Operations:
 *  op - publish_workflow    - K1/K2: publish or supersede a workflow version
 *  op - workflows           - K2: the template library, current versions only
 *  op - raise_requisition   - K3: raise a requisition, pinning the workflow version
 *  op - approve_requisition - K3: the one approval step
 *  op - requisitions        - K3: every requisition, with applicant counts
 *  op - apply               - adds a candidate to a requisition's pipeline
 *  op - board               - K4: the pipeline board for one requisition
 *  op - candidate           - K5: one candidate's record
 *  op - legal_actions       - the engine's read side — what can happen next, and why not
 *  op - transition          - K1/K4/K7: advance, reject, hold, skip, reschedule, cancel
 *  op - scorecard           - K7: submit one interviewer's scorecard
 *  op - update_candidate    - K6: the candidate's timezone and stated availability
 *  op - schedule_panel      - K6: a panel for an open round, with fit warnings
 *  op - reschedule_panel    - K6: move a panel (also the engine's `rescheduled` transition)
 *  op - panel_outcome       - K6: completed (logs interviewer time) | cancelled | no_show
 *  op - interviewer_load    - K6: panels and hours per interviewer over a date range
 *  op - build_offer         - K8: the first version of an offer, route computed from its terms
 *  op - approve_offer       - K8: one approval; distinct-approver enforced by the schema
 *  op - send_offer          - K8: approved -> sent (no e-signature integration)
 *  op - offer_viewed        - K8: sent -> viewed
 *  op - negotiate_offer     - K8: supersedes the current version, re-routes if it crosses a tier
 *  op - offer_outcome       - K8: accepted | declined (taxonomy reason) | expired | withdrawn (reason)
 *  op - offers              - K8: an application's full offer version history
 *
 * Interviewer availability itself is read from the calendar API's `board` op —
 * the E3 board with leave wired in — rather than duplicated here.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const recruitment = require(`${TELEWORKR_CONSTANTS.LIBDIR}/recruitment.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "publish_workflow": {
                const result = await recruitment.publishWorkflowAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, workflow_code: jsonReq.workflow_code,
                    title: jsonReq.title, job_family: jsonReq.job_family, rounds: jsonReq.rounds});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "workflows": {
                const result = await recruitment.workflowsAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "raise_requisition": {
                const result = await recruitment.raiseRequisitionAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, title: jsonReq.title, team: jsonReq.team,
                    positions: jsonReq.positions, req_type: jsonReq.req_type, location: jsonReq.location,
                    employment_type: jsonReq.employment_type, band: jsonReq.band,
                    band_min: jsonReq.band_min, band_max: jsonReq.band_max,
                    target_start: jsonReq.target_start, workflow_code: jsonReq.workflow_code});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "approve_requisition": {
                const result = await recruitment.approveRequisitionAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, requisition_id: jsonReq.requisition_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "requisitions": {
                const result = await recruitment.requisitionsAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "apply": {
                const result = await recruitment.applyAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, requisition_id: jsonReq.requisition_id,
                    full_name: jsonReq.full_name, email: jsonReq.email, phone: jsonReq.phone,
                    source: jsonReq.source, referrer_person_id: jsonReq.referrer_person_id,
                    resume_ref: jsonReq.resume_ref, timezone: jsonReq.timezone,
                    availability_notes: jsonReq.availability_notes});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "board": {
                const result = await recruitment.pipelineBoardAsync(jsonReq.org, actor.person_id,
                    jsonReq.requisition_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "candidate": {
                const result = await recruitment.candidateRecordAsync(jsonReq.org, actor.person_id,
                    jsonReq.application_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "legal_actions": {
                const result = await recruitment.legalActionsAsync(jsonReq.org, actor.person_id,
                    jsonReq.application_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "transition": {
                const result = await recruitment.recordTransitionAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, application_id: jsonReq.application_id,
                    round_id: jsonReq.round_id, kind: jsonReq.kind, reason: jsonReq.reason,
                    review_date: jsonReq.review_date, client_event_id: jsonReq.client_event_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "scorecard": {
                const result = await recruitment.submitScorecardAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, application_id: jsonReq.application_id,
                    round_id: jsonReq.round_id, criteria_ratings: jsonReq.criteria_ratings,
                    evidence: jsonReq.evidence, recommendation: jsonReq.recommendation,
                    client_event_id: jsonReq.client_event_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "update_candidate": {
                const result = await recruitment.updateCandidateAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, candidate_id: jsonReq.candidate_id,
                    timezone: jsonReq.timezone, availability_notes: jsonReq.availability_notes});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "schedule_panel": {
                const result = await recruitment.schedulePanelAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, application_id: jsonReq.application_id,
                    round_id: jsonReq.round_id, interviewer_person_ids: jsonReq.interviewer_person_ids,
                    scheduled_start: jsonReq.scheduled_start, scheduled_end: jsonReq.scheduled_end,
                    timezone_base: jsonReq.timezone_base, client_event_id: jsonReq.client_event_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "reschedule_panel": {
                const result = await recruitment.reschedulePanelAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, panel_assignment_id: jsonReq.panel_assignment_id,
                    scheduled_start: jsonReq.scheduled_start, scheduled_end: jsonReq.scheduled_end,
                    reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "panel_outcome": {
                const result = await recruitment.recordPanelOutcomeAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, panel_assignment_id: jsonReq.panel_assignment_id,
                    outcome: jsonReq.outcome, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "interviewer_load": {
                const result = await recruitment.interviewerLoadAsync(jsonReq.org, actor.person_id,
                    jsonReq.from_date, jsonReq.to_date);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "build_offer": {
                const result = await recruitment.buildOfferAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, application_id: jsonReq.application_id,
                    fixed_amount: jsonReq.fixed_amount, variable_amount: jsonReq.variable_amount,
                    joining_bonus: jsonReq.joining_bonus, start_date: jsonReq.start_date,
                    expires_on: jsonReq.expires_on, rationale: jsonReq.rationale,
                    letter_note: jsonReq.letter_note, client_event_id: jsonReq.client_event_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "approve_offer": {
                const result = await recruitment.approveOfferAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, offer_version_id: jsonReq.offer_version_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "send_offer": {
                const result = await recruitment.sendOfferAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, offer_version_id: jsonReq.offer_version_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "offer_viewed": {
                const result = await recruitment.recordOfferViewedAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, offer_version_id: jsonReq.offer_version_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "negotiate_offer": {
                const result = await recruitment.negotiateOfferAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, offer_version_id: jsonReq.offer_version_id,
                    fixed_amount: jsonReq.fixed_amount, variable_amount: jsonReq.variable_amount,
                    joining_bonus: jsonReq.joining_bonus, start_date: jsonReq.start_date,
                    expires_on: jsonReq.expires_on, rationale: jsonReq.rationale,
                    letter_note: jsonReq.letter_note});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "offer_outcome": {
                const result = await recruitment.recordOfferOutcomeAsync({org_id: jsonReq.org,
                    actor_person_id: actor.person_id, offer_version_id: jsonReq.offer_version_id,
                    outcome: jsonReq.outcome, decline_reason: jsonReq.decline_reason,
                    decline_detail: jsonReq.decline_detail, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "offers": {
                const result = await recruitment.offersForApplicationAsync(jsonReq.org, actor.person_id,
                    jsonReq.application_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Recruitment operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["publish_workflow", "workflows", "raise_requisition", "approve_requisition", "requisitions",
    "apply", "board", "candidate", "legal_actions", "transition", "scorecard",
    "update_candidate", "schedule_panel", "reschedule_panel", "panel_outcome", "interviewer_load",
    "build_offer", "approve_offer", "send_offer", "offer_viewed", "negotiate_offer", "offer_outcome", "offers"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
