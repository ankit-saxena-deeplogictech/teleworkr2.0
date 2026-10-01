/**
 * Tests K12 (slice 1) — the candidate retention policy, the per-outcome
 * expiry clock, the preview/execute run, and candidate-read audit coverage.
 *
 * Outcomes are injected directly (a backdated stage_transition row for
 * rejection, a direct withdrawn_at/offer_version write for withdrawal/hire)
 * rather than driven through the full round-by-round legal-transition
 * engine — this suite tests the retention clock's own logic, not K1/K4's
 * engine, which test_recruitment.js already covers. Same "backdate via raw
 * SQL rather than wait" discipline test_workload.js and others already use
 * for timing-dependent fixtures.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests candidateretention
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const recruitment = require(`${TELEWORKR_CONSTANTS.LIBDIR}/recruitment.js`);
const candidateretention = require(`${TELEWORKR_CONSTANTS.LIBDIR}/candidateretention.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Candidate retention test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 120)}`, true);}
}

const DAY = 86400;
const _now = () => Math.floor(Date.now()/1000);
const _rounds = () => [{id: "r1", title: "Resume review", round_type: "resume_review", sequence: 1,
    owner_role: "recruiter", sla_days: 2, scorecard_criteria: []}];

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "candidateretention")) {
        LOG.console("Skipping candidateretention test case, not called.\n"); return true;
    }
    LOG.console("\nK12 (slice 1) candidate retention clock\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testGate(w);
        await _testPolicy(w);
        await _testOutcomes(w);
        await _testRun(w);
        await _testAccessAudit(w);
        await _testDeletionRequests(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  candidateretention tests threw: ${err}\n`); LOG.error(`Candidateretention tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nCandidate retention tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------
// gates
// ---------------------------------------------------------------------------

async function _testGate(w) {
    LOG.console("\n publish/operate gates\n");
    await _checkThrows("an employee cannot publish a retention policy", _ =>
        candidateretention.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.alice,
            no_consent_days: 180, consent_days: 730, withdrawn_days: 180, step_up_verified: true}));
    await _checkThrows("admin cannot publish a retention policy either — hr only, same as leave_policy.publish", _ =>
        candidateretention.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.dave,
            no_consent_days: 180, consent_days: 730, withdrawn_days: 180, step_up_verified: true}));
    await _checkThrows("an employee cannot preview the run", _ =>
        candidateretention.previewRetentionRunAsync(w.org_id, w.alice));
}

// ---------------------------------------------------------------------------
// policy versioning
// ---------------------------------------------------------------------------

async function _testPolicy(w) {
    LOG.console("\n the policy, versioned like leave\n");
    const before = await candidateretention.policyAsync(w.org_id);
    _check("before any publish, a sane unpublished default is returned",
        before.published === false && before.no_consent_days == 180 && before.consent_days == 730);

    const v1 = await candidateretention.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
        no_consent_days: 180, consent_days: 730, withdrawn_days: 180, step_up_verified: true});
    _check("publishing v1 returns version 1", v1.version.version == 1, JSON.stringify(v1));

    const v2 = await candidateretention.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
        no_consent_days: 90, consent_days: 365, withdrawn_days: 90, step_up_verified: true});
    _check("republishing supersedes rather than editing v1", v2.version.version == 2);

    const rows = await dblayer.getQueryOrThrow(
        "SELECT status FROM candidate_retention_policy_version WHERE org_id=? ORDER BY version", [w.org_id]);
    _check("v1 is superseded, v2 is the published pointer",
        rows[0].status == "superseded" && rows[1].status == "published", JSON.stringify(rows));

    const current = await candidateretention.policyAsync(w.org_id);
    _check("policyAsync resolves the published pointer, not a stale version",
        current.published === true && current.no_consent_days == 90 && current.version == 2);

    await _checkThrows("a negative day-count is refused", _ =>
        candidateretention.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            no_consent_days: -1, consent_days: 365, withdrawn_days: 90, step_up_verified: true}));

    // restore a known policy (180/730/180) for the rest of the suite's day-math to be legible
    await candidateretention.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
        no_consent_days: 180, consent_days: 730, withdrawn_days: 180, step_up_verified: true});
}

// ---------------------------------------------------------------------------
// per-outcome disposition
// ---------------------------------------------------------------------------

async function _testOutcomes(w) {
    LOG.console("\n per-outcome expiry\n");

    // rejected, no consent — anchored 200 days ago, 180-day window: expired
    const rejectedNoConsent = await _applyAndReject(w, "Rejected NoConsent", 200);
    const d1 = await candidateretention.candidateDispositionAsync(w.org_id, rejectedNoConsent.candidate_id);
    _check("rejected, no consent, past 180 days is eligible", d1.eligible === true, JSON.stringify(d1));

    // rejected, no consent, only 10 days ago: not yet
    const rejectedRecent = await _applyAndReject(w, "Rejected Recent", 10);
    const d2 = await candidateretention.candidateDispositionAsync(w.org_id, rejectedRecent.candidate_id);
    _check("rejected, no consent, within 180 days is not yet eligible", d2.eligible === false);

    // rejected 200 days ago, but consented 10 days ago — 24-month window anchored
    // on consent_retain_at, not the (long past) rejection date
    const rejectedConsented = await _applyAndReject(w, "Rejected Consented", 200);
    await dblayer.runCmdOrThrow("UPDATE candidate SET consent_retain=1, consent_retain_at=? WHERE candidate_id=?",
        [_now() - 10*DAY, rejectedConsented.candidate_id]);
    const d3 = await candidateretention.candidateDispositionAsync(w.org_id, rejectedConsented.candidate_id);
    _check("rejected-and-consented re-anchors on consent_retain_at, not the rejection date — not yet eligible",
        d3.eligible === false, JSON.stringify(d3));
    await dblayer.runCmdOrThrow("UPDATE candidate SET consent_retain_at=? WHERE candidate_id=?",
        [_now() - 800*DAY, rejectedConsented.candidate_id]);
    const d3b = await candidateretention.candidateDispositionAsync(w.org_id, rejectedConsented.candidate_id);
    _check("...and becomes eligible once 24 months have passed since that consent",
        d3b.eligible === true, JSON.stringify(d3b));

    // withdrawn 200 days ago, 180-day window: expired
    const withdrawn = await _applyOnly(w, "Withdrawn Candidate");
    await dblayer.runCmdOrThrow("UPDATE application SET withdrawn_at=? WHERE application_id=?",
        [_now() - 200*DAY, withdrawn.application_id]);
    const d4 = await candidateretention.candidateDispositionAsync(w.org_id, withdrawn.candidate_id);
    _check("withdrawn, past 180 days is eligible", d4.eligible === true);

    // hired — never eligible, regardless of how long ago
    const hired = await _applyOnly(w, "Hired Candidate");
    await _insertAcceptedOffer(w, hired.application_id, _now() - 400*DAY);
    const d5 = await candidateretention.candidateDispositionAsync(w.org_id, hired.candidate_id);
    _check("hired moves to the employee record — never eligible for this run", d5.eligible === false,
        JSON.stringify(d5));

    // still in process — not eligible
    const inProcess = await _applyOnly(w, "InProcess Candidate");
    const d6 = await candidateretention.candidateDispositionAsync(w.org_id, inProcess.candidate_id);
    _check("still in process (no outcome yet) is not eligible", d6.eligible === false);

    w._fixtures = {rejectedNoConsent, rejectedRecent, rejectedConsented, withdrawn, hired, inProcess};
}

// ---------------------------------------------------------------------------
// the run — preview then execute
// ---------------------------------------------------------------------------

async function _testRun(w) {
    LOG.console("\n the retention run: preview, then execute\n");
    const preview = await candidateretention.previewRetentionRunAsync(w.org_id, w.carol);
    const eligibleIds = preview.eligible.map(c => c.candidate_id);
    _check("preview lists exactly the three truly-eligible candidates (no-consent-expired, consented-expired, withdrawn)",
        eligibleIds.includes(w._fixtures.rejectedNoConsent.candidate_id) &&
        eligibleIds.includes(w._fixtures.rejectedConsented.candidate_id) &&
        eligibleIds.includes(w._fixtures.withdrawn.candidate_id) &&
        eligibleIds.length == 3, JSON.stringify(eligibleIds));
    _check("preview excludes the not-yet-expired, hired and in-process candidates",
        !eligibleIds.includes(w._fixtures.rejectedRecent.candidate_id) &&
        !eligibleIds.includes(w._fixtures.hired.candidate_id) &&
        !eligibleIds.includes(w._fixtures.inProcess.candidate_id));

    const result = await candidateretention.executeRetentionRunAsync({org_id: w.org_id, actor_person_id: w.dave});
    _check("execute erases exactly the three eligible candidates", result.erased_count == 3, JSON.stringify(result));

    const gone = await dblayer.getQueryOrThrow("SELECT candidate_id FROM candidate WHERE org_id=? AND candidate_id IN (?,?,?)",
        [w.org_id, w._fixtures.rejectedNoConsent.candidate_id, w._fixtures.rejectedConsented.candidate_id,
            w._fixtures.withdrawn.candidate_id]);
    _check("the three erased candidates' rows are actually gone", gone.length == 0);
    const goneApplications = await dblayer.getQueryOrThrow(
        "SELECT application_id FROM application WHERE org_id=? AND application_id=?",
        [w.org_id, w._fixtures.withdrawn.application_id]);
    _check("their applications are gone too, not just the candidate row", goneApplications.length == 0);

    const untouched = await dblayer.getQueryOrThrow("SELECT candidate_id FROM candidate WHERE org_id=? AND candidate_id IN (?,?,?)",
        [w.org_id, w._fixtures.rejectedRecent.candidate_id, w._fixtures.hired.candidate_id,
            w._fixtures.inProcess.candidate_id]);
    _check("the not-yet-expired, hired and in-process candidates are completely untouched", untouched.length == 3);

    const runRow = (await dblayer.getQueryOrThrow(
        "SELECT * FROM candidate_retention_run WHERE org_id=? AND run_id=?", [w.org_id, result.run_id]))[0];
    _check("one candidate_retention_run row was inserted with the right erased_count", runRow?.erased_count == 3);

    const auditRow = (await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='candidate_retention.executed' AND object_ref=?",
        [w.org_id, result.run_id]))[0];
    _check("exactly one audit entry was written for the run, pointing at the run row",
        auditRow && auditRow.actor_person_id == w.dave);

    const rerun = await candidateretention.previewRetentionRunAsync(w.org_id, w.carol);
    _check("re-previewing afterwards finds nobody left due", rerun.eligible.length == 0, JSON.stringify(rerun.eligible));
}

// ---------------------------------------------------------------------------
// candidate.read audit coverage
// ---------------------------------------------------------------------------

async function _testAccessAudit(w) {
    LOG.console("\n every access to a candidate record is audited\n");
    const before = await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS n FROM audit_event WHERE org_id=? AND action='candidate.accessed'", [w.org_id]);
    await recruitment.candidateRecordAsync(w.org_id, w.carol, w._fixtures.inProcess.application_id);
    const after = await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS n FROM audit_event WHERE org_id=? AND action='candidate.accessed'", [w.org_id]);
    _check("reading a candidate record writes one candidate.accessed audit entry",
        after[0].n == before[0].n + 1);
}

// ---------------------------------------------------------------------------
// K12 slice 2 — a candidate's own self-service deletion request
// ---------------------------------------------------------------------------

async function _testDeletionRequests(w) {
    LOG.console("\n candidate deletion requests — decide, don't just track\n");

    await _checkThrows("an employee cannot read the deletion-request queue", _ =>
        candidateretention.pendingDeletionRequestsAsync(w.org_id, w.alice));

    const declineMe = await _applyOnly(w, "DeclineMe Candidate");
    const link1 = await recruitment.generatePortalLinkAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: declineMe.application_id});
    await recruitment.portalRequestDeletionAsync({token: link1.token, reason: "Changed my mind."});

    const queue = await candidateretention.pendingDeletionRequestsAsync(w.org_id, w.carol);
    _check("the pending request shows up in the queue", queue.requests.some(r =>
        r.application_id == declineMe.application_id && r.reason == "Changed my mind."), JSON.stringify(queue.requests));

    await _checkThrows("a decline with no reason is refused", _ =>
        candidateretention.decideCandidateDeletionRequestAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: declineMe.application_id, decision: "declined"}));

    const declined = await candidateretention.decideCandidateDeletionRequestAsync({org_id: w.org_id,
        actor_person_id: w.carol, application_id: declineMe.application_id, decision: "declined",
        decision_reason: "Still want you to go forward."});
    _check("decline is recorded", declined.status == "declined");

    const stillThere = (await dblayer.getQueryOrThrow("SELECT 1 FROM candidate WHERE org_id=? AND candidate_id=?",
        [w.org_id, declineMe.candidate_id]))[0];
    _check("a decline resumes the candidate — nothing was erased", Boolean(stillThere));
    const resumedLegal = await recruitment.legalActionsAsync(w.org_id, w.carol, declineMe.application_id);
    _check("the application resumes normal engine behaviour once declined",
        resumedLegal.terminal === undefined || resumedLegal.terminal === null, JSON.stringify(resumedLegal));

    const queueAfterDecline = await candidateretention.pendingDeletionRequestsAsync(w.org_id, w.carol);
    _check("the declined request no longer shows up in the queue",
        !queueAfterDecline.requests.some(r => r.application_id == declineMe.application_id));

    // approve — this one actually erases, across every application the candidate has
    const approveMe = await _applyOnly(w, "ApproveMe Candidate");
    const link2 = await recruitment.generatePortalLinkAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: approveMe.application_id});
    await recruitment.portalRequestDeletionAsync({token: link2.token, reason: "Please delete me."});

    await _checkThrows("an employee cannot decide a deletion request", _ =>
        candidateretention.decideCandidateDeletionRequestAsync({org_id: w.org_id, actor_person_id: w.alice,
            application_id: approveMe.application_id, decision: "approved"}));

    const approved = await candidateretention.decideCandidateDeletionRequestAsync({org_id: w.org_id,
        actor_person_id: w.carol, application_id: approveMe.application_id, decision: "approved"});
    _check("approval is recorded", approved.status == "approved");

    const gone = (await dblayer.getQueryOrThrow("SELECT 1 FROM candidate WHERE org_id=? AND candidate_id=?",
        [w.org_id, approveMe.candidate_id]))[0];
    _check("approving actually erases the candidate", !gone);
    const applicationGone = (await dblayer.getQueryOrThrow(
        "SELECT 1 FROM application WHERE org_id=? AND application_id=?", [w.org_id, approveMe.application_id]))[0];
    _check("and their application too", !applicationGone);

    const approveAuditRow = (await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='candidate.erased' AND object_ref=?",
        [w.org_id, approveMe.candidate_id]))[0];
    _check("the approval is audited under candidate.erased, naming the candidate", Boolean(approveAuditRow),
        JSON.stringify(approveAuditRow));

    await _checkThrows("deciding an already-decided request is refused", _ =>
        candidateretention.decideCandidateDeletionRequestAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: declineMe.application_id, decision: "approved"}));
}

// ---------------------------------------------------------------------------

/** Applies to the shared requisition, backdates the application, and leaves it in_process. */
async function _applyOnly(w, name) {
    const application = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: w.requisition_id, full_name: name, email: `${name.replace(/\s+/g, ".").toLowerCase()}.${w.stamp}@example.invalid`});
    return {candidate_id: application.candidate_id, application_id: application.application_id};
}

