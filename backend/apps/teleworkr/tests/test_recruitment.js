/**
 * Tests K — the recruitment domain, Phase 1: the pipeline core. The engine
 * is the thing worth being paranoid about — status is projected over an
 * append-only event log, never stored, across a graph with parallel rounds
 * and score-conditioned rounds, not a line. These tests walk that graph
 * both ways: a candidate whose conditional round triggers, and one whose
 * doesn't, plus rejection, hold, and the "invisible until submitted"
 * scorecard rule.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests recruitment
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const recruitment = require(`${TELEWORKR_CONSTANTS.LIBDIR}/recruitment.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Recruitment test failed: ${label} ${detail||""}`);}
}

const _today = () => new Date().toISOString().substring(0, 10);
const _inDays = days => new Date(Date.now() + days*86400000).toISOString().substring(0, 10);

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 100)}`, true);}
}

// r1 (seq 1, no scorecard) -> r2a + r2b in parallel (seq 2, both scored) ->
// r3 conditional on r2b's score (seq 3, scored) -> r4 (seq 4, no scorecard)
// sla_days (K11): each round's declared target, unused by anything until K11
// reads it back for adherence reporting — present here so that report has
// something real to measure across every test that walks this workflow.
const _rounds = () => [
    {id: "r1", title: "Resume review", round_type: "resume_review", sequence: 1, owner_role: "recruiter",
        sla_days: 2, scorecard_criteria: []},
    {id: "r2a", title: "HR screening", round_type: "hr_screen", sequence: 2, parallel_group: "p2",
        owner_role: "recruiter", sla_days: 2, scorecard_criteria: [{id: "c1", label: "Communication"}]},
    {id: "r2b", title: "Logical assessment", round_type: "aptitude_test", sequence: 2, parallel_group: "p2",
        owner_role: "system", sla_days: 3, scorecard_criteria: [{id: "c1", label: "Score"}]},
    {id: "r3", title: "Technical L3", round_type: "technical", sequence: 3, owner_role: "principal_engineer",
        condition: {round_id: "r2b", operator: "<", value: 3}, sla_days: 2,
        scorecard_criteria: [{id: "c1", label: "Depth"}]},
    {id: "r4", title: "HR final", round_type: "hr_final", sequence: 4, owner_role: "recruiter",
        sla_days: 2, scorecard_criteria: []}
];

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "recruitment")) {
        LOG.console("Skipping recruitment test case, not called.\n"); return true;
    }
    LOG.console("\nK recruitment\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testPublishValidation(w);
        const workflow = await _testPublish(w);
        const requisition = await _testRequisition(w, workflow);
        await _testFullWalkConditionTriggers(w, requisition);
        await _testFullWalkConditionSkipped(w, requisition);
        await _testRejectionAndHold(w, requisition);
        await _testScorecardVisibility(w, requisition);
        await _testCapabilityRefusals(w, requisition);
        await _testIdempotency(w, requisition);
        await _testPanelScheduling(w, requisition);
        await _testOffers(w, workflow);
        await _testAnalytics(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  recruitment tests threw: ${err}\n`); LOG.error(`Recruitment tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nRecruitment tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

/** K1/K2: publish validation refuses what the engine could never execute. */
async function _testPublishValidation(w) {
    LOG.console("\n publish validation\n");
    await _checkThrows("a round with no owner is refused",
        _ => recruitment.publishWorkflowAsync({org_id: w.org_id, actor_person_id: w.carol,
            workflow_code: "no-owner", title: "No owner", rounds: [{id: "a", title: "A", sequence: 1}]}));
    await _checkThrows("an optional round with no skip_role is refused",
        _ => recruitment.publishWorkflowAsync({org_id: w.org_id, actor_person_id: w.carol,
            workflow_code: "no-skip-role", title: "No skip role",
            rounds: [{id: "a", title: "A", sequence: 1, owner_role: "recruiter", optional: true}]}));
    await _checkThrows("a condition referencing a later round is refused",
        _ => recruitment.publishWorkflowAsync({org_id: w.org_id, actor_person_id: w.carol,
            workflow_code: "forward-condition", title: "Forward condition",
            rounds: [
                {id: "a", title: "A", sequence: 1, owner_role: "recruiter",
                    condition: {round_id: "b", operator: "<", value: 3}},
                {id: "b", title: "B", sequence: 2, owner_role: "recruiter"}]}));
    await _checkThrows("an employee cannot publish a workflow",
        _ => recruitment.publishWorkflowAsync({org_id: w.org_id, actor_person_id: w.alice,
            workflow_code: "employee-attempt", title: "Employee attempt", rounds: _rounds()}));
}

/** K1/K2: a well-formed workflow publishes and versions correctly. */
async function _testPublish(w) {
    LOG.console("\n publishing a workflow\n");
    const v1 = await recruitment.publishWorkflowAsync({org_id: w.org_id, actor_person_id: w.carol,
        workflow_code: "swe-hiring", title: "Software engineer", job_family: "Engineering", rounds: _rounds()});
    _check("publishing v1 returns version 1", v1.version == 1, JSON.stringify(v1));

    const v2 = await recruitment.publishWorkflowAsync({org_id: w.org_id, actor_person_id: w.carol,
        workflow_code: "swe-hiring", title: "Software engineer", job_family: "Engineering", rounds: _rounds()});
    _check("republishing supersedes rather than editing v1", v2.version == 2);
    const rows = await dblayer.getQueryOrThrow(
        "SELECT status FROM workflow_version WHERE org_id=? AND workflow_code='swe-hiring' ORDER BY version",
        [w.org_id]);
    _check("v1 is superseded, v2 is the published pointer",
        rows[0].status == "superseded" && rows[1].status == "published", JSON.stringify(rows));

    const list = await recruitment.workflowsAsync(w.org_id, w.carol);
    _check("the workflow list shows only the current version",
        list.workflows.find(wf => wf.workflow_code == "swe-hiring")?.version == 2, JSON.stringify(list.workflows));
    return list.workflows.find(wf => wf.workflow_code == "swe-hiring");
}

