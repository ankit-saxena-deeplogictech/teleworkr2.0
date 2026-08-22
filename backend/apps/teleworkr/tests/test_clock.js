/**
 * Tests A11 — the mobile clock's backend: the clock-status projection (today's
 * total with the running entry measured to now, the window's local end) and the
 * reconnect sync that replays offline-buffered events idempotently, reporting
 * conflicts instead of guessing.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests clock
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const calendar = require(`${TELEWORKR_CONSTANTS.LIBDIR}/calendar.js`);
const clockapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/clock.js`);
const clock = require(`${TELEWORKR_CONSTANTS.LIBDIR}/clock.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Clock test failed: ${label} ${detail||""}`);}
}

const _today = () => new Date().toISOString().substring(0, 10);

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true);}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "clock")) {
        LOG.console("Skipping clock test case, not called.\n"); return true;
    }
    LOG.console("\nA11 clock\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testStatus(w);
        await _testSync(w);
        await _testClockControl(w);
        await _testBreaks(w);
        await _testIdle(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  clock tests threw: ${err}\n`); LOG.error(`Clock tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nClock tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

/** Today's numbers, recomputed: the running entry projects to now. */
async function _testStatus(w) {
    LOG.console("\n the clock status projection\n");
    const day = _today();
    const quiet = await calendar.clockStatusAsync(w.org_id, w.alice, day);
    _check("an idle clock answers zero with its window",
        quiet.today_total_seconds == 0 && quiet.running === null &&
        quiet.window?.start_minute == 540 && quiet.workday === true &&
        quiet.window_ends_at_minute == 1020, JSON.stringify(quiet));

    const now = Math.floor(Date.now()/1000);
    const completed = await time.recordEventAsync({org_id: w.org_id, person_id: w.alice,
        entry_date: day, client_event_id: "clock-done", task_ref: "TASK-1", source: "timer",
        started_at: now - 3*3600, ended_at: now - 3600});
    const startedAt = now - 1800;
    await time.recordEventAsync({org_id: w.org_id, person_id: w.alice,
        entry_date: day, client_event_id: "clock-running", task_ref: "TASK-2", source: "timer",
        started_at: startedAt});

    const elapsed = Math.floor(Date.now()/1000) - startedAt;
    const status = await calendar.clockStatusAsync(w.org_id, w.alice, day);
    _check("the running entry is projected to now, on the same clock",
        Math.abs(status.today_total_seconds - (7200 + elapsed)) <= 2 &&
        status.running?.task_ref == "TASK-2" &&
        Math.abs(status.running.elapsed_seconds - elapsed) <= 2,
        `${status.today_total_seconds} / ${status.running?.elapsed_seconds}`);

    await time.editOwnAsync({org_id: w.org_id, person_id: w.alice,
        entry_event_id: completed.entry_event_id, reason: "wrong note",
        changes: {note: "fixed"}});
    const edited = await calendar.clockStatusAsync(w.org_id, w.alice, day);
    _check("a superseded original stays out of the projection",
        Math.abs(edited.today_total_seconds - (7200 + elapsed)) <= 2,
        `${edited.today_total_seconds}`);

    const undeclared = await calendar.clockStatusAsync(w.org_id, w.erin, day);
    _check("no declared window is named, not guessed",
        undeclared.workday === false && undeclared.reason == "undeclared" &&
        undeclared.window === null && undeclared.window_ends_at_minute === null);
}

/** The reconnect replay: stored once, replayed idempotently, conflicts named. */
async function _testSync(w) {
    LOG.console("\n the offline sync replays without doubling anything\n");
    const day = _today();
    const start = Math.floor(Date.parse(`${day}T10:00:00Z`)/1000);
    const make = (id, started) => ({client_event_id: id, entry_date: day, task_ref: "TASK-1",
        source: "timer", started_at: started, ended_at: started + 3600});

    const results = await time.syncEventsAsync(w.org_id, w.alice, [
        make("sync-a", start),
        make("sync-a", start),                       // the same buffered event replayed
        {...make("sync-a", start), started_at: start + 60},   // same id, different payload
        make("sync-b", start + 7200),
        {entry_date: day, source: "bogus"},          // one bad event
        {entry_date: day, task_ref: "TASK-3", source: "timer", duration_seconds: 600}]);

    _check("the batch reports every event's own outcome",
        results.map(r => r.result).join(",") == "stored,already_stored,conflict,stored,invalid,stored",
        results.map(r => r.result).join(","));
    _check("the conflict carries what was actually stored",
        results[2].stored?.duration_seconds == 3600);
    _check("nothing is doubled in the ledger",
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM time_entry_event WHERE org_id=? AND client_event_id='sync-a'",
            [w.org_id]))[0].c == 1 &&
        (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS c FROM time_entry_event WHERE org_id=? AND client_event_id='sync-b'",
            [w.org_id]))[0].c == 1);
    _check("the invalid event names its reason", /Unknown entry source/.test(results[4].reason || ""),
        results[4].reason);
}

