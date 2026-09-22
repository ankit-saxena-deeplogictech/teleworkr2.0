/**
 * K — the recruitment domain, Phase 1: the pipeline core.
 *
 * Same architecture as leave, deliberately (K1): a versioned workflow
 * definition with a published pointer, one engine that decides legal
 * transitions, and an append-only candidate event log — status is
 * PROJECTED over that log on every read, never stored as a column. That is
 * a materially bigger claim than leave makes (leave_request.status is a
 * plain mutable column; only its balance is event-sourced) — this module's
 * projector is closer in shape to training's course-progress projector or
 * survey's response distributions, except it walks a graph with parallel
 * rounds and score-conditioned rounds, not a line.
 *
 * A candidate is pinned to the workflow version they applied under (K1
 * item 4). The pin lives on `application`, not `requisition` — a
 * requisition can outlive several workflow republishes; a candidate never
 * silently moves from four rounds to seven mid-pipeline.
 *
 * Phase 1, deliberately (see the wireframe's K1–K12 for the fuller
 * ambition; each of these is a real simplification, not an oversight):
 *   - One approval step for a requisition, not a band/headcount/cost matrix.
 *   - No job-description drafting or posting-channel tracking (K3 items 5-6).
 *   - Round type is a plain string tag, not its own versioned shared library
 *     (K2 item 4).
 *   - No drag-to-reorder; a round's position is an explicit sequence number.
 *   - No resume/document storage — a plain text/URL reference.
 *   - Scorecards submit directly; no draft/autosave state (K7's "draft"
 *     state is deferred).
 *   - No re-entry / reuse-results-for-reapplication (K1's `reuse_results_for`).
 *   - Deferred entirely to later phases: offers (K8), the candidate portal
 *     (K9 — needs a magic-link/no-login surface nothing else in this app
 *     uses), hire→onboarding handoff (K10 — depends on D5/B3/G1, none of
 *     which exist yet), analytics (K11), retention & fairness runs (K12).
 *
 * K6 (panel scheduling) adds no availability model of its own — the panel
 * is checked against the E3 board with J6 leave already wired in
 * (`calendar.teamBoardAsync`), and a completed panel's hours land in the
 * time ledger exactly the way a completed training module's do. Narrowed,
 * deliberately: no candidate self-scheduling from offered slots (waits for
 * K9's portal), no calendar invites or room links (no calendar system
 * exists), interviewers chosen per panel rather than derived from the
 * round's `owner_role` tag, and interviewer load reported as counts and
 * hours with no "overloaded" threshold — the wireframe illustrates one but
 * never states a rule, so none is invented here.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const calendar = require(`${TELEWORKR_CONSTANTS.LIBDIR}/calendar.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);

const TRANSITION_KINDS = Object.freeze(["advanced", "rejected", "held", "skipped", "rescheduled", "cancelled"]);
const RECOMMENDATIONS = Object.freeze(["strong_no", "no", "lean_yes", "yes", "strong_yes"]);
const REQ_TYPES = Object.freeze(["new", "backfill"]);
const CANDIDATE_SOURCES = Object.freeze(["referral", "job_board", "careers_page", "internal", "other"]);
const CONDITION_OPERATORS = Object.freeze(["<", "<=", ">", ">=", "=="]);
const PANEL_OUTCOMES = Object.freeze(["completed", "cancelled", "no_show"]);
const INTERVIEW_CATEGORY = "interview_panel";   // the time ledger's category, as training's is "training"
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);
const _uuid = _ => serverutils.generateUUID(false);

// ---------------------------------------------------------------------------
// K1/K2 — the workflow: versioned definition, validated publish
// ---------------------------------------------------------------------------

/**
 * Publishes a workflow version and moves the pointer. Versions are
 * immutable; supersession moves the pointer and never edits a published
 * version — identical discipline to `publishCourseAsync`/`publishSurveyAsync`.
 *
 * @param {object} request {org_id, actor_person_id, workflow_code, title,
 *      job_family, rounds}
 * @returns {object} {workflow_version_id, version}
 */
exports.publishWorkflowAsync = async function(request) {
    const workflow = _validateWorkflow(request);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "workflow.publish",
        audit: {action: "recruitment.workflow_published", object_type: "workflow",
            object_ref: request.workflow_code,
            detail: {title: workflow.title, rounds: workflow.rounds.length}},

        action: async exec => {
            const current = await exec.getQuery(
                "SELECT * FROM workflow_pointer WHERE org_id=? AND workflow_code=?",
                [request.org_id, request.workflow_code]);
            const versions = await exec.getQuery(
                "SELECT MAX(version) AS max FROM workflow_version WHERE org_id=? AND workflow_code=?",
                [request.org_id, request.workflow_code]);
            const versionNumber = (versions[0].max || 0) + 1;

            const version = {workflow_version_id: _uuid(), org_id: request.org_id,
                workflow_code: request.workflow_code, version: versionNumber, status: "published",
                title: workflow.title, job_family: workflow.job_family || null,
                rounds: JSON.stringify(workflow.rounds), published_at: _now(),
                published_by: request.actor_person_id, created_at: _now(), created_by: request.actor_person_id};
            await exec.runCmd(`INSERT INTO workflow_version (workflow_version_id, org_id, workflow_code, version,
                    status, title, job_family, rounds, published_at, published_by, created_at, created_by)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                [version.workflow_version_id, version.org_id, version.workflow_code, version.version,
                    version.status, version.title, version.job_family, version.rounds, version.published_at,
                    version.published_by, version.created_at, version.created_by]);
            if (current.length) await exec.runCmd(
                "UPDATE workflow_version SET status='superseded' WHERE workflow_version_id=?",
                [current[0].workflow_version_id]);
            await exec.runCmd(
                `INSERT INTO workflow_pointer (org_id, workflow_code, workflow_version_id, updated_at)
                    VALUES (?,?,?,?)
                    ON CONFLICT (org_id, workflow_code) DO UPDATE SET workflow_version_id=excluded.workflow_version_id,
                        updated_at=excluded.updated_at`,
                [request.org_id, request.workflow_code, version.workflow_version_id, _now()]);

            return {workflow_version_id: version.workflow_version_id, version: versionNumber};
        }});
}

/**
 * Every published workflow, current version only (K2's template library).
 * @param {string} org_id The org
 * @param {string} actor_person_id The caller
 * @returns {object} {workflows: [...]}
 */
exports.workflowsAsync = async function(org_id, actor_person_id) {
    await _requireReadAsync(org_id, actor_person_id, "read workflows");
    const versions = await dblayer.getQueryOrThrow(
        `SELECT v.* FROM workflow_pointer p JOIN workflow_version v ON v.workflow_version_id = p.workflow_version_id
            WHERE p.org_id=? ORDER BY v.published_at DESC`, [org_id]);
    return {workflows: versions.map(v => ({workflow_code: v.workflow_code, version: v.version, title: v.title,
        job_family: v.job_family, rounds: JSON.parse(v.rounds), published_at: v.published_at}))};
}

// ---------------------------------------------------------------------------
// K3 — requisition & approval (simplified: one approval step)
// ---------------------------------------------------------------------------

/**
 * Raises a requisition, pinning the workflow's current published version —
 * a later republish of the workflow does not change what this requisition
 * hands new applicants (K1 item 4's pin lives on `application`, but the
 * requisition's own pin is what makes that possible: it's the version every
 * applicant to THIS requisition will inherit).
 *
 * @param {object} request {org_id, actor_person_id, title, team, positions,
 *      req_type, location, employment_type, band, band_min, band_max,
 *      target_start, workflow_code} — band_min/band_max are optional, but an
 *      offer built against this requisition can only compute a percentile
 *      when they're set (K8)
 * @returns The requisition row
 */
exports.raiseRequisitionAsync = async function(request) {
    if (!request?.title) throw new Error("A requisition needs a title.");
    if (!request.workflow_code) throw new Error("A requisition needs a workflow.");
    if (!request.target_start) throw new Error("A requisition needs a target start date.");
    _assertISODate(request.target_start, "target_start");
    if (request.req_type && !REQ_TYPES.includes(request.req_type)) throw new Error(
        `req_type must be one of ${REQ_TYPES.join(", ")}.`);
    if ((request.band_min != null || request.band_max != null) &&
        !(Number.isInteger(request.band_min) && Number.isInteger(request.band_max) && request.band_max > request.band_min))
        throw new Error("band_min and band_max, when either is set, must both be integers with band_max greater than band_min.");
    const pointer = await dblayer.getQueryOrThrow(
        "SELECT workflow_version_id FROM workflow_pointer WHERE org_id=? AND workflow_code=?",
        [request.org_id, request.workflow_code]);
    if (!pointer.length) throw new Error(`No published workflow ${request.workflow_code}. Publish it first.`);

    const requisitionId = _uuid();
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "requisition.create",
        audit: {action: "recruitment.requisition_raised", object_type: "requisition", object_ref: requisitionId,
            detail: {title: request.title, positions: request.positions || 1}},

        action: async exec => {
            const row = {requisition_id: requisitionId, org_id: request.org_id, title: request.title,
                team: request.team || null, positions: Number.isInteger(request.positions) ? request.positions : 1,
                req_type: request.req_type || "new", location: request.location || null,
                employment_type: request.employment_type || null, band: request.band || null,
                band_min: request.band_min ?? null, band_max: request.band_max ?? null,
                target_start: request.target_start, workflow_code: request.workflow_code,
                workflow_version_id: pointer[0].workflow_version_id, status: "pending_approval",
                raised_by: request.actor_person_id, created_at: _now(), created_by: request.actor_person_id};
            await exec.runCmd(`INSERT INTO requisition (requisition_id, org_id, title, team, positions, req_type,
                    location, employment_type, band, band_min, band_max, target_start, workflow_code,
                    workflow_version_id, status, raised_by, created_at, created_by)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [row.requisition_id, row.org_id, row.title, row.team, row.positions, row.req_type, row.location,
                    row.employment_type, row.band, row.band_min, row.band_max, row.target_start, row.workflow_code,
                    row.workflow_version_id, row.status, row.raised_by, row.created_at, row.created_by]);
            return row;
        }});
}

