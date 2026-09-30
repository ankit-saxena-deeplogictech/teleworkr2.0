/**
 * Tests H1/H2 — the lead's team capacity board and its aggregate reports.
 * Capacity is declared hours minus leave; committed is the sum of open
 * tasks' estimates; a ramping new hire is excluded from flagging; an
 * undeclared window never fabricates a zero.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests workload
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const workload = require(`${TELEWORKR_CONSTANTS.LIBDIR}/workload.js`);
const workloadapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/workload.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Workload test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 100)}`, true);}
}

const _today = () => new Date().toISOString().substring(0, 10);
const _addDays = (iso, days) => {const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate()+days); return d.toISOString().substring(0,10);}
const FROM = "2026-06-01", TO = "2026-06-07";   // Mon–Sun, a fixed past week

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "workload")) {
        LOG.console("Skipping workload test case, not called.\n"); return true;
    }
    LOG.console("\nH1/H2 team workload & reports\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testGate(w);
        await _testCapacity(w);
        await _testRamping(w);
        await _testReports(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  workload tests threw: ${err}\n`); LOG.error(`Workload tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nWorkload tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------
// the capability gate
// ---------------------------------------------------------------------------

async function _testGate(w) {
    LOG.console("\n the workload.read gate\n");
    await _checkThrows("an actor with no workload.read grant is refused outright", _ =>
        workload.teamCapacityAsync(w.org_id, w.erin, FROM, TO));
}

// ---------------------------------------------------------------------------
// capacity and committed hours
// ---------------------------------------------------------------------------

async function _testCapacity(w) {
    LOG.console("\n capacity, committed hours, and the flags they produce\n");
    const board = await workload.teamCapacityAsync(w.org_id, w.bob, FROM, TO);
    const alice = board.people.find(p => p.person_id == w.alice);
    const carol = board.people.find(p => p.person_id == w.carol);

    _check("alice's capacity is declared hours minus her one leave day",
        alice.capacity_seconds == 4*8*3600, `${alice.capacity_seconds}`);
    _check("alice's leave day is counted", alice.leave_days == 1);
    _check("alice's committed hours sum her open tasks' estimates, over her capacity",
        alice.committed_seconds == 35*3600, `${alice.committed_seconds}`);
    _check("over-committed alice is flagged over_capacity", alice.flag == "over_capacity");

    _check("carol has no declared window, so capacity is null, never a fabricated zero",
        carol.capacity_seconds === null);
    _check("carol's committed hours are still real, from her one open task",
        carol.committed_seconds == 5*3600);
    _check("with no capacity to compare against, carol gets no flag", carol.flag === null);

    _check("only bob's real direct reports appear on the board",
        !board.people.some(p => p.person_id == w.erin));
    _check("the header count matches the one over-capacity person", board.over_capacity_count == 1);
}

// ---------------------------------------------------------------------------
// a ramping new hire is excluded from flagging
// ---------------------------------------------------------------------------

async function _testRamping(w) {
    LOG.console("\n a ramping new hire is excluded from capacity flags\n");
    const recentFrom = _addDays(_today(), -3), recentTo = _today();
    const board = await workload.teamCapacityAsync(w.org_id, w.bob, recentFrom, recentTo);
    const dave = board.people.find(p => p.person_id == w.dave);
    _check("dave is marked ramping", dave.ramping === true);
    _check("despite being wildly over-committed, ramping suppresses the flag", dave.flag === null,
        JSON.stringify(dave));
}

// ---------------------------------------------------------------------------
// the H2 reports
// ---------------------------------------------------------------------------

async function _testReports(w) {
    LOG.console("\n the aggregate reports\n");
    const reports = await workload.teamReportsAsync(w.org_id, w.bob, FROM, TO);

    _check("blocked time is a real percentage of the team's open work, correctly derived",
        reports.blocked.open_seconds > 0 && reports.blocked.blocked_seconds >= 0 &&
        reports.blocked.percent === Math.round((reports.blocked.blocked_seconds/reports.blocked.open_seconds)*100),
        JSON.stringify(reports.blocked));

    _check("estimate accuracy is the weighted ratio of logged to estimated, over tasks with both",
        reports.estimate_accuracy.tasks_counted == 1 &&
        Math.abs(reports.estimate_accuracy.ratio - (9*3600)/(6*3600)) < 0.001, JSON.stringify(reports.estimate_accuracy));

    _check("utilisation carries billable, total and an honestly-reported unaccounted figure",
        reports.utilisation.billable_seconds == 9*3600 && reports.utilisation.total_seconds == 11*3600 &&
        reports.utilisation.capacity_seconds > reports.utilisation.total_seconds &&
        reports.utilisation.unaccounted_seconds == reports.utilisation.capacity_seconds - reports.utilisation.total_seconds,
        JSON.stringify(reports.utilisation));

    _check("no per-person data appears anywhere in the reports shape",
        !JSON.stringify(reports).includes(w.alice) && !JSON.stringify(reports).includes(w.carol));
}

// ---------------------------------------------------------------------------
// the API surface
// ---------------------------------------------------------------------------

async function _testAPI(w) {
    LOG.console("\n the workload API\n");
    const boardApi = await workloadapi.doService({op: "board", id: w.bobEmail, org: w.org_id,
        from_date: FROM, to_date: TO});
    _check("op board answers true with the people array", boardApi.result === true && Array.isArray(boardApi.people));

    const reportsApi = await workloadapi.doService({op: "reports", id: w.bobEmail, org: w.org_id,
        from_date: FROM, to_date: TO});
    _check("op reports answers true with all three reports",
        reportsApi.result === true && reportsApi.blocked && reportsApi.estimate_accuracy && reportsApi.utilisation);

    const refused = await workloadapi.doService({op: "board", id: w.erinEmail, org: w.org_id,
        from_date: FROM, to_date: TO});
    _check("an actor with no grant is refused with a reason through the API too",
        refused.result === false && /workload.read/.test(refused.reason||""));

    const invalid = await workloadapi.doService({op: "nonsense", id: w.bobEmail, org: w.org_id,
        from_date: FROM, to_date: TO});
    _check("an unknown op is refused", invalid.result === false);
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Workload test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["bob", "alice", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});

    const line = {alice: people.bob.person_id, carol: people.bob.person_id, dave: people.bob.person_id,
        bob: null, erin: null};
    for (const who of Object.keys(people)) {
        const isDave = who == "dave";
        await spine.recordEmploymentAsync({org_id: org.org_id, person_id: people[who].person_id,
            status: "active", jurisdiction: "GB", manager_person_id: line[who], contract_type: "employee",
            valid_from: isDave ? _addDays(_today(), -3) : "2026-01-01", source: "manual"});
    }

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    for (const who of ["alice", "carol", "dave", "erin"])
        await permissions.assignRoleAsync(org.org_id, people[who].person_id, "employee", from);

    // alice: a declared 8h/day window, Mon–Fri
    await windows.setWindowAsync({org_id: org.org_id, person_id: people.alice.person_id, timezone: "Etc/UTC",
        start_minute: 540, end_minute: 1020, days: [1,2,3,4,5], valid_from: "2026-01-01"});
    // dave: same, so his committed-vs-capacity ratio would read as over_capacity if not for ramping
    await windows.setWindowAsync({org_id: org.org_id, person_id: people.dave.person_id, timezone: "Etc/UTC",
        start_minute: 540, end_minute: 1020, days: [1,2,3,4,5], valid_from: "2026-01-01"});
    // carol: no window declared at all — undeclared

    // alice's one leave day inside the range, inserted directly (the projection only reads status='approved')
    await dblayer.runCmdOrThrow(
        `INSERT INTO leave_request (leave_request_id, org_id, person_id, leave_type, from_date, to_date,
            days_requested, days_deducted, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [`${stamp}-leave`, org.org_id, people.alice.person_id, "EL", "2026-06-03", "2026-06-03", 1, 1,
            "approved", Math.floor(Date.now()/1000)]);

    // alice: two open tasks totalling 35h estimated (over her 32h capacity), one with real logged time too
    const task1 = await tasks.createTaskAsync({org_id: org.org_id, actor_person_id: people.bob.person_id,
        title: "estimate task", assignee_person_id: people.alice.person_id, estimate_minutes: 6*60});
    await tasks.createTaskAsync({org_id: org.org_id, actor_person_id: people.bob.person_id,
        title: "second task", assignee_person_id: people.alice.person_id, estimate_minutes: 29*60});
    // 9h logged against the 6h-estimate task — the pair the estimate-accuracy report counts
    await time.recordEventAsync({org_id: org.org_id, person_id: people.alice.person_id, entry_date: FROM,
        client_event_id: `${stamp}-est`, task_ref: task1.task_ref, duration_seconds: 9*3600,
        billable: true, source: "manual"});
    // 2h more logged, non-billable, no task — utilisation's own non-billable half
    await time.recordEventAsync({org_id: org.org_id, person_id: people.alice.person_id, entry_date: FROM,
        client_event_id: `${stamp}-nonbill`, duration_seconds: 2*3600, billable: false, source: "manual"});

    // carol: no window, one open task with a real estimate
    await tasks.createTaskAsync({org_id: org.org_id, actor_person_id: people.bob.person_id,
        title: "carol's task", assignee_person_id: people.carol.person_id, estimate_minutes: 5*60});

    // dave: a huge estimate, so ramping is the only thing suppressing over_capacity
    await tasks.createTaskAsync({org_id: org.org_id, actor_person_id: people.bob.person_id,
        title: "dave's pile", assignee_person_id: people.dave.person_id, estimate_minutes: 200*60});

    // someone on the team is genuinely blocked, for the blocked-time report — backdated
    // deterministically, since blockedLoadForPersonAsync measures real elapsed time and
    // a task created moments ago floors to zero seconds old, same class of timing
    // fragility this session already hit once in A9's own notification tests.
    const now = Math.floor(Date.now()/1000);
    const blocker = await tasks.createTaskAsync({org_id: org.org_id, actor_person_id: people.bob.person_id,
        title: "blocker", assignee_person_id: people.alice.person_id});
    const blocked = await tasks.createTaskAsync({org_id: org.org_id, actor_person_id: people.bob.person_id,
        title: "blocked", assignee_person_id: people.carol.person_id});
    await dblayer.runCmdOrThrow("UPDATE task SET created_at=? WHERE task_id IN (?,?)",
        [now - 7200, blocker.task_id, blocked.task_id]);
    await tasks.addBlockAsync({org_id: org.org_id, actor_person_id: people.bob.person_id,
        blocked_task_ref: blocked.task_ref, blocker_task_ref: blocker.task_ref, reason: "waiting"});
    await dblayer.runCmdOrThrow(
        "UPDATE task_relation SET created_at=? WHERE org_id=? AND to_task_id=? AND relation_type='blocks'",
        [now - 3600, org.org_id, blocked.task_id]);

    return {org_id: org.org_id, stamp, bobEmail: `bob.${stamp}@example.invalid`, erinEmail: `erin.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["task_relation", "task_event", "task", "leave_request", "timesheet_entry",
        "time_entry_event", "timesheet", "working_window", "role_capability", "role", "capability_grant",
        "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["bob", "alice", "carol", "dave", "erin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
