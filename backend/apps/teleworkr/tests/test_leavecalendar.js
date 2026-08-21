/**
 * Tests J6 — the org calendar projection. Approved leave is a fact: it names a
 * person "on leave" on the E3 board (excluded from the shared window) and it
 * excludes and labels the day in the C5 weekly target. Pending requests are not
 * facts yet, and a cancellation unwinds the facts with the reversal.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests leavecalendar
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const setup = require(`${TELEWORKR_CONSTANTS.LIBDIR}/setup.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const calendar = require(`${TELEWORKR_CONSTANTS.LIBDIR}/calendar.js`);
const calendarapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/calendar.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Leave calendar test failed: ${label} ${detail||""}`);}
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
            clubbing: {mode: "exempt_first", window: "per_financial_year"},
            approval_route: ["manager"]}
    ]
});

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "leavecalendar")) {
        LOG.console("Skipping leave calendar test case, not called.\n"); return true;
    }
    LOG.console("\nJ6 leave calendar\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testFacts(w);
        await _testBoard(w);
        await _testWeekTarget(w);
        await _testCancellationUnwinds(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  leave calendar tests threw: ${err}\n`); LOG.error(`Leave calendar tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nLeave calendar tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

/** Approved leave is the only fact; pending stays invisible. */
async function _testFacts(w) {
    LOG.console("\n approved leave is a fact; pending is not\n");
    const r1 = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-09-14", to_date: "2026-09-15", notice_days: 20});
    w.leaveRequest = r1.request;
    await leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
        leave_request_id: r1.request.leave_request_id});

    const r2 = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-09-22", to_date: "2026-09-23", notice_days: 20});
    w.pendingRequest = r2.request;

    const onLeave = await calendar.onLeaveAsync(w.org_id, [w.alice, w.bob], "2026-09-15");
    _check("the approved request names the person on leave",
        onLeave.length == 1 && onLeave[0].person_id == w.alice &&
        onLeave[0].leave_type == "EL" && onLeave[0].to_date == "2026-09-15");

    const covered = await calendar.dayFactsAsync(w.org_id, w.alice, "2026-09-14");
    _check("the covered day is labelled with the leave fact",
        covered.leave && covered.leave[0].from_date == "2026-09-14");

    const gap = await calendar.dayFactsAsync(w.org_id, w.alice, "2026-09-16");
    _check("a day outside the range is not on leave", gap.leave === null);

    const pending = await calendar.dayFactsAsync(w.org_id, w.alice, "2026-09-22");
    _check("a pending request is not a fact yet", pending.leave === null);

    _check("public holidays stay null until the holiday calendar exists",
        covered.public_holiday === null);
}

/** E3: the board excludes and names the on-leave person instead of counting hours. */
async function _testBoard(w) {
    LOG.console("\n the board shows leave, not phantom availability\n");
    const normal = await calendar.teamBoardAsync(w.org_id, [w.alice, w.bob], "2026-09-17");
    _check("an ordinary day overlaps the full shared window",
        normal.shared_minutes == 480 && normal.on_leave.length == 0,
        `${normal.shared_minutes} / ${normal.on_leave.length}`);

    const board = await calendar.teamBoardAsync(w.org_id, [w.alice, w.bob, w.erin], "2026-09-15");
    _check("the on-leave person is named on the board",
        board.on_leave.length == 1 && board.on_leave[0].person_id == w.alice);
    _check("the per-person row carries the leave state",
        board.per_person.find(p => p.person_id == w.alice)?.reason == "on_leave");
    _check("the unavailable list names the person",
        board.unavailable.length == 1 && board.unavailable[0].person_id == w.alice);
    _check("leave is excluded from the shared window, not counted as work",
        board.shared_minutes == 480, `${board.shared_minutes}`);
    _check("a person who never declared hours stays named undeclared",
        board.undeclared.includes(w.erin));
}

