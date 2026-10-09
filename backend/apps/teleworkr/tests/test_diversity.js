/**
 * Tests K12 slice 3 — diversity data (collected optionally, stored apart)
 * and the HR-only, group-size-suppressed adverse-impact report.
 *
 * Stage transitions are injected directly via raw SQL, not driven through
 * the live legal-transition engine — this suite tests diversity.js's own
 * per-round/per-group aggregation, which itself deliberately reads raw
 * stage_transition rows rather than depending on recruitment.js's private
 * conditional/parallel-round engine (same choice candidateretention.js's
 * own outcome detection already made in slice 1). Round-by-round engine
 * correctness is test_recruitment.js's job, not this file's.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests diversity
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const recruitment = require(`${TELEWORKR_CONSTANTS.LIBDIR}/recruitment.js`);
const candidateretention = require(`${TELEWORKR_CONSTANTS.LIBDIR}/candidateretention.js`);
const diversity = require(`${TELEWORKR_CONSTANTS.LIBDIR}/diversity.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Diversity test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 120)}`, true);}
}

const _now = () => Math.floor(Date.now()/1000);
const _rounds = () => [{id: "r1", title: "Resume review", round_type: "resume_review", sequence: 1,
    owner_role: "recruiter", sla_days: 2, scorecard_criteria: []},
    {id: "r2", title: "Final", round_type: "final", sequence: 2, owner_role: "recruiter",
        sla_days: 2, scorecard_criteria: []}];

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "diversity")) {
        LOG.console("Skipping diversity test case, not called.\n"); return true;
    }
    LOG.console("\nK12 slice 3 — diversity data & adverse-impact reporting\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testPortalSelfService(w);
        await _testGate(w);
        await _testAdverseImpact(w);
        await _testErasureIncludesDiversityData(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  diversity tests threw: ${err}\n`); LOG.error(`Diversity tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nDiversity tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------

async function _testPortalSelfService(w) {
    LOG.console("\n self-service — collected optionally, correctable\n");
    const applied = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: w.requisition_id, full_name: "Portal Diversity Test", email: `portaldiv.${w.stamp}@example.invalid`});
    const link = await recruitment.generatePortalLinkAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applied.application_id});

    const blank = await diversity.portalGetDiversityAsync(link.token);
    _check("nothing submitted yet reads back as all-null", blank.gender === null && blank.ethnicity === null &&
        blank.disability_status === null, JSON.stringify(blank));

    await _checkThrows("an invalid gender value is refused", _ =>
        diversity.portalSetDiversityAsync({token: link.token, gender: "not-a-real-option"}));

    await diversity.portalSetDiversityAsync({token: link.token, gender: "woman", disability_status: "no",
        ethnicity: "Example"});
    const first = await diversity.portalGetDiversityAsync(link.token);
    _check("each field round-trips", first.gender == "woman" && first.disability_status == "no" &&
        first.ethnicity == "Example", JSON.stringify(first));

    await diversity.portalSetDiversityAsync({token: link.token, gender: "prefer_not_to_say"});
    const corrected = await diversity.portalGetDiversityAsync(link.token);
    _check("re-submitting corrects rather than duplicating — one row per candidate",
        corrected.gender == "prefer_not_to_say" && corrected.ethnicity === null, JSON.stringify(corrected));
    const rows = await dblayer.getQueryOrThrow("SELECT COUNT(*) AS n FROM candidate_diversity_data WHERE org_id=? AND candidate_id=?",
        [w.org_id, applied.candidate_id]);
    _check("confirmed only one row exists for this candidate", rows[0].n == 1);
}

async function _testGate(w) {
    LOG.console("\n reported to HR only, read literally\n");
    await _checkThrows("an employee cannot read the adverse-impact report", _ =>
        diversity.adverseImpactAsync(w.org_id, w.alice, {workflow_code: w.workflow_code, dimension: "gender"}));
    await _checkThrows("admin cannot either — hr only, deliberately narrower than the usual aggregate grant", _ =>
        diversity.adverseImpactAsync(w.org_id, w.dave, {workflow_code: w.workflow_code, dimension: "gender"}));
    await _checkThrows("an invalid dimension is refused", _ =>
        diversity.adverseImpactAsync(w.org_id, w.carol, {workflow_code: w.workflow_code, dimension: "not-a-field"}));
}

/**
 * 5 "woman" candidates: 4 evaluated+advanced at r1 (1 rejected at r1); of
 * those 4, 2 reach and advance r2 (hired), 2 reach and get rejected at r2.
 * 5 "man" candidates: all 5 advance r1; of those, 1 advances r2 (hired), 4
 * are rejected at r2. 2 "non_binary" candidates — below the minimum group
 * size, must be entirely suppressed. 1 candidate with no diversity data at
 * all — must be excluded from the report, not folded into any group.
 */
