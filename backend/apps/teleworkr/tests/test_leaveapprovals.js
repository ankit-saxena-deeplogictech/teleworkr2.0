/**
 * Tests J5 — leave approvals as policy-routed steps: the manager step with the
 * explicit short-notice exception, the two-step manager-then-HR route, declines
 * that keep their reason, cancellations as reversals, the approvals queue with
 * document-visibility boundaries, and the escalation window.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests leaveapprovals
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const setup = require(`${TELEWORKR_CONSTANTS.LIBDIR}/setup.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const leaveapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/leave.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Leave approvals test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

const POLICY = _ => ({
    scope: {jurisdiction: "IN", contract_type: "employee", status: ["active", "probation"]},
    escalation_after_days: 3,
    leave_types: [
        {code: "EL", label: "Earned leave",
            quantum: {annual_days: 12},
            accrual: {per_month: 1},
            eligibility: {states: ["active"]},
            notice: {multiplier: 3, floor_days: 3, short_notice_approvable: true},
            max_per_request: 6,
            max_per_period: {days: 20, period: "quarter"},
            clubbing: {mode: "exempt_first", window: "per_financial_year"},
            approval_route: ["manager", "hr_informed"]},
        {code: "SNL", label: "Short notice leave",
            quantum: {annual_days: 3},
            accrual: {per_month: 0},
            eligibility: {states: ["active", "probation"]},
            notice: {multiplier: 0, floor_days: 0, short_notice_approvable: true},
            max_per_request: 2,
            approval_route: ["manager_or_hr"]},
        {code: "ML", label: "Maternity",
            eligibility: {states: ["active"]},
            notice: {multiplier: 0, floor_days: 0, short_notice_approvable: false},
            lifetime_max: 2,
            approval_route: ["manager", "hr"]}
    ]
});

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "leaveapprovals")) {
        LOG.console("Skipping leave approvals test case, not called.\n"); return true;
    }
    LOG.console("\nJ5 leave approvals\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: POLICY()});
        await setup.importBalancesAsync({org_id: w.org_id, actor_person_id: w.dave,
            rows: [{email: w.aliceEmail, leave_type: "EL", days: 20},
                {email: w.aliceEmail, leave_type: "SNL", days: 3},
                {email: w.bobEmail, leave_type: "EL", days: 10},
                {email: w.carolEmail, leave_type: "SNL", days: 3}],
            source: "spreadsheet", cutover_date: "2026-04-01", commit: true});

        await _testManagerStep(w);
        await _testShortNotice(w);
        await _testSoDAndNonApprovers(w);
        await _testManagerOrHr(w);
        await _testTwoStepRoute(w);
        await _testDeclineAndCancel(w);
        await _testEscalations(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  leave approvals tests threw: ${err}\n`); LOG.error(`Leave approvals tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nLeave approvals tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _testManagerStep(w) {
    LOG.console("\n the manager step\n");
    const requested = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-09-25", to_date: "2026-09-25", notice_days: 20,
        reason: "Family function"});
    w.elRequest = requested.request;

    const bobQueue = await leave.pendingApprovalsForAsync({org_id: w.org_id, actor_person_id: w.bob});
    const inQueue = bobQueue.find(item => item.leave_request_id == requested.request.leave_request_id);
    _check("the request appears in the manager's queue with the deciding context",
        Boolean(inQueue) && inQueue.balance_after > 0 && inQueue.step == "manager");
    _check("the queue says proof was not provided, without carrying the document",
        inQueue.proof_provided === false && !("fields" in inQueue));

    const carolQueue = await leave.pendingApprovalsForAsync({org_id: w.org_id, actor_person_id: w.carol});
    _check("the manager step does not appear in HR's queue",
        !carolQueue.some(item => item.leave_request_id == requested.request.leave_request_id));

    const notApprover = await _checkThrows("someone other than the manager of record is refused", _ =>
        leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.dave,
            leave_request_id: requested.request.leave_request_id}));
    _check("the refusal names the step", /manager/.test(notApprover.message));

    const balanceBefore = (await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", asOf: requested.request.from_date})).available;
    const approved = await leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
        leave_request_id: requested.request.leave_request_id});
    _check("the manager's approval is final on a one-step route",
        approved.final === true && approved.result == "approved");
    const stored = (await dblayer.getQueryOrThrow("SELECT * FROM leave_request WHERE leave_request_id=?",
        [requested.request.leave_request_id]))[0];
    _check("the request is approved with the approver recorded",
        stored.status == "approved" && stored.decided_by == w.bob);
    const deduction = (await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_ledger_entry WHERE source_request_id=?", [requested.request.leave_request_id]))[0];
    _check("approval writes the deduction, stamped with the pinned policy version",
        deduction.days == -stored.days_deducted && deduction.policy_version_id == stored.policy_version_id);
    _check("the approval is an audit signature",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM audit_event WHERE action='leave.approved' AND object_ref=?",
            [requested.request.leave_request_id])).length == 1);
    _check("the balance after the approval reflects the deduction",
        approved.balance_after.available == balanceBefore - stored.days_deducted,
        `${approved.balance_after.available} vs ${balanceBefore - stored.days_deducted}`);
}

async function _testShortNotice(w) {
    LOG.console("\n short notice is an explicit, recorded exception\n");
    const requested = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-09-28", to_date: "2026-09-30", notice_days: 1});

    const silent = await _checkThrows("approving short notice without the exception flag is refused", _ =>
        leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
            leave_request_id: requested.request.leave_request_id}));
    _check("the refusal asks for the explicit exception", /approve_as_exception/.test(silent.message));

    const approved = await leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
        leave_request_id: requested.request.leave_request_id, approve_as_exception: true});
    const stored = (await dblayer.getQueryOrThrow("SELECT * FROM leave_request WHERE leave_request_id=?",
        [requested.request.leave_request_id]))[0];
    _check("the exception is recorded on the request", JSON.parse(stored.approval_exceptions).includes("short_notice"));
    _check("the audit records the exception",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM audit_event WHERE action='leave.approved' AND object_ref=?",
            [requested.request.leave_request_id]))[0].detail.includes("short_notice_exception"));
}

async function _testSoDAndNonApprovers(w) {
    LOG.console("\n self-approval is blocked; strangers are refused\n");
    const own = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.carol,
        leave_type: "SNL", from_date: "2026-09-21", to_date: "2026-09-22", notice_days: 2});
    const sod = await _checkThrows("approving your own leave is blocked, naming the rule", _ =>
        leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.carol,
            leave_request_id: own.request.leave_request_id}));
    _check("the block names the SoD rule", sod?.decision?.rule == "sod.self_approval");

    const stranger = await _checkThrows("a person who is not an approver is refused", async _ => {
        const target = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
            leave_type: "EL", from_date: "2026-10-02", to_date: "2026-10-02", notice_days: 20});
        return leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.erin,
            leave_request_id: target.request.leave_request_id});
    });
    _check("that refusal names the step", /not the approver/.test(stranger.message));
}

async function _testManagerOrHr(w) {
    LOG.console("\n routing data: manager or HR\n");
    const requested = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "SNL", from_date: "2026-09-21", to_date: "2026-09-22", notice_days: 2,
        fields: {proof: "medical-certificate.pdf"}});
    const carolQueue = await leave.pendingApprovalsForAsync({org_id: w.org_id, actor_person_id: w.carol});
    const inQueue = carolQueue.find(item => item.leave_request_id == requested.request.leave_request_id);
    _check("the SNL route appears in HR's queue", Boolean(inQueue) && inQueue.step == "manager_or_hr");
    _check("approvers see that proof was provided — not the document",
        inQueue.proof_provided === true && !JSON.stringify(inQueue).includes("medical-certificate.pdf"));

    await leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.carol,
        leave_request_id: requested.request.leave_request_id});
    _check("HR approves on the manager-or-HR route",
        (await dblayer.getQueryOrThrow("SELECT * FROM leave_request WHERE leave_request_id=?",
            [requested.request.leave_request_id]))[0].status == "approved");
}

async function _testTwoStepRoute(w) {
    LOG.console("\n routing data: manager, then HR\n");
    const requested = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "ML", from_date: "2026-10-05", to_date: "2026-10-09", notice_days: 30});

    const partial = await leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
        leave_request_id: requested.request.leave_request_id});
    _check("the first step of a two-step route approves partially",
        partial.final === false && partial.result == "partial");
    const stepped = (await dblayer.getQueryOrThrow("SELECT * FROM leave_request WHERE leave_request_id=?",
        [requested.request.leave_request_id]))[0];
    _check("the request stays pending and advances a step",
        stepped.status == "pending" && stepped.approval_step == 1);
    _check("no deduction is written before the final step",
        (await dblayer.getQueryOrThrow("SELECT * FROM leave_ledger_entry WHERE source_request_id=?",
            [requested.request.leave_request_id])).length == 0);

    const bobQueue = await leave.pendingApprovalsForAsync({org_id: w.org_id, actor_person_id: w.bob});
    _check("the first approver no longer sees it",
        !bobQueue.some(item => item.leave_request_id == requested.request.leave_request_id));
    const hrQueue = await leave.pendingApprovalsForAsync({org_id: w.org_id, actor_person_id: w.carol});
    _check("HR sees it at the second step",
        hrQueue.some(item => item.leave_request_id == requested.request.leave_request_id && item.step == "hr"));

    const final = await leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.carol,
        leave_request_id: requested.request.leave_request_id});
    _check("the second step approves and writes the deduction",
        final.final === true &&
        (await dblayer.getQueryOrThrow("SELECT * FROM leave_ledger_entry WHERE source_request_id=?",
            [requested.request.leave_request_id])).length == 1);
}

async function _testDeclineAndCancel(w) {
    LOG.console("\n declines name why; cancellations are reversals\n");
    const toDecline = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2027-01-04", to_date: "2027-01-06", notice_days: 20});
    await _checkThrows("a decline without a reason is refused", _ =>
        leave.declineLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
            leave_request_id: toDecline.request.leave_request_id}));
    await leave.declineLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
        leave_request_id: toDecline.request.leave_request_id, reason: "Above the quarter cap — split it across quarters and I'll approve both."});
    const declined = (await dblayer.getQueryOrThrow("SELECT * FROM leave_request WHERE leave_request_id=?",
        [toDecline.request.leave_request_id]))[0];
    _check("the decline keeps its reason on the record",
        declined.status == "declined" && /split it across quarters/.test(declined.decision_reason));
    _check("the decline is audited",
        (await dblayer.getQueryOrThrow("SELECT * FROM audit_event WHERE action='leave.declined' AND object_ref=?",
            [toDecline.request.leave_request_id])).length == 1);

    // cancelling a pending request closes it without a ledger trace
    const toCancelPending = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2027-04-05", to_date: "2027-04-07", notice_days: 20});
    const deductionsBefore = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM leave_ledger_entry WHERE org_id=? AND kind='deduction'", [w.org_id]))[0].c;
    const cancelled = await leave.cancelLeaveRequestAsync({org_id: w.org_id, person_id: w.alice,
        leave_request_id: toCancelPending.request.leave_request_id});
    _check("cancelling a pending request writes no reversal", cancelled.reversed_days == 0 &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM leave_ledger_entry WHERE org_id=? AND kind='deduction'", [w.org_id]))[0].c == deductionsBefore);

    // cancelling an approved request returns the days
    const asOf = w.elRequest.from_date;
    const balanceBefore = (await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", asOf})).available;
    const reversed = await leave.cancelLeaveRequestAsync({org_id: w.org_id, person_id: w.alice,
        leave_request_id: w.elRequest.leave_request_id});
    _check("cancelling an approved request writes a reversal entry",
        reversed.reversed_days == w.elRequest.days_deducted &&
        (await dblayer.getQueryOrThrow("SELECT * FROM leave_ledger_entry WHERE source_request_id=? AND kind='reversal'",
            [w.elRequest.leave_request_id])).length == 1);
    const balanceAfter = (await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", asOf})).available;
    _check("the days are returned to the balance",
        balanceAfter == balanceBefore + w.elRequest.days_deducted,
        `${balanceAfter} vs ${balanceBefore + w.elRequest.days_deducted}`);
    _check("the cancellation is audited",
        (await dblayer.getQueryOrThrow("SELECT * FROM audit_event WHERE action='leave.cancelled' AND object_ref=?",
            [w.elRequest.leave_request_id])).length == 1);
}

async function _testEscalations(w) {
    LOG.console("\n nothing sits unanswered\n");
    const stalled = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-10-26", to_date: "2026-10-28", notice_days: 20});
    await dblayer.runCmdOrThrow("UPDATE leave_request SET submitted_at=submitted_at-4*86400 WHERE leave_request_id=?",
        [stalled.request.leave_request_id]);

    const due = await leave.escalationsDueAsync(w.org_id);
    const listed = due.find(item => item.leave_request_id == stalled.request.leave_request_id);
    _check("a request past the policy's escalation window is listed",
        Boolean(listed) && listed.waiting_days >= 3 && listed.window_days == 3);
    _check("the escalation names the next approver up the chain",
        listed.route_to == w.dave, listed.route_to);
    _check("fresh requests are not escalated",
        !due.some(item => item.leave_request_id == (w.elRequest.leave_request_id)));
}

async function _testAPI(w) {
    LOG.console("\n the approvals API\n");
    const requested = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-11-02", to_date: "2026-11-04", notice_days: 20});
    const approved = await leaveapi.doService({op: "approve", id: w.bobEmail, org: w.org_id,
        leave_request_id: requested.request.leave_request_id});
    _check("op approve answers true and final", approved.result === "approved" && approved.final === true);

    const pending = await leaveapi.doService({op: "pending", id: w.bobEmail, org: w.org_id});
    _check("op pending answers with the queue", pending.result === true && Array.isArray(pending.queue));

    const escalations = await leaveapi.doService({op: "escalations", id: w.bobEmail, org: w.org_id});
    _check("op escalations answers with the due list", escalations.result === true && Array.isArray(escalations.escalations));
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

function _today() {return new Date().toISOString().substring(0, 10);}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `LeaveApprovals test ${stamp}`, home_jurisdiction: "IN"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    const line = {alice: people.bob.person_id, bob: people.dave.person_id};
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active",
        jurisdiction: who == "alice" || who == "bob" || who == "carol" ? "IN" : "GB",
        manager_person_id: line[who] || null, contract_type: "employee",
        valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);

    return {org_id: org.org_id, aliceEmail: `alice.${stamp}@example.invalid`,
        bobEmail: `bob.${stamp}@example.invalid`, carolEmail: `carol.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_ledger_entry WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_request WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_policy_pointer WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_policy_version WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM opening_balance_entry WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM import_batch WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