/**
 * Approves a requisition — the one approval step Phase 1 has. Self-approval
 * is already blocked by `sod.self_approval`, which already lists
 * `requisition.approve` (found already wired, unused, before this module
 * existed).
 * @param {object} request {org_id, actor_person_id, requisition_id}
 */
exports.approveRequisitionAsync = async function(request) {
    const requisition = await _requisitionAsync(request.org_id, request.requisition_id);
    if (!requisition) throw new Error(`No requisition ${request.requisition_id}.`);
    if (requisition.status != "pending_approval") throw new Error(
        `This requisition is ${requisition.status}, not pending approval.`);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "requisition.approve", subject_person_id: requisition.raised_by,
        audit: {action: "recruitment.requisition_approved", object_type: "requisition",
            object_ref: request.requisition_id, detail: {}},

        action: async exec => {
            await exec.runCmd(
                "UPDATE requisition SET status='approved', approved_at=?, approved_by=? WHERE requisition_id=?",
                [_now(), request.actor_person_id, request.requisition_id]);
            return {requisition_id: request.requisition_id, status: "approved"};
        }});
}

/**
 * Every requisition in the org, with an applicant count.
 * @returns {object} {requisitions: [...], req_types}
 */
exports.requisitionsAsync = async function(org_id, actor_person_id) {
    await _requireReadAsync(org_id, actor_person_id, "read requisitions");
    const requisitions = await dblayer.getQueryOrThrow(
        "SELECT * FROM requisition WHERE org_id=? ORDER BY created_at DESC", [org_id]);
    const counts = await dblayer.getQueryOrThrow(
        "SELECT requisition_id, COUNT(*) AS c FROM application WHERE org_id=? GROUP BY requisition_id", [org_id]);
    const countByReq = Object.fromEntries(counts.map(row => [row.requisition_id, row.c]));
    return {requisitions: requisitions.map(r => ({...r, applicants: countByReq[r.requisition_id] || 0})),
        req_types: REQ_TYPES, candidate_sources: CANDIDATE_SOURCES};
}

// ---------------------------------------------------------------------------
// candidates & applications
// ---------------------------------------------------------------------------

/**
 * Adds a candidate to a requisition's pipeline. Duplicate detection is by
 * email only for Phase 1 (K5 item 4's full "seen before, scorecards outside
 * the 6-month reuse window" nuance is deferred) — a second application from
 * the same email reuses the existing `candidate` row rather than creating a
 * second one, per `application`'s own register note.
 *
 * @param {object} request {org_id, actor_person_id, requisition_id,
 *      full_name, email, phone, source, referrer_person_id, resume_ref,
 *      timezone, availability_notes}
 * @returns {object} {application_id, candidate_id}
 */
