/**
 * The wiki API — N. The actor is the token's id (their email).
 *
 * Operations:
 *  op - create_space          - N1: create a space
 *  op - change_space_visibility - N3 item 6: lower/raise a space's ceiling, cascades demotions
 *  op - spaces                - N1: every space, plus the template list
 *  op - add_space_member      - space owner only
 *  op - remove_space_member   - space owner only
 *  op - create_page           - N1: a new draft page
 *  op - save_draft            - N2: a new, unpublished version
 *  op - request_review        - N2: assign a reviewer
 *  op - approve_review        - N2: the reviewer's decision
 *  op - publish_page          - N2: moves the published pointer
 *  op - page                  - N1/N5: read one page (live-rendered when sourced)
 *  op - search                - N4: title/section search
 *  op - mark_still_correct    - N4: resets the review clock, no new version
 *  op - deprecate_page        - N2/N4: status -> deprecated, names a successor
 *  op - archive_page          - N4: status -> archived, reason required
 *  op - acknowledge           - N4: records a must-read acknowledgement
 *  op - acknowledgement_status - N4: who has/hasn't acknowledged
 *  op - change_visibility     - N3: private/space/org — the reversible tier
 *  op - request_public_publish - N3: runs the scan, opens a request
 *  op - pending_public_requests - N3: the approver's queue
 *  op - decide_public_request - N3: approve (capability + named approver, both) or decline
 *  op - unpublish_public      - N3: retract, slug still resolves as "no longer published"
 *  op - create_share_link     - N3 item 2
 *  op - revoke_share_link     - N3 item 2
 *  op - share_links           - N3 item 2
 *  op - standing_review       - N3 item 5: org-wide exposure report
 *  op - link_task             - N5: page <-> task relation
 *  op - unlink_task           - N5
 *  op - pages_for_task        - N5
 *  op - tasks_for_page        - N5
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const wiki = require(`${TELEWORKR_CONSTANTS.LIBDIR}/wiki.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        switch (jsonReq.op) {
            case "create_space": {
                const result = await wiki.createSpaceAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    name: jsonReq.name, slug: jsonReq.slug, description: jsonReq.description, kind: jsonReq.kind,
                    default_visibility: jsonReq.default_visibility, public_approver_person_id: jsonReq.public_approver_person_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "change_space_visibility": {
                const result = await wiki.changeSpaceVisibilityAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    space_id: jsonReq.space_id, default_visibility: jsonReq.default_visibility});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "spaces": {
                const result = await wiki.spacesAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "add_space_member": {
                const result = await wiki.addSpaceMemberAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    space_id: jsonReq.space_id, person_id: jsonReq.person_id});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "remove_space_member": {
                const result = await wiki.removeSpaceMemberAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    space_id: jsonReq.space_id, person_id: jsonReq.person_id});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "create_page": {
                const result = await wiki.createPageDraftAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    space_id: jsonReq.space_id, parent_page_id: jsonReq.parent_page_id, title: jsonReq.title,
                    slug: jsonReq.slug, requires_acknowledgement: jsonReq.requires_acknowledgement});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "save_draft": {
                const result = await wiki.saveDraftVersionAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id, sections: jsonReq.sections, linked_page_ids: jsonReq.linked_page_ids,
                    embedded_file_refs: jsonReq.embedded_file_refs, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "request_review": {
                const result = await wiki.requestReviewAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id, wiki_page_version_id: jsonReq.wiki_page_version_id,
                    reviewer_person_id: jsonReq.reviewer_person_id});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "approve_review": {
                const result = await wiki.approveReviewAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    review_id: jsonReq.review_id});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "publish_page": {
                const result = await wiki.publishPageAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id, wiki_page_version_id: jsonReq.wiki_page_version_id,
                    review_cadence_months: jsonReq.review_cadence_months});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "page": {
                const result = await wiki.pageAsync(jsonReq.org, actor.person_id, jsonReq.page_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "search": {
                const result = await wiki.searchPagesAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    q: jsonReq.q, space_id: jsonReq.space_id, current_only: jsonReq.current_only});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "mark_still_correct": {
                const result = await wiki.markStillCorrectAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "deprecate_page": {
                const result = await wiki.deprecatePageAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id, successor_page_id: jsonReq.successor_page_id, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "archive_page": {
                const result = await wiki.archivePageAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id, reason: jsonReq.reason});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "acknowledge": {
                const result = await wiki.acknowledgeAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "acknowledgement_status": {
                const result = await wiki.acknowledgementStatusAsync(jsonReq.org, actor.person_id, jsonReq.page_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "change_visibility": {
                const result = await wiki.changeVisibilityAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id, visibility: jsonReq.visibility});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "request_public_publish": {
                const result = await wiki.requestPublicPublishAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id, reason: jsonReq.reason, slug: jsonReq.slug, allow_indexing: jsonReq.allow_indexing});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "pending_public_requests": {
                const result = await wiki.pendingPublicRequestsAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "decide_public_request": {
                const result = await wiki.decidePublicRequestAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    request_id: jsonReq.request_id, decision: jsonReq.decision, decision_reason: jsonReq.decision_reason,
                    step_up_verified: jsonReq.step_up_verified});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "unpublish_public": {
                const result = await wiki.unpublishPublicAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "create_share_link": {
                const result = await wiki.createShareLinkAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id, recipient_name: jsonReq.recipient_name, expires_in_days: jsonReq.expires_in_days});
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "revoke_share_link": {
                const result = await wiki.revokeShareLinkAsync(jsonReq.org, actor.person_id, jsonReq.share_link_id);
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "share_links": {
                const result = await wiki.shareLinksAsync(jsonReq.org, actor.person_id, jsonReq.page_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "standing_review": {
                const result = await wiki.standingReviewReportAsync(jsonReq.org, actor.person_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "link_task": {
                const result = await wiki.linkPageToTaskAsync({org_id: jsonReq.org, actor_person_id: actor.person_id,
                    page_id: jsonReq.page_id, task_ref: jsonReq.task_ref});
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "unlink_task": {
                const result = await wiki.unlinkPageFromTaskAsync(jsonReq.org, jsonReq.page_id, jsonReq.task_ref);
                return {...CONSTANTS.TRUE_RESULT, result};
            }
            case "pages_for_task": {
                const result = await wiki.pagesForTaskAsync(jsonReq.org, jsonReq.task_ref);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            case "tasks_for_page": {
                const result = await wiki.tasksForPageAsync(jsonReq.org, jsonReq.page_id);
                return {...CONSTANTS.TRUE_RESULT, ...result};
            }
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Wiki operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["create_space", "change_space_visibility", "spaces", "add_space_member", "remove_space_member",
    "create_page", "save_draft", "request_review", "approve_review", "publish_page", "page", "search",
    "mark_still_correct", "deprecate_page", "archive_page", "acknowledge", "acknowledgement_status",
    "change_visibility", "request_public_publish", "pending_public_requests", "decide_public_request", "unpublish_public",
    "create_share_link", "revoke_share_link", "share_links", "standing_review",
    "link_task", "unlink_task", "pages_for_task", "tasks_for_page"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
