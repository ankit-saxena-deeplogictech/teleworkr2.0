/**
 * The apps API — G1. The actor is the token's id (their email); every
 * permission the wireframes care about is enforced in lib/apps.js.
 *
 * Operations:
 *  op - catalogue        - The catalogue, annotated for the caller
 *  op - launch           - Records that the caller opened an app
 *  op - request_access   - Requests access to an app that needs it
 *  op - pending_requests - Requests named to the caller as approver
 *  op - decide_request   - Approves or denies a named request
 *  op - link_task        - Attaches the caller's own deep link to a task
 *  op - my_links         - The caller's own attached links
 *  op - remove_link      - Removes one of the caller's own links
 *  op - save_app         - Admin: creates, edits or deprecates a catalogue entry
 *  op - usage_report     - Admin: seats and 60-day usage per app
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const apps = require(`${TELEWORKR_CONSTANTS.LIBDIR}/apps.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        const org_id = jsonReq.org;
        switch (jsonReq.op) {
            case "catalogue": {
                const result = await apps.catalogueAsync(org_id, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "launch": {
                const event = await apps.recordLaunchAsync(org_id, actor.person_id, jsonReq.app_id);
                return {...CONSTANTS.TRUE_RESULT, event};
            }
            case "request_access": {
                const request = await apps.requestAccessAsync({org_id, actor_person_id: actor.person_id,
                    app_id: jsonReq.app_id, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, request};
            }
            case "pending_requests": {
                const result = await apps.pendingRequestsForApproverAsync(org_id, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "decide_request": {
                const result = await apps.decideRequestAsync({org_id, actor_person_id: actor.person_id,
                    request_id: jsonReq.request_id, decision: jsonReq.decision,
                    decision_reason: jsonReq.decision_reason});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "link_task": {
                const link = await apps.linkTaskAsync({org_id, actor_person_id: actor.person_id,
                    app_id: jsonReq.app_id, task_ref: jsonReq.task_ref, label: jsonReq.label, url: jsonReq.url});
                return {...CONSTANTS.TRUE_RESULT, link};
            }
            case "my_links": {
                const result = await apps.myLinksAsync(org_id, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "remove_link": {
                await apps.removeLinkAsync(org_id, actor.person_id, jsonReq.link_id);
                return CONSTANTS.TRUE_RESULT;
            }
            case "save_app": {
                const result = await apps.saveAppAsync({org_id, actor_person_id: actor.person_id,
                    app_id: jsonReq.app_id, name: jsonReq.name, category: jsonReq.category,
                    launch_url: jsonReq.launch_url, launch_label: jsonReq.launch_label,
                    requires_request: jsonReq.requires_request, cost_per_seat_minor: jsonReq.cost_per_seat_minor,
                    cost_currency: jsonReq.cost_currency, approver_person_id: jsonReq.approver_person_id,
                    deprecated: jsonReq.deprecated});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "usage_report": {
                const result = await apps.usageReportAsync(org_id, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Apps operation ${jsonReq.op} failed: ${err}`);
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
    ["catalogue", "launch", "request_access", "pending_requests", "decide_request", "link_task",
        "my_links", "remove_link", "save_app", "usage_report"].includes(jsonReq.op) &&
    jsonReq.id && jsonReq.org;