exports.applyAsync = async function(request) {
    if (!request?.full_name || !request?.email) throw new Error("A candidate needs a name and an email.");
    if (request.source && !CANDIDATE_SOURCES.includes(request.source)) throw new Error(
        `source must be one of ${CANDIDATE_SOURCES.join(", ")}.`);
    if (request.timezone) _assertTimezone(request.timezone);
    const requisition = await _requisitionAsync(request.org_id, request.requisition_id);
    if (!requisition) throw new Error(`No requisition ${request.requisition_id}.`);
    if (requisition.status != "approved") throw new Error(
        "Candidates can only be added to an approved requisition.");

    const applicationId = _uuid();
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "stage_transition.record",
        audit: {action: "recruitment.application_created", object_type: "application", object_ref: applicationId,
            detail: {requisition_id: request.requisition_id}},

        action: async exec => {
            const email = request.email.trim().toLowerCase();
            let candidate = (await exec.getQuery(
                "SELECT * FROM candidate WHERE org_id=? AND email=?", [request.org_id, email]))[0];
            if (!candidate) {
                candidate = {candidate_id: _uuid(), org_id: request.org_id, full_name: request.full_name.trim(),
                    email, phone: request.phone || null, source: request.source || "other",
                    referrer_person_id: request.referrer_person_id || null, resume_ref: request.resume_ref || null,
                    timezone: request.timezone || null, availability_notes: request.availability_notes || null,
                    created_at: _now(), created_by: request.actor_person_id};
                await exec.runCmd(`INSERT INTO candidate (candidate_id, org_id, full_name, email, phone, source,
                        referrer_person_id, resume_ref, timezone, availability_notes, created_at, created_by)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [candidate.candidate_id, candidate.org_id, candidate.full_name, candidate.email,
                        candidate.phone, candidate.source, candidate.referrer_person_id, candidate.resume_ref,
                        candidate.timezone, candidate.availability_notes, candidate.created_at, candidate.created_by]);
            }
            const application = {application_id: applicationId, org_id: request.org_id,
                candidate_id: candidate.candidate_id, requisition_id: request.requisition_id,
                workflow_version_id: requisition.workflow_version_id, applied_at: _now(),
                applied_via: request.source || candidate.source, created_at: _now(),
                created_by: request.actor_person_id};
            await exec.runCmd(`INSERT INTO application (application_id, org_id, candidate_id, requisition_id,
                    workflow_version_id, applied_at, applied_via, created_at, created_by)
                    VALUES (?,?,?,?,?,?,?,?,?)`,
                [application.application_id, application.org_id, application.candidate_id,
                    application.requisition_id, application.workflow_version_id, application.applied_at,
                    application.applied_via, application.created_at, application.created_by]);
            return {application_id: applicationId, candidate_id: candidate.candidate_id};
        }});
}

// ---------------------------------------------------------------------------
// the engine — legal actions, and recording a transition
// ---------------------------------------------------------------------------

/**
 * The engine's read side (K4's "available transitions — returned by the
 * engine, not listed by this screen"). Projects the application's current
 * state and states, for each currently-active round, which of the six
 * actions are legal and why not for the rest — so a disabled control always
 * has a reason attached (K7 item 5).
 *
 * @param {string} org_id The org
 * @param {string} actor_person_id The caller
 * @param {string} application_id The application
 * @returns {object} {terminal, current_rounds: [{round_id, title, state,
 *      review_date, scorecard_criteria, actions: [{action, legal, why_not}]}]}
 */
exports.legalActionsAsync = async function(org_id, actor_person_id, application_id) {
    await _requireReadAsync(org_id, actor_person_id, "read the engine's legal actions");
    const application = await _applicationAsync(org_id, application_id);
    if (!application) throw new Error(`No application ${application_id}.`);
    const projected = await _projectAsync(org_id, application);
    if (projected.terminal) return {terminal: projected.terminal, current_rounds: []};

    const scorecards = await dblayer.getQueryOrThrow(
        "SELECT * FROM scorecard WHERE org_id=? AND application_id=?", [org_id, application_id]);

    const current_rounds = projected.current_rounds.map(({round, state, transition}) => {
        const hasScorecard = scorecards.some(s => s.round_id == round.id);
        const needsScorecard = (round.scorecard_criteria || []).length > 0;
        const actions = [
            {action: "advance", legal: !needsScorecard || hasScorecard,
                why_not: (needsScorecard && !hasScorecard) ? "Requires a submitted scorecard." : null},
            {action: "reject", legal: true, why_not: null},
            {action: "hold", legal: true, why_not: null},
            {action: "skip", legal: Boolean(round.optional),
                why_not: round.optional ? null : "Round is mandatory."},
            {action: "reschedule", legal: true, why_not: null},
            {action: "cancel", legal: true, why_not: null}
        ];
        return {round_id: round.id, title: round.title, state, review_date: transition?.review_date || null,
            scorecard_criteria: round.scorecard_criteria || [], actions};
    });
    return {terminal: null, current_rounds};
}

const ACTION_TO_KIND = Object.freeze({advance: "advanced", reject: "rejected", hold: "held",
    skip: "skipped", reschedule: "rescheduled", cancel: "cancelled"});

/**
 * Records one of the six transitions, having first checked it against
 * `legalActionsAsync`'s own current view — the engine is one function, not
 * duplicated per-screen logic re-deriving legality (K1's central claim).
 *
 * @param {object} request {org_id, actor_person_id, application_id,
 *      round_id, kind, reason, review_date, detail, client_event_id}
 * @returns The stage_transition row
 */
exports.recordTransitionAsync = async function(request) {
    if (!TRANSITION_KINDS.includes(request.kind)) throw new Error(
        `kind must be one of ${TRANSITION_KINDS.join(", ")}.`);
    if (["rejected", "held", "cancelled"].includes(request.kind) && !request.reason) throw new Error(
        `${request.kind} needs a reason.`);
    if (request.kind == "held" && !request.review_date) throw new Error(
        "A hold needs a review date — a hold without one is how pipelines rot.");
    if (request.review_date) _assertISODate(request.review_date, "review_date");

    const application = await _applicationAsync(request.org_id, request.application_id);
    if (!application) throw new Error(`No application ${request.application_id}.`);

    // Idempotency is checked before legality, deliberately: a replay arrives
    // after the transition it is replaying already moved the round on, so by
    // then the engine would (correctly) no longer see that round as current
    // and would refuse it — which must not turn an idempotent retry into a
    // spurious failure. A genuinely duplicate client_event_id short-circuits
    // here, before anything is re-validated.
    if (request.client_event_id) {
        const existing = await dblayer.getQueryOrThrow(
            "SELECT * FROM stage_transition WHERE org_id=? AND client_event_id=?",
            [request.org_id, request.client_event_id]);
        if (existing.length) return existing[0];
    }

    const legal = await exports.legalActionsAsync(request.org_id, request.actor_person_id, request.application_id);
    const roundEntry = legal.current_rounds.find(r => r.round_id == request.round_id);
    if (!roundEntry) throw new Error(
        `Round ${request.round_id} is not currently active for this application — the engine refuses transitions on a round that isn't open.`);
    const actionName = Object.keys(ACTION_TO_KIND).find(key => ACTION_TO_KIND[key] == request.kind);
    const action = roundEntry.actions.find(a => a.action == actionName);
    if (!action?.legal) throw new Error(action?.why_not || `${actionName} is not a legal action here.`);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "stage_transition.record", reason: request.reason,   // typed text goes in the reason column, never detail
        audit: {action: `recruitment.candidate_${request.kind}`, object_type: "application",
            object_ref: request.application_id,
            detail: {round_id: request.round_id, candidate_id: application.candidate_id}},

        action: async exec => {
            // re-check inside the transaction too, closing the race between
            // the pre-check above and this write actually landing
            if (request.client_event_id) {
                const existing = await exec.getQuery(
                    "SELECT * FROM stage_transition WHERE org_id=? AND client_event_id=?",
                    [request.org_id, request.client_event_id]);
                if (existing.length) return existing[0];
            }
            return await _insertTransitionViaAsync(exec, request);
        }});
}

/** The one place a stage_transition row is written — the engine and K6's reschedule share it. */
async function _insertTransitionViaAsync(exec, spec) {
    const row = {stage_transition_id: _uuid(), org_id: spec.org_id,
        application_id: spec.application_id, round_id: spec.round_id, kind: spec.kind,
        reason: spec.reason || null, review_date: spec.review_date || null,
        detail: JSON.stringify(spec.detail || {}), actor_person_id: spec.actor_person_id,
        occurred_at: _now(), client_event_id: spec.client_event_id || null};
    await exec.runCmd(`INSERT INTO stage_transition (stage_transition_id, org_id, application_id,
            round_id, kind, reason, review_date, detail, actor_person_id, occurred_at, client_event_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [row.stage_transition_id, row.org_id, row.application_id, row.round_id, row.kind, row.reason,
            row.review_date, row.detail, row.actor_person_id, row.occurred_at, row.client_event_id]);
    return row;
}

// ---------------------------------------------------------------------------
// K7 — scorecard & decision: independent submission, locked once in
// ---------------------------------------------------------------------------

/**
 * Submits one interviewer's scorecard. Locked once submitted — there is no
 * draft state in Phase 1, so submit is the only write. An extreme rating
 * (below 3 or above 4) needs at least 80 characters of evidence (K7 item 1):
 * "good candidate" isn't a record, evidence is.
 *
 * @param {object} request {org_id, actor_person_id, application_id,
 *      round_id, criteria_ratings, evidence, recommendation, client_event_id}
 */
exports.submitScorecardAsync = async function(request) {
    const application = await _applicationAsync(request.org_id, request.application_id);
    if (!application) throw new Error(`No application ${request.application_id}.`);
    const version = await _versionByIdAsync(request.org_id, application.workflow_version_id);
    const round = JSON.parse(version.rounds).find(r => r.id == request.round_id);
    if (!round) throw new Error(`No round ${request.round_id} in this workflow.`);
    if (!Array.isArray(request.criteria_ratings) || !request.criteria_ratings.length) throw new Error(
        "A scorecard needs at least one rating.");
    if (!RECOMMENDATIONS.includes(request.recommendation)) throw new Error(
        `recommendation must be one of ${RECOMMENDATIONS.join(", ")}.`);
    for (const rating of request.criteria_ratings) {
        if (!Number.isInteger(rating.rating) || rating.rating < 1 || rating.rating > 5) throw new Error(
            `The rating for ${rating.criterion_id} must be an integer from 1 to 5.`);
        if ((rating.rating < 3 || rating.rating > 4) && (!request.evidence || request.evidence.trim().length < 80))
            throw new Error(
                "A rating below 3 or above 4 needs at least 80 characters of evidence — \"good candidate\" isn't a record, evidence is.");
    }

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "scorecard.submit",
        audit: {action: "recruitment.scorecard_submitted", object_type: "application",
            object_ref: request.application_id, detail: {round_id: request.round_id}},

        action: async exec => {
            if (request.client_event_id) {
                const existing = await exec.getQuery(
                    "SELECT * FROM scorecard WHERE org_id=? AND application_id=? AND round_id=? AND interviewer_person_id=?",
                    [request.org_id, request.application_id, request.round_id, request.actor_person_id]);
                if (existing.length) return existing[0];
            }
            const row = {scorecard_id: _uuid(), org_id: request.org_id, application_id: request.application_id,
                round_id: request.round_id, interviewer_person_id: request.actor_person_id,
                criteria_ratings: JSON.stringify(request.criteria_ratings), evidence: request.evidence || null,
                recommendation: request.recommendation, submitted_at: _now()};
            await exec.runCmd(`INSERT INTO scorecard (scorecard_id, org_id, application_id, round_id,
                    interviewer_person_id, criteria_ratings, evidence, recommendation, submitted_at)
                    VALUES (?,?,?,?,?,?,?,?,?)`,
                [row.scorecard_id, row.org_id, row.application_id, row.round_id, row.interviewer_person_id,
                    row.criteria_ratings, row.evidence, row.recommendation, row.submitted_at]);
            return row;
        }});
}

// ---------------------------------------------------------------------------
// K4 — pipeline board
// ---------------------------------------------------------------------------

/**
 * The board: live applications grouped by their projected current round.
 * Held candidates are surfaced separately (K4 item 2 — a visible column
 * with review dates, never a hiding place), same for terminal outcomes.
 *
 * @returns {object} {requisition, columns: [{round_id, title, cards}],
 *      held, rejected, completed}
 */
exports.pipelineBoardAsync = async function(org_id, actor_person_id, requisition_id) {
    await _requireReadAsync(org_id, actor_person_id, "read the pipeline board");
    const requisition = await _requisitionAsync(org_id, requisition_id);
    if (!requisition) throw new Error(`No requisition ${requisition_id}.`);
    const version = await _versionByIdAsync(org_id, requisition.workflow_version_id);
    const rounds = JSON.parse(version.rounds).sort((a, b) => a.sequence - b.sequence);

    const applications = await dblayer.getQueryOrThrow(
        "SELECT * FROM application WHERE org_id=? AND requisition_id=?", [org_id, requisition_id]);
    const candidateIds = [...new Set(applications.map(a => a.candidate_id))];
    const candidates = candidateIds.length ? await dblayer.getQueryOrThrow(
        `SELECT * FROM candidate WHERE org_id=? AND candidate_id IN (${candidateIds.map(_ => "?").join(",")})`,
        [org_id, ...candidateIds]) : [];
    const candidateById = Object.fromEntries(candidates.map(c => [c.candidate_id, c]));

    const columns = Object.fromEntries(rounds.map(r => [r.id, {round_id: r.id, title: r.title, cards: []}]));
    const held = [], rejected = [], completed = [];
    for (const application of applications) {
        const projected = await _projectAsync(org_id, application);
        const candidate = candidateById[application.candidate_id];
        const candidate_name = candidate?.full_name || "—";
        if (projected.terminal?.kind == "rejected") {
            rejected.push({application_id: application.application_id, candidate_name,
                reason: projected.terminal.reason}); continue;
        }
        if (projected.terminal?.kind == "completed") {
            completed.push({application_id: application.application_id, candidate_name}); continue;
        }
        for (const current of projected.current_rounds) {
            const card = {application_id: application.application_id, candidate_name, state: current.state,
                review_date: current.transition?.review_date || null,
                entered_at: current.transition?.occurred_at || application.applied_at,
                round_id: current.round.id, round_title: current.round.title};
            if (current.state == "held") held.push(card);
            else columns[current.round.id]?.cards.push(card);
        }
    }
    return {requisition, columns: Object.values(columns), held, rejected, completed};
}

// ---------------------------------------------------------------------------
// K5 — candidate record
// ---------------------------------------------------------------------------

/**
 * The K5 drawer payload. Evaluations follow the "invisible until submitted"
 * rule (K7 item 3): while a round is still open, a caller sees only their
 * own scorecard (plus how many total exist, not who or what they said);
 * once the round is resolved, or once the caller has submitted their own
 * for it, the full set is visible — same shape as training's "what a lead
 * sees vs never sees" split.
 */
exports.candidateRecordAsync = async function(org_id, actor_person_id, application_id) {
    await _requireReadAsync(org_id, actor_person_id, "read a candidate record");
    const application = await _applicationAsync(org_id, application_id);
    if (!application) throw new Error(`No application ${application_id}.`);
    const candidate = await _candidateAsync(org_id, application.candidate_id);
    const requisition = await _requisitionAsync(org_id, application.requisition_id);
    const version = await _versionByIdAsync(org_id, application.workflow_version_id);
    const projected = await _project(JSON.parse(version.rounds),
        await dblayer.getQueryOrThrow(
            "SELECT * FROM stage_transition WHERE org_id=? AND application_id=? ORDER BY occurred_at ASC",
            [org_id, application_id]),
        await dblayer.getQueryOrThrow(
            "SELECT * FROM scorecard WHERE org_id=? AND application_id=?", [org_id, application_id]));

    const scorecards = await dblayer.getQueryOrThrow(
        "SELECT * FROM scorecard WHERE org_id=? AND application_id=?", [org_id, application_id]);
    const evaluations = projected.rounds.filter(round => round.status != "pending").map(round => {
        const roundCards = scorecards.filter(s => s.round_id == round.id);
        const closed = !["not_started", "held"].includes(round.status);
        const actorSubmitted = roundCards.some(s => s.interviewer_person_id == actor_person_id);
        const reveal = closed || actorSubmitted;
        return {round_id: round.id, title: round.title, status: round.status, scorecard_count: roundCards.length,
            visible: reveal, scorecards: reveal ? roundCards.map(s => ({
                interviewer_person_id: s.interviewer_person_id, recommendation: s.recommendation,
                score: _cardScore(s), evidence: s.evidence, submitted_at: s.submitted_at})) : []};
    });

    const activity = await dblayer.getQueryOrThrow(
        "SELECT * FROM stage_transition WHERE org_id=? AND application_id=? ORDER BY occurred_at DESC",
        [org_id, application_id]);
    const names = await _namesAsync(org_id);
    const panels = (await dblayer.getQueryOrThrow(
        "SELECT * FROM panel_assignment WHERE org_id=? AND application_id=? ORDER BY scheduled_start ASC",
        [org_id, application_id])).map(row => _panelRow(row, names));
    const offers = await _offersWithApprovalsAsync(org_id, application_id, actor_person_id);

    return {candidate, requisition: requisition ? {requisition_id: requisition.requisition_id,
            title: requisition.title, band: requisition.band, band_min: requisition.band_min,
            band_max: requisition.band_max} : null,
        application: {application_id, applied_at: application.applied_at, applied_via: application.applied_via,
            workflow_version: version.version},
        workflow: projected.rounds, terminal: projected.terminal, evaluations, activity, panels, offers,
        recommendations: RECOMMENDATIONS, decline_reasons: DECLINE_REASONS};
}

// ---------------------------------------------------------------------------
// K6 — panel scheduling: the product's own availability model, read not rebuilt
// ---------------------------------------------------------------------------

/**
 * Records the candidate's timezone and what they said about when they can
 * talk. There is no candidate portal yet (K9), so the hiring team enters
 * this on the candidate's behalf. The notes are typed text about a person,
 * so they go nowhere near the audit detail.
 *
 * @param {object} request {org_id, actor_person_id, candidate_id, timezone,
 *      availability_notes}
 */
exports.updateCandidateAsync = async function(request) {
    const candidate = await _candidateAsync(request.org_id, request.candidate_id);
    if (!candidate) throw new Error(`No candidate ${request.candidate_id}.`);
    if (request.timezone) _assertTimezone(request.timezone);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "panel.schedule",
        audit: {action: "recruitment.candidate_availability_set", object_type: "candidate",
            object_ref: request.candidate_id, detail: {timezone: request.timezone || null}},

        action: async exec => {
            await exec.runCmd("UPDATE candidate SET timezone=?, availability_notes=? WHERE org_id=? AND candidate_id=?",
                [request.timezone || null, request.availability_notes || null, request.org_id, request.candidate_id]);
            return {candidate_id: request.candidate_id, timezone: request.timezone || null,
                availability_notes: request.availability_notes || null};
        }});
}

/**
 * Schedules a panel for a round the candidate is in right now. Nothing is
 * refused on availability grounds — a scheduler may knowingly book someone
 * outside their hours, with their agreement — but every interviewer the slot
 * does not fit is named in `warnings`, with the reason, checked against the
 * same E3 board (J6 leave wired in) the team screen draws. The browser's
 * drawing of that board is a guide; this check is the record.
 *
 * @param {object} request {org_id, actor_person_id, application_id, round_id,
 *      interviewer_person_ids, scheduled_start, scheduled_end, timezone_base,
 *      client_event_id}
 * @returns {object} {panel, warnings: [{person_id, reason}]}
 */
exports.schedulePanelAsync = async function(request) {
    // Idempotency first, for the same reason recordTransitionAsync checks it
    // first: a replay must answer with the stored panel, not be re-validated.
    if (request.client_event_id) {
        const existing = await dblayer.getQueryOrThrow(
            "SELECT * FROM panel_assignment WHERE org_id=? AND client_event_id=?",
            [request.org_id, request.client_event_id]);
        if (existing.length) {
            const panel = _panelRow(existing[0], await _namesAsync(request.org_id));
            return {panel, warnings: await _panelFitAsync(request.org_id, panel.interviewer_person_ids,
                panel.scheduled_start, panel.scheduled_end)};
        }
    }

    _assertSlot(request.scheduled_start, request.scheduled_end);
    if (request.timezone_base) _assertTimezone(request.timezone_base);
    const interviewers = await _assertInterviewersAsync(request.org_id, request.interviewer_person_ids);
    await _assertRoundOpenAsync(request.org_id, request.application_id, request.round_id);
    const warnings = await _panelFitAsync(request.org_id, interviewers,
        request.scheduled_start, request.scheduled_end);

    const panelId = _uuid();
    const stored = await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "panel.schedule",
        audit: {action: "recruitment.panel_scheduled", object_type: "application",
            object_ref: request.application_id,
            detail: {panel_assignment_id: panelId, round_id: request.round_id, interviewers: interviewers.length,
                scheduled_start: request.scheduled_start, scheduled_end: request.scheduled_end,
                warnings: warnings.length}},

        action: async exec => {
            if (request.client_event_id) {
                const existing = await exec.getQuery(
                    "SELECT * FROM panel_assignment WHERE org_id=? AND client_event_id=?",
                    [request.org_id, request.client_event_id]);
                if (existing.length) return existing[0];
            }
            const row = {panel_assignment_id: panelId, org_id: request.org_id,
                application_id: request.application_id, round_id: request.round_id,
                interviewer_person_ids: JSON.stringify(interviewers), scheduled_start: request.scheduled_start,
                scheduled_end: request.scheduled_end, timezone_base: request.timezone_base || null,
                status: "scheduled", reason: null, scheduled_by: request.actor_person_id, created_at: _now(),
                completed_at: null, client_event_id: request.client_event_id || null};
            await exec.runCmd(`INSERT INTO panel_assignment (panel_assignment_id, org_id, application_id,
                    round_id, interviewer_person_ids, scheduled_start, scheduled_end, timezone_base, status,
                    reason, scheduled_by, created_at, completed_at, client_event_id)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [row.panel_assignment_id, row.org_id, row.application_id, row.round_id,
                    row.interviewer_person_ids, row.scheduled_start, row.scheduled_end, row.timezone_base,
                    row.status, row.reason, row.scheduled_by, row.created_at, row.completed_at,
                    row.client_event_id]);
            return row;
        }});
    return {panel: _panelRow(stored, await _namesAsync(request.org_id)), warnings};
}

