/**
 * Tests E5 (narrowed) — office-day status: home/office/elsewhere per day,
 * the peer cohort (and its no-manager fallback), and the co-location note.
 * No desk/office entity exists anywhere in this app, so there is nothing
 * here about booking, capacity or auto-release — status only.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests officedays
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const officedays = require(`${TELEWORKR_CONSTANTS.LIBDIR}/officedays.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Office days test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 120)}`, true);}
}

// 2026-06-01 is a Monday — the same fixed past week test_workload.js already
// established as a known Mon-Sun anchor, reused here for the same determinism.
const MONDAY = "2026-06-01", TUESDAY = "2026-06-02", FRIDAY = "2026-06-05";

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "officedays")) {
        LOG.console("Skipping officedays test case, not called.\n"); return true;
    }
    LOG.console("\nE5 office-day status\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testValidation(w);
        await _testCorrection(w);
        await _testWeekAndCohort(w);
        await _testCohortFallback(w);
        await _testCoLocation(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  officedays tests threw: ${err}\n`); LOG.error(`Officedays tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nOffice days tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _testValidation(w) {
    LOG.console("\n validation\n");
    await _checkThrows("an invalid status is refused", _ =>
        officedays.setStatusAsync({org_id: w.org_id, person_id: w.alice, status_date: MONDAY, status: "beach"}));
    await _checkThrows("a malformed date is refused", _ =>
        officedays.setStatusAsync({org_id: w.org_id, person_id: w.alice, status_date: "not-a-date", status: "home"}));
}

async function _testCorrection(w) {
    LOG.console("\n re-setting a date corrects rather than duplicates\n");
    await officedays.setStatusAsync({org_id: w.org_id, person_id: w.alice, status_date: MONDAY, status: "home"});
    await officedays.setStatusAsync({org_id: w.org_id, person_id: w.alice, status_date: MONDAY, status: "office", location: "NYC"});
    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM office_day_status WHERE org_id=? AND person_id=? AND status_date=?", [w.org_id, w.alice, MONDAY]);
    _check("exactly one row exists for that person/date", rows.length == 1, JSON.stringify(rows));
    _check("it reflects the latest correction, not the first write",
        rows[0].status == "office" && rows[0].location == "NYC", JSON.stringify(rows[0]));
}

async function _testWeekAndCohort(w) {
    LOG.console("\n the week, for the caller and their cohort\n");
    await officedays.setStatusAsync({org_id: w.org_id, person_id: w.carol, status_date: TUESDAY, status: "elsewhere", location: "SF"});

    const week = await officedays.weekStatusAsync(w.org_id, w.alice, MONDAY);
    _check("exactly the 5 weekdays are returned", week.days.length == 5 &&
        week.days[0] == MONDAY && week.days[4] == FRIDAY, JSON.stringify(week.days));
    _check("the caller is first and marked is_self", week.people[0].person_id == w.alice && week.people[0].is_self === true);
    _check("alice and carol share a manager (bob), so carol is in alice's cohort",
        week.people.some(p => p.person_id == w.carol && !p.is_self), JSON.stringify(week.people.map(p => p.person_id)));
    _check("alice's own Monday correction is reflected",
        week.people[0].statuses[MONDAY]?.status == "office" && week.people[0].statuses[MONDAY]?.location == "NYC");
    _check("carol's Tuesday status is visible to alice too",
        week.people.find(p => p.person_id == w.carol).statuses[TUESDAY]?.location == "SF");
    _check("a day nobody declared is simply absent, not a fabricated default",
        week.people[0].statuses[FRIDAY] === null, JSON.stringify(week.people[0].statuses[FRIDAY]));
}

async function _testCohortFallback(w) {
    LOG.console("\n no manager — falls back to the org roster minus self\n");
    const week = await officedays.weekStatusAsync(w.org_id, w.bob, MONDAY);
    const others = week.people.filter(p => !p.is_self).map(p => p.person_id);
    _check("bob (no manager) falls back to the whole org roster minus himself, not an empty cohort",
        others.includes(w.alice) && others.includes(w.carol) && others.includes(w.dave) && !others.includes(w.bob),
        JSON.stringify(others));
}

async function _testCoLocation(w) {
    LOG.console("\n co-location — both in the office, the same day\n");
    await officedays.setStatusAsync({org_id: w.org_id, person_id: w.alice, status_date: FRIDAY, status: "office"});
    await officedays.setStatusAsync({org_id: w.org_id, person_id: w.carol, status_date: FRIDAY, status: "office"});
    const week = await officedays.weekStatusAsync(w.org_id, w.alice, MONDAY);
    _check("Friday, both in the office, is flagged as co-location",
        week.co_location.some(c => c.date == FRIDAY && c.with.includes("carol")), JSON.stringify(week.co_location));
    _check("Monday — alice in the office alone (carol has no Monday status) — is not flagged",
        !week.co_location.some(c => c.date == MONDAY), JSON.stringify(week.co_location));
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Office days test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave"])
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});

    const line = {alice: people.bob.person_id, carol: people.bob.person_id, bob: null, dave: null};
    for (const who of Object.keys(people))
        await spine.recordEmploymentAsync({org_id: org.org_id, person_id: people[who].person_id,
            status: "active", jurisdiction: "GB", manager_person_id: line[who], contract_type: "employee",
            valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const who of Object.keys(people)) await permissions.assignRoleAsync(org.org_id, people[who].person_id, "employee", from);

    return {org_id: org.org_id, stamp, ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["office_day_status", "role_capability", "role", "capability_grant", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
