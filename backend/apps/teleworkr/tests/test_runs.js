/**
 * Tests J7 — the scheduled runs. Accrual, year-end lapse and the absence sweep:
 * each previewable before it executes, idempotent per period, batch-tagged on
 * the ledger, reversible by negating the batch — and the sweep detects and
 * routes, never actions.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests runs
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const setup = require(`${TELEWORKR_CONSTANTS.LIBDIR}/setup.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const runs = require(`${TELEWORKR_CONSTANTS.LIBDIR}/runs.js`);
const runsapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/runs.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Runs test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

const POLICY = _ => ({
    scope: {jurisdiction: "IN", contract_type: "employee", status: ["active", "probation"]},
    leave_types: [
        {code: "EL", label: "Earned leave",
            quantum: {annual_days: 12},
            accrual: {per_month: 1},
            eligibility: {states: ["active"]},
            notice: {multiplier: 3, floor_days: 3, short_notice_approvable: true},
            max_per_request: 6,
            max_per_period: {days: 20, period: "quarter"},
            carry_forward: {cap_days: 3},
            clubbing: {mode: "exempt_first", window: "per_financial_year"},
            approval_route: ["manager"]},
        {code: "SNL", label: "Short notice leave",
            quantum: {annual_days: 3},
            accrual: {per_month: 0},
            eligibility: {states: ["active", "probation"]},
            notice: {multiplier: 0, floor_days: 0, short_notice_approvable: true},
            approval_route: ["manager"]}
    ]
});

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "runs")) {
        LOG.console("Skipping runs test case, not called.\n"); return true;
    }
    LOG.console("\nJ7 scheduled runs\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testAccrualRun(w);
        await _testLapseRun(w);
        await _testSweep(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  runs tests threw: ${err}\n`); LOG.error(`Runs tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nRuns tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

/** Accrual: preview, execute with a batch tag, refuse repeats, reverse the batch. */
async function _testAccrualRun(w) {
    LOG.console("\n the monthly accrual run\n");
    const preview = await runs.previewRunAsync({org_id: w.org_id, actor_person_id: w.carol,
        kind: "accrual", period: "2026-08"});
    _check("the preview names the scope and the owed rows",
        preview.scope_count == 5 && preview.affected_count == 32,
        `${preview.scope_count} / ${preview.affected_count}`);

    const executed = await runs.executeRunAsync({org_id: w.org_id, actor_person_id: w.carol,
        kind: "accrual", period: "2026-08", batch_id: "acc-aug-2026"});
    _check("execution writes the owed rows in one batch",
        executed.affected_count == 32 &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM leave_ledger_entry WHERE org_id=? AND batch_id=? AND kind='accrual'",
            [w.org_id, "acc-aug-2026"]))[0].c == 32);

    const runRow = (await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_run WHERE org_id=? AND run_id=?", [w.org_id, executed.run_id]))[0];
    _check("the run is a record with its operator and scope",
        runRow.status == "executed" && runRow.operator_person_id == w.carol &&
        runRow.scope_count == 5 && runRow.affected_count == 32);
    _check("the run is audited with the batch id",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM audit_event WHERE action='leave_run.executed' AND object_ref=?",
            [executed.run_id])).length == 1);

    await _checkThrows("a second execution of the same period is refused", _ =>
        runs.executeRunAsync({org_id: w.org_id, actor_person_id: w.carol,
            kind: "accrual", period: "2026-08", batch_id: "acc-aug-2026"}));

    const again = await runs.previewRunAsync({org_id: w.org_id, actor_person_id: w.carol,
        kind: "accrual", period: "2026-08"});
    _check("after the run, the preview shows nothing owed", again.affected_count == 0);

    const after = (await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", asOf: "2026-08-31"})).available;
    _check("the accruals are in the balance", after == 28, `${after}`);

    const reversed = await runs.reverseRunAsync({org_id: w.org_id, actor_person_id: w.carol,
        run_id: executed.run_id});
    _check("reversing removes the batch as a unit",
        reversed.reversed_entries == 32 &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM leave_ledger_entry WHERE org_id=? AND batch_id=?",
            [w.org_id, "acc-aug-2026"]))[0].c == 0);
    _check("the reversal is audited",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM audit_event WHERE action='leave_run.reversed' AND object_ref=?",
            [executed.run_id])).length == 1);

    const restored = (await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", asOf: "2026-08-31"})).available;
    _check("the on-demand projection is the same before and after", restored == 28, `${restored}`);

    await _checkThrows("a second reversal is refused", _ =>
        runs.reverseRunAsync({org_id: w.org_id, actor_person_id: w.carol, run_id: executed.run_id}));

    const rerun = await runs.executeRunAsync({org_id: w.org_id, actor_person_id: w.carol,
        kind: "accrual", period: "2026-08", batch_id: "acc-aug-2026b"});
    _check("a reversed run can be run again, materialising only what is still owed",
        rerun.affected_count == 24, `${rerun.affected_count}`);
    await runs.reverseRunAsync({org_id: w.org_id, actor_person_id: w.carol, run_id: rerun.run_id});
}