/**
 * Moves a scheduled panel. K1 and K6 describe the same event — a reschedule
 * keeps the round and resets its SLA — so the engine's own `rescheduled`
 * transition is written in the same transaction, rather than asking the
 * scheduler for two actions that could drift apart. That transition resolves
 * nothing in the projector (it never has), so writing it under
 * panel.schedule cannot advance or end a candidate.
 *
 * @param {object} request {org_id, actor_person_id, panel_assignment_id,
 *      scheduled_start, scheduled_end, reason}
 * @returns {object} {panel, warnings}
 */
exports.reschedulePanelAsync = async function(request) {
    const panel = await _panelAsync(request.org_id, request.panel_assignment_id);
    if (!panel) throw new Error(`No panel ${request.panel_assignment_id}.`);
    if (panel.status != "scheduled") throw new Error(`This panel is ${panel.status} — only a scheduled panel can move.`);
    _assertSlot(request.scheduled_start, request.scheduled_end);
    await _assertRoundOpenAsync(request.org_id, panel.application_id, panel.round_id);
    const interviewers = JSON.parse(panel.interviewer_person_ids);
    const warnings = await _panelFitAsync(request.org_id, interviewers,
        request.scheduled_start, request.scheduled_end);

    const updated = await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "panel.schedule", reason: request.reason,
        audit: {action: "recruitment.panel_rescheduled", object_type: "application",
            object_ref: panel.application_id,
            detail: {panel_assignment_id: panel.panel_assignment_id, round_id: panel.round_id,
                from_start: panel.scheduled_start, to_start: request.scheduled_start}},

        action: async exec => {
            await exec.runCmd(
                "UPDATE panel_assignment SET scheduled_start=?, scheduled_end=?, reason=? WHERE panel_assignment_id=?",
                [request.scheduled_start, request.scheduled_end, request.reason || null, panel.panel_assignment_id]);
            await _insertTransitionViaAsync(exec, {org_id: request.org_id, application_id: panel.application_id,
                round_id: panel.round_id, kind: "rescheduled", reason: request.reason,
                detail: {panel_assignment_id: panel.panel_assignment_id}, actor_person_id: request.actor_person_id});
            return {...panel, scheduled_start: request.scheduled_start, scheduled_end: request.scheduled_end,
                reason: request.reason || null};
        }});
    return {panel: _panelRow(updated, await _namesAsync(request.org_id)), warnings};
}