async function _testAdverseImpact(w) {
    LOG.console("\n per-round pass rates and the 4/5ths selection-rate ratio\n");

    const woman = [];
    for (let i = 0; i < 5; i++) woman.push(await _candidateWithGender(w, `Woman ${i}`, "woman"));
    await _transition(w, woman[0].application_id, "r1", "rejected");
    for (let i = 1; i < 5; i++) await _transition(w, woman[i].application_id, "r1", "advanced");
    await _transition(w, woman[1].application_id, "r2", "advanced");
    await _offer(w, woman[1].application_id, "accepted");
    await _transition(w, woman[2].application_id, "r2", "advanced");
    await _offer(w, woman[2].application_id, "accepted");
    await _transition(w, woman[3].application_id, "r2", "rejected");
    await _transition(w, woman[4].application_id, "r2", "rejected");

    const man = [];
    for (let i = 0; i < 5; i++) man.push(await _candidateWithGender(w, `Man ${i}`, "man"));
    for (let i = 0; i < 5; i++) await _transition(w, man[i].application_id, "r1", "advanced");
    await _transition(w, man[0].application_id, "r2", "advanced");
    await _offer(w, man[0].application_id, "accepted");
    for (let i = 1; i < 5; i++) await _transition(w, man[i].application_id, "r2", "rejected");

    const tooSmall = [];
    for (let i = 0; i < 2; i++) tooSmall.push(await _candidateWithGender(w, `NB ${i}`, "non_binary"));
    for (const c of tooSmall) await _transition(w, c.application_id, "r1", "advanced");

    await _applyOnly(w, "No Diversity Data");   // never calls portalSetDiversityAsync at all

    const report = await diversity.adverseImpactAsync(w.org_id, w.carol,
        {workflow_code: w.workflow_code, dimension: "gender"});

    _check("the too-small non_binary group is entirely suppressed",
        !report.overall.some(o => o.group == "non_binary") &&
        !report.rounds.some(round => round.groups.some(g => g.group == "non_binary")),
        JSON.stringify(report));
    // 2, not 1: non_binary (2 candidates) plus prefer_not_to_say — the earlier
    // self-service test's own candidate shares this same requisition/workflow
    // and left behind a single prefer_not_to_say row, also below the minimum.
    _check("suppressed_group_count reports both omitted groups (non_binary and prefer_not_to_say)",
        report.suppressed_group_count == 2, JSON.stringify(report.suppressed_group_count));

    const r1 = report.rounds.find(r => r.round_id == "r1");
    const r1woman = r1.groups.find(g => g.group == "woman"), r1man = r1.groups.find(g => g.group == "man");
    _check("r1: woman evaluated 5, passed 4", r1woman.evaluated == 5 && r1woman.passed == 4, JSON.stringify(r1woman));
    _check("r1: man evaluated 5, passed 5 (pass_rate 1.0)", r1man.evaluated == 5 && r1man.passed == 5 &&
        r1man.pass_rate == 1, JSON.stringify(r1man));

    const r2 = report.rounds.find(r => r.round_id == "r2");
    const r2woman = r2.groups.find(g => g.group == "woman"), r2man = r2.groups.find(g => g.group == "man");
    _check("r2: woman evaluated 4, passed 2", r2woman.evaluated == 4 && r2woman.passed == 2, JSON.stringify(r2woman));
    _check("r2: man evaluated 5, passed 1", r2man.evaluated == 5 && r2man.passed == 1, JSON.stringify(r2man));

    const overallWoman = report.overall.find(o => o.group == "woman"), overallMan = report.overall.find(o => o.group == "man");
    _check("overall: woman selection rate is 2/5 = 0.4", overallWoman.applied == 5 && overallWoman.hired == 2 &&
        overallWoman.selection_rate == 0.4, JSON.stringify(overallWoman));
    _check("overall: man selection rate is 1/5 = 0.2", overallMan.applied == 5 && overallMan.hired == 1 &&
        overallMan.selection_rate == 0.2, JSON.stringify(overallMan));
    _check("woman has the higher rate, so its own impact_ratio is 1.0 and it is not flagged",
        overallWoman.impact_ratio == 1 && overallWoman.adverse_impact === false, JSON.stringify(overallWoman));
    _check("man's ratio (0.2/0.4 = 0.5) is below the 4/5ths threshold and is flagged",
        overallMan.impact_ratio == 0.5 && overallMan.adverse_impact === true, JSON.stringify(overallMan));

    _check("the response never names a candidate anywhere",
        !/candidate_id|full_name/i.test(JSON.stringify(report)), JSON.stringify(report));

    const auditRow = (await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='diversity.aggregate_read' AND object_ref=?",
        [w.org_id, w.workflow_code]))[0];
    _check("reading the report writes one diversity.aggregate_read audit entry", Boolean(auditRow) && auditRow.actor_person_id == w.carol);

    w._fixtures = {probe: woman[0]};
}

