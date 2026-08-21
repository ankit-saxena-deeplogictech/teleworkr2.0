/**
 * Tests J1/J3 — the versioned, effective-dated leave policy with a published
 * pointer, the evaluator whose arithmetic is shown line by line, the
 * append-only ledger, and the projected balance that is never stored.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests leave
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const entityshapes = require(`${TELEWORKR_CONSTANTS.LIBDIR}/entityshapes.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const setup = require(`${TELEWORKR_CONSTANTS.LIBDIR}/setup.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const leaveapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/leave.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Leave test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

const POLICY = _ => ({
    scope: {jurisdiction: "IN", contract_type: "employee", status: ["active", "probation"]},
    leave_types: [
        {code: "EL", label: "Earned leave", allow_half_days: true,
            quantum: {annual_days: 12},
            accrual: {per_month: 1, pro_rata: true, freezes_on: ["LWP"]},
            eligibility: {states: ["active"]},
            notice: {multiplier: 3, floor_days: 3, short_notice_approvable: true},
            max_per_request: 6,
            max_per_period: {days: 6, period: "quarter"},
            carry_forward: {cap_days: 3},
            clubbing: {mode: "exempt_first", window: "per_financial_year"},
            combinable_with: ["ML"],
            approval_route: ["manager", "hr_informed"]},
        {code: "SNL", label: "Short notice leave",
            quantum: {annual_days: 3},
            accrual: {per_month: 0},
            eligibility: {states: ["active", "probation"]},
            notice: {multiplier: 0, floor_days: 0, short_notice_approvable: true},
            max_per_request: 2,
            approval_route: ["manager", "hr_informed"],
            combinable_with: [],
            proof_after_consecutive_days: 2},
        {code: "ML", label: "Maternity",
            eligibility: {states: ["active"]},
            notice: {multiplier: 0, floor_days: 0, short_notice_approvable: false},
            lifetime_max: 2,
            combinable_with: ["EL"],
            approval_route: ["manager", "hr_informed"]},
        {code: "LWP", label: "Leave without pay",
            eligibility: {states: ["active"]},
            notice: {multiplier: 0, floor_days: 0, short_notice_approvable: false},
            requires_exhausted: ["EL"],
            backdating: {allowed_days: 0, for_types: []},
            approval_route: ["manager", "management_review"]},
        {code: "CO", label: "Comp-off",
            accrual: {per_month: 0},
            eligibility: {states: ["active"]},
            notice: {multiplier: 0, floor_days: 0, short_notice_approvable: true},
            expiry: {months: 1},
            approval_route: ["manager", "hr_informed"]}
    ]
});

const RESOLUTIONS = _ => ({
    leave_during_probation: "per_type_eligibility",
    clubbing_window: "per_financial_year",
    half_day_rule: "confirm_not_deduct"});

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "leave")) {
        LOG.console("Skipping leave test case, not called.\n"); return true;
    }
    LOG.console("\nJ1/J3 leave\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testPublish(w);
        await _testBalance(w);
        await _testEvaluate(w);
        await _testRequests(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  leave tests threw: ${err}\n`); LOG.error(`Leave tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nLeave tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _testPublish(w) {
    LOG.console("\n the policy is a versioned record with a published pointer\n");
    await _checkThrows("unresolved structural conflicts block publish, naming each", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: POLICY()}));
    const blocked = await _checkThrows("the refusal carries the conflict rows for the screen", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: POLICY()}));
    _check("each blocking conflict is a named, choice-bearing row",
        blocked.conflicts?.length >= 2 &&
        blocked.conflicts.every(conflict => conflict.choices.length && conflict.why.length));

    const published = await leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
        step_up_verified: true, effective_from: "2026-04-01", policy: POLICY(),
        resolutions: RESOLUTIONS()});
    w.v1 = published.version;
    _check("publishing creates version 1", published.version.version == 1 && published.superseded === null);
    _check("the resolutions are stored with the version",
        published.resolutions.clubbing_window?.choice == "per_financial_year" &&
        published.resolutions.half_day_rule?.source == "explicit");
    _check("the pointer now points at version 1",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM leave_policy_pointer WHERE org_id=?", [w.org_id]))[0].policy_version_id == published.version.policy_version_id);
    _check("the publish is audited with the diff facts",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM audit_event WHERE org_id=? AND action='leave_policy.published'",
            [w.org_id])).length == 1);

    await _checkThrows("a person without leave_policy.publish is refused", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.erin,
            step_up_verified: true, effective_from: "2026-04-01", policy: POLICY(),
            resolutions: RESOLUTIONS()}));

    const withColour = POLICY(); withColour.leave_types[0].colour = "red";
    await _checkThrows("a rule the schema cannot express blocks publish", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: withColour}));
    const noRoute = POLICY(); noRoute.leave_types[0].approval_route = [];
    await _checkThrows("a type without an approval route blocks publish", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: noRoute}));
    const noWindow = POLICY(); noWindow.leave_types[0].clubbing = {mode: "exempt_first"};
    await _checkThrows("exempt-first clubbing without a window blocks publish", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: noWindow}));
    const badRef = POLICY(); badRef.leave_types[3].requires_exhausted = ["XX"];
    await _checkThrows("a reference to an unknown type blocks publish", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: badRef}));
    await _checkThrows("a non-ISO effective date blocks publish", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "April fools", policy: POLICY()}));

    const v2 = await leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
        step_up_verified: true, effective_from: "2026-04-01", policy: POLICY(),
        resolutions: RESOLUTIONS()});
    w.v2 = v2.version;
    _check("a new publish supersedes rather than rewrites", v2.version.version == 2 &&
        v2.superseded == published.version.policy_version_id);
    _check("the superseded version is retained, marked superseded",
        (await dblayer.getQueryOrThrow("SELECT * FROM leave_policy_version WHERE policy_version_id=?",
            [published.version.policy_version_id]))[0].status == "superseded");
    _check("the pointer moved to version 2",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM leave_policy_pointer WHERE org_id=?", [w.org_id]))[0].policy_version_id == v2.version.policy_version_id);
    _check("policy versions have no in-place update path",
        (_ => {try {entityshapes.assertUpdatable("leave_policy_version"); return false;} catch (err) {return true;}})());
}

async function _testBalance(w) {
    LOG.console("\n balance is a projection over the ledger\n");
    // the B6 opening assertion joins the projection
    await setup.importBalancesAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows: [{email: w.aliceEmail, leave_type: "EL", days: 9}], source: "spreadsheet",
        cutover_date: "2026-04-01", commit: true});

    const balance = await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", asOf: "2026-08-21"});
    _check("the balance is opening plus materialised accruals",
        balance.opening == 9 && balance.accrued == 8 && balance.available == 17,
        JSON.stringify({opening: balance.opening, accrued: balance.accrued, available: balance.available}));
    _check("every accrual pins its policy version", balance.policy_version_id == w.v2.policy_version_id);

    // bob is on probation and gets his short-notice year-start grant the same way
    await setup.importBalancesAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows: [{email: `bob.${w.stamp}@example.invalid`, leave_type: "SNL", days: 3}],
        source: "spreadsheet", cutover_date: "2026-04-01", commit: true});

    await leave.balanceAsync({org_id: w.org_id, person_id: w.alice, leave_type: "EL", asOf: "2026-08-21"});
    const accrualRows = await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_ledger_entry WHERE org_id=? AND person_id=? AND kind='accrual'",
        [w.org_id, w.alice]);
    _check("accrual materialisation is idempotent", accrualRows.length == 8);

    await leave.recordEntryAsync({org_id: w.org_id, person_id: w.alice, leave_type: "EL",
        days: -2, kind: "deduction", entry_date: "2026-05-10", policy_version_id: w.v2.policy_version_id,
        reason: "taken", recorded_by: "system"});
    const afterDeduction = await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", asOf: "2026-08-21"});
    _check("a deduction entry reduces the projection", afterDeduction.available == 15,
        `${afterDeduction.available}`);

    // comp-off units carry their own expiry clock, per unit
    const isoDaysAgo = daysAgo => {const d = new Date(); d.setUTCDate(d.getUTCDate()-daysAgo);
        return d.toISOString().substring(0, 10);};
    await leave.recordEntryAsync({org_id: w.org_id, person_id: w.alice, leave_type: "CO",
        days: 1, kind: "accrual", entry_date: isoDaysAgo(40), policy_version_id: w.v2.policy_version_id,
        recorded_by: "system"});
    await leave.recordEntryAsync({org_id: w.org_id, person_id: w.alice, leave_type: "CO",
        days: 1, kind: "accrual", entry_date: isoDaysAgo(28), policy_version_id: w.v2.policy_version_id,
        recorded_by: "system"});
    const compOff = await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "CO", asOf: _today()});
    _check("an expired unit leaves the balance", compOff.available == 1, `${compOff.available}`);
    _check("a unit about to expire is named with its date",
        compOff.expiring.length == 1 && compOff.expiring[0].expires_on,
        JSON.stringify(compOff.expiring));

    _check("the ledger has no in-place update path",
        (_ => {try {entityshapes.assertUpdatable("leave_ledger_entry"); return false;} catch (err) {return true;}})());
}

async function _testEvaluate(w) {
    LOG.console("\n one evaluator, arithmetic shown\n");
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.alice,
        timezone: "Etc/GMT+5", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: "2026-01-01"});

    const simple = await leave.evaluateAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-09-18", to_date: "2026-09-18", notice_days: 20});
    _check("a plain request is allowed with its deduction shown",
        simple.allowed && simple.working_days == 1 && simple.days_deducted == 1,
        JSON.stringify(simple.reason));
    _check("the first clubbing occurrence is free and says so",
        simple.clubbing_exempted == 2 && simple.clubbed_days == 0,
        JSON.stringify(simple.steps.find(step => step.rule == "clubbing")));
    _check("the approval route comes from the policy",
        simple.approval_route.join(",") == "manager,hr_informed");

    const shortNotice = await leave.evaluateAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-09-18", to_date: "2026-09-18", notice_days: 2});
    _check("short notice is a warning with an exception path, not a block",
        shortNotice.allowed && shortNotice.warnings.some(warning => warning.rule == "notice" && /short-notice exception/.test(warning.reason)));

    const backdated = await leave.evaluateAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-08-20", to_date: "2026-08-20", notice_days: 20});
    _check("backdating beyond the clause is refused, quoting the clause",
        !backdated.allowed && backdated.rule_fired == "backdating");

    const tooLong = await leave.evaluateAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-09-07", to_date: "2026-09-15", notice_days: 20});
    _check("a request above max_per_request is refused, naming it",
        !tooLong.allowed && tooLong.rule_fired == "max_per_request");

    const lwp = await leave.evaluateAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "LWP", from_date: "2026-09-14", to_date: "2026-09-15", notice_days: 20});
    _check("LWP needs paid leave exhausted first, and says how much remains",
        !lwp.allowed && lwp.rule_fired == "requires_exhausted" && /EL/.test(lwp.reason), lwp.reason);

    const compOff = await leave.evaluateAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "CO", from_date: "2026-09-14", to_date: "2026-09-15", notice_days: 20});
    _check("insufficient balance names the rule and offers routes",
        !compOff.allowed && compOff.rule_fired == "balance" && /EL/.test(compOff.route||""), compOff.reason);

    // probation: the policy covers the person but the type does not
    const probationEL = await leave.evaluateAsync({org_id: w.org_id, person_id: w.bob,
        leave_type: "EL", from_date: "2026-09-18", to_date: "2026-09-18", notice_days: 20});
    _check("a person on probation is refused earned leave, quoting the states",
        !probationEL.allowed && probationEL.rule_fired == "eligibility" && /active/.test(probationEL.reason));
    const probationSNL = await leave.evaluateAsync({org_id: w.org_id, person_id: w.bob,
        leave_type: "SNL", from_date: "2026-09-18", to_date: "2026-09-18", notice_days: 20});
    _check("and is offered short notice leave instead",
        probationSNL.allowed && probationSNL.days_deducted == 1);
}

async function _testRequests(w) {
    LOG.console("\n requests pin their evaluation\n");
    const first = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-09-25", to_date: "2026-09-25", notice_days: 20,
        reason: "Family function"});
    _check("the first request pins its policy version",
        first.request.policy_version_id == w.v2.policy_version_id && first.request.status == "pending");
    _check("the first occurrence's weekend is exempt",
        first.request.days_deducted == 1 && first.evaluation.clubbing_exempted == 2,
        `${first.request.days_deducted}`);

    const second = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-09-28", to_date: "2026-09-30", notice_days: 20});
    _check("a later clubbing in the same year is charged",
        second.evaluation.clubbed_days == 1 && second.request.days_deducted == 4,
        `${second.evaluation.clubbed_days} clubbed, ${second.request.days_deducted} deducted`);

    const refused = await _checkThrows("the quarter cap is refused, whatever the balance", _ =>
        leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
            leave_type: "EL", from_date: "2026-09-14", to_date: "2026-09-16", notice_days: 20}));
    _check("the cap refusal names the rule and the budget",
        refused?.evaluation?.rule_fired == "max_per_period" && /quarter/.test(refused.evaluation.reason));

    // maternity is a lifetime counter
    await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "ML", from_date: "2026-10-05", to_date: "2026-10-09", notice_days: 30});
    await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "ML", from_date: "2026-11-02", to_date: "2026-11-06", notice_days: 30});
    const thirdMl = await _checkThrows("maternity is refused past its lifetime counter", _ =>
        leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
            leave_type: "ML", from_date: "2026-12-01", to_date: "2026-12-04", notice_days: 30}));
    _check("the lifetime rule names the count",
        thirdMl?.evaluation?.rule_fired == "lifetime_max" && /2 time/.test(thirdMl.evaluation.reason));

    // escalating proof comes from the policy
    await setup.importBalancesAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows: [{email: w.aliceEmail, leave_type: "SNL", days: 3}], source: "spreadsheet",
        cutover_date: "2026-04-01", commit: true});
    const snl = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "SNL", from_date: "2026-09-21", to_date: "2026-09-22", notice_days: 2,
        fields: {manager_informed_at: "07:40"}});
    _check("proof is required from the policy's consecutive-day rule",
        snl.evaluation.proof_required == "SNL needs proof from day 2 (policy v2).");

    _check("the person's requests are listed with their evaluations",
        (await leave.requestsForPersonAsync(w.org_id, w.alice)).length >= 4);
}

async function _testAPI(w) {
    LOG.console("\n the leave API\n");
    const published = await leaveapi.doService({op: "publish", id: w.carolEmail, org: w.org_id,
        step_up_verified: true, effective_from: "2026-04-01", policy: POLICY(),
        resolutions: RESOLUTIONS()});
    _check("op publish answers true with the version", published.result === true && published.version.version >= 3);

    const evaluation = await leaveapi.doService({op: "evaluate", id: w.aliceEmail, org: w.org_id,
        leave_type: "EL", from_date: "2026-10-02", to_date: "2026-10-02", notice_days: 20});
    _check("op evaluate answers with the working", evaluation.result === true && evaluation.allowed);

    const balance = await leaveapi.doService({op: "balance", id: w.aliceEmail, org: w.org_id,
        leave_type: "EL"});
    _check("op balance answers with the projection", balance.result === true && balance.available > 0);

    const unknown = await leaveapi.doService({op: "balance", id: "nobody@example.invalid", org: w.org_id,
        leave_type: "EL"});
    _check("an unknown actor is refused", unknown.result === false && /No person/.test(unknown.reason||""));
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

function _today() {return new Date().toISOString().substring(0, 10);}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Leave test ${stamp}`, home_jurisdiction: "IN"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    const line = {alice: {jurisdiction: "IN", status: "active"},
        bob: {jurisdiction: "IN", status: "probation"}};
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: line[who]?.status || "active",
        jurisdiction: line[who]?.jurisdiction || "GB", contract_type: "employee",
        valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);

    return {org_id: org.org_id, stamp, aliceEmail: `alice.${stamp}@example.invalid`,
        carolEmail: `carol.${stamp}@example.invalid`,
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
    await dblayer.runCmdBestEffortAsync("DELETE FROM working_window WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