/**
 * Records how a panel went. `completed` writes one non-billable time entry per
 * interviewer in the same transaction as the status change — interviewing is
 * work, and like a completed training module neither record may exist without
 * the other. The entry's note names the round, never the candidate: it is the
 * interviewer's record and outlives the candidate's erasure.
 *
 * Cancelling a panel meeting is not the engine's `cancelled` transition, which
 * removes the round itself from the candidate's process. The round stays open
 * here; the meeting just isn't happening. A no-show is recorded against the
 * panel, never the candidate (K6).
 *
 * @param {object} request {org_id, actor_person_id, panel_assignment_id,
 *      outcome: completed | cancelled | no_show, reason}
 * @returns {object} {panel, time_entries}
 */
exports.recordPanelOutcomeAsync = async function(request) {
    if (!PANEL_OUTCOMES.includes(request.outcome)) throw new Error(
        `outcome must be one of ${PANEL_OUTCOMES.join(", ")}.`);
    const panel = await _panelAsync(request.org_id, request.panel_assignment_id);
    if (!panel) throw new Error(`No panel ${request.panel_assignment_id}.`);
    const names = await _namesAsync(request.org_id);
    if (panel.status == request.outcome) return {panel: _panelRow(panel, names),   // a replay, not a second outcome
        time_entries: await _panelTimeEntriesAsync(panel)};
    if (panel.status != "scheduled") throw new Error(`This panel is already ${panel.status}.`);
    if (request.outcome != "completed" && !request.reason) throw new Error(`${request.outcome} needs a reason.`);
    if (request.outcome == "completed" && panel.scheduled_start > _now()) throw new Error(
        "A panel that hasn't started can't be completed — its hours would be logged for time not yet worked.");

    const version = await _versionByIdAsync(request.org_id,
        (await _applicationAsync(request.org_id, panel.application_id)).workflow_version_id);
    const roundTitle = JSON.parse(version.rounds).find(r => r.id == panel.round_id)?.title || panel.round_id;
    const interviewers = JSON.parse(panel.interviewer_person_ids);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "panel.schedule", reason: request.reason,
        audit: {action: `recruitment.panel_${request.outcome}`, object_type: "application",
            object_ref: panel.application_id,
            detail: {panel_assignment_id: panel.panel_assignment_id, round_id: panel.round_id,
                interviewers: interviewers.length}},

        action: async exec => {
            const completedAt = request.outcome == "completed" ? _now() : null;
            await exec.runCmd(
                "UPDATE panel_assignment SET status=?, reason=?, completed_at=? WHERE panel_assignment_id=?",
                [request.outcome, request.reason || panel.reason || null, completedAt, panel.panel_assignment_id]);
            const time_entries = [];
            if (request.outcome == "completed") for (const person_id of interviewers)
                time_entries.push(await time.insertEventViaAsync(exec, {org_id: request.org_id, person_id,
                    client_event_id: _panelEntryClientId(panel, person_id),
                    entry_date: new Date(panel.scheduled_start*1000).toISOString().substring(0, 10),
                    source: "manual", category: INTERVIEW_CATEGORY, note: `Interview panel — ${roundTitle}`,
                    duration_seconds: panel.scheduled_end - panel.scheduled_start, billable: 0}));
            return {panel: _panelRow({...panel, status: request.outcome,
                reason: request.reason || panel.reason || null, completed_at: completedAt}, names), time_entries};
        }});
}

/**
 * Interview load per interviewer over a date range — panels scheduled or
 * completed, counted and summed. No "overloaded" flag: the wireframe draws
 * one but never states the rule, so none is invented. Sorted by name, not by
 * load, because interviewer load is a distribution and never a ranking (K11).
 *
 * @returns {object} {from_date, to_date, interviewers: [{person_id, name,
 *      panels, completed, seconds}]}
 */
exports.interviewerLoadAsync = async function(org_id, actor_person_id, from_date, to_date) {
    await _requireReadAsync(org_id, actor_person_id, "read interviewer load");
    _assertISODate(from_date, "from_date"); _assertISODate(to_date, "to_date");
    if (to_date < from_date) throw new Error("to_date cannot be before from_date.");
    const from = Date.parse(`${from_date}T00:00:00Z`)/1000;
    const to = Date.parse(`${to_date}T00:00:00Z`)/1000 + 86400;

    const panels = await dblayer.getQueryOrThrow(
        `SELECT * FROM panel_assignment WHERE org_id=? AND status IN ('scheduled','completed')
            AND scheduled_start >= ? AND scheduled_start < ?`, [org_id, from, to]);
    const names = await _namesAsync(org_id);
    const byPerson = new Map();
    for (const panel of panels) for (const person_id of JSON.parse(panel.interviewer_person_ids)) {
        const row = byPerson.get(person_id) ||
            {person_id, name: names[person_id] || person_id, panels: 0, completed: 0, seconds: 0};
        row.panels++; row.seconds += panel.scheduled_end - panel.scheduled_start;
        if (panel.status == "completed") row.completed++;
        byPerson.set(person_id, row);
    }
    return {from_date, to_date, interviewers: [...byPerson.values()]
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))};
}

// ---------------------------------------------------------------------------
// K8 — offer, approval matrix & acceptance
//
// The wireframe's matrix names specific approver roles (hiring manager, HR,
// Finance); this app's permission model has none of those as a role. What
// survives here is the mechanism, not the names: the offer computes a
// REQUIRED-APPROVAL-COUNT from its own band position and bonus size, and
// each approval must come from a distinct person (offer_approval's own
// unique index enforces that — not application logic that could drift).
// ---------------------------------------------------------------------------

const DECLINE_REASONS = Object.freeze(["compensation", "counter_offer", "another_offer", "location",
    "role_scope", "timing", "personal", "other"]);
const OFFER_TERMINAL = Object.freeze(["accepted", "declined", "expired", "withdrawn"]);

/**
 * Computes the percentile of `fixed_amount` within [band_min, band_max]
 * (clamped 0-100; null when the requisition declared no band, in which case
 * the offer is simply routed as within-band-low, since there is nothing to
 * be a deviation from), and the required-approval count from it: 1 within
 * band at or below the 75th percentile; 2 above the 75th percentile, or
 * when joining_bonus exceeds 10% of fixed_amount (a relative stand-in for
 * the wireframe's currency-specific "over ₹1L" example); 3 above the band
 * entirely.
 */
function _offerRoute(fixed_amount, joining_bonus, band_min, band_max) {
    let percentile = null, aboveBand = false;
    if (Number.isInteger(band_min) && Number.isInteger(band_max) && band_max > band_min) {
        aboveBand = fixed_amount > band_max;
        percentile = Math.round(Math.max(0, Math.min(1, (fixed_amount - band_min)/(band_max - band_min))) * 100);
    }
    const bigBonus = Number.isInteger(joining_bonus) && joining_bonus > fixed_amount*0.1;
    const required_approvals = aboveBand ? 3 : ((percentile != null && percentile > 75) || bigBonus) ? 2 : 1;
    return {percentile, required_approvals};
}

/**
 * Builds the first version of an offer. Only legal once the candidate has
 * passed every round — reuses the engine's own projection rather than
 * re-deciding "is this application ready for an offer" here.
 *
 * @param {object} request {org_id, actor_person_id, application_id,
 *      fixed_amount, variable_amount, joining_bonus, start_date, expires_on,
 *      rationale, letter_note, client_event_id}
 * @returns The offer_version row
 */
