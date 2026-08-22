/**
 * Tests E3/E4 — the availability model. Effective-dated windows that supersede
 * rather than edit, travel as a dated three-period chain, the overlap projection
 * with named zero-overlap evidence, DST flags derived from the zone, and the
 * clock-in-history drift nudge.
 *
 * Fixed-offset Etc zones keep the timezone math deterministic; America/New_York
 * covers the DST transition.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests windows
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const entityshapes = require(`${TELEWORKR_CONSTANTS.LIBDIR}/entityshapes.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const windowsapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/windows.js`);

const WED = "2026-06-17";        // a Wednesday
let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Windows test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "windows")) {
        LOG.console("Skipping windows test case, not called.\n"); return true;
    }
    LOG.console("\nE3/E4 working windows\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testSetAndAsOf(w);
        await _testTravel(w);
        await _testOverlap(w);
        await _testDST(w);
        await _testDrift(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  windows tests threw: ${err}\n`); LOG.error(`Windows tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nWindows tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------
// declared windows
// ---------------------------------------------------------------------------

async function _testSetAndAsOf(w) {
    LOG.console("\n declared windows are effective-dated\n");
    const alice = await windows.setWindowAsync({org_id: w.org_id, person_id: w.alice,
        timezone: "Etc/GMT+5", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: "2026-01-01", note: "New York hours"});
    _check("a window is recorded", Boolean(alice.window_id));
    _check("the window is in force later", (await windows.windowAsOfAsync(w.org_id, w.alice, "2026-03-15"))?.window_id == alice.window_id);
    _check("the working days round-trip", JSON.parse((await windows.getOpenWindowAsync(w.org_id, w.alice)).days).join(",") == "1,2,3,4,5");

    await _checkThrows("an unknown timezone is refused", _ =>
        windows.setWindowAsync({org_id: w.org_id, person_id: w.alice, timezone: "Not/AZone",
            start_minute: 540, end_minute: 1020, days: [1,2,3,4,5], valid_from: "2026-02-01"}));
    await _checkThrows("minutes outside the day are refused", _ =>
        windows.setWindowAsync({org_id: w.org_id, person_id: w.alice, timezone: "Etc/GMT+5",
            start_minute: 1440, end_minute: 1020, days: [1,2,3,4,5], valid_from: "2026-02-01"}));
    await _checkThrows("a zero-length window is refused", _ =>
        windows.setWindowAsync({org_id: w.org_id, person_id: w.alice, timezone: "Etc/GMT+5",
            start_minute: 540, end_minute: 540, days: [1,2,3,4,5], valid_from: "2026-02-01"}));
    await _checkThrows("empty days are refused", _ =>
        windows.setWindowAsync({org_id: w.org_id, person_id: w.alice, timezone: "Etc/GMT+5",
            start_minute: 540, end_minute: 1020, days: [], valid_from: "2026-02-01"}));
    await _checkThrows("a day outside 1..7 is refused", _ =>
        windows.setWindowAsync({org_id: w.org_id, person_id: w.alice, timezone: "Etc/GMT+5",
            start_minute: 540, end_minute: 1020, days: [1,2,9], valid_from: "2026-02-01"}));
    await _checkThrows("repeated days are refused", _ =>
        windows.setWindowAsync({org_id: w.org_id, person_id: w.alice, timezone: "Etc/GMT+5",
            start_minute: 540, end_minute: 1020, days: [1,1,2,3,4,5], valid_from: "2026-02-01"}));

    // supersede: the old window stays answerable for its dates
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.alice,
        timezone: "Etc/GMT+5", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: "2026-07-01", note: "confirmed unchanged"});
    const history = await windows.windowHistoryAsync(w.org_id, w.alice);
    _check("a change closes the old period where the new one starts",
        history.length == 2 && history[0].valid_to == "2026-07-01" && history[1].valid_to === null);
    _check("March still answers with the March window",
        (await windows.windowAsOfAsync(w.org_id, w.alice, "2026-03-15")).note == "New York hours");
    _check("August answers with the new one",
        (await windows.windowAsOfAsync(w.org_id, w.alice, "2026-08-15")).note == "confirmed unchanged");

    await _checkThrows("a window starting behind the open one is refused", _ =>
        windows.setWindowAsync({org_id: w.org_id, person_id: w.alice, timezone: "Etc/GMT+5",
            start_minute: 540, end_minute: 1020, days: [1,2,3,4,5], valid_from: "2026-05-01"}));

    _check("the window entity has no in-place update path",
        (_ => {try {entityshapes.assertUpdatable("working_window"); return false;} catch (err) {return true;}})());
}

// ---------------------------------------------------------------------------
// travel
// ---------------------------------------------------------------------------

async function _testTravel(w) {
    LOG.console("\n travel is a dated state\n");
    await _checkThrows("travel with no open window is refused", _ =>
        windows.setTravelAsync({org_id: w.org_id, person_id: w.bob, timezone: "Asia/Kolkata",
            valid_from: "2026-07-04", valid_to: "2026-07-22"}));

    await windows.setWindowAsync({org_id: w.org_id, person_id: w.bob,
        timezone: "Etc/GMT+1", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: "2026-01-01"});
    await windows.setTravelAsync({org_id: w.org_id, person_id: w.bob, timezone: "Asia/Kolkata",
        valid_from: "2026-07-04", valid_to: "2026-07-22", start_minute: 600, end_minute: 1110});

    const during = await windows.windowAsOfAsync(w.org_id, w.bob, "2026-07-10");
    _check("during the trip the window is the travel window",
        during.kind == "travel" && during.timezone == "Asia/Kolkata" && during.start_minute == 600);
    const after = await windows.windowAsOfAsync(w.org_id, w.bob, "2026-08-01");
    _check("after the trip the base window resumes",
        after.kind == "declared" && after.timezone == "Etc/GMT+1" && after.valid_from == "2026-07-22");
    _check("the chain keeps all three periods",
        (await windows.windowHistoryAsync(w.org_id, w.bob)).length == 3);

    await _checkThrows("travelling while already travelling is refused", _ =>
        windows.setTravelAsync({org_id: w.org_id, person_id: w.bob, timezone: "Europe/London",
            valid_from: "2026-07-10", valid_to: "2026-07-12"}));
    await _checkThrows("a trip ending before it starts is refused", _ =>
        windows.setTravelAsync({org_id: w.org_id, person_id: w.bob, timezone: "Europe/London",
            valid_from: "2026-07-22", valid_to: "2026-07-20"}));

    // ending travel early is a new declared window inside the trip
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.bob, timezone: "Etc/GMT+1",
        start_minute: 540, end_minute: 1020, days: [1,2,3,4,5], valid_from: "2026-07-15", note: "came home early"});
    _check("ending the trip early resumes the base at the new date",
        (await windows.windowAsOfAsync(w.org_id, w.bob, "2026-07-16")).kind == "declared");
}

// ---------------------------------------------------------------------------
// the overlap projection
// ---------------------------------------------------------------------------

async function _testOverlap(w) {
    LOG.console("\n the overlap projection\n");
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.carol,
        timezone: "Etc/GMT-9", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: "2026-01-01"});   // UTC+9: 09–17 local = 00:00–08:00 UTC

    // alice: 09–17 UTC-5 = 14:00–22:00 UTC · bob (resumed base): 09–17 UTC-5 = 14:00–22:00 UTC
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.bob,
        timezone: "Etc/GMT+1", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: "2026-07-16"});   // UTC-1: 09–17 local = 10:00–18:00 UTC

    const pair = await windows.teamOverlapAsync(w.org_id, [w.alice, w.bob], WED);
    _check("two New York / UTC-1 days share 4 hours", pair.shared_minutes == 240, `${pair.shared_minutes}`);
    _check("the shared span is projected, not stored",
        pair.span && pair.span.to - pair.span.from == 240);

    const trio = await windows.teamOverlapAsync(w.org_id, [w.alice, w.bob, w.carol], WED);
    _check("a team with no shared minutes says so with a zero, not silence",
        trio.shared_minutes == 0 && trio.span === null);
    _check("the zero-overlap evidence names the pairs",
        trio.zero_overlap_pairs.length == 2 &&
        trio.zero_overlap_pairs.every(pair => pair.a == w.carol || pair.b == w.carol) &&
        trio.zero_overlap_pairs.some(pair => pair.a == w.alice || pair.b == w.alice) &&
        trio.zero_overlap_pairs.some(pair => pair.a == w.bob || pair.b == w.bob),
        JSON.stringify(trio.zero_overlap_pairs));

    const withAbsent = await windows.teamOverlapAsync(w.org_id, [w.alice, w.bob, w.erin], WED);
    _check("someone who never declared hours is named, not dropped",
        withAbsent.undeclared.includes(w.erin));

    const saturday = await windows.availabilityForDateAsync(w.org_id, w.alice, "2026-06-20");
    _check("a weekend is an off day, named as such", !saturday.workday && saturday.reason == "off_day");

    // night shifts crossing midnight are real shapes
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.bob,
        timezone: "Etc/GMT+5", start_minute: 1200, end_minute: 240, days: [1,2,3,4,5],
        valid_from: "2026-07-20", note: "night shift"});     // 20:00–04:00 UTC-5
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.carol,
        timezone: "Etc/GMT+5", start_minute: 1320, end_minute: 360, days: [1,2,3,4,5],
        valid_from: "2026-07-20"});                          // 22:00–06:00 UTC-5
    const night = await windows.teamOverlapAsync(w.org_id, [w.bob, w.carol], "2026-07-22");
    _check("two night shifts crossing midnight share their true overlap",
        night.shared_minutes == 360, `${night.shared_minutes}`);
}

// ---------------------------------------------------------------------------
// DST
// ---------------------------------------------------------------------------

async function _testDST(w) {
    LOG.console("\n daylight saving, announced from the zone\n");
    _check("a fixed-offset zone flags nothing",
        (await windows.dstTransitionFlagsAsync(w.org_id, [w.alice], "2026-03-01")).length == 0);

    await windows.setWindowAsync({org_id: w.org_id, person_id: w.erin,
        timezone: "America/New_York", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: "2026-02-01"});
    const flags = await windows.dstTransitionFlagsAsync(w.org_id, [w.erin], "2026-03-01");
    _check("the US spring-forward week is flagged before it happens",
        flags.length == 1 && flags[0].timezone == "America/New_York" &&
        flags[0].offset_minutes != flags[0].offset_in_a_week,
        JSON.stringify(flags));
}

// ---------------------------------------------------------------------------
// the drift nudge
// ---------------------------------------------------------------------------

async function _testDrift(w) {
    LOG.console("\n declared hours nudged by clock-in history\n");
    // bob is on 09:00–17:00 UTC-5 (night shift); put him back on days for the drift check
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.bob,
        timezone: "Etc/GMT+5", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: "2026-08-01"});

    // Five workdays of clock-ins at 07:30 local (12:30 UTC). driftAsync scans the
    // last N calendar days from the real wall clock, so the fixture dates are
    // computed relative to today rather than hardcoded — an absolute date here
    // would silently stop matching the day this test runs after the date it names.
    // An 8-day span always contains at least 5 weekdays (worst case starts on a
    // weekend), so 5 is always reachable without overshooting the window.
    const weekdaysWithinLast8 = [];
    for (let i = 0; i < 8 && weekdaysWithinLast8.length < 5; i++) {
        const d = new Date(); d.setUTCDate(d.getUTCDate() - i);
        if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) weekdaysWithinLast8.push(d.toISOString().substring(0, 10));
    }
    for (const iso of weekdaysWithinLast8)
        await time.recordEventAsync({org_id: w.org_id, person_id: w.bob, entry_date: iso,
            client_event_id: `drift-${iso}`, task_ref: "TASK-1", source: "timer",
            started_at: Math.floor(Date.parse(`${iso}T12:30:00Z`)/1000)});

    const drift = await windows.driftAsync(w.org_id, w.bob, {days: 8, grace_minutes: 30});
    _check("clock-ins before the declared start are counted as drift",
        drift.days_with_events == 5 && drift.early_days == 5, JSON.stringify(drift));
    _check("the nudge suggests the observed start",
        drift.suggested_start_minute == 450, `${drift.suggested_start_minute}`);

    const quiet = await windows.driftAsync(w.org_id, w.alice, {days: 8});
    _check("no clock-ins means no nudge",
        quiet.days_with_events == 0 && quiet.suggested_start_minute === null);

    const undeclared = await windows.driftAsync(w.org_id, w.fred);
    _check("an undeclared person has nothing to drift from", undeclared.window === null);
}

// ---------------------------------------------------------------------------
// the API
// ---------------------------------------------------------------------------

async function _testAPI(w) {
    LOG.console("\n the windows API\n");
    const set = await windowsapi.doService({op: "set", id: w.bobEmail, org: w.org_id,
        timezone: "Etc/GMT+5", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: new Date().toISOString().substring(0, 10)});
    _check("op set answers true with the window", set.result === true && Boolean(set.window?.window_id));

    const availability = await windowsapi.doService(
        {op: "availability", id: w.bobEmail, org: w.org_id, date: new Date().toISOString().substring(0, 10)});
    _check("op availability names the state", availability.result === true && "workday" in availability);

    const overlap = await windowsapi.doService(
        {op: "team_overlap", id: w.bobEmail, org: w.org_id, person_ids: [w.alice, w.bob], date: WED});
    _check("op team_overlap projects the shared minutes", overlap.result === true && overlap.shared_minutes == 240);

    const bad = await windowsapi.doService({op: "set", id: w.bobEmail, org: w.org_id,
        timezone: "Not/AZone", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: new Date().toISOString().substring(0, 10)});
    _check("a bad timezone through the API is refused with a reason",
        bad.result === false && /IANA/.test(bad.reason||""), bad.reason);
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Windows test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "erin", "fred"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "GB",
        contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    return {org_id: org.org_id, bobEmail: `bob.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM working_window WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "erin", "fred"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
