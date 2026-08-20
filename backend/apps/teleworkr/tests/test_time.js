/**
 * Tests the C-section time domain — the append-only ledger and its offline-sync
 * idempotency, the C5 edit trail that never overwrites an original, the weekly
 * submit / return / approve loop with the C7 approval signature, and the manager
 * mirror that never carries per-entry start times.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests time
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const timeapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/time.js`);

const BASE = 1750000000;    // unix seconds for fixed test instants
const W0 = "2026-06-08";    // ledger week
const MON = "2026-06-15", TUE = "2026-06-16", WED = "2026-06-17", THU = "2026-06-18", FRI = "2026-06-19";
const W1 = "2026-06-22";    // edit-trail week
const W2 = "2026-06-29";    // HR correction week

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Time test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "time")) {
        LOG.console("Skipping time test case, not called.\n"); return true;
    }
    LOG.console("\nC-section time\n");

    await dblayer.readyAsync();
    const world = null;
    let w;
    try {
        w = await _buildWorld();
        await _testLedger(w);
        await _testEditTrail(w);
        await _testWeekLoop(w);
        await _testApproverRead(w);
        await _testOtherPersonEdit(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  time tests threw: ${err}\n`); LOG.error(`Time tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nTime tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------
// the ledger
// ---------------------------------------------------------------------------

async function _testLedger(w) {
    LOG.console("\n the append-only ledger\n");
    const base = {org_id: w.org_id, person_id: w.alice, entry_date: W0};

    const entry = await time.recordEventAsync({...base, client_event_id: "client-1",
        task_ref: "TASK-1042", duration_seconds: 9000, source: "timer", note: "fold work"});
    _check("an event is recorded and returned with its id", Boolean(entry.entry_event_id));

    const retry = await time.recordEventAsync({...base, client_event_id: "client-1",
        task_ref: "TASK-1042", duration_seconds: 9000, source: "timer"});
    _check("a retried sync with the same client_event_id returns the same row",
        retry.entry_event_id == entry.entry_event_id);
    _check("and does not duplicate it",
        (await dblayer.getQueryOrThrow("SELECT * FROM time_entry_event WHERE client_event_id='client-1'", [])).length == 1);

    _check("overlapping entries are recorded, never refused — time is not discarded",
        Boolean(await time.recordEventAsync({...base, client_event_id: "client-2",
            task_ref: "TASK-1038", started_at: BASE, ended_at: BASE+7200, source: "manual"})) &&
        Boolean(await time.recordEventAsync({...base, client_event_id: "client-3",
            task_ref: "TASK-1042", started_at: BASE+3600, ended_at: BASE+9000, source: "manual"})));

    await _checkThrows("a negative duration is refused", _ =>
        time.recordEventAsync({...base, client_event_id: "client-neg", duration_seconds: -60, source: "manual"}));
    await _checkThrows("an end before its start is refused", _ =>
        time.recordEventAsync({...base, client_event_id: "client-end", started_at: BASE+100, ended_at: BASE, source: "manual"}));
    await _checkThrows("an unknown source is refused", _ =>
        time.recordEventAsync({...base, client_event_id: "client-src", duration_seconds: 60, source: "vibes"}));
    await _checkThrows("a non-ISO entry date is refused", _ =>
        time.recordEventAsync({...base, client_event_id: "client-date", entry_date: "15/06/2026", duration_seconds: 60}));

    const running = await time.recordEventAsync({...base, client_event_id: "client-run",
        entry_date: time.weekStartOf(new Date().toISOString().substring(0,10)),
        task_ref: "TASK-1042", started_at: Math.floor(Date.now()/1000)-3600, source: "timer"});
    _check("a running timer stores zero duration and projects it on read", running.duration_seconds == 0);
    const weekView = await time.timesheetForOwnerAsync(w.org_id, w.alice, new Date().toISOString().substring(0,10));
    _check("the running timer's projected total is about an hour",
        Math.abs(weekView.totals.total_seconds - 3600) <= 120, `${weekView.totals.total_seconds}s`);

    await _checkThrows("a reconstructed entry without its signal is refused", _ =>
        time.recordEventAsync({...base, client_event_id: "client-rec", duration_seconds: 1800,
            source: "reconstructed", reconstructed: true}));
    const reconstructed = await time.recordEventAsync({...base, client_event_id: "client-rec2",
        entry_date: "2026-06-09", duration_seconds: 1800, source: "reconstructed", reconstructed: true,
        signal: JSON.stringify({type: "app_session", name: "Figma — apibot-hero-v3"})});
    _check("a reconstructed entry keeps the signal it came from",
        reconstructed.reconstructed == 1 && /apibot/.test(reconstructed.signal));

    _check("weekStartOf returns the Monday",
        (new Date(`${time.weekStartOf(WED)}T00:00:00Z`).getUTCDay()) == 1 &&
        time.weekStartOf(WED) == MON);
}

// ---------------------------------------------------------------------------
// the C5 edit trail
// ---------------------------------------------------------------------------

async function _testEditTrail(w) {
    LOG.console("\n edits append; originals survive\n");
    const original = await time.recordEventAsync({org_id: w.org_id, person_id: w.alice, entry_date: W1,
        client_event_id: "edit-orig", task_ref: "TASK-1042", duration_seconds: 9000,
        source: "timer", note: "hero block"});

    const edited = await time.editOwnAsync({org_id: w.org_id, person_id: w.alice,
        entry_event_id: original.entry_event_id, reason: "added the fold work I forgot to time",
        changes: {duration_seconds: 12000}});
    _check("an edit appends a new event", edited.entry_event_id != original.entry_event_id);
    _check("the new event supersedes the original", edited.supersedes_entry_event_id == original.entry_event_id);
    _check("the new event carries the reason", edited.reason == "added the fold work I forgot to time");
    const stored = (await dblayer.getQueryOrThrow(
        "SELECT * FROM time_entry_event WHERE entry_event_id=?", [original.entry_event_id]))[0];
    _check("the original value is never overwritten",
        stored.duration_seconds == 9000 && stored.reason === null);
    _check("the edit kept the task it did not change", edited.task_ref == "TASK-1042");

    const retimed = await time.editOwnAsync({org_id: w.org_id, person_id: w.alice,
        entry_event_id: original.entry_event_id, reason: "wrong window",
        changes: {started_at: BASE, ended_at: BASE+6000}});
    _check("changing the times recomputes the duration", retimed.duration_seconds == 6000, `${retimed.duration_seconds}`);

    await _checkThrows("an edit without a reason is refused", _ =>
        time.editOwnAsync({org_id: w.org_id, person_id: w.alice,
            entry_event_id: original.entry_event_id, changes: {duration_seconds: 60}}));
    await _checkThrows("an edit with an unknown field is refused", _ =>
        time.editOwnAsync({org_id: w.org_id, person_id: w.alice,
            entry_event_id: original.entry_event_id, reason: "x", changes: {colour: "red"}}));
    await _checkThrows("editing someone else's entry through your own path is refused", _ =>
        time.editOwnAsync({org_id: w.org_id, person_id: w.bob,
            entry_event_id: original.entry_event_id, reason: "x", changes: {duration_seconds: 60}}));

    const audited = await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='time_entry.edited' AND object_ref=?",
        [w.org_id, original.entry_event_id]);
    _check("every edit lands in the audit log with the before and after",
        audited.length >= 1 && /from/.test(audited[0].detail) && /to/.test(audited[0].detail));
}

// ---------------------------------------------------------------------------
// the weekly loop
// ---------------------------------------------------------------------------

async function _testWeekLoop(w) {
    LOG.console("\n submit · return · approve\n");
    // a fresh week for this section
    const events = [
        {entry_date: MON, task_ref: "TASK-1042", duration_seconds: 7200},
        {entry_date: TUE, task_ref: "TASK-1042", duration_seconds: 5400},
        {entry_date: WED, task_ref: "TASK-1038", duration_seconds: 3600, billable: 0},
        {entry_date: THU, task_ref: "TASK-1042", duration_seconds: 9000},
        {entry_date: FRI, task_ref: "TASK-1038", duration_seconds: 1800, reconstructed: true,
            source: "reconstructed", signal: JSON.stringify({type: "calendar", name: "1:1 Mary"})}
    ];
    for (const event of events) await time.recordEventAsync({org_id: w.org_id, person_id: w.alice,
        client_event_id: `loop-${event.entry_date}`, ...event});

    const submitted = await time.submitTimesheetAsync({org_id: w.org_id, person_id: w.alice, week_start: MON});
    _check("submitting creates a submitted sheet", submitted.timesheet.status == "submitted");
    _check("the submitted total is projected from the events",
        submitted.totals.total_seconds == 7200+5400+3600+9000+1800, `${submitted.totals.total_seconds}`);
    const pins = await dblayer.getQueryOrThrow("SELECT * FROM timesheet_entry WHERE timesheet_id=?",
        [submitted.timesheet.timesheet_id]);
    _check("submission pins every entry event", pins.length == 5);

    const submittedWeek = await time.timesheetForOwnerAsync(w.org_id, w.alice, MON);
    _check("the owner's view shows the submitted state", submittedWeek.timesheet.status == "submitted");

    // a submitted week is locked
    const wedEvent = (await time.eventsForDayAsync(w.org_id, w.alice, WED))[0];
    await _checkThrows("a submitted week is locked against edits", _ =>
        time.editOwnAsync({org_id: w.org_id, person_id: w.alice,
            entry_event_id: wedEvent.entry_event_id, reason: "x", changes: {duration_seconds: 3601}}));

    // return with named unlocked dates — C7's partial unlock
    await time.returnTimesheetAsync({org_id: w.org_id, actor_person_id: w.bob,
        subject_person_id: w.alice, week_start: MON,
        reason: "please split Thursday", unlock_dates: [THU]});
    const returned = await time.timesheetForOwnerAsync(w.org_id, w.alice, MON);
    _check("a return pins the reason on the record",
        returned.timesheet.status == "returned" && returned.timesheet.return_reason == "please split Thursday");

    const thuEvent = (await time.eventsForDayAsync(w.org_id, w.alice, THU))[0];
    const editedThu = await time.editOwnAsync({org_id: w.org_id, person_id: w.alice,
        entry_event_id: thuEvent.entry_event_id, reason: "split by task", changes: {duration_seconds: 4500}});
    _check("an unlocked date is editable after a return", Boolean(editedThu.entry_event_id));
    await _checkThrows("a date outside the unlock is still locked", _ =>
        time.editOwnAsync({org_id: w.org_id, person_id: w.alice,
            entry_event_id: wedEvent.entry_event_id, reason: "x", changes: {duration_seconds: 3601}}));

    await _checkThrows("a returned week cannot be approved as-is", _ =>
        time.approveTimesheetAsync({org_id: w.org_id, actor_person_id: w.bob,
            subject_person_id: w.alice, week_start: MON}));
    await _checkThrows("returning a week that is not awaiting approval is refused", _ =>
        time.returnTimesheetAsync({org_id: w.org_id, actor_person_id: w.bob,
            subject_person_id: w.alice, week_start: MON, reason: "again", unlock_dates: [THU]}));
    await _checkThrows("a return without a reason is refused", _ =>
        time.returnTimesheetAsync({org_id: w.org_id, actor_person_id: w.bob,
            subject_person_id: w.alice, week_start: MON, unlock_dates: [THU]}));

    const resubmitted = await time.submitTimesheetAsync({org_id: w.org_id, person_id: w.alice, week_start: MON});
    const repins = await dblayer.getQueryOrThrow("SELECT * FROM timesheet_entry WHERE timesheet_id=?",
        [resubmitted.timesheet.timesheet_id]);
    _check("resubmitting re-pins the week, including the edited event",
        repins.some(pin => pin.entry_event_id == editedThu.entry_event_id) &&
        !repins.some(pin => pin.entry_event_id == thuEvent.entry_event_id));

    // the approval signature
    await time.approveTimesheetAsync({org_id: w.org_id, actor_person_id: w.bob,
        subject_person_id: w.alice, week_start: MON});
    const approved = await time.timesheetForOwnerAsync(w.org_id, w.alice, MON);
    _check("approval flips the week to approved with the approver's name",
        approved.timesheet.status == "approved" && approved.timesheet.approved_by == w.bob);

    const signature = await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='timesheet.approved' AND object_ref=?",
        [w.org_id, MON]);
    _check("approval is a signature in the audit log with the totals as they stood",
        signature.length == 1 && signature[0].actor_person_id == w.bob &&
        JSON.parse(signature[0].detail).total_seconds == 4500+7200+5400+3600+1800,
        signature[0]?.detail);

    await _checkThrows("an approved week is read-only", _ =>
        time.editOwnAsync({org_id: w.org_id, person_id: w.alice,
            entry_event_id: editedThu.entry_event_id, reason: "x", changes: {duration_seconds: 1}}));

    await _checkThrows("approving your own week is blocked, naming the rule", _ =>
        time.approveTimesheetAsync({org_id: w.org_id, actor_person_id: w.alice,
            subject_person_id: w.alice, week_start: MON}));

    // bob's own week: submit, then a stranger and HR try to approve
    await time.recordEventAsync({org_id: w.org_id, person_id: w.bob, client_event_id: "bob-1",
        entry_date: MON, task_ref: "TASK-2000", duration_seconds: 3600});
    await time.submitTimesheetAsync({org_id: w.org_id, person_id: w.bob, week_start: MON});
    const stranger = await _checkThrows("a stranger cannot approve", _ =>
        time.approveTimesheetAsync({org_id: w.org_id, actor_person_id: w.erin,
            subject_person_id: w.bob, week_start: MON}));
    _check("the refusal carries the permission decision", Boolean(stranger?.decision));
    const hrApproves = await _checkThrows("HR cannot approve outside its direct reports", _ =>
        time.approveTimesheetAsync({org_id: w.org_id, actor_person_id: w.carol,
            subject_person_id: w.bob, week_start: MON}));
    _check("the HR refusal names who can instead", Boolean(hrApproves?.decision?.who_can));
}

// ---------------------------------------------------------------------------
// the manager mirror
// ---------------------------------------------------------------------------

async function _testApproverRead(w) {
    LOG.console("\n the manager mirror\n");
    const view = await time.timesheetForApproverAsync(w.org_id, w.bob, w.alice, MON);
    _check("the approver read carries the totals", view.totals.total_seconds > 0, `${view.totals.total_seconds}`);
    _check("per-task totals and the billable split are present",
        Array.isArray(view.totals.by_task) && view.totals.by_task.length > 0 &&
        view.totals.billable_seconds <= view.totals.total_seconds);
    _check("per-entry start times are absent from the approver's shape",
        !("events" in view) && JSON.stringify(view).includes("started_at") == false);

    const selfView = await time.timesheetForOwnerAsync(w.org_id, w.alice, MON);
    _check("the owner's own view keeps the full entries with their times",
        Array.isArray(selfView.events) && selfView.events.some(event => event.started_at !== undefined));

    await _checkThrows("a reader with no timesheet.read is refused", _ =>
        time.timesheetForApproverAsync(w.org_id, w.erin, w.alice, MON));

    const aliceWeek = await time.timesheetForOwnerAsync(w.org_id, w.alice, MON);
    _check("the owner's read is not gated by the approver path", Boolean(aliceWeek.totals));
}

// ---------------------------------------------------------------------------
// the HR correction power
// ---------------------------------------------------------------------------

async function _testOtherPersonEdit(w) {
    LOG.console("\n editing someone else's time\n");
    const entry = await time.recordEventAsync({org_id: w.org_id, person_id: w.alice, entry_date: W2,
        client_event_id: "hr-edit-orig", task_ref: "TASK-1042", duration_seconds: 5400, source: "timer"});

    const edited = await time.editOtherAsync({org_id: w.org_id, actor_person_id: w.carol,
        subject_person_id: w.alice, entry_event_id: entry.entry_event_id,
        reason: "adjusted after client correction", changes: {duration_seconds: 6000, client_code: "APIBOT-02"}});
    _check("HR's correction appends an event with the reason",
        edited.supersedes_entry_event_id == entry.entry_event_id &&
        edited.reason == "adjusted after client correction" && edited.client_code == "APIBOT-02");

    const auditRow = (await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='time_entry.edited' AND object_ref=?",
        [w.org_id, entry.entry_event_id]))[0];
    _check("the correction is audited with HR as the actor",
        auditRow.actor_person_id == w.carol && auditRow.subject_person_id == w.alice);
    _check("the audit entry pins the acting HR's permission set",
        JSON.parse(auditRow.effective_permissions).some(g => g.capability == "time_entry.edit_other"));

    await _checkThrows("a correction without a reason is refused", _ =>
        time.editOtherAsync({org_id: w.org_id, actor_person_id: w.carol,
            subject_person_id: w.alice, entry_event_id: entry.entry_event_id,
            changes: {duration_seconds: 60}}));
    const strangerEdit = await _checkThrows("a stranger cannot correct anyone's time", _ =>
        time.editOtherAsync({org_id: w.org_id, actor_person_id: w.erin,
            subject_person_id: w.alice, entry_event_id: entry.entry_event_id,
            reason: "x", changes: {duration_seconds: 60}}));
    _check("that refusal names the capability", Boolean(strangerEdit?.decision));
}

// ---------------------------------------------------------------------------
// the API surface
// ---------------------------------------------------------------------------

async function _testAPI(w) {
    LOG.console("\n the time API\n");
    const recorded = await timeapi.doService({op: "record", id: w.aliceEmail, org: w.org_id,
        client_event_id: "api-1", entry_date: FRI, task_ref: "TASK-1042", duration_seconds: 3600});
    _check("op record answers true with the entry id", recorded.result === true && Boolean(recorded.entry_event_id));

    const retried = await timeapi.doService({op: "record", id: w.aliceEmail, org: w.org_id,
        client_event_id: "api-1", entry_date: FRI, task_ref: "TASK-1042", duration_seconds: 3600});
    _check("the API retry is idempotent", retried.entry_event_id == recorded.entry_event_id);

    const day = await timeapi.doService({op: "day", id: w.aliceEmail, org: w.org_id, entry_date: FRI});
    _check("op day returns the caller's own entries",
        day.result === true && day.events.some(event => event.client_event_id == "api-1"),
        `${day.events?.length} event(s)`);

    const unknown = await timeapi.doService({op: "day", id: "nobody@example.invalid", org: w.org_id, entry_date: FRI});
    _check("an unknown actor is refused with a reason", unknown.result === false && /No person/.test(unknown.reason||""));

    const invalid = await timeapi.doService({op: "frobnicate", id: w.aliceEmail, org: w.org_id});
    _check("an unknown op is refused", invalid.result === false);
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Time test ${stamp}`, home_jurisdiction: "GB"});
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
    await dblayer.runCmdBestEffortAsync("DELETE FROM timesheet_entry WHERE org_id=?", [w.org_id]);
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