/** Year-end: EL lapses above the carry cap; uncapped types lapse entirely. */
async function _testLapseRun(w) {
    LOG.console("\n the year-end carry and lapse run\n");
    const preview = await runs.previewRunAsync({org_id: w.org_id, actor_person_id: w.carol,
        kind: "lapse", period: "2027-03-31"});
    _check("the preview computes each person's lapse",
        preview.scope_count == 5 && preview.affected_count == 5,
        `${preview.scope_count} / ${preview.affected_count}`);
    const alice = preview.detail.lapses.filter(lapse => lapse.person_id == w.alice);
    _check("EL above the carry cap and all of SNL lapse",
        alice.length == 2 && alice.find(l => l.leave_type == "EL")?.days == -32 &&
        alice.find(l => l.leave_type == "SNL")?.days == -3,
        JSON.stringify(alice));

    const executed = await runs.executeRunAsync({org_id: w.org_id, actor_person_id: w.carol,
        kind: "lapse", period: "2027-03-31", batch_id: "lapse-fy2026"});
    _check("execution writes the lapse entries batch-tagged",
        executed.affected_count == 5 &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM leave_ledger_entry WHERE org_id=? AND batch_id=? AND kind='lapse'",
            [w.org_id, "lapse-fy2026"]))[0].c == 5);

    const capped = (await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", asOf: "2027-03-31"})).available;
    const gone = (await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "SNL", asOf: "2027-03-31"})).available;
    _check("the balance lands on the carry cap and zero",
        capped == 3 && gone == 0, `${capped} / ${gone}`);

    const reversed = await runs.reverseRunAsync({org_id: w.org_id, actor_person_id: w.carol,
        run_id: executed.run_id});
    const restoredEL = (await leave.balanceAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", asOf: "2027-03-31"})).available;
    _check("reversing restores the pre-lapse balance",
        reversed.reversed_entries == 5 && restoredEL == 35, `${restoredEL}`);
}

/** The absence sweep detects and names — it never actions. */
async function _testSweep(w) {
    LOG.console("\n the unauthorised absence sweep\n");
    for (const [iso, ref] of [["2026-09-07", "1"], ["2026-09-09", "2"], ["2026-09-11", "3"]])
        await time.recordEventAsync({org_id: w.org_id, person_id: w.bob, entry_date: iso,
            client_event_id: `sweep-bob-${ref}`, task_ref: "TASK-1", source: "timer",
            started_at: Math.floor(Date.parse(`${iso}T12:00:00Z`)/1000)});

    const cover = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.carol,
        leave_type: "EL", from_date: "2026-09-07", to_date: "2026-09-11", notice_days: 20});
    await leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
        leave_request_id: cover.request.leave_request_id});

    const preview = await runs.previewRunAsync({org_id: w.org_id, actor_person_id: w.carol,
        kind: "absence_sweep", period: "2026-09-07", to_date: "2026-09-13"});
    _check("exactly the unclocked, unrequested person is flagged",
        preview.affected_count == 1 && preview.detail.flags[0].person_id == w.alice &&
        preview.detail.flags[0].days.length == 5,
        JSON.stringify(preview.detail.flags));
    _check("clock-ins on alternating days break every streak",
        !preview.detail.flags.some(flag => flag.person_id == w.bob));
    _check("approved leave covering the days is not absence",
        !preview.detail.flags.some(flag => flag.person_id == w.carol));
    _check("someone without declared hours is not swept",
        !preview.detail.flags.some(flag => flag.person_id == w.erin));

    const executed = await runs.executeRunAsync({org_id: w.org_id, actor_person_id: w.carol,
        kind: "absence_sweep", period: "2026-09-07", to_date: "2026-09-13"});
    const runRow = (await dblayer.getQueryOrThrow(
        "SELECT * FROM leave_run WHERE org_id=? AND run_id=?", [w.org_id, executed.run_id]))[0];
    _check("the sweep run records the flags and writes no ledger rows",
        runRow.affected_count == 1 && JSON.parse(runRow.detail).flags.length == 1 &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM leave_ledger_entry WHERE org_id=? AND batch_id=?",
            [w.org_id, executed.batch_id]))[0].c == 0);
    await runs.reverseRunAsync({org_id: w.org_id, actor_person_id: w.carol, run_id: executed.run_id});
}

