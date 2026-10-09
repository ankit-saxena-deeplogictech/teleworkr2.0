/**
 * K12 (slice 1) — the candidate retention clock and the run that executes
 * it. Candidate data has no employment relationship behind it, so it runs
 * on its own outcome-anchored clock rather than person/employment's.
 *
 * The policy is versioned exactly like leave (`leave.js`'s
 * `publishPolicyAsync`/pointer shape, simplified to one org-wide policy —
 * no jurisdiction scope yet, matching the wireframe's own "Open" note that
 * the numbers are placeholders pending a legal read, not that the
 * mechanism needs scoping today). The run is previewed then executed
 * exactly like J7 (`runs.js`): one `audit.performAsync` entry per
 * execution, re-checking eligibility fresh rather than trusting a stale
 * preview.
 *
 * An application's outcome is computed, never stored — `application` has
 * no status column; status is projected from `stage_transition`/
 * `offer_version`/`withdrawn_at`, the same way `recruitmentFunnelAsync`
 * already derives "hired" from the latest accepted `offer_version`.
 *
 * "Rejected, consented" anchors its 24-month window on
 * `candidate.consent_retain_at`, not the rejection date — deliberately,
 * so K9's existing `portalSetConsentAsync` (which already refreshes
 * `consent_retain_at`) is what "re-consent" means. Anchoring on the
 * rejection date instead would make re-consenting do nothing.
 *
 * Narrowed, deliberately: no scheduler exists anywhere in this backend —
 * this is an admin-triggered preview/execute pair, exactly what J7 itself
 * actually is despite the wireframe's "runs whether or not anyone
 * remembers" phrasing. Anonymised funnel counts surviving deletion is a
 * reporting-layer change (recruitmentFunnelAsync counts live rows) and is
 * deferred, not folded in here.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);

const DAY_SECONDS = 86400;
const DEFAULT_POLICY = Object.freeze({no_consent_days: 180, consent_days: 730, withdrawn_days: 180});

const _now = _ => Math.floor(Date.now()/1000);
const _uuid = _ => serverutils.generateUUID(false);

async function _requireAsync(org_id, actor_person_id, capability, what) {
    const decision = await permissions.checkAsync({org_id, actor_person_id, capability});
    if (!decision.allowed) throw Object.assign(new Error(`${capability} is required to ${what}.`), {decision});
}

// ---------------------------------------------------------------------------
// policy — versioned, published, pointed at, exactly like leave
// ---------------------------------------------------------------------------

/**
 * The published policy, or a sensible default — the wireframe's own
 * placeholder numbers — if nothing has been published yet, so the engine
 * works before an admin ever visits the screen.
 * @param {string} org_id The org
 * @returns {object} {version, no_consent_days, consent_days, withdrawn_days}
 */
exports.policyAsync = async function(org_id) {
    const pointer = (await dblayer.getQueryOrThrow(
        "SELECT * FROM candidate_retention_policy_pointer WHERE org_id=?", [org_id]))[0];
    if (!pointer) return {version: 0, published: false, ...DEFAULT_POLICY};
    const version = (await dblayer.getQueryOrThrow(
        "SELECT * FROM candidate_retention_policy_version WHERE policy_version_id=?",
        [pointer.policy_version_id]))[0];
    return {version: version.version, published: true, no_consent_days: version.no_consent_days,
        consent_days: version.consent_days, withdrawn_days: version.withdrawn_days};
}

