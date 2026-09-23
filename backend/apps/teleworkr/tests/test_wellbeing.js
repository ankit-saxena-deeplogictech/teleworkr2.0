/**
 * Tests M — wellbeing & load. Five real signals, each checked at its own
 * threshold boundary with a constructed fixture; the evaluator's
 * idempotency and mute-vs-ledger split; the tighten-only override; the
 * cohort floor refusing rather than emptying; a share's expiry and revoke.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests wellbeing
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const wellbeing = require(`${TELEWORKR_CONSTANTS.LIBDIR}/wellbeing.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Wellbeing test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 100)}`, true);}
}

const _today = () => new Date().toISOString().substring(0, 10);
const _isoDaysAgo = (iso, days) => {const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate()-days); return d.toISOString().substring(0,10);}
const _now = () => Math.floor(Date.now()/1000);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "wellbeing")) {
        LOG.console("Skipping wellbeing test case, not called.\n"); return true;
    }
    LOG.console("\nM wellbeing & load\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _publishDefaults(w);
        await _testSustainedLoad(w);
        await _testNoRecovery(w);
        await _testOutOfWindow(w);
        await _testBlockedDrag(w);
        await _testLeaveNotTaken(w);
        await _testIdempotencyAndMute(w);
        await _testThresholdOverride(w);
        await _testTeamLoadCohortFloor(w);
        await _testShares(w);
        await _testCapabilityRefusals(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  wellbeing tests threw: ${err}\n`); LOG.error(`Wellbeing tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nWellbeing tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

/** Publishes every signal at its documented default, so the evaluator has real thresholds to read. */
async function _publishDefaults(w) {
    for (const signal_code of wellbeing.SIGNAL_CODES)
        await wellbeing.publishSignalDefinitionAsync({org_id: w.org_id, actor_person_id: w.carol, signal_code,
            threshold: wellbeing.SIGNAL_SPECS[signal_code].default_threshold, ladder: {offer_after_days: 14}});
}