/** The API surface. */
async function _testAPI(w) {
    LOG.console("\n the clock API\n");
    const day = _today();
    const status = await clockapi.doService({op: "status", id: w.aliceEmail, org: w.org_id});
    _check("op status answers with today's clock",
        status.result === true && Number.isInteger(status.today_total_seconds) &&
        status.window !== null);

    const start = Math.floor(Date.parse(`${day}T09:00:00Z`)/1000);
    const synced = await clockapi.doService({op: "sync", id: w.bobEmail, org: w.org_id,
        events: [{client_event_id: "api-a", entry_date: day, task_ref: "TASK-1",
            source: "timer", started_at: start, ended_at: start + 3600}]});
    _check("op sync stores the buffered event", synced.result === true &&
        synced.results[0].result == "stored");

    const replayed = await clockapi.doService({op: "sync", id: w.bobEmail, org: w.org_id,
        events: [{client_event_id: "api-a", entry_date: day, task_ref: "TASK-1",
            source: "timer", started_at: start, ended_at: start + 3600}]});
    _check("op sync replays idempotently", replayed.result === true &&
        replayed.results[0].result == "already_stored");

    const undeclared = await clockapi.doService({op: "status", id: w.erinEmail, org: w.org_id});
    _check("op status names an undeclared day",
        undeclared.result === true && undeclared.reason == "undeclared");

    LOG.console("\n the C2 ops over the API\n");
    const apiDay = "2026-06-19";
    const t0 = 1781300000;

    const inResult = await clockapi.doService({op: "in", id: w.aliceEmail, org: w.org_id,
        date: apiDay, at: t0, task_ref: "TASK-API"});
    _check("op in starts the clock", inResult.result && inResult.session.state == "running", inResult.reason);

    const again = await clockapi.doService({op: "in", id: w.aliceEmail, org: w.org_id, date: apiDay, at: t0+10});
    _check("op in refuses a second clock with a reason",
        !again.result && /already running/i.test(again.reason||""), again.reason);

    const session = await clockapi.doService({op: "session", id: w.aliceEmail, org: w.org_id, date: apiDay});
    _check("op session answers the popover's facts",
        session.result && session.clocked_in_at == t0 && session.running?.task_ref == "TASK-API");

    const preview = await clockapi.doService({op: "out_preview", id: w.aliceEmail, org: w.org_id,
        date: apiDay, at: t0 + 1800});
    _check("op out_preview states the session and its warnings",
        preview.result && preview.session_seconds == 1800 && Array.isArray(preview.warnings));

    const brk = await clockapi.doService({op: "break_start", id: w.aliceEmail, org: w.org_id,
        date: apiDay, at: t0 + 1800});
    _check("op break_start pauses the clock", brk.result && brk.session.state == "break", brk.reason);

    const back = await clockapi.doService({op: "break_end", id: w.aliceEmail, org: w.org_id,
        date: apiDay, at: t0 + 2100, resume_task_ref: "TASK-API"});
    _check("op break_end measures the break and resumes",
        back.result && back.seconds == 300 && back.session.state == "running", back.reason);

    const idle = await clockapi.doService({op: "idle", id: w.aliceEmail, org: w.org_id,
        date: apiDay, decision: "keep", idle_seconds: 600, at: t0 + 2400});
    _check("op idle defaults to keeping the time", idle.result && idle.decision == "keep");

    const outResult = await clockapi.doService({op: "out", id: w.aliceEmail, org: w.org_id,
        date: apiDay, at: t0 + 3600});
    _check("op out closes the clock and reports what was recorded",
        outResult.result && outResult.recorded_seconds == 1500 && outResult.session.state == "not_clocked_in",
        String(outResult.recorded_seconds));

    const bad = await clockapi.doService({op: "nonsense", id: w.aliceEmail, org: w.org_id});
    _check("an unknown op is refused", !bad.result);
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

/** C2's one button, driven by state. */
async function _testClockControl(w) {
    LOG.console("\n C2 clock control\n");
    const day = "2026-06-16";     // a day of its own, so the status tests above stay untouched
    const t0 = 1781000000;

    const started = await clock.clockInAsync({org_id: w.org_id, person_id: w.bob, entry_date: day,
        at: t0, task_ref: "TASK-9", client_event_id: "cc-in"});
    _check("clocking in opens an entry bound to the task",
        started.entry.task_ref == "TASK-9" && started.entry.ended_at === null);
    _check("the session reports it as running", started.session.state == "running");

    await _checkThrows("clocking in twice is refused", _ =>
        clock.clockInAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0+60}));

    const preview = await clock.clockOutPreviewAsync({org_id: w.org_id, person_id: w.bob,
        entry_date: day, at: t0 + 3600});
    _check("the clock-out confirm states what will be recorded", preview.session_seconds == 3600);
    _check("and warns that the timer is running",
        preview.warnings.some(warning => warning.kind == "timer_running"));

    const switched = await clock.switchTaskAsync({org_id: w.org_id, person_id: w.bob, entry_date: day,
        task_ref: "TASK-10", at: t0 + 3600, client_event_id: "cc-switch"});
    _check("switching closes the first entry at the switch",
        switched.closed.ended_at == t0 + 3600 && switched.closed.duration_seconds == 3600);
    _check("and opens the next one bound to the new task",
        switched.entry.task_ref == "TASK-10" && switched.entry.ended_at === null);
    _check("no time is lost across the switch",
        switched.session.today_total_seconds >= 3600);

    await _checkThrows("switching to the task already running is refused", _ =>
        clock.switchTaskAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, task_ref: "TASK-10"}));

    const out = await clock.clockOutAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 5400});
    _check("clocking out closes the running entry", out.entry.ended_at == t0 + 5400);
    _check("and records the second stretch", out.recorded_seconds == 1800);
    _check("the session is no longer running", out.session.state == "not_clocked_in");
    _check("the day totals both stretches", out.session.today_total_seconds == 5400,
        String(out.session.today_total_seconds));

    await _checkThrows("clocking out when nothing runs is refused", _ =>
        clock.clockOutAsync({org_id: w.org_id, person_id: w.bob, entry_date: day}));

    const events = time.currentEvents(await time.eventsForDayAsync(w.org_id, w.bob, day));
    _check("the closed entries are two, not four", events.length == 2, String(events.length));
    const all = await time.eventsForDayAsync(w.org_id, w.bob, day);
    _check("and the superseded originals are still in the ledger", all.length > events.length);
}