/** K3: raise, approve, and the SOD rule already wired to requisition.approve. */
async function _testRequisition(w) {
    LOG.console("\n requisition & approval\n");
    await _checkThrows("a requisition against an unpublished workflow is refused",
        _ => recruitment.raiseRequisitionAsync({org_id: w.org_id, actor_person_id: w.carol,
            title: "Ghost role", target_start: _inDays(60), workflow_code: "nope"}));

    const requisition = await recruitment.raiseRequisitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        title: "Senior Frontend Engineer", team: "Platform", positions: 2, req_type: "backfill",
        target_start: _inDays(60), workflow_code: "swe-hiring"});
    _check("raising pins the workflow's current published version",
        requisition.status == "pending_approval" && requisition.workflow_code == "swe-hiring",
        JSON.stringify(requisition));

    await _checkThrows("the raiser cannot approve their own requisition (sod.self_approval)",
        _ => recruitment.approveRequisitionAsync({org_id: w.org_id, actor_person_id: w.carol,
            requisition_id: requisition.requisition_id}));
    await _checkThrows("an employee cannot approve a requisition",
        _ => recruitment.approveRequisitionAsync({org_id: w.org_id, actor_person_id: w.alice,
            requisition_id: requisition.requisition_id}));
    await _checkThrows("candidates cannot be added before approval",
        _ => recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
            requisition_id: requisition.requisition_id, full_name: "Too Early", email: `early.${w.stamp}@example.invalid`}));

    const approved = await recruitment.approveRequisitionAsync({org_id: w.org_id, actor_person_id: w.dave,
        requisition_id: requisition.requisition_id});
    _check("a different approver succeeds", approved.status == "approved");

    return requisition;
}

/** The engine, walked with the conditional round triggering (low r2b score). */
async function _testFullWalkConditionTriggers(w, requisition) {
    LOG.console("\n the engine — conditional round triggers on a low score\n");

    const applied = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: requisition.requisition_id, full_name: "Asha Rao",
        email: `asha.${w.stamp}@example.invalid`, source: "referral", referrer_person_id: w.bob});
    const applicationId = applied.application_id;

    let legal = await recruitment.legalActionsAsync(w.org_id, w.carol, applicationId);
    _check("a fresh application starts at the first round, no scorecard needed",
        legal.current_rounds.length == 1 && legal.current_rounds[0].round_id == "r1" &&
        legal.current_rounds[0].actions.find(a => a.action == "advance").legal === true,
        JSON.stringify(legal.current_rounds));

    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r1", kind: "advanced"});
    legal = await recruitment.legalActionsAsync(w.org_id, w.carol, applicationId);
    _check("advancing r1 opens both parallel rounds at once",
        legal.current_rounds.length == 2 &&
        legal.current_rounds.every(r => ["r2a", "r2b"].includes(r.round_id)), JSON.stringify(legal.current_rounds));
    _check("a scored round cannot advance without a submitted scorecard",
        legal.current_rounds.find(r => r.round_id == "r2a").actions.find(a => a.action == "advance").legal === false);

    await _checkThrows("advancing r2a without a scorecard is refused by the engine",
        _ => recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: applicationId, round_id: "r2a", kind: "advanced"}));

    await recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r2a", criteria_ratings: [{criterion_id: "c1", rating: 4}],
        recommendation: "yes"});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r2a", kind: "advanced"});

    legal = await recruitment.legalActionsAsync(w.org_id, w.carol, applicationId);
    _check("the parallel group does not clear until BOTH rounds resolve",
        legal.current_rounds.length == 1 && legal.current_rounds[0].round_id == "r2b", JSON.stringify(legal.current_rounds));

    // a low logical-assessment score (avg 2) triggers the r3 condition (<3) —
    // a rating this low needs 80+ characters of evidence
    await recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.dave,
        application_id: applicationId, round_id: "r2b", criteria_ratings: [{criterion_id: "c1", rating: 2}],
        recommendation: "lean_yes",
        evidence: "Solved only two of the five logic puzzles within the time limit, and needed a hint to get started on a third."});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.dave,
        application_id: applicationId, round_id: "r2b", kind: "advanced"});

    legal = await recruitment.legalActionsAsync(w.org_id, w.carol, applicationId);
    _check("a low score on r2b opens the conditional round r3",
        legal.current_rounds.length == 1 && legal.current_rounds[0].round_id == "r3", JSON.stringify(legal.current_rounds));

    // hold r3, confirm it surfaces as held with the review date, then supersede
    // the hold with a real transition once the scorecard is in
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r3", kind: "held", reason: "Waiting on panel availability",
        review_date: _inDays(5)});
    legal = await recruitment.legalActionsAsync(w.org_id, w.carol, applicationId);
    _check("a hold surfaces with its review date, and blocks nothing else from being legal later",
        legal.current_rounds[0].state == "held" && legal.current_rounds[0].review_date == _inDays(5),
        JSON.stringify(legal.current_rounds));

    await recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r3", criteria_ratings: [{criterion_id: "c1", rating: 4}],
        recommendation: "yes"});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r3", kind: "advanced"});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r4", kind: "advanced"});

    legal = await recruitment.legalActionsAsync(w.org_id, w.carol, applicationId);
    _check("passing the final round completes the application",
        legal.terminal?.kind == "completed", JSON.stringify(legal.terminal));
}

/** The engine, walked with the conditional round skipped (high r2b score). */
async function _testFullWalkConditionSkipped(w, requisitionArg) {
    LOG.console("\n the engine — conditional round auto-skips on a high score\n");
    const applied = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: requisitionArg.requisition_id, full_name: "Deepak Nair",
        email: `deepak.${w.stamp}@example.invalid`, source: "job_board"});
    const applicationId = applied.application_id;

    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r1", kind: "advanced"});
    await recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r2a", criteria_ratings: [{criterion_id: "c1", rating: 5}],
        recommendation: "strong_yes",
        evidence: "Answered every question fluently and anticipated the follow-up before it was asked."});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r2a", kind: "advanced"});
    // a HIGH logical-assessment score (5) does NOT satisfy r3's condition (<3)
    await recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.dave,
        application_id: applicationId, round_id: "r2b", criteria_ratings: [{criterion_id: "c1", rating: 5}],
        recommendation: "strong_yes",
        evidence: "Finished all five logic puzzles well inside the time limit with no hints needed."});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.dave,
        application_id: applicationId, round_id: "r2b", kind: "advanced"});

    const legal = await recruitment.legalActionsAsync(w.org_id, w.carol, applicationId);
    _check("a high score on r2b skips the conditional round r3 entirely, landing straight on r4",
        legal.current_rounds.length == 1 && legal.current_rounds[0].round_id == "r4", JSON.stringify(legal.current_rounds));

    const board = await recruitment.pipelineBoardAsync(w.org_id, w.carol, requisitionArg.requisition_id);
    const r3Column = board.columns.find(c => c.round_id == "r3");
    _check("the board never shows a condition-skipped round as having a card in it",
        r3Column && r3Column.cards.length == 0, JSON.stringify(r3Column));
}