/** Directly inserts a time_entry_event — bypassing time.js's API so a fixture can control exact hours and dates. */
async function _insertTime(w, person_id, entry_date, started_at, duration_seconds) {
    await dblayer.runCmdOrThrow(
        `INSERT INTO time_entry_event (entry_event_id, org_id, person_id, entry_date, started_at, ended_at,
            duration_seconds, source, billable, reconstructed, recorded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [`te-${w.stamp}-${Math.random().toString(36).slice(2,8)}`, w.org_id, person_id, entry_date,
            started_at, started_at + duration_seconds, duration_seconds, "manual", 1, 0, _now()]);
}

async function _testSustainedLoad(w) {
    LOG.console("\n sustained load\n");
    // 50h/week for 3 weeks against a 40h contract — 25% over, above the 15% default
    for (let weekAgo = 0; weekAgo < 3; weekAgo++) {
        const date = _isoDaysAgo(_today(), weekAgo*7 + 1);
        await _insertTime(w, w.loaded, date, Math.floor(Date.parse(`${date}T09:00:00Z`)/1000), 50*3600);
    }
    const preview = await wellbeing.previewSignalEvaluationAsync({org_id: w.org_id, actor_person_id: w.carol});
    const entry = preview.entries.find(e => e.person_id == w.loaded && e.signal_code == "sustained_load");
    _check("50h/week against a 40h contract lights sustained_load",
        entry?.lit === true && entry.inputs.avg_weekly_hours > 45, JSON.stringify(entry));

    const control = preview.entries.find(e => e.person_id == w.steady && e.signal_code == "sustained_load");
    _check("no logged time at all does not light sustained_load", control?.lit === false, JSON.stringify(control));
}

async function _testNoRecovery(w) {
    LOG.console("\n no recovery\n");
    const today = _today();
    for (let daysAgo = 0; daysAgo < 13; daysAgo++)
        await _insertTime(w, w.norecovery, _isoDaysAgo(today, daysAgo),
            Math.floor(Date.parse(`${_isoDaysAgo(today, daysAgo)}T10:00:00Z`)/1000), 3600);
    const preview = await wellbeing.previewSignalEvaluationAsync({org_id: w.org_id, actor_person_id: w.carol});
    const entry = preview.entries.find(e => e.person_id == w.norecovery && e.signal_code == "no_recovery");
    _check("13 consecutive days with logged time lights no_recovery (threshold 12)",
        entry?.lit === true && entry.inputs.streak_days >= 12, JSON.stringify(entry));
}

async function _testOutOfWindow(w) {
    LOG.console("\n out-of-window work\n");
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.outofwindow, timezone: "Etc/GMT",
        start_minute: 540, end_minute: 1020, days: [1,2,3,4,5,6,7], valid_from: "2026-01-01"});
    const today = _today();
    // 4 distinct days with an entry at 22:00 GMT — well outside 09:00-17:00
    for (const daysAgo of [1, 3, 5, 7])
        await _insertTime(w, w.outofwindow, _isoDaysAgo(today, daysAgo),
            Math.floor(Date.parse(`${_isoDaysAgo(today, daysAgo)}T22:00:00Z`)/1000), 1800);
    const preview = await wellbeing.previewSignalEvaluationAsync({org_id: w.org_id, actor_person_id: w.carol});
    const entry = preview.entries.find(e => e.person_id == w.outofwindow && e.signal_code == "out_of_window");
    _check("4 evenings outside the declared window in a fortnight lights out_of_window",
        entry?.lit === true && entry.inputs.out_of_window_days >= 4, JSON.stringify(entry));
}

async function _testBlockedDrag(w) {
    LOG.console("\n blocked drag\n");
    const blocker = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.carol,
        title: "Blocker", assignee_person_id: w.carol});
    const blocked = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.carol,
        title: "Blocked work", assignee_person_id: w.blockeddrag});
    await tasks.addBlockAsync({org_id: w.org_id, actor_person_id: w.carol,
        blocker_task_ref: blocker.task_ref, blocked_task_ref: blocked.task_ref, reason: "Waiting on the blocker."});
    // task.created_at and the block relation's created_at both land in the same
    // wall-clock second as this test executes — push both back two hours so the
    // ratio has real elapsed time to divide, deterministically, with no sleep.
    await dblayer.runCmdOrThrow("UPDATE task SET created_at = created_at - 7200 WHERE org_id=? AND task_ref=?",
        [w.org_id, blocked.task_ref]);
    await dblayer.runCmdOrThrow(
        `UPDATE task_relation SET created_at = created_at - 7200 WHERE org_id=? AND relation_type='blocks'
            AND to_task_id=(SELECT task_id FROM task WHERE org_id=? AND task_ref=?)`,
        [w.org_id, w.org_id, blocked.task_ref]);

    const load = await tasks.blockedLoadForPersonAsync(w.org_id, w.blockeddrag);
    _check("a task blocked immediately after creation carries nearly all of its open time as blocked",
        load.ratio != null && load.ratio > 0.2, JSON.stringify(load));

    const preview = await wellbeing.previewSignalEvaluationAsync({org_id: w.org_id, actor_person_id: w.carol});
    const entry = preview.entries.find(e => e.person_id == w.blockeddrag && e.signal_code == "blocked_drag");
    _check("blocked_drag lights for the person carrying the blocked task",
        entry?.lit === true, JSON.stringify(entry));
    const control = preview.entries.find(e => e.person_id == w.steady && e.signal_code == "blocked_drag");
    _check("no open tasks at all does not light blocked_drag", control?.lit === false, JSON.stringify(control));
}

/** A future evaluated_for decouples "day of year > 182" from whatever day the suite actually runs on. */
async function _testLeaveNotTaken(w) {
    LOG.console("\n leave not taken\n");
    await leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol, effective_from: "2026-01-01",
        step_up_verified: true,
        policy: {scope: {jurisdiction: "IN"},
            leave_types: [{code: "EL", label: "Earned Leave", quantum: {annual_days: 20}, approval_route: ["manager"]}]}});
    await dblayer.runCmdOrThrow(
        `INSERT INTO opening_balance_entry (opening_balance_id, org_id, person_id, leave_type, days,
            cutover_date, source, imported_at) VALUES (?,?,?,?,?,?,?,?)`,
        [`ob-${w.stamp}`, w.org_id, w.leavenottaken, "EL", 18, "2026-01-01", "manual", _now()]);

    const futureEval = "2026-12-01";   // day of year ~335, past the 182-day check point regardless of run date
    const preview = await wellbeing.previewSignalEvaluationAsync({org_id: w.org_id, actor_person_id: w.carol,
        evaluated_for: futureEval});
    const entry = preview.entries.find(e => e.person_id == w.leavenottaken && e.signal_code == "leave_not_taken");
    _check("18 of 20 days still available, late in the year, lights leave_not_taken",
        entry?.lit === true && entry.inputs.unused_percent >= 60, JSON.stringify(entry));
}

async function _testIdempotencyAndMute(w) {
    LOG.console("\n evaluator idempotency and mute\n");
    const evaluated_for = _today();
    const first = await wellbeing.evaluateSignalsAsync({org_id: w.org_id, actor_person_id: w.carol, evaluated_for});
    _check("the first execution for today writes rows", first.people > 0, JSON.stringify(first));

    const countBefore = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM signal_ledger_entry WHERE org_id=? AND evaluated_for=?",
        [w.org_id, evaluated_for]))[0].c;
    const second = await wellbeing.evaluateSignalsAsync({org_id: w.org_id, actor_person_id: w.carol, evaluated_for});
    const countAfter = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM signal_ledger_entry WHERE org_id=? AND evaluated_for=?",
        [w.org_id, evaluated_for]))[0].c;
    _check("a same-day re-run writes nothing new", countBefore == countAfter, `${countBefore} vs ${countAfter}`);

    const notified = await dblayer.getQueryOrThrow(
        `SELECT * FROM notification WHERE org_id=? AND recipient_person_id=? AND category='wellbeing_signal'`,
        [w.org_id, w.loaded]);
    _check("a newly-lit signal, unmuted, raised the already-catalogued wellbeing_signal notification",
        notified.length > 0, JSON.stringify(notified.map(n => n.status)));

    // A fresh person, muted before their first-ever evaluation — isolated from
    // w.norecovery's own fixture, which already lit (and notified) earlier in
    // this same test, so it can never produce a second "newly lit" transition
    // to observe muting against.
    const muteEvalDate = "2026-11-15";
    await wellbeing.muteAsync({org_id: w.org_id, person_id: w.muted, signal_code: "no_recovery",
        muted_until: "2026-12-31"});   // must outlast muteEvalDate, not "today" — the mute is checked as of evaluated_for
    for (let daysAgo = 0; daysAgo < 13; daysAgo++)
        await _insertTime(w, w.muted, _isoDaysAgo(muteEvalDate, daysAgo),
            Math.floor(Date.parse(`${_isoDaysAgo(muteEvalDate, daysAgo)}T10:00:00Z`)/1000), 3600);
    await wellbeing.evaluateSignalsAsync({org_id: w.org_id, actor_person_id: w.carol, evaluated_for: muteEvalDate});
    const ledgerRow = (await dblayer.getQueryOrThrow(
        "SELECT * FROM signal_ledger_entry WHERE org_id=? AND person_id=? AND signal_code=? AND evaluated_for=?",
        [w.org_id, w.muted, "no_recovery", muteEvalDate]))[0];
    _check("the ledger keeps writing while muted — signals are computed regardless",
        ledgerRow?.lit == 1, JSON.stringify(ledgerRow));
    const mutedNotification = await dblayer.getQueryOrThrow(
        `SELECT * FROM notification WHERE org_id=? AND recipient_person_id=? AND category='wellbeing_signal' AND object_ref='no_recovery'`,
        [w.org_id, w.muted]);
    _check("but muting suppressed the notification for that first-ever, newly-lit signal",
        mutedNotification.length == 0, JSON.stringify(mutedNotification));
}

async function _testThresholdOverride(w) {
    LOG.console("\n personal threshold override — tighten only\n");
    await _checkThrows("a looser override than the published default is refused",
        _ => wellbeing.setThresholdOverrideAsync({org_id: w.org_id, person_id: w.steady,
            signal_code: "blocked_drag", value: 90}));
    const tightened = await wellbeing.setThresholdOverrideAsync({org_id: w.org_id, person_id: w.steady,
        signal_code: "blocked_drag", value: 5});
    _check("a stricter override is accepted", tightened.percent == 5, JSON.stringify(tightened));
    await wellbeing.clearThresholdOverrideAsync(w.org_id, w.steady, "blocked_drag");
    const cleared = await dblayer.getQueryOrThrow(
        "SELECT * FROM signal_threshold_override WHERE org_id=? AND person_id=? AND signal_code=?",
        [w.org_id, w.steady, "blocked_drag"]);
    _check("clearing an override removes it", cleared.length == 0);
}

async function _testTeamLoadCohortFloor(w) {
    LOG.console("\n team load — cohort floor\n");

    const small = await spine.directReportsAsOfAsync(w.org_id, w.smallLead);
    _check("the small-cohort fixture really is below the floor", small.length + 1 < wellbeing.MINIMUM_COHORT,
        `${small.length + 1}`);
    await _checkThrows("a lead with a cohort below the floor is refused, not emptied",
        _ => wellbeing.teamLoadAsync(w.org_id, w.smallLead));

    const big = await spine.directReportsAsOfAsync(w.org_id, w.bigLead);
    _check("the big-cohort fixture meets the floor", big.length + 1 >= wellbeing.MINIMUM_COHORT, `${big.length + 1}`);
    const result = await wellbeing.teamLoadAsync(w.org_id, w.bigLead);
    _check("a cohort at or above the floor returns bins, not a per-person list",
        result.cohort_size >= wellbeing.MINIMUM_COHORT && Array.isArray(result.bins), JSON.stringify(result));
    const asText = JSON.stringify(result);
    const leaksAPersonId = [w.bigLead, ...big.map(r => r.person_id)].some(id => asText.includes(id));
    _check("no person_id or name appears anywhere in the team load response", !leaksAPersonId, asText.slice(0, 300));
}

async function _testShares(w) {
    LOG.console("\n shares — time-boxed, revocable\n");
    const share = await wellbeing.shareSummaryAsync({org_id: w.org_id, sharer_person_id: w.steady,
        recipient_person_id: w.carol, period_from: _isoDaysAgo(_today(), 13), period_to: _today(),
        expires_in_days: 14});
    _check("sharing returns a snapshot with hours and blocked time, not signal names",
        share.summary && !JSON.stringify(share.summary).includes("signal"), JSON.stringify(share.summary));

    let received = await wellbeing.sharesReceivedAsync(w.org_id, w.carol);
    _check("the recipient sees the active share", received.some(s => s.share_id == share.share_id), JSON.stringify(received));

    await wellbeing.revokeShareAsync(w.org_id, w.steady, share.share_id);
    received = await wellbeing.sharesReceivedAsync(w.org_id, w.carol);
    _check("revoking makes it unreadable immediately", !received.some(s => s.share_id == share.share_id));

    const expiring = await wellbeing.shareSummaryAsync({org_id: w.org_id, sharer_person_id: w.steady,
        recipient_person_id: w.carol, period_from: _isoDaysAgo(_today(), 13), period_to: _today(),
        expires_in_days: 14});
    await dblayer.runCmdOrThrow("UPDATE signal_share SET expires_at=? WHERE share_id=?", [_now() - 1, expiring.share_id]);
    received = await wellbeing.sharesReceivedAsync(w.org_id, w.carol);
    _check("an expired share is unreadable by the recipient", !received.some(s => s.share_id == expiring.share_id));

    await _checkThrows("revoking someone else's share is refused",
        _ => wellbeing.revokeShareAsync(w.org_id, w.carol, expiring.share_id));
}

async function _testCapabilityRefusals(w) {
    LOG.console("\n capability refusals\n");
    await _checkThrows("an employee cannot publish a signal definition",
        _ => wellbeing.publishSignalDefinitionAsync({org_id: w.org_id, actor_person_id: w.employee,
            signal_code: "blocked_drag", threshold: {percent: 20}, ladder: {offer_after_days: 14}}));
    await _checkThrows("an employee cannot run the evaluator",
        _ => wellbeing.evaluateSignalsAsync({org_id: w.org_id, actor_person_id: w.employee}));
    await _checkThrows("an employee with no direct reports cannot read team load",
        _ => wellbeing.teamLoadAsync(w.org_id, w.employee));
    const own = await wellbeing.myLoadAsync(w.org_id, w.employee);
    _check("every role, including a plain employee, can read their own load", own != null);
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Wellbeing test ${stamp}`, home_jurisdiction: "IN"});
    const roleOf = {carol: "hr", employee: "employee", loaded: "employee", steady: "employee",
        norecovery: "employee", outofwindow: "employee", blockeddrag: "employee", leavenottaken: "employee",
        muted: "employee", smallLead: "lead", bigLead: "lead"};
    const people = {};
    for (const who of Object.keys(roleOf))
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});
    // a handful of direct reports for the small/big cohort fixtures
    const smallReports = [], bigReports = [];
    for (let i = 0; i < 3; i++) smallReports.push(await spine.createPersonAsync(
        {display_name: `small-report-${i}`, email: `small-report-${i}.${stamp}@example.invalid`}));
    for (let i = 0; i < 5; i++) bigReports.push(await spine.createPersonAsync(
        {display_name: `big-report-${i}`, email: `big-report-${i}.${stamp}@example.invalid`}));

    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN", contract_type: "employee",
        contracted_pattern: {hours_per_week: 40}, valid_from: "2026-01-01", source: "manual"});
    for (const report of smallReports) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: report.person_id, status: "active", jurisdiction: "IN", contract_type: "employee",
        manager_person_id: people.smallLead.person_id, valid_from: "2026-01-01", source: "manual"});
    for (const report of bigReports) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: report.person_id, status: "active", jurisdiction: "IN", contract_type: "employee",
        manager_person_id: people.bigLead.person_id, valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const [who, role] of Object.entries(roleOf)) await permissions.assignRoleAsync(org.org_id, people[who].person_id, role, from);
    for (const report of [...smallReports, ...bigReports]) await permissions.assignRoleAsync(org.org_id, report.person_id, "employee", from);

    return {org_id: org.org_id, stamp, smallReports, bigReports,
        ...Object.fromEntries(Object.entries(people).map(([name, person]) => [name, person.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["signal_share", "signal_mute", "signal_threshold_override", "signal_ledger_entry",
        "signal_definition_pointer", "signal_definition", "task_relation", "task_event", "task",
        "opening_balance_entry", "leave_ledger_entry", "leave_request", "leave_policy_pointer",
        "leave_policy_version", "time_entry_event", "notification", "notification_setting",
        "working_window", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["carol", "employee", "loaded", "steady", "norecovery", "outofwindow", "blockeddrag",
        "leavenottaken", "muted", "smallLead", "bigLead"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
    for (const report of [...(w.smallReports||[]), ...(w.bigReports||[])])
        await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [report.person_id]);
}