/** @param {object} request {org_id, actor_person_id, step_up_verified, no_consent_days, consent_days, withdrawn_days} */
exports.publishPolicyAsync = async function(request) {
    for (const field of ["no_consent_days", "consent_days", "withdrawn_days"]) {
        const value = request[field];
        if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer.`);
    }

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id,
        capability: "candidate_retention.publish", step_up_verified: request.step_up_verified,
        audit: {action: "candidate_retention.published", object_type: "candidate_retention_policy",
            object_ref: request.org_id, detail: {no_consent_days: request.no_consent_days,
                consent_days: request.consent_days, withdrawn_days: request.withdrawn_days}},
        action: async exec => {
            const versions = await exec.getQuery(
                "SELECT MAX(version) AS max FROM candidate_retention_policy_version WHERE org_id=?", [request.org_id]);
            const version = {policy_version_id: _uuid(), org_id: request.org_id,
                version: (versions[0].max || 0) + 1, status: "published",
                no_consent_days: request.no_consent_days, consent_days: request.consent_days,
                withdrawn_days: request.withdrawn_days, published_at: _now(),
                published_by: request.actor_person_id, created_at: _now(), created_by: request.actor_person_id};

            const current = await exec.getQuery(
                "SELECT * FROM candidate_retention_policy_pointer WHERE org_id=?", [request.org_id]);
            await exec.runCmd(
                `INSERT INTO candidate_retention_policy_version (policy_version_id, org_id, version, status,
                    no_consent_days, consent_days, withdrawn_days, published_at, published_by, created_at, created_by)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                [version.policy_version_id, version.org_id, version.version, version.status,
                    version.no_consent_days, version.consent_days, version.withdrawn_days,
                    version.published_at, version.published_by, version.created_at, version.created_by]);
            if (current.length) await exec.runCmd(
                "UPDATE candidate_retention_policy_version SET status='superseded' WHERE policy_version_id=?",
                [current[0].policy_version_id]);
            await exec.runCmd(
                `INSERT INTO candidate_retention_policy_pointer (org_id, policy_version_id, updated_at)
                    VALUES (?,?,?)
                    ON CONFLICT (org_id) DO UPDATE SET policy_version_id=excluded.policy_version_id,
                        updated_at=excluded.updated_at`,
                [request.org_id, version.policy_version_id, _now()]);

            LOG.info(`Published candidate retention policy v${version.version} in ${request.org_id}.`);
            return {version};
        }});
}

// ---------------------------------------------------------------------------
// outcome and expiry — computed, never stored
// ---------------------------------------------------------------------------

/**
 * An application's outcome, the same signal recruitmentFunnelAsync already
 * uses for "hired" (the latest offer_version, by version, accepted).
 * @returns {object} {outcome: "withdrawn"|"hired"|"rejected"|"in_process", anchor_at}
 */
async function _outcomeForApplicationAsync(org_id, application) {
    if (application.withdrawn_at) return {outcome: "withdrawn", anchor_at: application.withdrawn_at};

    const offers = await dblayer.getQueryOrThrow(
        "SELECT * FROM offer_version WHERE org_id=? AND application_id=? ORDER BY version DESC",
        [org_id, application.application_id]);
    if (offers.length && offers[0].status == "accepted")
        return {outcome: "hired", anchor_at: offers[0].responded_at || offers[0].sent_at || application.applied_at};

    const rejections = await dblayer.getQueryOrThrow(
        `SELECT * FROM stage_transition WHERE org_id=? AND application_id=? AND kind='rejected'
            ORDER BY occurred_at DESC LIMIT 1`, [org_id, application.application_id]);
    if (rejections.length) return {outcome: "rejected", anchor_at: rejections[0].occurred_at};

    return {outcome: "in_process", anchor_at: null};
}

/** @returns {number|null} The epoch second this application's retention expires, or null if never/not yet. */
async function _expiryForApplicationAsync(org_id, candidate, application, policy) {
    const {outcome, anchor_at} = await _outcomeForApplicationAsync(org_id, application);
    if (outcome == "hired" || outcome == "in_process") return null;
    if (outcome == "withdrawn") return anchor_at + policy.withdrawn_days*DAY_SECONDS;
    // rejected
    if (candidate.consent_retain) return (candidate.consent_retain_at || anchor_at) + policy.consent_days*DAY_SECONDS;
    return anchor_at + policy.no_consent_days*DAY_SECONDS;
}

