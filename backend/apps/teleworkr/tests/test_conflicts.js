/**
 * Tests J8 — the policy conflicts the engine can't resolve. Structural
 * conflicts block publish until HR chooses a reading; assumed ones carry a
 * working interpretation; every resolution is stored with the policy version.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests conflicts
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const leaveapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/leave.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Conflicts test failed: ${label} ${detail||""}`);}
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
            approval_route: ["manager", "hr_informed"]}
    ]
});

const RESOLUTIONS = _ => ({
    leave_during_probation: "per_type_eligibility",
    clubbing_window: "per_financial_year",
    half_day_rule: "confirm_not_deduct"});

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "conflicts")) {
        LOG.console("Skipping conflicts test case, not called.\n"); return true;
    }
    LOG.console("\nJ8 policy conflicts\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testGate(w);
        await _testEnforcement(w);
        await _testReader(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  conflicts tests threw: ${err}\n`); LOG.error(`Conflicts tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nConflicts tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

/** Structural conflicts block publish and the refusal names each of them. */
async function _testGate(w) {
    LOG.console("\n unresolved structural conflicts block publish\n");
    const blocked = await _checkThrows("publishing without resolutions is refused", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: POLICY()}));
    _check("the refusal names every blocking conflict with choices",
        blocked.conflicts?.length == 3 &&
        blocked.conflicts.every(conflict => conflict.class == "publish" &&
            conflict.choices.length && conflict.why.length),
        JSON.stringify(blocked.conflicts?.map(c => c.id)));

    const badChoice = await _checkThrows("a choice outside the conflict's options is refused", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: POLICY(),
            resolutions: {...RESOLUTIONS(), clubbing_window: "per_decade"}}));
    _check("the invalid choice is named", /clubbing_window/.test(badChoice.message));

    const mismatch = await _checkThrows("a resolution contradicting the typed policy is refused", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: POLICY(),
            resolutions: {...RESOLUTIONS(), clubbing_window: "per_quarter"}}));
    _check("the contradiction names the type", /EL/.test(mismatch.message));

    const published = await leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
        step_up_verified: true, effective_from: "2026-04-01", policy: POLICY(),
        resolutions: RESOLUTIONS()});
    w.v1 = published.version;
    _check("with resolutions chosen, publish proceeds",
        published.version.version == 1 && published.superseded === null);
    _check("explicit resolutions are stored as explicit",
        published.resolutions.half_day_rule?.source == "explicit" &&
        published.resolutions.half_day_rule?.decided_by == w.carol);
    _check("an assumed conflict stores its working interpretation as default",
        published.resolutions.short_notice_rules?.choice == "2d_foreseeable_4h_floor" &&
        published.resolutions.short_notice_rules?.source == "default");
}

/** The chosen reading changes what the schema will accept. */
async function _testEnforcement(w) {
    LOG.console("\n resolutions are enforced, not decorative\n");
    const noLeave = await _checkThrows("no_leave_during_probation refuses probation eligibility", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: POLICY(),
            resolutions: {...RESOLUTIONS(), leave_during_probation: "no_leave_during_probation"}}));
    _check("the refused type is named", /SNL/.test(noLeave.message));

    const clean = POLICY(); clean.leave_types[1].eligibility = {states: ["active"]};
    const published = await leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
        step_up_verified: true, effective_from: "2026-04-01", policy: clean,
        resolutions: {...RESOLUTIONS(), leave_during_probation: "no_leave_during_probation"}});
    _check("the blanket reading publishes once no type grants probation leave",
        Boolean(published.version.policy_version_id));

    const maternity = POLICY();
    maternity.leave_types.push({code: "ML", label: "Maternity",
        quantum: {annual_days: 182},
        eligibility: {states: ["active"]},
        notice: {multiplier: 0, floor_days: 0, short_notice_approvable: false},
        approval_route: ["manager", "hr"]});
    const legal = await _checkThrows("26 weeks against a 12-week statute blocks for legal", _ =>
        leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
            step_up_verified: true, effective_from: "2026-04-01", policy: maternity,
            resolutions: RESOLUTIONS()}));
    _check("the legal conflict is named with its class",
        legal.conflicts?.some(conflict => conflict.id == "maternity_third_child" &&
            conflict.class == "legal"));
    const decided = await leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol,
        step_up_verified: true, effective_from: "2026-04-01", policy: maternity,
        resolutions: {...RESOLUTIONS(), maternity_third_child: "12w_statutory"}});
    _check("a deliberate legal reading publishes", Boolean(decided.version.policy_version_id));
}

/** The J8 screen reads every conflict with its resolution state. */
async function _testReader(w) {
    LOG.console("\n the conflicts screen reads the record\n");
    const rows = await leave.policyConflictsAsync(w.org_id, w.v1.policy_version_id);
    _check("all seven conflicts are listed", rows.length == 7);
    const halfDay = rows.find(row => row.id == "half_day_rule");
    _check("a resolved conflict shows its explicit choice and who decided",
        halfDay.detected === true && halfDay.resolution == "confirm_not_deduct" &&
        halfDay.source == "explicit" && halfDay.decided_by == w.carol);
    const carry = rows.find(row => row.id == "carry_vs_exit_cap");
    _check("an undetected conflict is shown as not applicable",
        carry.detected === false && carry.resolution === null);
}

/** The API surface. */
async function _testAPI(w) {
    LOG.console("\n the conflicts API\n");
    const published = await leaveapi.doService({op: "publish", id: w.carolEmail, org: w.org_id,
        step_up_verified: true, effective_from: "2026-04-01", policy: POLICY(),
        resolutions: RESOLUTIONS()});
    _check("op publish answers with the conflicts and resolutions",
        published.result === true && Array.isArray(published.conflicts) &&
        published.resolutions.clubbing_window?.choice == "per_financial_year");

    const rows = await leaveapi.doService({op: "conflicts", id: w.carolEmail, org: w.org_id,
        policy_version_id: published.version.policy_version_id});
    _check("op conflicts answers with the full seven-row table",
        rows.result === true && rows.conflicts.length == 7);
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Conflicts test ${stamp}`, home_jurisdiction: "IN"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN",
        contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);

    return {org_id: org.org_id, stamp, carolEmail: `carol.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_ledger_entry WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_request WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_policy_pointer WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_policy_version WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM opening_balance_entry WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