exports.buildOfferAsync = async function(request) {
    const application = await _applicationAsync(request.org_id, request.application_id);
    if (!application) throw new Error(`No application ${request.application_id}.`);
    // Idempotency is checked before any state-dependent validation, for the
    // same reason recordTransitionAsync checks it first: a replay arrives
    // after the build it is replaying already landed, so by then "does this
    // application already have an offer" would (correctly) be true and
    // would refuse it — which must not turn an idempotent retry into a
    // spurious failure.
    if (request.client_event_id) {
        const replay = await dblayer.getQueryOrThrow(
            "SELECT * FROM offer_version WHERE org_id=? AND client_event_id=?",
            [request.org_id, request.client_event_id]);
        if (replay.length) return replay[0];
    }

    const projected = await _projectAsync(request.org_id, application);
    if (projected.terminal?.kind != "completed") throw new Error(
        "An offer can only be built once the candidate has passed every round.");
    const existing = await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM offer_version WHERE org_id=? AND application_id=?",
        [request.org_id, request.application_id]);
    if (existing[0].c) throw new Error(
        "This application already has an offer — negotiate the existing one instead of building a second.");

    const offer = _validateOfferTerms(request);
    const requisition = await _requisitionAsync(request.org_id, application.requisition_id);
    const {percentile, required_approvals} = _offerRoute(offer.fixed_amount, offer.joining_bonus,
        requisition?.band_min, requisition?.band_max);
    if (required_approvals > 1 && !offer.rationale) throw new Error(
        "This offer is above the 75th percentile of the band (or above it, or carries a large joining bonus) — not blocked, but it needs the deviation rationale.");

    const offerVersionId = _uuid();
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "offer.approve",
        audit: {action: "recruitment.offer_built", object_type: "application", object_ref: request.application_id,
            detail: {offer_version_id: offerVersionId, version: 1, required_approvals, percentile}},

        action: async exec => {
            if (request.client_event_id) {
                const found = await exec.getQuery(
                    "SELECT * FROM offer_version WHERE org_id=? AND client_event_id=?",
                    [request.org_id, request.client_event_id]);
                if (found.length) return found[0];
            }
            const row = {offer_version_id: offerVersionId, org_id: request.org_id,
                application_id: request.application_id, version: 1, status: "pending_approval",
                fixed_amount: offer.fixed_amount, variable_amount: offer.variable_amount,
                joining_bonus: offer.joining_bonus, start_date: offer.start_date, expires_on: offer.expires_on,
                band_min: requisition?.band_min ?? null, band_max: requisition?.band_max ?? null,
                percentile, rationale: offer.rationale, required_approvals, decline_reason: null,
                decline_detail: null, superseded_by_version_id: null, letter_note: offer.letter_note,
                offered_by: request.actor_person_id, created_at: _now(), sent_at: null, responded_at: null,
                withdrawn_at: null, withdrawn_reason: null, client_event_id: request.client_event_id || null};
            await exec.runCmd(`INSERT INTO offer_version (offer_version_id, org_id, application_id, version,
                    status, fixed_amount, variable_amount, joining_bonus, start_date, expires_on, band_min,
                    band_max, percentile, rationale, required_approvals, decline_reason, decline_detail,
                    superseded_by_version_id, letter_note, offered_by, created_at, sent_at, responded_at,
                    withdrawn_at, withdrawn_reason, client_event_id)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [row.offer_version_id, row.org_id, row.application_id, row.version, row.status,
                    row.fixed_amount, row.variable_amount, row.joining_bonus, row.start_date, row.expires_on,
                    row.band_min, row.band_max, row.percentile, row.rationale, row.required_approvals,
                    row.decline_reason, row.decline_detail, row.superseded_by_version_id, row.letter_note,
                    row.offered_by, row.created_at, row.sent_at, row.responded_at, row.withdrawn_at,
                    row.withdrawn_reason, row.client_event_id]);
            return row;
        }});
}

/**
 * Records one approval. Self-approval is blocked by the same SOD rule that
 * already guards `requisition.approve` (`offer.approve` was added to
 * `sod.self_approval.applies_to`). A second approval from the same person
 * is refused by `offer_approval`'s own unique index — that refusal is what
 * makes "distinct" a fact of the data, not a promise from this function.
 */
exports.approveOfferAsync = async function(request) {
    const offer = await _offerAsync(request.org_id, request.offer_version_id);
    if (!offer) throw new Error(`No offer ${request.offer_version_id}.`);
    if (offer.status != "pending_approval") throw new Error(
        `This offer is ${offer.status}, not pending approval.`);

    const result = await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "offer.approve", subject_person_id: offer.offered_by,
        audit: {action: "recruitment.offer_approval_recorded", object_type: "application",
            object_ref: offer.application_id, detail: {offer_version_id: offer.offer_version_id}},

        action: async exec => {
            const already = await exec.getQuery(
                "SELECT * FROM offer_approval WHERE org_id=? AND offer_version_id=? AND approver_person_id=?",
                [request.org_id, offer.offer_version_id, request.actor_person_id]);
            if (already.length) throw new Error("You have already approved this offer.");
            await exec.runCmd(`INSERT INTO offer_approval (offer_approval_id, org_id, offer_version_id,
                    approver_person_id, approved_at) VALUES (?,?,?,?,?)`,
                [_uuid(), request.org_id, offer.offer_version_id, request.actor_person_id, _now()]);
            const count = (await exec.getQuery(
                "SELECT COUNT(*) AS c FROM offer_approval WHERE org_id=? AND offer_version_id=?",
                [request.org_id, offer.offer_version_id]))[0].c;
            const approved = count >= offer.required_approvals;
            if (approved) await exec.runCmd("UPDATE offer_version SET status='approved' WHERE offer_version_id=?",
                [offer.offer_version_id]);
            return {approvals_received: count, required_approvals: offer.required_approvals, approved};
        }});
    return {...result, offer: await _offerAsync(request.org_id, request.offer_version_id)};
}

/** approved → sent. No e-signature integration — this is a status the sender sets. */
exports.sendOfferAsync = async function(request) {
    return await _transitionOfferAsync(request, "approved", "sent",
        "recruitment.offer_sent", exec => exec.runCmd(
            "UPDATE offer_version SET status='sent', sent_at=? WHERE offer_version_id=?", [_now(), request.offer_version_id]));
}

/** sent → viewed. */
exports.recordOfferViewedAsync = async function(request) {
    return await _transitionOfferAsync(request, "sent", "viewed",
        "recruitment.offer_viewed", exec => exec.runCmd(
            "UPDATE offer_version SET status='viewed' WHERE offer_version_id=?", [request.offer_version_id]));
}

async function _transitionOfferAsync(request, fromStatus, toStatus, action, write) {
    const offer = await _offerAsync(request.org_id, request.offer_version_id);
    if (!offer) throw new Error(`No offer ${request.offer_version_id}.`);
    if (offer.status != fromStatus) throw new Error(`This offer is ${offer.status}, not ${fromStatus}.`);
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "offer.approve",
        audit: {action, object_type: "application", object_ref: offer.application_id,
            detail: {offer_version_id: offer.offer_version_id}},
        action: async exec => {await write(exec); return {offer_version_id: offer.offer_version_id, status: toStatus};}});
}

/**
 * A negotiation supersedes the current version and inserts the next — same
 * versioned-with-supersession shape as everywhere else in this schema.
 * Version 1 is retained, exactly as the wireframe asks. Re-routes: the new
 * terms get their own percentile and required_approvals, computed fresh —
 * a revision that crosses a tier is not quietly waved through on the old
 * route.
 *
 * @param {object} request {org_id, actor_person_id, offer_version_id,
 *      fixed_amount, variable_amount, joining_bonus, start_date, expires_on,
 *      rationale, letter_note}
 */
exports.negotiateOfferAsync = async function(request) {
    const current = await _offerAsync(request.org_id, request.offer_version_id);
    if (!current) throw new Error(`No offer ${request.offer_version_id}.`);
    if (!["sent", "viewed", "negotiating"].includes(current.status)) throw new Error(
        `This offer is ${current.status} — only a sent offer can be negotiated.`);
    const offer = _validateOfferTerms(request);
    const {percentile, required_approvals} = _offerRoute(offer.fixed_amount, offer.joining_bonus,
        current.band_min, current.band_max);
    if (required_approvals > 1 && !offer.rationale) throw new Error(
        "This revision is above the 75th percentile of the band (or above it, or carries a large joining bonus) — it needs the deviation rationale.");

    const nextVersionId = _uuid();
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "offer.approve",
        audit: {action: "recruitment.offer_negotiated", object_type: "application",
            object_ref: current.application_id,
            detail: {from_version: current.version, to_version: current.version + 1,
                re_routed: required_approvals != current.required_approvals}},

        action: async exec => {
            await exec.runCmd(
                "UPDATE offer_version SET status='negotiating', superseded_by_version_id=? WHERE offer_version_id=?",
                [nextVersionId, current.offer_version_id]);
            const row = {offer_version_id: nextVersionId, org_id: request.org_id,
                application_id: current.application_id, version: current.version + 1, status: "pending_approval",
                fixed_amount: offer.fixed_amount, variable_amount: offer.variable_amount,
                joining_bonus: offer.joining_bonus, start_date: offer.start_date, expires_on: offer.expires_on,
                band_min: current.band_min, band_max: current.band_max, percentile, rationale: offer.rationale,
                required_approvals, decline_reason: null, decline_detail: null, superseded_by_version_id: null,
                letter_note: offer.letter_note, offered_by: request.actor_person_id, created_at: _now(),
                sent_at: null, responded_at: null, withdrawn_at: null, withdrawn_reason: null, client_event_id: null};
            await exec.runCmd(`INSERT INTO offer_version (offer_version_id, org_id, application_id, version,
                    status, fixed_amount, variable_amount, joining_bonus, start_date, expires_on, band_min,
                    band_max, percentile, rationale, required_approvals, decline_reason, decline_detail,
                    superseded_by_version_id, letter_note, offered_by, created_at, sent_at, responded_at,
                    withdrawn_at, withdrawn_reason, client_event_id)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [row.offer_version_id, row.org_id, row.application_id, row.version, row.status,
                    row.fixed_amount, row.variable_amount, row.joining_bonus, row.start_date, row.expires_on,
                    row.band_min, row.band_max, row.percentile, row.rationale, row.required_approvals,
                    row.decline_reason, row.decline_detail, row.superseded_by_version_id, row.letter_note,
                    row.offered_by, row.created_at, row.sent_at, row.responded_at, row.withdrawn_at,
                    row.withdrawn_reason, row.client_event_id]);
            return row;
        }});
}