/**
 * One candidate's full disposition: every application's outcome and
 * expiry, and whether the candidate overall is eligible for erasure —
 * every application resolved as rejected/withdrawn (none hired, none
 * still in process), and now past the latest of their expiries.
 * @param {string} org_id The org
 * @param {string} candidate_id The candidate
 * @returns {object} {candidate_id, full_name, applications, eligible, eligible_since}
 */
exports.candidateDispositionAsync = async function(org_id, candidate_id) {
    const candidate = (await dblayer.getQueryOrThrow(
        "SELECT * FROM candidate WHERE org_id=? AND candidate_id=?", [org_id, candidate_id]))[0];
    if (!candidate) throw new Error(`No candidate ${candidate_id}.`);
    const policy = await exports.policyAsync(org_id);
    const applications = await dblayer.getQueryOrThrow(
        "SELECT * FROM application WHERE org_id=? AND candidate_id=?", [org_id, candidate_id]);

    const rows = [];
    for (const application of applications) {
        const {outcome, anchor_at} = await _outcomeForApplicationAsync(org_id, application);
        const expiry_at = await _expiryForApplicationAsync(org_id, candidate, application, policy);
        rows.push({application_id: application.application_id, requisition_id: application.requisition_id,
            outcome, anchor_at, expiry_at});
    }

    const blocksErasure = rows.some(r => r.outcome == "hired" || r.outcome == "in_process");
    const expiries = rows.map(r => r.expiry_at);
    const latestExpiry = expiries.length ? Math.max(...expiries) : null;
    const eligible = !blocksErasure && rows.length > 0 && latestExpiry !== null && _now() >= latestExpiry;

    return {candidate_id, full_name: candidate.full_name, applications: rows,
        eligible, eligible_since: eligible ? latestExpiry : null};
}

// ---------------------------------------------------------------------------
// the run — preview, then execute, exactly like J7
// ---------------------------------------------------------------------------

async function _eligibleCandidatesAsync(org_id) {
    const candidates = await dblayer.getQueryOrThrow("SELECT candidate_id FROM candidate WHERE org_id=?", [org_id]);
    const eligible = [];
    for (const {candidate_id} of candidates) {
        const disposition = await exports.candidateDispositionAsync(org_id, candidate_id);
        if (disposition.eligible) eligible.push(disposition);
    }
    return eligible;
}

/**
 * What a run would do, right now — no writes.
 * @param {string} org_id The org
 * @param {string} actor_person_id The caller
 * @returns {object} {policy, eligible}
 */
exports.previewRetentionRunAsync = async function(org_id, actor_person_id) {
    await _requireAsync(org_id, actor_person_id, "candidate_retention.operate", "preview the candidate retention run");
    const policy = await exports.policyAsync(org_id);
    const eligible = await _eligibleCandidatesAsync(org_id);
    return {policy, eligible};
}

/**
 * Executes the run — recomputes eligibility fresh (state may have drifted
 * since any earlier preview), then erases every still-eligible candidate's
 * whole object graph in one transaction, with one audit entry for the run.
 *
 * Eligibility is recomputed here, outside the transaction, deliberately —
 * candidateDispositionAsync reads via the plain dblayer accessors (it is
 * also called from previewRetentionRunAsync, which has no transaction),
 * and calling a plain accessor from inside runInTransactionAsync's own
 * callback self-deadlocks dblayer's single serial queue (the same class of
 * bug this session has hit and fixed before). The narrow staleness window
 * between this recompute and the transaction below — a candidate's
 * eligibility changing in the last few seconds — is an acceptable trade
 * for a single-admin-triggered action with no plausible concurrent writer.
 * @param {object} request {org_id, actor_person_id}
 * @returns {object} {erased_count, run_id}
 */