/** A break is not worked time, and it is its own record. */
async function _testBreaks(w) {
    LOG.console("\n breaks\n");
    const day = "2026-06-17";
    const t0 = 1781100000;

    await clock.clockInAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0, task_ref: "TASK-11"});
    const paused = await clock.startBreakAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 1800});
    _check("starting a break stops the clock", paused.session.state == "break");
    _check("and remembers the task to come back to", paused.resumes_task_ref == "TASK-11");
    _check("the break is not counted as worked time", paused.session.today_total_seconds == 1800,
        String(paused.session.today_total_seconds));

    await _checkThrows("a second break is refused while one is open", _ =>
        clock.startBreakAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 1900}));
    await _checkThrows("clocking in during a break is refused", _ =>
        clock.clockInAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 1900}));

    const resumed = await clock.endBreakAsync({org_id: w.org_id, person_id: w.bob, entry_date: day,
        at: t0 + 2520, resume_task_ref: "TASK-11"});
    _check("ending the break measures it", resumed.seconds == 720);
    _check("and picks the task back up", resumed.resumed?.task_ref == "TASK-11");
    _check("the popover can state the break count and total",
        resumed.session.break_count == 1 && resumed.session.break_seconds == 720);

    const breaks = await clock.breaksAsync(w.org_id, w.bob, day);
    _check("the break is one current row, superseded not updated", breaks.length == 1 && breaks[0].ended_at !== null);
    const raw = await dblayer.getQueryOrThrow(
        "SELECT * FROM clock_break WHERE org_id=? AND person_id=? AND entry_date=?", [w.org_id, w.bob, day]);
    _check("and the open original survives in the table", raw.length == 2);

    await clock.clockOutAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 3000});
}

