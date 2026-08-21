/**
 * Tests H5 — the disclosure surface. The personal access log grouped by actor
 * and action, the live mirror whose sees list is produced by the same permission
 * checks the API enforces and whose does-not-see list quotes the ceiling, the
 * retention table from the entity register, and the self-service export bundle.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests disclosure
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const disclosure = require(`${TELEWORKR_CONSTANTS.LIBDIR}/disclosure.js`);
const disclosureapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/disclosure.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Disclosure test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "disclosure")) {
        LOG.console("Skipping disclosure test case, not called.\n"); return true;
    }
    LOG.console("\nH5 disclosure\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _seed(w);
        await _testAccessLog(w);
        await _testMirror(w);
        await _testRetention(w);
        await _testExport(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  disclosure tests threw: ${err}\n`); LOG.error(`Disclosure tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nDisclosure tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _seed(w) {
    const today = new Date().toISOString().substring(0, 10);
    await time.recordEventAsync({org_id: w.org_id, person_id: w.alice, entry_date: today,
        client_event_id: "disc-1", task_ref: "TASK-1", duration_seconds: 3600, source: "timer"});
    await time.recordEventAsync({org_id: w.org_id, person_id: w.alice, entry_date: today,
        client_event_id: "disc-2", task_ref: "TASK-1", duration_seconds: 1800, source: "reconstructed",
        reconstructed: true, signal: JSON.stringify({type: "calendar", name: "1:1 Mary"})});
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.alice,
        timezone: "Etc/GMT+5", start_minute: 540, end_minute: 1020, days: [1,2,3,4,5],
        valid_from: "2026-01-01"});
    await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice,
        title: "Single-pager", project: "APIBot", due_date: "2026-08-24"});

    const now = Math.floor(Date.now()/1000);
    for (const action of ["timesheet.approved", "timesheet.approved"])
        await audit.writeAsync({org_id: w.org_id, action, object_type: "timesheet", object_ref: "W33",
            actor_person_id: w.bob, subject_person_id: w.alice, occurred_at: now});
    await audit.writeAsync({org_id: w.org_id, action: "time_entry.edited", object_type: "time_entry",
        object_ref: "e-1", actor_person_id: w.carol, subject_person_id: w.alice, occurred_at: now});
    await audit.writeAsync({org_id: w.org_id, action: "time_entry.edited", object_type: "time_entry",
        object_ref: "e-2", actor_person_id: w.alice, subject_person_id: w.alice, occurred_at: now});
    await audit.writeAsync({org_id: w.org_id, action: "timesheet.approved", object_type: "timesheet",
        object_ref: "W20", actor_person_id: w.bob, subject_person_id: w.alice,
        occurred_at: now - 100*86400});
}

async function _testAccessLog(w) {
    LOG.console("\n the personal access log\n");
    const log = await disclosure.accessLogAsync({org_id: w.org_id, person_id: w.alice, days: 90});
    _check("the log groups by actor and action with counts",
        log.accesses.length == 2, JSON.stringify(log.accesses));
    const byBob = log.accesses.find(entry => entry.actor_person_id == w.bob);
    const byCarol = log.accesses.find(entry => entry.actor_person_id == w.carol);
    _check("approvals are counted", byBob?.action == "timesheet.approved" && byBob.count == 2,
        JSON.stringify(byBob));
    _check("corrections are counted", byCarol?.action == "time_entry.edited" && byCarol.count == 1);
    _check("the log names the people", byBob?.display_name == "bob" && byCarol?.display_name == "carol");
    _check("the person's own actions are counted separately", log.self_count == 1, `${log.self_count}`);
    _check("actions older than the window fall out", !log.accesses.some(entry => entry.action == "timesheet.approved" && entry.count == 3));
}

async function _testMirror(w) {
    LOG.console("\n the mirror is generated from the engine\n");
    const asBob = await disclosure.mirrorAsync({org_id: w.org_id, person_id: w.alice, viewer_person_id: w.bob});
    _check("a lead sees the weekly totals with the billable split",
        asBob.sees.weekly_totals?.total_seconds == 5400 &&
        asBob.sees.weekly_totals.by_task.some(row => row.task_ref == "TASK-1"),
        JSON.stringify(asBob.sees.weekly_totals));
    _check("the reconstructed count is part of the totals",
        asBob.sees.weekly_totals.reconstructed_count == 1);
    _check("the totals carry no per-entry times",
        JSON.stringify(asBob.sees.weekly_totals).includes("started_at") == false);
    _check("the lead sees task status and due dates",
        asBob.sees.task_status_and_due_dates.some(row => row.task_ref == "TASK-1" && row.due_date == "2026-08-24"));
    _check("the declared working window is visible to the team",
        asBob.sees.working_window?.timezone == "Etc/GMT+5");
    _check("leave dates answer honestly until the J-section exists",
        Array.isArray(asBob.sees.leave_dates) && asBob.sees.leave_dates.length == 0);

    _check("the does-not-see list quotes the never-measured ceiling",
        asBob.does_not_see.some(item => item.item == "keystrokes.read") &&
        asBob.does_not_see.some(item => item.item == "idle minutes"));

    const asErin = await disclosure.mirrorAsync({org_id: w.org_id, person_id: w.alice, viewer_person_id: w.erin});
    _check("a viewer with no grants sees no gated view",
        !("weekly_totals" in asErin.sees) && !("task_status_and_due_dates" in asErin.sees));
    _check("and the mirror says why for each",
        asErin.does_not_see.some(item => item.item.startsWith("Weekly total")) &&
        asErin.does_not_see.some(item => item.item.startsWith("Task status")));

    const asCarol = await disclosure.mirrorAsync({org_id: w.org_id, person_id: w.alice, viewer_person_id: w.carol});
    _check("HR sees the totals through its org-wide read",
        asCarol.sees.weekly_totals?.total_seconds == 5400);
}

async function _testRetention(w) {
    LOG.console("\n retention in concrete numbers\n");
    const entities = await disclosure.retentionAsync();
    const auditEvent = entities.find(entry => entry.entity == "audit_event");
    const timeEvent = entities.find(entry => entry.entity == "time_entry_event");
    const comment = entities.find(entry => entry.entity == "task_comment");
    _check("audit entries keep seven years, anchored to the event",
        auditEvent?.keep == "7y" && auditEvent?.anchor == "occurred_at");
    _check("time entries keep seven years",
        timeEvent?.keep == "7y" && timeEvent?.anchor == "period_closed");
    _check("comments keep as long as their task",
        comment && comment.keep === null);
}

async function _testExport(w) {
    LOG.console("\n the self-service export\n");
    const bundle = await disclosure.exportMyDataAsync({org_id: w.org_id, person_id: w.alice});
    _check("the bundle carries the person", bundle.person?.email == w.aliceEmail);
    _check("employment history is included", bundle.employments.length == 1);
    _check("time entries are included", bundle.time_entries.length == 2);
    _check("the audit entries about them are included",
        bundle.audit_entries_about_me.some(entry => entry.action == "timesheet.approved"));
    _check("their tasks and the window are included",
        bundle.tasks.some(row => row.task_ref == "TASK-1") && bundle.working_windows.length == 1);
    _check("the bundle serialises", Boolean(JSON.stringify(bundle).length));

    await _checkThrows("an unknown person is refused", _ =>
        disclosure.exportMyDataAsync({org_id: w.org_id, person_id: "ghost-person"}));
}

async function _testAPI(w) {
    LOG.console("\n the disclosure API\n");
    const log = await disclosureapi.doService({op: "access_log", id: w.aliceEmail, org: w.org_id});
    _check("op access_log answers true with the grouped accesses",
        log.result === true && Array.isArray(log.accesses));

    const mirror = await disclosureapi.doService({op: "mirror", id: w.aliceEmail, org: w.org_id,
        viewer_person_id: w.bob});
    _check("op mirror renders the chosen viewer's view",
        mirror.result === true && mirror.sees?.weekly_totals?.total_seconds == 5400);

    const retention = await disclosureapi.doService({op: "retention", id: w.aliceEmail, org: w.org_id});
    _check("op retention answers with the register", retention.result === true &&
        retention.entities.some(entry => entry.entity == "audit_event"));

    const exported = await disclosureapi.doService({op: "export", id: w.aliceEmail, org: w.org_id});
    _check("op export answers with the bundle", exported.result === true && Boolean(exported.person));

    const unknown = await disclosureapi.doService({op: "retention", id: "nobody@example.invalid", org: w.org_id});
    _check("an unknown actor is refused", unknown.result === false && /No person/.test(unknown.reason||""));
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Disclosure test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    const line = {alice: people.bob.person_id, bob: null, carol: null, dave: null, erin: null};
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "GB",
        manager_person_id: line[who], contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);

    return {org_id: org.org_id, aliceEmail: `alice.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["task_relation", "task_watcher", "task_comment", "task_event", "task"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM working_window WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM timesheet WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