/** Applies, then injects a backdated 'rejected' stage_transition directly. */
async function _applyAndReject(w, name, daysAgo) {
    const applied = await _applyOnly(w, name);
    await dblayer.runCmdOrThrow(
        `INSERT INTO stage_transition (stage_transition_id, org_id, application_id, round_id, kind,
            actor_person_id, occurred_at) VALUES (?,?,?,?,?,?,?)`,
        [`${w.stamp}-${name}-rej`, w.org_id, applied.application_id, "r1", "rejected", w.carol, _now() - daysAgo*DAY]);
    return applied;
}

async function _insertAcceptedOffer(w, application_id, respondedAt) {
    await dblayer.runCmdOrThrow(
        `INSERT INTO offer_version (offer_version_id, org_id, application_id, version, status,
            fixed_amount, start_date, expires_on, required_approvals, offered_by, created_at, responded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`${w.stamp}-${application_id}-offer`, w.org_id, application_id, 1, "accepted",
            500000, "2026-01-01", "2026-02-01", 1, w.carol, respondedAt, respondedAt]);
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Candidate retention test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "carol", "dave"])
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "GB",
        contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const [who, role] of [["alice", "employee"], ["carol", "hr"], ["dave", "admin"]])
        await permissions.assignRoleAsync(org.org_id, people[who].person_id, role, from);

    await recruitment.publishWorkflowAsync({org_id: org.org_id, actor_person_id: people.carol.person_id,
        workflow_code: `wf-${stamp}`, title: "Test role", job_family: "Engineering", rounds: _rounds()});
    const requisition = await recruitment.raiseRequisitionAsync({org_id: org.org_id, actor_person_id: people.carol.person_id,
        title: "Test requisition", team: "Platform", positions: 1, req_type: "backfill",
        target_start: new Date(Date.now() + 60*DAY*1000).toISOString().substring(0, 10), workflow_code: `wf-${stamp}`});
    await recruitment.approveRequisitionAsync({org_id: org.org_id, actor_person_id: people.dave.person_id,
        requisition_id: requisition.requisition_id});

    return {org_id: org.org_id, stamp, requisition_id: requisition.requisition_id,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["candidate_retention_run", "candidate_retention_policy_version",
        "candidate_retention_policy_pointer", "offer_approval", "offer_version", "candidate_portal_link",
        "panel_assignment", "scorecard", "stage_transition", "application", "candidate", "requisition",
        "workflow_pointer", "workflow_version", "role_capability", "role", "capability_grant", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "carol", "dave"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