/** C5: the target counts only working days, with leave excluded and labelled. */
async function _testWeekTarget(w) {
    LOG.console("\n the weekly target excludes and labels leave days\n");
    const target = await calendar.weekTargetAsync(w.org_id, w.alice, "2026-09-18");
    _check("the week starts at the Monday", target.week_start == "2026-09-14");
    _check("two leave days take the target from five days to three",
        target.working_days == 3 && target.target_seconds == 3*480*60,
        `${target.working_days} / ${target.target_seconds}`);
    _check("the leave days are excluded with their label",
        target.excluded_days.filter(d => d.reason == "leave").length == 2 &&
        target.excluded_days.filter(d => d.reason == "leave")
            .every(d => ["2026-09-14", "2026-09-15"].includes(d.date) && d.leave_type == "EL"));
    _check("the weekend is excluded as off days",
        target.excluded_days.filter(d => d.reason == "off_day").length == 2);
    _check("a working day carries its own target",
        target.per_day.find(d => d.date == "2026-09-16")?.target_seconds == 480*60);

    const full = await calendar.weekTargetAsync(w.org_id, w.bob, "2026-09-18");
    _check("a week without leave keeps the full five-day target",
        full.target_seconds == 5*480*60 && full.working_days == 5,
        `${full.target_seconds}`);
}

/** Cancelling the approved request unwinds the facts — nothing is edited, the reversal is the record. */
async function _testCancellationUnwinds(w) {
    LOG.console("\n cancellation unwinds the calendar facts\n");
    await leave.cancelLeaveRequestAsync({org_id: w.org_id, person_id: w.alice,
        leave_request_id: w.leaveRequest.leave_request_id});

    const facts = await calendar.dayFactsAsync(w.org_id, w.alice, "2026-09-15");
    _check("a cancelled request stops being a leave fact", facts.leave === null);

    const onLeave = await calendar.onLeaveAsync(w.org_id, [w.alice], "2026-09-15");
    _check("the board no longer names the person on leave", onLeave.length == 0);

    const target = await calendar.weekTargetAsync(w.org_id, w.alice, "2026-09-18");
    _check("the target is restored with only the weekend excluded",
        target.target_seconds == 5*480*60 &&
        target.excluded_days.every(d => d.reason == "off_day"),
        `${target.target_seconds}`);
}

/** The API surface for the board and the target. */
async function _testAPI(w) {
    LOG.console("\n the calendar API\n");
    const r3 = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-10-05", to_date: "2026-10-06", notice_days: 20});
    await leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
        leave_request_id: r3.request.leave_request_id});

    const board = await calendarapi.doService({op: "board", id: w.carolEmail, org: w.org_id,
        person_ids: [w.alice, w.bob], date: "2026-10-05"});
    _check("op board projects the overlap with the leave wired in",
        board.result === true && board.on_leave.length == 1 && board.shared_minutes == 480,
        JSON.stringify({result: board.result, on_leave: board.on_leave?.length, shared: board.shared_minutes}));

    const facts = await calendarapi.doService({op: "day_facts", id: w.aliceEmail, org: w.org_id,
        date: "2026-10-05"});
    _check("op day_facts labels the leave day", facts.result === true &&
        facts.leave && facts.leave[0].leave_type == "EL");

    const target = await calendarapi.doService({op: "week_target", id: w.bobEmail, org: w.org_id,
        person_id: w.alice, week_start: "2026-10-08"});
    _check("op week_target excludes and labels the leave days",
        target.result === true && target.week_start == "2026-10-05" &&
        target.target_seconds == 3*480*60 &&
        target.excluded_days.filter(d => d.reason == "leave").length == 2,
        JSON.stringify({week_start: target.week_start, target: target.target_seconds,
            excluded: target.excluded_days?.length}));
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `LeaveCalendar test ${stamp}`, home_jurisdiction: "IN"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    const line = {alice: people.bob.person_id};
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

    await leave.publishPolicyAsync({org_id: org.org_id, actor_person_id: people.carol.person_id,
        step_up_verified: true, effective_from: "2026-04-01", policy: POLICY()});

    await setup.importBalancesAsync({org_id: org.org_id, actor_person_id: people.dave.person_id,
        rows: [{email: `alice.${stamp}@example.invalid`, leave_type: "EL", days: 20}],
        source: "spreadsheet", cutover_date: "2026-04-01", commit: true});

    for (const who of ["alice", "bob", "carol"])
        await windows.setWindowAsync({org_id: org.org_id, person_id: people[who].person_id,
            timezone: "Etc/GMT", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
            valid_from: "2026-01-01"});

    return {org_id: org.org_id, stamp, aliceEmail: `alice.${stamp}@example.invalid`,
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