/**
 * The erase cascade, shared by the batch run below and the single-
 * candidate deletion-request path — one cascade to keep in sync, not two.
 * @param {object} exec The transaction executor
 * @param {string} org_id The org
 * @param {string} candidate_id The candidate being erased
 * @param {array} applicationIds That candidate's application ids
 */
async function _eraseCandidateRowsAsync(exec, org_id, candidate_id, applicationIds) {
    if (applicationIds.length) {
        const placeholders = applicationIds.map(_ => "?").join(",");
        await exec.runCmd(
            `DELETE FROM offer_approval WHERE org_id=? AND offer_version_id IN
                (SELECT offer_version_id FROM offer_version WHERE org_id=? AND application_id IN (${placeholders}))`,
            [org_id, org_id, ...applicationIds]);
        await exec.runCmd(`DELETE FROM offer_version WHERE org_id=? AND application_id IN (${placeholders})`,
            [org_id, ...applicationIds]);
        await exec.runCmd(`DELETE FROM panel_assignment WHERE org_id=? AND application_id IN (${placeholders})`,
            [org_id, ...applicationIds]);
        await exec.runCmd(`DELETE FROM scorecard WHERE org_id=? AND application_id IN (${placeholders})`,
            [org_id, ...applicationIds]);
        await exec.runCmd(`DELETE FROM candidate_portal_link WHERE org_id=? AND application_id IN (${placeholders})`,
            [org_id, ...applicationIds]);
        await exec.runCmd(`DELETE FROM stage_transition WHERE org_id=? AND application_id IN (${placeholders})`,
            [org_id, ...applicationIds]);
        await exec.runCmd(`DELETE FROM application WHERE org_id=? AND application_id IN (${placeholders})`,
            [org_id, ...applicationIds]);
    }
    // K12 slice 3: keyed directly by candidate_id, no application_id join needed.
    await exec.runCmd("DELETE FROM candidate_diversity_data WHERE org_id=? AND candidate_id=?", [org_id, candidate_id]);
    await exec.runCmd("DELETE FROM candidate WHERE org_id=? AND candidate_id=?", [org_id, candidate_id]);
}

exports.executeRetentionRunAsync = async function(request) {
    const {org_id, actor_person_id} = request;
    await _requireAsync(org_id, actor_person_id, "candidate_retention.operate", "execute the candidate retention run");
    const policy = await exports.policyAsync(org_id);
    const eligible = await _eligibleCandidatesAsync(org_id);
    // performAsync builds the audit row from `audit` before `action` runs, so the
    // run_id is minted here and the audit entry points at the candidate_retention_run
    // row (inserted inside `action`) for the full erased/candidate-id detail.
    const run_id = _uuid();

    return await audit.performAsync({
        org_id, actor_person_id, capability: "candidate_retention.operate",
        audit: {action: "candidate_retention.executed", object_type: "candidate_retention_run",
            object_ref: run_id, detail: {candidate_count: eligible.length}},
        action: async exec => {
            const erasedIds = [];
            for (const disposition of eligible) {
                await _eraseCandidateRowsAsync(exec, org_id, disposition.candidate_id,
                    disposition.applications.map(a => a.application_id));
                erasedIds.push(disposition.candidate_id);
            }

            const policyPointer = (await exec.getQuery(
                "SELECT policy_version_id FROM candidate_retention_policy_pointer WHERE org_id=?", [org_id]))[0];
            const run = {run_id, org_id, policy_version_id: policyPointer?.policy_version_id || null,
                operator_person_id: actor_person_id, erased_count: erasedIds.length,
                detail: JSON.stringify({candidate_ids: erasedIds, policy}), created_at: _now()};
            await exec.runCmd(
                `INSERT INTO candidate_retention_run (run_id, org_id, policy_version_id, operator_person_id,
                    erased_count, detail, created_at) VALUES (?,?,?,?,?,?,?)`,
                [run.run_id, run.org_id, run.policy_version_id, run.operator_person_id, run.erased_count,
                    run.detail, run.created_at]);

            LOG.info(`Candidate retention run ${run.run_id} erased ${run.erased_count} candidate(s) in ${org_id}.`);
            return {erased_count: run.erased_count, run_id: run.run_id};
        }});
}