/**
 * Records how the offer ended. `withdrawn` is a legal event (the wireframe's
 * own words) and always carries a reason; `declined` carries a taxonomy
 * reason so the funnel can be analysed without free text standing in for
 * data (K11).
 *
 * @param {object} request {org_id, actor_person_id, offer_version_id,
 *      outcome: accepted|declined|expired|withdrawn, decline_reason,
 *      decline_detail, reason}
 */
exports.recordOfferOutcomeAsync = async function(request) {
    if (!OFFER_TERMINAL.includes(request.outcome)) throw new Error(
        `outcome must be one of ${OFFER_TERMINAL.join(", ")}.`);
    const offer = await _offerAsync(request.org_id, request.offer_version_id);
    if (!offer) throw new Error(`No offer ${request.offer_version_id}.`);
    if (OFFER_TERMINAL.includes(offer.status)) throw new Error(`This offer is already ${offer.status}.`);
    if (request.outcome == "declined" && !DECLINE_REASONS.includes(request.decline_reason)) throw new Error(
        `decline_reason must be one of ${DECLINE_REASONS.join(", ")}.`);
    if (request.outcome == "withdrawn" && !request.reason) throw new Error(
        "A withdrawal is a legal event and needs a reason.");

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "offer.approve", reason: request.outcome == "withdrawn" ? request.reason : undefined,
        audit: {action: `recruitment.offer_${request.outcome}`, object_type: "application",
            object_ref: offer.application_id, detail: {offer_version_id: offer.offer_version_id}},

        action: async exec => {
            await exec.runCmd(`UPDATE offer_version SET status=?, responded_at=?, decline_reason=?,
                    decline_detail=?, withdrawn_at=?, withdrawn_reason=? WHERE offer_version_id=?`,
                [request.outcome, ["accepted", "declined"].includes(request.outcome) ? _now() : null,
                    request.outcome == "declined" ? request.decline_reason : null,
                    request.outcome == "declined" ? (request.decline_detail || null) : null,
                    request.outcome == "withdrawn" ? _now() : null,
                    request.outcome == "withdrawn" ? request.reason : null, offer.offer_version_id]);
            return {offer_version_id: offer.offer_version_id, status: request.outcome};
        }});
}

/** Every version of an application's offer, current first — the K5 drawer's history list. */
exports.offersForApplicationAsync = async function(org_id, actor_person_id, application_id) {
    await _requireReadAsync(org_id, actor_person_id, "read an application's offer");
    return {offers: await _offersWithApprovalsAsync(org_id, application_id, actor_person_id)};
}

/** Every offer version for an application, current first, each carrying who has approved it so far. */
async function _offersWithApprovalsAsync(org_id, application_id, actor_person_id) {
    const offers = await dblayer.getQueryOrThrow(
        "SELECT * FROM offer_version WHERE org_id=? AND application_id=? ORDER BY version DESC",
        [org_id, application_id]);
    if (!offers.length) return offers;
    const ids = offers.map(o => o.offer_version_id);
    const approvals = await dblayer.getQueryOrThrow(
        `SELECT offer_version_id, approver_person_id FROM offer_approval
            WHERE org_id=? AND offer_version_id IN (${ids.map(_ => "?").join(",")})`, [org_id, ...ids]);
    const names = await _namesAsync(org_id);
    return offers.map(offer => {
        const forThis = approvals.filter(a => a.offer_version_id == offer.offer_version_id);
        return {...offer, approvals_received: forThis.length,
            approved_by_actor: forThis.some(a => a.approver_person_id == actor_person_id),
            approvers: forThis.map(a => names[a.approver_person_id] || a.approver_person_id)};
    });
}

function _validateOfferTerms(request) {
    if (!Number.isInteger(request.fixed_amount) || request.fixed_amount <= 0) throw new Error(
        "fixed_amount must be a positive integer.");
    if (request.variable_amount !== undefined && request.variable_amount !== null &&
        (!Number.isInteger(request.variable_amount) || request.variable_amount < 0)) throw new Error(
        "variable_amount, when set, must be a non-negative integer.");
    if (request.joining_bonus !== undefined && request.joining_bonus !== null &&
        (!Number.isInteger(request.joining_bonus) || request.joining_bonus < 0)) throw new Error(
        "joining_bonus, when set, must be a non-negative integer.");
    _assertISODate(request.start_date, "start_date");
    _assertISODate(request.expires_on, "expires_on");
    if (request.expires_on < _today()) throw new Error("expires_on cannot be in the past.");
    return {fixed_amount: request.fixed_amount, variable_amount: request.variable_amount ?? null,
        joining_bonus: request.joining_bonus ?? null, start_date: request.start_date,
        expires_on: request.expires_on, rationale: request.rationale || null,
        letter_note: request.letter_note || null};
}

async function _offerAsync(org_id, offer_version_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM offer_version WHERE org_id=? AND offer_version_id=?", [org_id, offer_version_id]);
    return rows[0] || null;
}

// ---------------------------------------------------------------------------
// the engine's core — pure, so its graph-walk can be reasoned about (and
// tested) without a database
// ---------------------------------------------------------------------------

/**
 * Projects an application's state by replaying `stage_transition` rows
 * against the workflow's round graph — status is never stored, only this.
 * Rounds sharing a sequence run in parallel; a stage-group only clears once
 * every round in it is passed, skipped or cancelled. A rejection at any
 * round, in any group, ends the whole application immediately. A
 * conditional round is auto-skipped when its referenced (earlier) round's
 * scorecard-derived average score does not satisfy the condition.
 *
 * @param {array} rounds The workflow version's round definitions
 * @param {array} transitions This application's stage_transition rows, in
 *      occurred_at order
 * @param {array} scorecards This application's scorecard rows
 * @returns {object} {rounds: [...with .status], current_rounds:
 *      [{round, state, transition}], terminal: null|{kind, round_id?, reason?}}
 */
function _project(rounds, transitions, scorecards) {
    const sorted = [...rounds].sort((a, b) => a.sequence - b.sequence);
    const sequences = [...new Set(sorted.map(r => r.sequence))].sort((a, b) => a - b);
    const latestByRound = {};
    for (const t of transitions) latestByRound[t.round_id] = t;   // later rows overwrite — last write wins

    const roundScore = round => {
        const cards = scorecards.filter(s => s.round_id == round.id);
        const averages = cards.map(_cardScore).filter(v => v != null);
        return averages.length ? averages.reduce((a, b) => a + b, 0) / averages.length : null;
    };
    const conditionMet = round => {
        if (!round.condition) return true;
        const referenced = sorted.find(r => r.id == round.condition.round_id);
        const score = referenced ? roundScore(referenced) : null;
        if (score == null) return false;   // no score yet — the safe default is not to open a conditional round
        const {operator, value} = round.condition;
        if (operator == "<") return score < value;
        if (operator == "<=") return score <= value;
        if (operator == ">") return score > value;
        if (operator == ">=") return score >= value;
        return score == value;
    };

    const roundStatus = {};
    let terminal = null;
    const currentRounds = [];

    walk:
    for (const sequence of sequences) {
        const group = sorted.filter(r => r.sequence == sequence);
        for (const round of group) {
            if (!conditionMet(round)) {roundStatus[round.id] = {state: "skipped_by_condition"}; continue;}
            const transition = latestByRound[round.id];
            if (!transition) {roundStatus[round.id] = {state: "not_started"}; continue;}
            const state = {advanced: "passed", rejected: "rejected", held: "held", skipped: "skipped",
                cancelled: "cancelled"}[transition.kind] || "not_started";   // rescheduled resolves nothing
            roundStatus[round.id] = {state, transition};
        }

        const rejectedRound = group.find(r => roundStatus[r.id]?.state == "rejected");
        if (rejectedRound) {
            terminal = {kind: "rejected", round_id: rejectedRound.id,
                reason: roundStatus[rejectedRound.id].transition.reason};
            break walk;
        }

        const unresolved = group.filter(r =>
            !["passed", "skipped", "skipped_by_condition", "cancelled"].includes(roundStatus[r.id]?.state));
        if (unresolved.length) {
            for (const round of unresolved) currentRounds.push({round, state: roundStatus[round.id]?.state || "not_started",
                transition: roundStatus[round.id]?.transition || null});
            break walk;   // this stage-group has not cleared; nothing later has been reached
        }
    }
    if (!terminal && !currentRounds.length) terminal = {kind: "completed"};

    return {rounds: sorted.map(r => ({...r, status: roundStatus[r.id]?.state || "pending"})),
        current_rounds: currentRounds, terminal};
}

function _cardScore(card) {
    const ratings = JSON.parse(card.criteria_ratings || "[]").map(r => r.rating).filter(Number.isInteger);
    return ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
}