/** Rejection is terminal at any round, and ends further transitions. */
async function _testRejectionAndHold(w, requisitionArg) {
    LOG.console("\n rejection is terminal\n");
    const applied = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: requisitionArg.requisition_id, full_name: "Rejected Candidate",
        email: `rejected.${w.stamp}@example.invalid`});
    const applicationId = applied.application_id;

    await _checkThrows("a hold with no reason is refused",
        _ => recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: applicationId, round_id: "r1", kind: "held", review_date: _inDays(3)}));
    await _checkThrows("a hold with no review date is refused — that is how pipelines rot",
        _ => recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: applicationId, round_id: "r1", kind: "held", reason: "Waiting"}));

    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r1", kind: "rejected", reason: "role_fit"});

    const legal = await recruitment.legalActionsAsync(w.org_id, w.carol, applicationId);
    _check("rejection is terminal and names the round and reason",
        legal.terminal?.kind == "rejected" && legal.terminal.round_id == "r1" && legal.terminal.reason == "role_fit",
        JSON.stringify(legal.terminal));

    await _checkThrows("no further transition can be recorded once rejected",
        _ => recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: applicationId, round_id: "r1", kind: "advanced"}));

    const board = await recruitment.pipelineBoardAsync(w.org_id, w.carol, requisitionArg.requisition_id);
    _check("the board lists the rejection with its reason, not as a stuck card",
        board.rejected.some(r => r.application_id == applicationId && r.reason == "role_fit"),
        JSON.stringify(board.rejected));
}

/** K7 item 3: invisible until submitted. A fresh application, so r2a is a still-open round. */
async function _testScorecardVisibility(w, requisition) {
    LOG.console("\n scorecards — invisible until submitted\n");
    const applied = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: requisition.requisition_id,
        full_name: "Visibility Test", email: `visibility.${w.stamp}@example.invalid`});
    const appId = applied.application_id;
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appId, round_id: "r1", kind: "advanced"});

    await recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appId, round_id: "r2a", criteria_ratings: [{criterion_id: "c1", rating: 4}],
        recommendation: "yes", evidence: "Clear and structured answers throughout the screen."});

    const beforeOwnSubmit = await recruitment.candidateRecordAsync(w.org_id, w.dave, appId);
    const r2aBefore = beforeOwnSubmit.evaluations.find(e => e.round_id == "r2a");
    _check("before submitting their own, a second interviewer sees a count but not the content",
        r2aBefore.visible === false && r2aBefore.scorecard_count == 1 && r2aBefore.scorecards.length == 0,
        JSON.stringify(r2aBefore));

    await recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.dave,
        application_id: appId, round_id: "r2a", criteria_ratings: [{criterion_id: "c1", rating: 2}],
        recommendation: "no",
        evidence: "Struggled to clearly explain the reasoning behind two of the three answers given during the screen."});

    const afterOwnSubmit = await recruitment.candidateRecordAsync(w.org_id, w.dave, appId);
    const r2aAfter = afterOwnSubmit.evaluations.find(e => e.round_id == "r2a");
    _check("after submitting their own, the same interviewer sees both scorecards in full",
        r2aAfter.visible === true && r2aAfter.scorecards.length == 2, JSON.stringify(r2aAfter));

    await _checkThrows("resubmitting a scorecard for the same round is refused — it locks once submitted",
        _ => recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: appId, round_id: "r2a", criteria_ratings: [{criterion_id: "c1", rating: 3}],
            recommendation: "lean_yes"}));

    await _checkThrows("an extreme rating with thin evidence is refused",
        _ => recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: appId, round_id: "r2b", criteria_ratings: [{criterion_id: "c1", rating: 1}],
            recommendation: "strong_no", evidence: "Not good."}));
    const okScore = await recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appId, round_id: "r2b", criteria_ratings: [{criterion_id: "c1", rating: 1}],
        recommendation: "strong_no", evidence: "Could not solve the warm-up problem despite three separate hints, and the explanation for the approach taken did not follow from the question asked at all."});
    _check("an extreme rating with 80+ characters of evidence is accepted", Boolean(okScore.scorecard_id));
}

/** Capability refusals, beyond the ones already exercised inline above. */
async function _testCapabilityRefusals(w, requisition) {
    LOG.console("\n capability refusals\n");
    await _checkThrows("an employee cannot read the pipeline board",
        _ => recruitment.pipelineBoardAsync(w.org_id, w.alice, requisition.requisition_id));
    await _checkThrows("a lead holds no recruitment capability in Phase 1 (TEAM-scope plumbing deferred)",
        _ => recruitment.requisitionsAsync(w.org_id, w.bob));
}

/** client_event_id replay returns the same row rather than duplicating. */
async function _testIdempotency(w, requisition) {
    LOG.console("\n idempotency\n");
    const applied = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: requisition.requisition_id,
        full_name: "Idempotency Test", email: `idem.${w.stamp}@example.invalid`});
    const clientEventId = `idem-${w.stamp}-r1`;
    const first = await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applied.application_id, round_id: "r1", kind: "advanced", client_event_id: clientEventId});
    const replay = await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applied.application_id, round_id: "r1", kind: "advanced", client_event_id: clientEventId});
    _check("a replayed transition returns the stored event, not a duplicate",
        first.stage_transition_id == replay.stage_transition_id &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM stage_transition WHERE org_id=? AND client_event_id=?",
            [w.org_id, clientEventId]))[0].c == 1);
}