/** The API surface: preview, execute, reverse, list — and the permission gate. */
async function _testAPI(w) {
    LOG.console("\n the runs API\n");
    const preview = await runsapi.doService({op: "preview", id: w.carolEmail, org: w.org_id,
        kind: "lapse", period: "2027-03-31"});
    _check("op preview answers with the computed facts",
        preview.result === true && preview.affected_count == 5);

    const executed = await runsapi.doService({op: "execute", id: w.carolEmail, org: w.org_id,
        kind: "lapse", period: "2027-03-31", batch_id: "api-lapse"});
    _check("op execute runs the batch", executed.result === true && executed.affected_count == 5 &&
        Boolean(executed.run_id));

    const reversed = await runsapi.doService({op: "reverse", id: w.carolEmail, org: w.org_id,
        run_id: executed.run_id});
    _check("op reverse negates the batch", reversed.result === true && reversed.reversed_entries == 5);

    const list = await runsapi.doService({op: "list", id: w.carolEmail, org: w.org_id});
    _check("op list shows the run history", list.result === true && list.runs.length == 5,
        `${list.runs?.length}`);

    const refused = await runsapi.doService({op: "execute", id: w.erinEmail, org: w.org_id,
        kind: "lapse", period: "2027-03-31"});
    _check("a person without leave_run.operate is refused with a reason",
        refused.result === false && /No grant/.test(refused.reason||""), refused.reason);
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Runs test ${stamp}`, home_jurisdiction: "IN"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    const line = {alice: people.bob.person_id, carol: people.bob.person_id};
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active",
        jurisdiction: who == "dave" ? "GB" : "IN",
        manager_person_id: line[who] || null, contract_type: "employee",
        valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);
    await permissions.assignRoleAsync(org.org_id, people.erin.person_id, "employee", from);

    await leave.publishPolicyAsync({org_id: org.org_id, actor_person_id: people.carol.person_id,
        step_up_verified: true, effective_from: "2026-04-01", policy: POLICY(),
        resolutions: {leave_during_probation: "per_type_eligibility",
            clubbing_window: "per_financial_year"}});

    await setup.importBalancesAsync({org_id: org.org_id, actor_person_id: people.dave.person_id,
        rows: [{email: `alice.${stamp}@example.invalid`, leave_type: "EL", days: 20},
            {email: `alice.${stamp}@example.invalid`, leave_type: "SNL", days: 3}],
        source: "spreadsheet", cutover_date: "2026-04-01", commit: true});

    for (const who of ["alice", "bob", "carol"])
        await windows.setWindowAsync({org_id: org.org_id, person_id: people[who].person_id,
            timezone: "Etc/GMT", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
            valid_from: "2026-01-01"});

    return {org_id: org.org_id, stamp, carolEmail: `carol.${stamp}@example.invalid`,
        erinEmail: `erin.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_ledger_entry WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_request WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_run WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_policy_pointer WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM leave_policy_version WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM opening_balance_entry WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM import_batch WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM working_window WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