async function _projectAsync(org_id, application) {
    const version = await _versionByIdAsync(org_id, application.workflow_version_id);
    const rounds = JSON.parse(version.rounds);
    const transitions = await dblayer.getQueryOrThrow(
        "SELECT * FROM stage_transition WHERE org_id=? AND application_id=? ORDER BY occurred_at ASC",
        [org_id, application.application_id]);
    const scorecards = await dblayer.getQueryOrThrow(
        "SELECT * FROM scorecard WHERE org_id=? AND application_id=?", [org_id, application.application_id]);
    return _project(rounds, transitions, scorecards);
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function _validateWorkflow(request) {
    if (!request?.title || typeof request.title != "string") throw new Error("A workflow needs a title.");
    if (!request.workflow_code || !/^[a-z0-9-]{2,64}$/.test(request.workflow_code)) throw new Error(
        "workflow_code must be lowercase letters, digits and dashes (2-64).");
    const rounds = request.rounds;
    if (!Array.isArray(rounds) || !rounds.length) throw new Error("A workflow needs at least one round.");
    const ids = new Set();
    for (const round of rounds) {
        if (!round?.id || !round?.title) throw new Error("Every round needs an id and a title.");
        if (ids.has(round.id)) throw new Error(`Duplicate round id ${round.id}.`);
        ids.add(round.id);
        if (!Number.isInteger(round.sequence) || round.sequence < 1) throw new Error(
            `Round ${round.id} needs a sequence number of 1 or more.`);
        if (!round.owner_role) throw new Error(
            `Round ${round.id} needs an owner role — an unowned round is a defect, not a preference.`);
        if (round.optional && !round.skip_role) throw new Error(
            `Round ${round.id} is optional and needs a skip_role — otherwise skip has no authoriser.`);
    }
    for (const round of rounds) {
        if (!round.condition) continue;
        const referenced = rounds.find(r => r.id == round.condition.round_id);
        if (!referenced) throw new Error(
            `Round ${round.id}'s condition references an unknown round ${round.condition.round_id}.`);
        if (referenced.sequence >= round.sequence) throw new Error(
            `Round ${round.id}'s condition references round ${round.condition.round_id}, which does not come before it — a round cannot depend on one that comes after it.`);
        if (!CONDITION_OPERATORS.includes(round.condition.operator)) throw new Error(
            `Round ${round.id}'s condition operator must be one of ${CONDITION_OPERATORS.join(", ")}.`);
    }
    return request;
}

function _assertISODate(date, label = "date") {
    if (typeof date != "string" || !ISO_DATE.test(date)) throw new Error(
        `${label} must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(date)}.`);
    return date;
}

async function _requireReadAsync(org_id, actor_person_id, what) {
    const grants = await permissions.activeGrantsAsync(org_id, actor_person_id, {capability: "candidate.read"});
    if (!grants.length) throw Object.assign(new Error(`candidate.read is required to ${what}.`),
        {decision: {reason: `candidate.read is required to ${what}.`}});
}

async function _requisitionAsync(org_id, requisition_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM requisition WHERE org_id=? AND requisition_id=?", [org_id, requisition_id]);
    return rows[0] || null;
}

async function _candidateAsync(org_id, candidate_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM candidate WHERE org_id=? AND candidate_id=?", [org_id, candidate_id]);
    return rows[0] || null;
}

async function _applicationAsync(org_id, application_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM application WHERE org_id=? AND application_id=?", [org_id, application_id]);
    return rows[0] || null;
}

async function _versionByIdAsync(org_id, workflow_version_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM workflow_version WHERE org_id=? AND workflow_version_id=?",
        [org_id, workflow_version_id]);
    return rows[0] || null;
}

// -- K6 internals --

/**
 * An Area/Location IANA name, or UTC. ICU also accepts legacy abbreviations
 * like "IST", but "IST" is India, Israel and Irish Standard Time at once — a
 * 3.5-hour spread that would put a panel at the wrong hour for someone — so
 * abbreviations are refused rather than silently resolved to one of them.
 */
function _assertTimezone(timeZone) {
    const refuse = _ => {throw new Error(
        `${JSON.stringify(timeZone)} is not an unambiguous IANA timezone — use a name like Asia/Kolkata or Europe/London.`);};
    if (typeof timeZone != "string" || (timeZone != "UTC" && !timeZone.includes("/"))) refuse();
    try {new Intl.DateTimeFormat("en-US", {timeZone});} catch {refuse();}
    return timeZone;
}

function _assertSlot(start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(
        "scheduled_start and scheduled_end must be unix seconds.");
    if (end <= start) throw new Error("A panel has to end after it starts.");
    // A validity guard, not a business rule: a panel longer than a day is a
    // data-entry error, and completing it would log that whole span as every
    // interviewer's work.
    if (end - start > 86400) throw new Error("A panel longer than a day is almost certainly a typo in the times.");
}

/** Interviewers must be people in force in this org, named once each. */
async function _assertInterviewersAsync(org_id, person_ids) {
    if (!Array.isArray(person_ids) || !person_ids.length) throw new Error("A panel needs at least one interviewer.");
    if (new Set(person_ids).size != person_ids.length) throw new Error("An interviewer is listed twice.");
    const inForce = new Set((await spine.rosterAsOfAsync(org_id)).map(row => row.person_id));
    const strangers = person_ids.filter(id => !inForce.has(id));
    if (strangers.length) throw new Error(
        `${strangers.length == 1 ? "One interviewer has" : `${strangers.length} interviewers have`} no employment in force in this organisation.`);
    return person_ids;
}

/** A panel belongs to a round the candidate is in now — the engine's own projection decides that. */
async function _assertRoundOpenAsync(org_id, application_id, round_id) {
    const application = await _applicationAsync(org_id, application_id);
    if (!application) throw new Error(`No application ${application_id}.`);
    const projected = await _projectAsync(org_id, application);
    if (projected.terminal) throw new Error(
        `This application is ${projected.terminal.kind} — there is no round left to hold a panel for.`);
    if (!projected.current_rounds.some(entry => entry.round.id == round_id)) throw new Error(
        `Round ${round_id} is not open for this candidate. A panel is scheduled for the round they are in.`);
}

/**
 * Which interviewers the slot does not fit, and why — read from the E3 board
 * with J6 leave wired in (calendar.teamBoardAsync), the same projection the
 * team screen draws. A person's local working day can straddle UTC midnight,
 * so the boards either side of the slot's UTC date are read too: the slot fits
 * if it sits wholly inside any one of that person's spans.
 */
async function _panelFitAsync(org_id, person_ids, start, end) {
    const day = new Date(start*1000).toISOString().substring(0, 10);
    const dates = [-1, 0, 1].map(delta => {
        const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + delta);
        return date.toISOString().substring(0, 10);
    });
    const boards = [];
    for (const date of dates) boards.push(await calendar.teamBoardAsync(org_id, person_ids, date));

    const fromMinute = start/60, toMinute = end/60, warnings = [];
    for (const person_id of person_ids) {
        const fits = boards.some(board => board.per_person.some(entry => entry.person_id == person_id &&
            entry.workday && entry.span && entry.span.from <= fromMinute && toMinute <= entry.span.to));
        if (fits) continue;
        const onTheDay = boards[1].per_person.find(entry => entry.person_id == person_id);
        warnings.push({person_id, reason: onTheDay && !onTheDay.workday ? onTheDay.reason : "outside_window"});
    }
    return warnings;
}

async function _panelAsync(org_id, panel_assignment_id) {
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM panel_assignment WHERE org_id=? AND panel_assignment_id=?", [org_id, panel_assignment_id]);
    return rows[0] || null;
}

function _panelRow(row, names = {}) {
    const ids = typeof row.interviewer_person_ids == "string" ?
        JSON.parse(row.interviewer_person_ids) : row.interviewer_person_ids;
    return {...row, interviewer_person_ids: ids,
        interviewers: ids.map(person_id => ({person_id, name: names[person_id] || person_id}))};
}

async function _namesAsync(org_id) {
    return Object.fromEntries((await spine.rosterAsOfAsync(org_id))
        .map(row => [row.person_id, row.display_name || row.person_id]));
}

/** Deterministic per interviewer, so a completed panel can never log the same hours twice. */
const _panelEntryClientId = (panel, person_id) => `panel-${panel.panel_assignment_id}-${person_id}`;

async function _panelTimeEntriesAsync(panel) {
    if (panel.status != "completed") return [];
    const entries = [];
    for (const person_id of JSON.parse(panel.interviewer_person_ids)) entries.push(...await dblayer.getQueryOrThrow(
        "SELECT * FROM time_entry_event WHERE org_id=? AND person_id=? AND client_event_id=?",
        [panel.org_id, person_id, _panelEntryClientId(panel, person_id)]));
    return entries;
}

exports.TRANSITION_KINDS = TRANSITION_KINDS;
exports.RECOMMENDATIONS = RECOMMENDATIONS;
exports.REQ_TYPES = REQ_TYPES;
exports.CANDIDATE_SOURCES = CANDIDATE_SOURCES;
exports.PANEL_OUTCOMES = PANEL_OUTCOMES;
exports.INTERVIEW_CATEGORY = INTERVIEW_CATEGORY;
exports.DECLINE_REASONS = DECLINE_REASONS;
exports.OFFER_TERMINAL = OFFER_TERMINAL;
