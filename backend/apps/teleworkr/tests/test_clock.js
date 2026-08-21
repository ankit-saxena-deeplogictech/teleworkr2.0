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

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Clock test failed: ${label} ${detail||""}`);}
}

const _today = () => new Date().toISOString().substring(0, 10);

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
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

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