const _at = (dateISO, hour, minute = 0) =>
    Date.parse(`${dateISO}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`)/1000;

/**
 * K6: panels are checked against the E3 board with J6 leave wired in, never
 * refused on availability, and a completed panel's hours land in the time
 * ledger exactly once per interviewer.
 */
async function _testPanelScheduling(w, requisition) {
    LOG.console("\n K6 — panel scheduling\n");
    // carol and dave work 09:00–17:00 GMT every day; alice declares no window at all
    for (const who of ["carol", "dave"])
        await windows.setWindowAsync({org_id: w.org_id, person_id: w[who], timezone: "Etc/GMT",
            start_minute: 540, end_minute: 1020, days: [1,2,3,4,5,6,7], valid_from: "2026-01-01"});
    const leaveDay = _inDays(12);
    await dblayer.runCmdOrThrow(`INSERT INTO leave_request (leave_request_id, org_id, person_id,
            leave_type, from_date, to_date, days_requested, days_deducted, status, created_at, submitted_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [`lv-k6-${w.stamp}`, w.org_id, w.dave, "EL", leaveDay, leaveDay, 1, 1, "approved",
            Math.floor(Date.now()/1000), Math.floor(Date.now()/1000)]);

    const applied = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: requisition.requisition_id, full_name: "Panel Test",
        email: `panel.${w.stamp}@example.invalid`, timezone: "Asia/Kolkata",
        availability_notes: "Evenings after 18:30 IST, currently employed"});
    const applicationId = applied.application_id;

    await _checkThrows("an ambiguous timezone abbreviation is refused, even though ICU would accept it",
        _ => recruitment.updateCandidateAsync({org_id: w.org_id, actor_person_id: w.carol,
            candidate_id: applied.candidate_id, timezone: "IST"}));
    await recruitment.updateCandidateAsync({org_id: w.org_id, actor_person_id: w.carol,
        candidate_id: applied.candidate_id, timezone: "Europe/London", availability_notes: "Mornings"});
    const stored = (await dblayer.getQueryOrThrow(
        "SELECT timezone, availability_notes FROM candidate WHERE org_id=? AND candidate_id=?",
        [w.org_id, applied.candidate_id]))[0];
    _check("the candidate's timezone and availability are recorded on their behalf",
        stored.timezone == "Europe/London" && stored.availability_notes == "Mornings", JSON.stringify(stored));

    const day = _inDays(10);
    const fit = await recruitment.schedulePanelAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r1", interviewer_person_ids: [w.carol, w.dave],
        scheduled_start: _at(day, 10), scheduled_end: _at(day, 11), timezone_base: "Europe/London"});
    _check("a slot inside everyone's window schedules with no warnings",
        fit.panel.status == "scheduled" && fit.warnings.length == 0 &&
        fit.panel.interviewers.map(i => i.name).sort().join(",") == "carol,dave", JSON.stringify(fit));

    const late = await recruitment.schedulePanelAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r1", interviewer_person_ids: [w.carol, w.alice],
        scheduled_start: _at(day, 20), scheduled_end: _at(day, 21)});
    _check("a slot is never refused on availability — each misfit is named with its reason",
        late.panel.status == "scheduled" &&
        late.warnings.some(x => x.person_id == w.carol && x.reason == "outside_window") &&
        late.warnings.some(x => x.person_id == w.alice && x.reason == "undeclared"), JSON.stringify(late.warnings));

    const onLeave = await recruitment.schedulePanelAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r1", interviewer_person_ids: [w.carol, w.dave],
        scheduled_start: _at(leaveDay, 10), scheduled_end: _at(leaveDay, 11)});
    _check("approved leave is read from J6, not re-asked — the interviewer on leave is named",
        onLeave.warnings.length == 1 && onLeave.warnings[0].person_id == w.dave &&
        onLeave.warnings[0].reason == "on_leave", JSON.stringify(onLeave.warnings));

    await _checkThrows("a panel for a round the candidate is not in is refused",
        _ => recruitment.schedulePanelAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: applicationId, round_id: "r4", interviewer_person_ids: [w.carol],
            scheduled_start: _at(day, 10), scheduled_end: _at(day, 11)}));
    await _checkThrows("an interviewer with no employment in the org is refused",
        _ => recruitment.schedulePanelAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: applicationId, round_id: "r1", interviewer_person_ids: ["not-a-person"],
            scheduled_start: _at(day, 10), scheduled_end: _at(day, 11)}));
    await _checkThrows("a panel that ends before it starts is refused",
        _ => recruitment.schedulePanelAsync({org_id: w.org_id, actor_person_id: w.carol,
            application_id: applicationId, round_id: "r1", interviewer_person_ids: [w.carol],
            scheduled_start: _at(day, 11), scheduled_end: _at(day, 10)}));
    await _checkThrows("an employee cannot schedule a panel",
        _ => recruitment.schedulePanelAsync({org_id: w.org_id, actor_person_id: w.alice,
            application_id: applicationId, round_id: "r1", interviewer_person_ids: [w.carol],
            scheduled_start: _at(day, 10), scheduled_end: _at(day, 11)}));

    const clientEventId = `k6-${w.stamp}`;
    const first = await recruitment.schedulePanelAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r1", interviewer_person_ids: [w.dave],
        scheduled_start: _at(day, 14), scheduled_end: _at(day, 15), client_event_id: clientEventId});
    const replay = await recruitment.schedulePanelAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r1", interviewer_person_ids: [w.dave],
        scheduled_start: _at(day, 14), scheduled_end: _at(day, 15), client_event_id: clientEventId});
    _check("a replayed schedule returns the stored panel, not a second one",
        first.panel.panel_assignment_id == replay.panel.panel_assignment_id);

    // reschedule: moves the panel AND writes the engine's own `rescheduled` transition
    const moved = await recruitment.reschedulePanelAsync({org_id: w.org_id, actor_person_id: w.carol,
        panel_assignment_id: fit.panel.panel_assignment_id, scheduled_start: _at(day, 12),
        scheduled_end: _at(day, 13), reason: "Candidate asked for later"});
    const rescheduledRows = await dblayer.getQueryOrThrow(
        "SELECT * FROM stage_transition WHERE org_id=? AND application_id=? AND kind='rescheduled'",
        [w.org_id, applicationId]);
    const legalAfterMove = await recruitment.legalActionsAsync(w.org_id, w.carol, applicationId);
    _check("a reschedule moves the panel and records the engine's rescheduled transition — the round stays open",
        moved.panel.scheduled_start == _at(day, 12) && rescheduledRows.length == 1 &&
        legalAfterMove.current_rounds.some(r => r.round_id == "r1"), JSON.stringify(rescheduledRows));

    // outcomes
    await _checkThrows("a panel that hasn't started cannot be completed",
        _ => recruitment.recordPanelOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
            panel_assignment_id: moved.panel.panel_assignment_id, outcome: "completed"}));

    const past = _inDays(-2);
    const held = await recruitment.schedulePanelAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r1", interviewer_person_ids: [w.carol, w.dave],
        scheduled_start: _at(past, 10), scheduled_end: _at(past, 11, 30)});
    const done = await recruitment.recordPanelOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
        panel_assignment_id: held.panel.panel_assignment_id, outcome: "completed"});
    _check("completing a panel logs one non-billable entry per interviewer, for the panel's length",
        done.panel.status == "completed" && done.time_entries.length == 2 &&
        done.time_entries.every(e => e.category == "interview_panel" && e.billable == 0 &&
            e.duration_seconds == 5400 && e.entry_date == past), JSON.stringify(done.time_entries));
    _check("the interviewer's time entry names the round, never the candidate",
        done.time_entries.every(e => /Resume review/.test(e.note) && !/Panel Test/.test(e.note)),
        JSON.stringify(done.time_entries.map(e => e.note)));

    const again = await recruitment.recordPanelOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
        panel_assignment_id: held.panel.panel_assignment_id, outcome: "completed"});
    const entryCount = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM time_entry_event WHERE org_id=? AND category='interview_panel'",
        [w.org_id]))[0].c;
    _check("completing twice is a replay — the hours are never logged a second time",
        again.time_entries.length == 2 && entryCount == 2, `entries in ledger: ${entryCount}`);

    await _checkThrows("cancelling a panel needs a reason",
        _ => recruitment.recordPanelOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
            panel_assignment_id: late.panel.panel_assignment_id, outcome: "cancelled"}));
    const cancelled = await recruitment.recordPanelOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
        panel_assignment_id: late.panel.panel_assignment_id, outcome: "cancelled", reason: "Outside hours"});
    const cancelTransitions = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM stage_transition WHERE org_id=? AND application_id=? AND kind='cancelled'",
        [w.org_id, applicationId]))[0].c;
    const legalAfterCancel = await recruitment.legalActionsAsync(w.org_id, w.carol, applicationId);
    _check("cancelling a panel meeting is not cancelling the round — the round stays open, no transition",
        cancelled.panel.status == "cancelled" && cancelTransitions == 0 &&
        legalAfterCancel.current_rounds.some(r => r.round_id == "r1"), `cancelled transitions: ${cancelTransitions}`);

    const noShow = await recruitment.recordPanelOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
        panel_assignment_id: onLeave.panel.panel_assignment_id, outcome: "no_show", reason: "Interviewer on leave"});
    _check("a no-show is recorded against the panel, and logs no time",
        noShow.panel.status == "no_show" && noShow.time_entries.length == 0);

    const load = await recruitment.interviewerLoadAsync(w.org_id, w.carol, _inDays(-7), _inDays(14));
    const carolLoad = load.interviewers.find(i => i.person_id == w.carol);
    const daveLoad = load.interviewers.find(i => i.person_id == w.dave);
    // carol: fit (moved, 1h) + held (1.5h, completed); the late one was cancelled, so it isn't load
    // dave:  fit (1h) + replayed-once panel (1h) + held (1.5h); the no-show isn't load either
    _check("interviewer load counts scheduled and completed panels, never cancelled or no-show ones",
        carolLoad?.panels == 2 && carolLoad.seconds == 9000 && carolLoad.completed == 1 &&
        daveLoad?.panels == 3 && daveLoad.seconds == 12600, JSON.stringify(load.interviewers));
    _check("interviewer load is listed by name, not ranked by load",
        load.interviewers.map(i => i.name).join(",") == [...load.interviewers.map(i => i.name)].sort().join(","));

    const record = await recruitment.candidateRecordAsync(w.org_id, w.carol, applicationId);
    _check("the candidate record carries its panels with interviewer names",
        record.panels.length == 5 && record.panels.every(p => p.interviewers.every(i => i.name != i.person_id)),
        JSON.stringify(record.panels.map(p => p.status)));
}

/**
 * Walks a fresh candidate all the way to a completed pipeline: r1 -> r2a +
 * r2b in parallel (both scored high so r3's condition, score < 3, never
 * triggers) -> r4. Returns the application_id, ready for an offer.
 */
async function _walkToCompletion(w, requisitionId, fullName, email) {
    const applied = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: requisitionId, full_name: fullName, email});
    const applicationId = applied.application_id;
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r1", kind: "advanced"});
    await recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r2a", criteria_ratings: [{criterion_id: "c1", rating: 5}],
        recommendation: "strong_yes", evidence: "Excellent communication and clarity throughout the conversation, with strong examples."});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r2a", kind: "advanced"});
    await recruitment.submitScorecardAsync({org_id: w.org_id, actor_person_id: w.dave,
        application_id: applicationId, round_id: "r2b", criteria_ratings: [{criterion_id: "c1", rating: 5}],
        recommendation: "strong_yes", evidence: "Solved every logic puzzle quickly and explained the reasoning clearly and confidently throughout."});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.dave,
        application_id: applicationId, round_id: "r2b", kind: "advanced"});
    // r3's condition (score < 3) is never satisfied by a 5, so it auto-skips
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: applicationId, round_id: "r4", kind: "advanced"});
    return applicationId;
}

/**
 * K8: the approval route is computed from the offer's own attributes — a
 * required-approval-count (1/2/3) standing in for the wireframe's named
 * roles (hiring manager/HR/Finance), which this app's permission model
 * doesn't have. Walks all three tiers, a negotiation that re-routes, and
 * the decline/withdraw taxonomy.
 */
async function _testOffers(w, workflow) {
    LOG.console("\n K8 — offers\n");
    const requisition = await recruitment.raiseRequisitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        title: "Backend Engineer", target_start: _inDays(90), workflow_code: workflow.workflow_code,
        band_min: 100000, band_max: 200000});
    await recruitment.approveRequisitionAsync({org_id: w.org_id, actor_person_id: w.dave,
        requisition_id: requisition.requisition_id});

    const midWalk = await recruitment.applyAsync({org_id: w.org_id, actor_person_id: w.carol,
        requisition_id: requisition.requisition_id, full_name: "Not Done Yet",
        email: `notdone.${w.stamp}@example.invalid`});
    await _checkThrows("an offer cannot be built before the candidate has passed every round",
        _ => recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
            application_id: midWalk.application_id, fixed_amount: 150000, start_date: _inDays(60),
            expires_on: _inDays(14)}));

    // tier 1: within band, 50th percentile — one approval, no rationale needed
    const app1 = await _walkToCompletion(w, requisition.requisition_id, "Offer Tier One",
        `offer1.${w.stamp}@example.invalid`);
    const offer1 = await recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
        application_id: app1, fixed_amount: 150000, start_date: _inDays(60), expires_on: _inDays(14),
        client_event_id: `offer1-${w.stamp}`});
    _check("a within-band offer at the 50th percentile needs one approval and no rationale",
        offer1.percentile == 50 && offer1.required_approvals == 1 && offer1.status == "pending_approval",
        JSON.stringify(offer1));

    const replay1 = await recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
        application_id: app1, fixed_amount: 150000, start_date: _inDays(60), expires_on: _inDays(14),
        client_event_id: `offer1-${w.stamp}`});
    _check("a replayed build returns the stored offer, not a duplicate",
        replay1.offer_version_id == offer1.offer_version_id);

    await _checkThrows("a second, independent offer on the same application is refused",
        _ => recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
            application_id: app1, fixed_amount: 160000, start_date: _inDays(60), expires_on: _inDays(14)}));
    await _checkThrows("an employee cannot build an offer",
        _ => recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.alice,
            application_id: app1, fixed_amount: 150000, start_date: _inDays(60), expires_on: _inDays(14)}));
    await _checkThrows("the builder cannot approve their own offer (sod.self_approval)",
        _ => recruitment.approveOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
            offer_version_id: offer1.offer_version_id}));

    const approval1 = await recruitment.approveOfferAsync({org_id: w.org_id, actor_person_id: w.carol,
        offer_version_id: offer1.offer_version_id});
    _check("one approval is enough at required_approvals 1, and the offer approves",
        approval1.approved === true && approval1.offer.status == "approved", JSON.stringify(approval1));
    await _checkThrows("the same person cannot approve twice",
        _ => recruitment.approveOfferAsync({org_id: w.org_id, actor_person_id: w.carol,
            offer_version_id: offer1.offer_version_id}));

    const sent1 = await recruitment.sendOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
        offer_version_id: offer1.offer_version_id});
    _check("approved moves to sent", sent1.status == "sent");
    await recruitment.recordOfferViewedAsync({org_id: w.org_id, actor_person_id: w.frank,
        offer_version_id: offer1.offer_version_id});

    await _checkThrows("declining without a taxonomy reason is refused",
        _ => recruitment.recordOfferOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
            offer_version_id: offer1.offer_version_id, outcome: "declined"}));
    const declined = await recruitment.recordOfferOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
        offer_version_id: offer1.offer_version_id, outcome: "declined", decline_reason: "compensation"});
    _check("decline records a taxonomy reason, feeding K11 rather than free text standing in for data",
        declined.status == "declined");
    const declinedRow = (await recruitment.offersForApplicationAsync(w.org_id, w.carol, app1)).offers[0];
    _check("the decline reason is stored on the record", declinedRow.decline_reason == "compensation");

    // tier 2: above the 75th percentile — needs a rationale and two distinct approvals
    const app2 = await _walkToCompletion(w, requisition.requisition_id, "Offer Tier Two",
        `offer2.${w.stamp}@example.invalid`);
    await _checkThrows("an offer above the 75th percentile needs a deviation rationale",
        _ => recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
            application_id: app2, fixed_amount: 195000, start_date: _inDays(60), expires_on: _inDays(14)}));
    const offer2 = await recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
        application_id: app2, fixed_amount: 195000, start_date: _inDays(60), expires_on: _inDays(14),
        rationale: "Competing offer verified; the candidate's systems-design depth is scarce on this team."});
    _check("95th percentile needs two approvals", offer2.percentile == 95 && offer2.required_approvals == 2,
        JSON.stringify(offer2));

    const step1 = await recruitment.approveOfferAsync({org_id: w.org_id, actor_person_id: w.carol,
        offer_version_id: offer2.offer_version_id});
    _check("one of two approvals leaves the offer pending",
        step1.approved === false && step1.offer.status == "pending_approval", JSON.stringify(step1));
    const step2 = await recruitment.approveOfferAsync({org_id: w.org_id, actor_person_id: w.dave,
        offer_version_id: offer2.offer_version_id});
    _check("the second distinct approval completes the route",
        step2.approved === true && step2.offer.status == "approved", JSON.stringify(step2));

    await recruitment.sendOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
        offer_version_id: offer2.offer_version_id});
    await recruitment.recordOfferViewedAsync({org_id: w.org_id, actor_person_id: w.frank,
        offer_version_id: offer2.offer_version_id});

    // negotiate: the revision crosses into "above band" and re-routes to three approvals
    const negotiated = await recruitment.negotiateOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
        offer_version_id: offer2.offer_version_id, fixed_amount: 250000, start_date: _inDays(60),
        expires_on: _inDays(14), rationale: "Candidate has a competing offer above this band entirely."});
    _check("a revision that crosses into above-band re-routes to three approvals",
        negotiated.version == 2 && negotiated.required_approvals == 3, JSON.stringify(negotiated));

    const history = await recruitment.offersForApplicationAsync(w.org_id, w.carol, app2);
    const v1 = history.offers.find(o => o.version == 1);
    _check("version 1 is retained and points at the version that superseded it",
        v1.status == "negotiating" && v1.superseded_by_version_id == negotiated.offer_version_id, JSON.stringify(v1));

    for (const approver of [w.carol, w.dave, w.erin])
        await recruitment.approveOfferAsync({org_id: w.org_id, actor_person_id: approver,
            offer_version_id: negotiated.offer_version_id});
    const approvedV2 = (await recruitment.offersForApplicationAsync(w.org_id, w.carol, app2)).offers
        .find(o => o.offer_version_id == negotiated.offer_version_id);
    _check("three distinct approvals complete an above-band route", approvedV2.status == "approved");

    await recruitment.sendOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
        offer_version_id: negotiated.offer_version_id});
    await _checkThrows("withdrawing needs a reason — it is a legal event",
        _ => recruitment.recordOfferOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
            offer_version_id: negotiated.offer_version_id, outcome: "withdrawn"}));
    const withdrawn = await recruitment.recordOfferOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
        offer_version_id: negotiated.offer_version_id, outcome: "withdrawn",
        reason: "Role scope changed after budget review."});
    _check("withdrawal is recorded with its reason", withdrawn.status == "withdrawn");

    // tier 3, direct: above band from the very first version, not only reachable via negotiation
    const app3 = await _walkToCompletion(w, requisition.requisition_id, "Offer Tier Three",
        `offer3.${w.stamp}@example.invalid`);
    const offer3 = await recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
        application_id: app3, fixed_amount: 260000, start_date: _inDays(60), expires_on: _inDays(14),
        rationale: "Above band — exceptional prior experience shipping this exact system at scale."});
    _check("an offer above the band computes three required approvals directly",
        offer3.required_approvals == 3, JSON.stringify(offer3));

    // a large joining bonus alone crosses the tier, even within band
    const app4 = await _walkToCompletion(w, requisition.requisition_id, "Offer Tier Bonus",
        `offer4.${w.stamp}@example.invalid`);
    const offer4 = await recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.frank,
        application_id: app4, fixed_amount: 120000, joining_bonus: 20000, start_date: _inDays(60),
        expires_on: _inDays(14), rationale: "Relocation is time-critical; the bonus offsets the notice-period gap."});
    _check("a joining bonus over 10% of the fixed amount alone requires two approvals, even within band",
        offer4.percentile == 20 && offer4.required_approvals == 2, JSON.stringify(offer4));
}

/**
 * K11: pure reporting over a small, deliberately mixed cohort — one hire,
 * one decline, one early rejection, one still-open hold — under its own
 * dedicated workflow and requisition, so every count can be checked
 * exactly instead of being diluted by every other test's applications
 * sharing "swe-hiring".
 */
async function _testAnalytics(w) {
    LOG.console("\n K11 — analytics & SLA\n");
    const workflowCode = `analytics-${w.stamp}`;
    await recruitment.publishWorkflowAsync({org_id: w.org_id, actor_person_id: w.dave,
        workflow_code: workflowCode, title: "Analytics test", job_family: "Engineering",
        rounds: [
            {id: "r1", title: "Round one", round_type: "screen", sequence: 1, owner_role: "recruiter",
                sla_days: 2, scorecard_criteria: []},
            {id: "r2", title: "Round two", round_type: "technical", sequence: 2, owner_role: "recruiter",
                sla_days: 1, scorecard_criteria: []}
        ]});
    const requisition = await recruitment.raiseRequisitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        title: "Analytics Engineer", target_start: _inDays(60), workflow_code: workflowCode});
    await recruitment.approveRequisitionAsync({org_id: w.org_id, actor_person_id: w.dave,
        requisition_id: requisition.requisition_id});

    const _apply = async (name, source) => (await recruitment.applyAsync({org_id: w.org_id,
        actor_person_id: w.carol, requisition_id: requisition.requisition_id, full_name: name,
        email: `${name.replace(/\s+/g, ".").toLowerCase()}.${w.stamp}@example.invalid`, source})).application_id;

    // A: referral, hired.
    const appA = await _apply("Hired Candidate", "referral");
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appA, round_id: "r1", kind: "advanced"});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appA, round_id: "r2", kind: "advanced"});
    const offerA = await recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appA, fixed_amount: 150000, start_date: _inDays(45), expires_on: _inDays(14)});
    await recruitment.approveOfferAsync({org_id: w.org_id, actor_person_id: w.dave,
        offer_version_id: offerA.offer_version_id});
    await recruitment.recordOfferOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
        offer_version_id: offerA.offer_version_id, outcome: "accepted"});

    // B: referral, offer declined on compensation.
    const appB = await _apply("Declined Candidate", "referral");
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appB, round_id: "r1", kind: "advanced"});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appB, round_id: "r2", kind: "advanced"});
    const offerB = await recruitment.buildOfferAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appB, fixed_amount: 150000, start_date: _inDays(45), expires_on: _inDays(14)});
    await recruitment.approveOfferAsync({org_id: w.org_id, actor_person_id: w.dave,
        offer_version_id: offerB.offer_version_id});
    await recruitment.recordOfferOutcomeAsync({org_id: w.org_id, actor_person_id: w.carol,
        offer_version_id: offerB.offer_version_id, outcome: "declined", decline_reason: "compensation"});

    // C: job board, rejected at round one — never reaches round two.
    const appC = await _apply("Rejected Candidate", "job_board");
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appC, round_id: "r1", kind: "rejected", reason: "Not a fit for this role."});

    // D: careers page, still open — held at round two, the non-completion bucket.
    const appD = await _apply("Held Candidate", "careers_page");
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appD, round_id: "r1", kind: "advanced"});
    await recruitment.recordTransitionAsync({org_id: w.org_id, actor_person_id: w.carol,
        application_id: appD, round_id: "r2", kind: "held", reason: "Waiting on a reference.",
        review_date: _inDays(5)});

    // Round two's sla_days is 1. Push A's and B's round-two decisions two
    // days later than they actually happened — a deterministic, timing-
    // independent breach, leaving round one (untouched) comfortably inside
    // its own 2-day target.
    await dblayer.runCmdOrThrow(
        `UPDATE stage_transition SET occurred_at = occurred_at + 172800
            WHERE org_id=? AND round_id='r2' AND kind='advanced' AND application_id IN (?,?)`,
        [w.org_id, appA, appB]);

    const funnel = await recruitment.recruitmentFunnelAsync(w.org_id, w.carol, {workflow_code: workflowCode});
    _check("applied counts every candidate raised under this workflow's own requisition",
        funnel.applied == 4, JSON.stringify(funnel.funnel));
    const [, round1, round2, hired] = funnel.funnel;
    _check("round one is reached by all four applications",
        round1.round_id == "r1" && round1.reached == 4 && round1.pct_of_previous == 100, JSON.stringify(round1));
    _check("round two is reached by the three who cleared round one",
        round2.round_id == "r2" && round2.reached == 3 && round2.pct_of_previous == 75, JSON.stringify(round2));
    _check("the trailing row is an acceptance rate over offers built, not a stage pass-through",
        hired.is_acceptance === true && hired.reached == 1 && hired.pct_of_previous == 50, JSON.stringify(hired));
    _check("median time to hire is computed from the one accepted offer",
        funnel.median_time_to_hire_days != null && funnel.median_time_to_hire_days >= 0,
        JSON.stringify(funnel.median_time_to_hire_days));

    const [stage1, stage2] = funnel.time_in_stage;
    _check("round one's dwell comfortably meets its 2-day SLA for all four decisions",
        stage1.sla_days == 2 && stage1.sla_met_pct == 100, JSON.stringify(stage1));
    _check("round two's pushed-out dwell breaches its 1-day SLA for both decisions",
        stage2.sla_days == 1 && stage2.sla_met_pct == 0 && stage2.median_days >= 2, JSON.stringify(stage2));

    const overview = await recruitment.recruitmentOverviewAsync(w.org_id, w.carol,
        {requisition_id: requisition.requisition_id});
    const referral = overview.sources.find(s => s.source == "referral");
    const jobBoard = overview.sources.find(s => s.source == "job_board");
    const careers = overview.sources.find(s => s.source == "careers_page");
    _check("referral is half the applicants and all of the hires",
        referral?.applicants == 2 && referral.applicant_pct == 50 && referral.hires == 1 && referral.hire_pct == 100,
        JSON.stringify(referral));
    _check("job board contributed an applicant but no hire",
        jobBoard?.applicants == 1 && jobBoard.hires == 0, JSON.stringify(jobBoard));
    _check("careers page contributed the still-open applicant, no hire yet",
        careers?.applicants == 1 && careers.hires == 0, JSON.stringify(careers));
    _check("the one decline is attributed to compensation, out of the two offers built",
        overview.offers_total == 2 && overview.declines.length == 1 &&
        overview.declines[0].decline_reason == "compensation" && overview.declines[0].count == 1,
        JSON.stringify(overview.declines));

    await _checkThrows("an employee cannot read the funnel",
        _ => recruitment.recruitmentFunnelAsync(w.org_id, w.alice, {workflow_code: workflowCode}));
    await _checkThrows("an employee cannot read the overview",
        _ => recruitment.recruitmentOverviewAsync(w.org_id, w.alice, {}));
    await _checkThrows("a workflow_code with no published pointer is refused, not silently empty",
        _ => recruitment.recruitmentFunnelAsync(w.org_id, w.carol, {workflow_code: `no-such-workflow-${w.stamp}`}));

    // Interviewer load's concentration stat, isolated to its own date window
    // so it can't be diluted by K6's own panel-scheduling test fixture.
    const day = _inDays(300);
    const panels = [
        {who: w.bob, start: _at(day, 9), end: _at(day, 11)},
        {who: w.bob, start: _at(day, 13), end: _at(day, 15)},
        {who: w.alice, start: _at(day, 9), end: _at(day, 10)}
    ];
    for (const [i, panel] of panels.entries())
        await dblayer.runCmdOrThrow(`INSERT INTO panel_assignment (panel_assignment_id, org_id, application_id,
                round_id, interviewer_person_ids, scheduled_start, scheduled_end, status, scheduled_by, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [`k11-panel-${w.stamp}-${i}`, w.org_id, appA, "r1", JSON.stringify([panel.who]),
                panel.start, panel.end, "completed", w.carol, Math.floor(Date.now()/1000)]);

    const load = await recruitment.interviewerLoadAsync(w.org_id, w.carol, day, day);
    _check("the list itself stays name-sorted — bob has more hours but alice sorts first",
        load.interviewers[0]?.person_id == w.alice && load.interviewers[1]?.person_id == w.bob,
        JSON.stringify(load.interviewers.map(i => i.person_id)));
    _check("concentration reports the busiest quarter's share of total hours, not a ranked list",
        load.concentration_headcount == 1 && load.concentration_pct == 80,
        JSON.stringify({headcount: load.concentration_headcount, pct: load.concentration_pct}));
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Recruitment test ${stamp}`, home_jurisdiction: "IN"});
    const people = {};
    // erin and frank exist for K8: a required_approvals of 2 or 3 needs that
    // many DISTINCT offer.approve holders besides whoever built the offer,
    // and carol+dave alone are not enough to cover the above-band tier.
    for (const who of ["alice", "bob", "carol", "dave", "erin", "frank"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN",
        contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const [who, role] of [["alice", "employee"], ["bob", "lead"], ["carol", "hr"], ["dave", "admin"],
        ["erin", "hr"], ["frank", "admin"]])
        await permissions.assignRoleAsync(org.org_id, people[who].person_id, role, from);

    return {org_id: org.org_id, stamp, ...Object.fromEntries(
        Object.entries(people).map(([name, person]) => [name, person.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["offer_approval", "offer_version", "panel_assignment", "scorecard", "stage_transition",
        "application", "candidate", "requisition", "workflow_pointer", "workflow_version", "time_entry_event",
        "working_window", "leave_request"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin", "frank"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