// ---------------------------------------------------------------------------
// K12 slice 2 — a candidate's own self-service deletion request
// ---------------------------------------------------------------------------

/**
 * The queue: every application with a deletion request awaiting a decision.
 * @param {string} org_id The org
 * @param {string} actor_person_id The caller
 * @returns {object} {requests: [{application_id, candidate_id, full_name, requisition_title, reason, requested_at}]}
 */
exports.pendingDeletionRequestsAsync = async function(org_id, actor_person_id) {
    await _requireAsync(org_id, actor_person_id, "data.manage_requests", "read candidate deletion requests");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT a.application_id, a.candidate_id, a.deletion_requested_at, a.deletion_requested_reason,
            c.full_name, r.title AS requisition_title
            FROM application a JOIN candidate c ON c.candidate_id = a.candidate_id
            JOIN requisition r ON r.requisition_id = a.requisition_id
            WHERE a.org_id=? AND a.deletion_requested_at IS NOT NULL AND a.deletion_decided_at IS NULL
            ORDER BY a.deletion_requested_at ASC`, [org_id]);
    return {requests: rows.map(row => ({application_id: row.application_id, candidate_id: row.candidate_id,
        full_name: row.full_name, requisition_title: row.requisition_title,
        reason: row.deletion_requested_reason, requested_at: row.deletion_requested_at}))};
}

/**
 * Decides a candidate's deletion request. A decline is a plain write — the
 * application simply resumes once decided, same as every other decline this
 * session (approve is the only branch that needs the A8 transaction, since
 * it's the one that actually erases). Approve reuses the exact erasure
 * trigger the batch run already uses (candidate_retention.operate) — not a
 * new capability, since both paths do the same kind of action, just
 * triggered differently.
 * @param {object} request {org_id, actor_person_id, application_id, decision, decision_reason}
 */
exports.decideCandidateDeletionRequestAsync = async function(request) {
    const {org_id, actor_person_id, application_id, decision} = request;
    await _requireAsync(org_id, actor_person_id, "data.manage_requests", "decide a candidate deletion request");
    if (!["approved", "declined"].includes(decision)) throw new Error("decision must be approved or declined.");
    const application = (await dblayer.getQueryOrThrow(
        "SELECT * FROM application WHERE org_id=? AND application_id=?", [org_id, application_id]))[0];
    if (!application || !application.deletion_requested_at || application.deletion_decided_at)
        throw new Error(`Application ${application_id} has no deletion request awaiting a decision.`);

    if (decision == "declined") {
        if (!request.decision_reason?.trim()) throw new Error("A decline needs a reason.");
        await dblayer.runCmdOrThrow(
            `UPDATE application SET deletion_decided_at=?, deletion_decided_by=?, deletion_decision='declined',
                deletion_decision_reason=? WHERE application_id=?`,
            [_now(), actor_person_id, request.decision_reason, application_id]);
        return {status: "declined"};
    }

    return await audit.performAsync({
        org_id, actor_person_id, capability: "candidate_retention.operate",
        audit: {action: "candidate.erased", object_type: "candidate", object_ref: application.candidate_id,
            detail: {via: "deletion_request", application_id}},
        action: async exec => {
            // Erasure is of the candidate, not just the one application they
            // requested it through — a right to erasure is about the data
            // subject, and a candidate row with other applications still
            // attached would be a half-measure, not an erasure.
            const applicationIds = (await exec.getQuery(
                "SELECT application_id FROM application WHERE org_id=? AND candidate_id=?",
                [org_id, application.candidate_id])).map(row => row.application_id);
            await _eraseCandidateRowsAsync(exec, org_id, application.candidate_id, applicationIds);
            return {status: "approved"};
        }});
}
