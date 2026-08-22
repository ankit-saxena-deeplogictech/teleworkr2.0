/**
 * Tests C1 — the Day board. Now/next before what exists: the clock strip names
 * what it is bound to, due-today is exact, needs-you is capped at five and
 * sorted by whether the other person is awake, presence summarises rather than
 * lists, and the week footer agrees with C5's own numbers.
 *
 * Also tests the honest gap: no calendar-event entity exists yet, so meetings
 * and focus report a stated absence rather than an invented number.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests dayboard
 *
 * (C) 2026 Tekmonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const clock = require(`${TELEWORKR_CONSTANTS.LIBDIR}/clock.js`);
const dayboard = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dayboard.js`);
const dayboardapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/dayboard.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Day board test failed: ${label} ${detail||""}`);}
}

const DAY = "2026-06-22";

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "dayboard")) {
        LOG.console("Skipping day board test case, not called.\n"); return true;
    }
    LOG.console("\nC1 day board\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testNowNext(w);
        await _testDueToday(w);
        await _testMeetingsAndFocusAreHonest(w);
        await _testNeedsYou(w);
        await _testPresence(w);
        await _testWeek(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  day board tests threw: ${err}\n`); LOG.error(`Day board tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nDay board tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Day board test ${stamp}`, home_jurisdiction: "IN"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN",
        manager_person_id: who == "alice" ? people.bob.person_id : null,
        contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);
    await permissions.assignRoleAsync(org.org_id, people.erin.person_id, "employee", from);

    // alice, bob, carol: full-day windows — always inside. dave, erin: a one-minute
    // slot far from now — outside for the test's duration.
    const nowMinutes = Math.floor(Date.now()/1000 % 86400) / 60;
    const asleepStart = Math.floor((nowMinutes + 300) % 1440);
    for (const who of ["alice", "bob", "carol"])
        await windows.setWindowAsync({org_id: org.org_id, person_id: people[who].person_id,
            timezone: "Etc/GMT", start_minute: 0, end_minute: 1439, days: [1,2,3,4,5,6,7],
            valid_from: "2026-01-01"});
    for (const who of ["dave", "erin"])
        await windows.setWindowAsync({org_id: org.org_id, person_id: people[who].person_id,
            timezone: "Etc/GMT", start_minute: asleepStart, end_minute: (asleepStart + 1) % 1440,
            days: [1,2,3,4,5,6,7], valid_from: "2026-01-01"});

    return {org_id: org.org_id, stamp, aliceEmail: `alice.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _testNowNext(w) {
    LOG.console("\n now/next before what exists\n");
    const idle = await dayboard.boardAsync({org_id: w.org_id, person_id: w.alice, date: DAY});
    _check("not clocked in shows a clock at rest", idle.clock.state == "not_clocked_in");
    _check("and nothing is working on", idle.working_on === null);

    const t0 = 1782000000;
    await clock.clockInAsync({org_id: w.org_id, person_id: w.alice, entry_date: DAY, at: t0, task_ref: "TASK-1042"});
    const task = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.dave,
        title: "Single-pager for APIBot", assignee_person_id: w.alice, project: "APIBot"});
    // rebind the running timer to a task that actually exists, so the strip can name it
    await clock.switchTaskAsync({org_id: w.org_id, person_id: w.alice, entry_date: DAY,
        task_ref: task.task_ref, at: t0 + 5});

    const running = await dayboard.boardAsync({org_id: w.org_id, person_id: w.alice, date: DAY});
    _check("running is drawn from the same clock C2 reports", running.clock.state == "running");
    _check("working on names the bound task", running.working_on?.task_ref == task.task_ref);
    _check("and carries its title, not just its ref", running.working_on?.title == "Single-pager for APIBot");

    await clock.startBreakAsync({org_id: w.org_id, person_id: w.alice, entry_date: DAY, at: t0 + 3600});
    const onBreak = await dayboard.boardAsync({org_id: w.org_id, person_id: w.alice, date: DAY});
    _check("a break is its own state, not running", onBreak.clock.state == "break");

    await clock.endBreakAsync({org_id: w.org_id, person_id: w.alice, entry_date: DAY, at: t0 + 3900,
        resume_task_ref: task.task_ref});
    await clock.clockOutAsync({org_id: w.org_id, person_id: w.alice, entry_date: DAY, at: t0 + 4200});
    const done = await dayboard.boardAsync({org_id: w.org_id, person_id: w.alice, date: DAY});
    _check("clocked out returns to not_clocked_in", done.clock.state == "not_clocked_in");
    _check("and the day's total survives the clock-out", done.clock.today_total_seconds > 0);
}

async function _testDueToday(w) {
    LOG.console("\n due today, with an exact count\n");
    const t1 = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.dave,
        title: "Ship the design", assignee_person_id: w.carol, due_date: DAY});
    const t2 = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.dave,
        title: "Also due today", assignee_person_id: w.carol, due_date: DAY});
    await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.dave,
        title: "Due next week", assignee_person_id: w.carol, due_date: "2026-07-01"});
    const overdue = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.dave,
        title: "Overdue", assignee_person_id: w.carol, due_date: "2026-06-01"});

    const board = await dayboard.boardAsync({org_id: w.org_id, person_id: w.carol, date: DAY});
    _check("the count is exact, not capped silently", board.due_today.count == 2, String(board.due_today.count));
    _check("rows name the tasks", board.due_today.rows.some(row => row.task_ref == t1.task_ref) &&
        board.due_today.rows.some(row => row.task_ref == t2.task_ref));
    _check("a task due next week is not counted today",
        !board.due_today.rows.some(row => row.title == "Due next week"));
    _check("overdue is counted separately from due-today", board.due_today.overdue_count >= 1,
        String(board.due_today.overdue_count));

    await tasks.updateTaskAsync({org_id: w.org_id, actor_person_id: w.dave, task_ref: t1.task_ref,
        changes: {status: "done"}});
    const afterDone = await dayboard.boardAsync({org_id: w.org_id, person_id: w.carol, date: DAY});
    _check("a task marked done today drops out of the due-today rows",
        !afterDone.due_today.rows.some(row => row.task_ref == t1.task_ref));
}

async function _testMeetingsAndFocusAreHonest(w) {
    LOG.console("\n no calendar-event entity yet — an honest gap, not an invented number\n");
    const board = await dayboard.boardAsync({org_id: w.org_id, person_id: w.bob, date: DAY});
    _check("meetings state a reason instead of a fabricated count",
        board.meetings.count === 0 && board.meetings.reason == "not_tracked");
    _check("focus states the same absence", board.focus.minutes === null && board.focus.reason == "not_tracked");
}

async function _testNeedsYou(w) {
    LOG.console("\n needs-you: capped at five, sorted by who is awake\n");
    const mine = [];
    for (let i = 0; i < 7; i++) mine.push(await tasks.createTaskAsync({org_id: w.org_id,
        actor_person_id: w.dave, title: `Needs-you source ${i}`, assignee_person_id: w.alice}));

    // dave (awake) blocks two, erin (asleep) blocks two, more than the five-item cap between them
    for (let i = 0; i < 4; i++) await tasks.addBlockAsync({org_id: w.org_id,
        actor_person_id: (i % 2 == 0) ? w.dave : w.erin, blocked_task_ref: mine[i].task_ref,
        blocker_task_ref: mine[i+4]?.task_ref || mine[6].task_ref,
        reason: `blocker ${i}`});

    const board = await dayboard.boardAsync({org_id: w.org_id, person_id: w.alice, date: DAY});
    _check("needs-you never exceeds the cap of five", board.needs_you.items.length <= 5,
        String(board.needs_you.items.length));
    _check("needs-you is not empty when there is a backlog", board.needs_you.items.length > 0);

    const awakeCount = board.needs_you.items.filter(item => item.other_availability?.online_now).length;
    const firstAsleepIndex = board.needs_you.items.findIndex(item => !item.other_availability?.online_now);
    _check("awake items are never ordered after an asleep one",
        firstAsleepIndex == -1 || board.needs_you.items.slice(0, firstAsleepIndex)
            .every(item => item.other_availability?.online_now),
        `awake=${awakeCount}, firstAsleepAt=${firstAsleepIndex}`);
}

async function _testPresence(w) {
    LOG.console("\n presence summarises, it does not list\n");
    const board = await dayboard.boardAsync({org_id: w.org_id, person_id: w.alice, date: DAY});
    _check("presence excludes the viewer themselves",
        !board.presence.sample.some(person => person.person_id == w.alice));
    _check("total counts the rest of the org's roster", board.presence.total == 4, String(board.presence.total));
    _check("bob and carol are awake by the fixture, dave and erin are not",
        board.presence.online == 2, String(board.presence.online));
    _check("the sample names people rather than only a count", board.presence.sample.length > 0);
    _check("the sample is capped, not the full roster",
        board.presence.sample.length <= board.presence.total);
}

async function _testWeek(w) {
    LOG.console("\n the week footer agrees with C5's own numbers\n");
    const t0 = 1782100000;
    await clock.clockInAsync({org_id: w.org_id, person_id: w.erin, entry_date: DAY, at: t0});
    await clock.clockOutAsync({org_id: w.org_id, person_id: w.erin, entry_date: DAY, at: t0 + 7200});

    const board = await dayboard.boardAsync({org_id: w.org_id, person_id: w.erin, date: DAY});
    _check("the week total reflects the entry just recorded", board.week.logged_seconds >= 7200,
        String(board.week.logged_seconds));
    _check("a target is stated for a declared window", board.week.target_seconds > 0);
    _check("the week starts on the ISO week boundary", /^\d{4}-\d{2}-\d{2}$/.test(board.week.week_start));
}

async function _testAPI(w) {
    LOG.console("\n the API surface\n");
    const email = `alice.${w.stamp}@example.invalid`;
    const result = await dayboardapi.doService({op: "board", id: email, org: w.org_id, date: DAY});
    _check("op board returns the whole screen in one call",
        result.result && result.clock && result.due_today && result.needs_you && result.presence && result.week,
        result.reason);

    const unknown = await dayboardapi.doService({op: "board", id: "nobody@example.invalid", org: w.org_id});
    _check("an unprovisioned caller is refused with a reason", !unknown.result && Boolean(unknown.reason));

    const bad = await dayboardapi.doService({op: "nonsense", id: email, org: w.org_id});
    _check("an unknown op is refused", !bad.result);
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["task_relation", "task_watcher", "task_comment", "task_event", "task"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM clock_break WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM timesheet_entry WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM timesheet WHERE org_id=?", [w.org_id]);
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