async function _testErasureIncludesDiversityData(w) {
    LOG.console("\n erasure includes diversity data — easy to forget, not forgotten\n");
    const candidate_id = w._fixtures.probe.candidate_id;
    const before = (await dblayer.getQueryOrThrow("SELECT 1 FROM candidate_diversity_data WHERE org_id=? AND candidate_id=?",
        [w.org_id, candidate_id]))[0];
    _check("the probe candidate really does have a diversity row before erasure", Boolean(before));

    const link = await recruitment.generatePortalLinkAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: w._fixtures.probe.application_id});
    await recruitment.portalRequestDeletionAsync({token: link.token, reason: "test erasure"});
    await candidateretention.decideCandidateDeletionRequestAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: w._fixtures.probe.application_id, decision: "approved"});

    const after = (await dblayer.getQueryOrThrow("SELECT 1 FROM candidate_diversity_data WHERE org_id=? AND candidate_id=?",
        [w.org_id, candidate_id]))[0];
    _check("the diversity row is gone too, not just the candidate/application rows", !after);
}

// ---------------------------------------------------------------------------

async function _applyOnly(w, name) {
    const application = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: w.requisition_id, full_name: name, email: `${name.replace(/\s+/g, ".").toLowerCase()}.${w.stamp}@example.invalid`});
    return {candidate_id: application.candidate_id, application_id: application.application_id};
}

async function _candidateWithGender(w, name, gender) {
    const applied = await _applyOnly(w, name);
    const link = await recruitment.generatePortalLinkAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applied.application_id});
    await diversity.portalSetDiversityAsync({token: link.token, gender});
    return applied;
}

async function _transition(w, application_id, round_id, kind) {
    await dblayer.runCmdOrThrow(
        `INSERT INTO stage_transition (stage_transition_id, org_id, application_id, round_id, kind, actor_person_id, occurred_at)
            VALUES (?,?,?,?,?,?,?)`,
        [`${w.stamp}-${application_id}-${round_id}`, w.org_id, application_id, round_id, kind, w.carol, _now()]);
}

async function _offer(w, application_id, status) {
    await dblayer.runCmdOrThrow(
        `INSERT INTO offer_version (offer_version_id, org_id, application_id, version, status,
            fixed_amount, start_date, expires_on, required_approvals, offered_by, created_at, responded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [`${w.stamp}-${application_id}-offer`, w.org_id, application_id, 1, status,
            500000, "2026-01-01", "2026-02-01", 1, w.carol, _now(), _now()]);
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Diversity test ${stamp}`, home_jurisdiction: "GB"});
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

    const workflow_code = `wf-div-${stamp}`;
    await recruitment.publishWorkflowAsync({org_id: org.org_id, actor_person_id: people.carol.person_id,
        workflow_code, title: "Diversity test role", job_family: "Engineering", rounds: _rounds()});
    const requisition = await recruitment.raiseRequisitionAsync({org_id: org.org_id, actor_person_id: people.carol.person_id,
        title: "Diversity test requisition", team: "Platform", positions: 5, req_type: "backfill",
        target_start: new Date(Date.now() + 60*86400*1000).toISOString().substring(0, 10), workflow_code});
    await recruitment.approveRequisitionAsync({org_id: org.org_id, actor_person_id: people.dave.person_id,
        requisition_id: requisition.requisition_id});

    return {org_id: org.org_id, stamp, workflow_code, requisition_id: requisition.requisition_id,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["candidate_diversity_data", "offer_approval", "offer_version", "candidate_portal_link",
        "panel_assignment", "scorecard", "stage_transition", "application", "candidate", "requisition",
        "workflow_pointer", "workflow_version", "candidate_retention_run", "candidate_retention_policy_version",
        "candidate_retention_policy_pointer", "role_capability", "role", "capability_grant", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "carol", "dave"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