/** The idle path, where the product is most easily made untrustworthy. */
async function _testIdle(w) {
    LOG.console("\n idle — keep is the default, and a discard is never silent\n");
    const day = "2026-06-18";
    const t0 = 1781200000;

    await clock.clockInAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0, task_ref: "TASK-12"});
    const kept = await clock.resolveIdleAsync({org_id: w.org_id, person_id: w.bob, entry_date: day,
        decision: "keep", idle_seconds: 600, at: t0 + 3600});
    _check("keeping idle time changes nothing", kept.entry === null && kept.session.state == "running");

    const discarded = await clock.resolveIdleAsync({org_id: w.org_id, person_id: w.bob, entry_date: day,
        decision: "discard", idle_seconds: 600, at: t0 + 3600});
    _check("discarding trims the entry to where the person stopped",
        discarded.entry.ended_at == t0 + 3000);
    _check("the discard carries its reason", /idle/i.test(discarded.entry.reason||""));

    const ledger = await time.eventsForDayAsync(w.org_id, w.bob, day);
    _check("the original entry is still in the ledger, not deleted",
        ledger.some(event => event.entry_event_id == discarded.entry.supersedes_entry_event_id));

    await _checkThrows("a discard with no amount is refused", _ =>
        clock.resolveIdleAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, decision: "discard"}));
    await _checkThrows("an unknown resolution is refused", _ =>
        clock.resolveIdleAsync({org_id: w.org_id, person_id: w.bob, entry_date: day,
            decision: "delete_it_all", idle_seconds: 60}));

    // resolving as a break: the day still adds up, the interval moves where it belongs
    await clock.clockInAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 3600, task_ref: "TASK-12"});
    const asBreak = await clock.resolveIdleAsync({org_id: w.org_id, person_id: w.bob, entry_date: day,
        decision: "break", idle_seconds: 900, at: t0 + 5400});
    _check("resolving idle as a break trims the entry", asBreak.entry.ended_at == t0 + 4500);
    _check("records the break", asBreak.session.break_seconds == 900,
        String(asBreak.session.break_seconds));
    _check("and the clock picks up again on the same task", asBreak.session.state == "running" &&
        asBreak.session.running?.task_ref == "TASK-12");

    const zero = await clock.clockOutAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 5400});
    _check("clocking out in the same second the clock resumed still succeeds",
        zero.recorded_seconds === 0, String(zero.recorded_seconds));

    await _checkThrows("trimming an entry to nothing is refused, clock out instead", async _ => {
        await clock.clockInAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 6000, task_ref: "TASK-13"});
        return clock.resolveIdleAsync({org_id: w.org_id, person_id: w.bob, entry_date: day,
            decision: "discard", idle_seconds: 9999, at: t0 + 6060});
    });
    await clock.clockOutAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 6100});

    await _checkThrows("a clock-out before the entry started is still refused", async _ => {
        await clock.clockInAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 7000});
        return clock.clockOutAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 6000});
    });
    await clock.clockOutAsync({org_id: w.org_id, person_id: w.bob, entry_date: day, at: t0 + 7200});
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Clock test ${stamp}`, home_jurisdiction: "IN"});
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
    await permissions.assignRoleAsync(org.org_id, people.erin.person_id, "employee", from);

    for (const who of ["alice", "bob", "carol", "dave"])
        await windows.setWindowAsync({org_id: org.org_id, person_id: people[who].person_id,
            timezone: "Etc/GMT", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5,6,7],
            valid_from: "2026-01-01"});

    return {org_id: org.org_id, stamp, aliceEmail: `alice.${stamp}@example.invalid`,
        bobEmail: `bob.${stamp}@example.invalid`, erinEmail: `erin.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM clock_break WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM task WHERE org_id=?", [w.org_id]);
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
