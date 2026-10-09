/**
 * Tests A10 — the product-event catalogue, its pseudonymous person_ref, the
 * 7 built metrics (the 8th, weekly overlap-board use, is narrowed out — see
 * events.js's own header), and the on-demand retention rollup.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests events
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const clock = require(`${TELEWORKR_CONSTANTS.LIBDIR}/clock.js`);
const leave = require(`${TELEWORKR_CONSTANTS.LIBDIR}/leave.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const events = require(`${TELEWORKR_CONSTANTS.LIBDIR}/events.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Events test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 120)}`, true);}
}

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "events")) {
        LOG.console("Skipping events test case, not called.\n"); return true;
    }
    LOG.console("\nA10 events\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testValidation(w);
        await _testPersonRef(w);
        await _testIntegration(w);
        await _testSummaryMath(w);
        await _testRetention(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  events tests threw: ${err}\n`); LOG.error(`Events tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nEvents tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------

async function _testValidation(w) {
    LOG.console("\n emitAsync validation\n");
    await _checkThrows("an unknown action is refused", _ =>
        events.emitAsync({org_id: w.org_id, action: "made.up", person_id: w.alice, source: "web"}));
    await _checkThrows("a bad source is refused", _ =>
        events.emitAsync({org_id: w.org_id, action: "timer.started", person_id: w.alice, source: "carrier_pigeon"}));
}

async function _testPersonRef(w) {
    LOG.console("\n person_ref — pseudonymous, stable within an org\n");
    await events.emitAsync({org_id: w.org_id, action: "signal.muted", person_id: w.alice, source: "web", detail: {signal_code: "all"}});
    const rows = await dblayer.getQueryOrThrow(
        "SELECT person_ref FROM product_event WHERE org_id=? AND action='signal.muted' AND person_ref IS NOT NULL ORDER BY created_at DESC LIMIT 2",
        [w.org_id]);
    await events.emitAsync({org_id: w.org_id, action: "signal.muted", person_id: w.alice, source: "web", detail: {signal_code: "all"}});
    const again = (await dblayer.getQueryOrThrow(
        "SELECT person_ref FROM product_event WHERE org_id=? AND action='signal.muted' AND person_ref IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [w.org_id]))[0];
    _check("person_ref is stable across two emits for the same org+person", rows[0].person_ref == again.person_ref);

    const otherOrg = await spine.createOrgAsync({name: `Events ref test ${w.stamp}`, home_jurisdiction: "GB"});
    await events.emitAsync({org_id: otherOrg.org_id, action: "signal.muted", person_id: w.alice, source: "web", detail: {signal_code: "all"}});
    const inOtherOrg = (await dblayer.getQueryOrThrow(
        "SELECT person_ref FROM product_event WHERE org_id=? AND action='signal.muted'", [otherOrg.org_id]))[0];
    _check("person_ref differs for the same person across two different orgs", inOtherOrg.person_ref != again.person_ref);
    await dblayer.runCmdBestEffortAsync("DELETE FROM product_event WHERE org_id=?", [otherOrg.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [otherOrg.org_id]);
}

async function _testIntegration(w) {
    LOG.console("\n real call sites actually emit\n");

    await clock.clockInAsync({org_id: w.org_id, person_id: w.alice, task_ref: null});
    const started = await dblayer.getQueryOrThrow(
        "SELECT * FROM product_event WHERE org_id=? AND action='timer.started'", [w.org_id]);
    const created = await dblayer.getQueryOrThrow(
        "SELECT * FROM product_event WHERE org_id=? AND action='time_entry.created'", [w.org_id]);
    _check("clocking in emits timer.started", started.length == 1, JSON.stringify(started));
    _check("clocking in emits time_entry.created with its source", created.length == 1 &&
        JSON.parse(created[0].detail).source == "timer", JSON.stringify(created));
    await clock.clockOutAsync({org_id: w.org_id, person_id: w.alice});

    await leave.publishPolicyAsync({org_id: w.org_id, actor_person_id: w.carol, step_up_verified: true,
        effective_from: "2026-01-01", resolutions: {},
        policy: {scope: {jurisdiction: "GB", contract_type: "employee", status: ["active"]},
            leave_types: [{code: "EL", label: "Earned leave", quantum: {annual_days: 12},
                accrual: {per_month: 1}, eligibility: {states: ["active"]},
                notice: {multiplier: 0, floor_days: 0, short_notice_approvable: true},
                max_per_request: 6, approval_route: ["manager"]}]}});
    const request = await leave.requestLeaveAsync({org_id: w.org_id, person_id: w.alice,
        leave_type: "EL", from_date: "2026-12-14", to_date: "2026-12-14", notice_days: 20});
    const requested = await dblayer.getQueryOrThrow(
        "SELECT * FROM product_event WHERE org_id=? AND action='approval.requested'", [w.org_id]);
    _check("requesting leave emits approval.requested with the correlator", requested.length == 1 &&
        JSON.parse(requested[0].detail).leave_request_id == request.request.leave_request_id, JSON.stringify(requested));

    await leave.approveLeaveRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
        leave_request_id: request.request.leave_request_id});
    const decided = await dblayer.getQueryOrThrow(
        "SELECT * FROM product_event WHERE org_id=? AND action='approval.decided'", [w.org_id]);
    _check("approving emits approval.decided correlated to the same request", decided.length == 1 &&
        JSON.parse(decided[0].detail).leave_request_id == request.request.leave_request_id &&
        JSON.parse(decided[0].detail).decision == "approved", JSON.stringify(decided));

    const first = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice, title: "Blocker"});
    const second = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice, title: "Blocked"});
    await tasks.addBlockAsync({org_id: w.org_id, actor_person_id: w.alice,
        blocker_task_ref: first.task_ref, blocked_task_ref: second.task_ref, reason: "waiting"});
    const blocked = await dblayer.getQueryOrThrow(
        "SELECT * FROM product_event WHERE org_id=? AND action='task.blocked'", [w.org_id]);
    _check("blocking a task emits task.blocked", blocked.length == 1 &&
        JSON.parse(blocked[0].detail).task_id == second.task_id, JSON.stringify(blocked));

    await tasks.resolveBlockAsync({org_id: w.org_id, actor_person_id: w.alice,
        blocker_task_ref: first.task_ref, blocked_task_ref: second.task_ref});
    const unblocked = await dblayer.getQueryOrThrow(
        "SELECT * FROM product_event WHERE org_id=? AND action='task.unblocked'", [w.org_id]);
    _check("unblocking emits task.unblocked for the same task", unblocked.length == 1 &&
        JSON.parse(unblocked[0].detail).task_id == second.task_id, JSON.stringify(unblocked));

    // resolveBlockAsync deliberately leaves the task's status as-is (the
    // module's own comment: "unblocking is not the same as knowing what the
    // task should be now"), so a second block on the same pair finds the
    // task already at status 'blocked' — no status flip, so no second
    // task.blocked event. Confirms the emit is tied to the real status
    // change, not to the relation being (re-)created.
    await tasks.addBlockAsync({org_id: w.org_id, actor_person_id: w.alice,
        blocker_task_ref: first.task_ref, blocked_task_ref: second.task_ref, reason: "waiting again"});
    const blockedAgain = await dblayer.getQueryOrThrow(
        "SELECT * FROM product_event WHERE org_id=? AND action='task.blocked'", [w.org_id]);
    _check("re-blocking a task whose status never left 'blocked' emits no second task.blocked",
        blockedAgain.length == 1, JSON.stringify(blockedAgain));
}

async function _testSummaryMath(w) {
    LOG.console("\n summaryAsync's math\n");

    // a clean slate — the integration and person_ref tests above left their
    // own real events behind, and this section wants deterministic fixtures
    await dblayer.runCmdBestEffortAsync("DELETE FROM product_event WHERE org_id=?", [w.org_id]);
    const base = _now() - 3600;

    // median approval latency — odd count (3): 100, 200, 300 -> median 200
    for (const [reqAt, decAt] of [[base+1000, base+1100], [base+2000, base+2200], [base+3000, base+3300]]) {
        await _seed(w.org_id, "approval.requested", w.alice, reqAt, {leave_request_id: `lat-odd-${reqAt}`});
        await _seed(w.org_id, "approval.decided", w.bob, decAt, {leave_request_id: `lat-odd-${reqAt}`, decision: "approved"});
    }
    const oddLatency = await events.summaryAsync(w.org_id, w.dave, {from_date: "2000-01-01", to_date: "2100-01-01"});
    _check("median approval latency, odd sample, is the middle value", oddLatency.median_approval_latency_seconds.median_seconds == 200,
        JSON.stringify(oddLatency.median_approval_latency_seconds));

    // blocked duration across a re-block cycle on the same task_id:
    // block@1000/unblock@1100 (100s), block@1200/unblock@1500 (300s) -> median 200
    await _seed(w.org_id, "task.blocked", w.alice, base+1000, {task_id: "T-re"});
    await _seed(w.org_id, "task.unblocked", w.alice, base+1100, {task_id: "T-re"});
    await _seed(w.org_id, "task.blocked", w.alice, base+1200, {task_id: "T-re"});
    await _seed(w.org_id, "task.unblocked", w.alice, base+1500, {task_id: "T-re"});
    const blockedDur = await events.summaryAsync(w.org_id, w.dave, {from_date: "2000-01-01", to_date: "2100-01-01"});
    _check("blocked duration pairs each unblock with its own cycle's block, not an earlier one",
        blockedDur.median_blocked_duration_seconds.median_seconds == 200 &&
        blockedDur.median_blocked_duration_seconds.sample_size == 2,
        JSON.stringify(blockedDur.median_blocked_duration_seconds));

    // wellbeing mute rate — zero shown must not divide by zero
    const zeroShown = await events.summaryAsync(w.org_id, w.dave, {from_date: "1999-01-01", to_date: "1999-01-02"});
    _check("mute rate with zero signals shown is null, not NaN/Infinity", zeroShown.wellbeing_mute_rate.rate === null,
        JSON.stringify(zeroShown.wellbeing_mute_rate));

    await _seed(w.org_id, "signal.shown", w.alice, base+5000, {signal_code: "sustained_load"});
    await _seed(w.org_id, "signal.shown", w.bob, base+5001, {signal_code: "sustained_load"});
    await _seed(w.org_id, "signal.muted", w.alice, base+5002, {signal_code: "sustained_load"});
    const muteRate = await events.summaryAsync(w.org_id, w.dave, {from_date: "2000-01-01", to_date: "2100-01-01"});
    _check("mute rate is muted/shown", muteRate.wellbeing_mute_rate.rate == 0.5 &&
        muteRate.wellbeing_mute_rate.shown == 2 && muteRate.wellbeing_mute_rate.muted == 1,
        JSON.stringify(muteRate.wellbeing_mute_rate));

    // pages in review window — live wiki_page state, cadence 3 months
    const inWindowId = serverutils.generateUUID(false), outOfWindowId = serverutils.generateUUID(false);
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_page (page_id, org_id, space_id, title, slug, status, review_cadence_months, last_reviewed_at, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
        [inWindowId, w.org_id, "space-1", "Fresh page", `fresh-${w.stamp}`, "published", 3, _now() - 10, _now()]);
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_page (page_id, org_id, space_id, title, slug, status, review_cadence_months, last_reviewed_at, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
        [outOfWindowId, w.org_id, "space-1", "Stale page", `stale-${w.stamp}`, "published", 3, _now() - 400*86400, _now()]);
    const pagesResult = await events.summaryAsync(w.org_id, w.dave, {from_date: "2000-01-01", to_date: "2100-01-01"});
    _check("pages-in-review-window counts the fresh page and excludes the stale one",
        pagesResult.pages_in_review_window.total_published == 2 && pagesResult.pages_in_review_window.in_window == 1,
        JSON.stringify(pagesResult.pages_in_review_window));

    await _checkThrows("a non-admin cannot read the summary", _ =>
        events.summaryAsync(w.org_id, w.alice, {}));

    await dblayer.runCmdBestEffortAsync("DELETE FROM wiki_page WHERE org_id=?", [w.org_id]);
}

async function _testRetention(w) {
    LOG.console("\n retention — preview then execute\n");
    const freshOrg = (await spine.createOrgAsync({name: `Events retention test ${w.stamp}`, home_jurisdiction: "GB"})).org_id;
    await permissions.ensureBuiltinRolesAsync(freshOrg);
    await permissions.assignRoleAsync(freshOrg, w.dave, "admin", {granted_by: "system", valid_from: "2026-01-01"});

    const old = _now() - 91*86400, recent = _now() - 5*86400;
    await dblayer.runCmdOrThrow(
        `INSERT INTO product_event (event_id, org_id, action, person_ref, occurred_at, source, schema_version, detail, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`, [serverutils.generateUUID(false), freshOrg, "timer.started", "ref", old, "web", 1, "", old]);
    await dblayer.runCmdOrThrow(
        `INSERT INTO product_event (event_id, org_id, action, person_ref, occurred_at, source, schema_version, detail, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`, [serverutils.generateUUID(false), freshOrg, "timer.started", "ref", recent, "web", 1, "", recent]);

    const preview = await events.previewRetentionRunAsync(freshOrg, w.dave);
    _check("preview reports exactly the one old row", preview.rows_to_aggregate == 1, JSON.stringify(preview));
    const stillThere = await dblayer.getQueryOrThrow("SELECT * FROM product_event WHERE org_id=?", [freshOrg]);
    _check("preview makes no changes", stillThere.length == 2);

    const executed = await events.executeRetentionRunAsync(freshOrg, w.dave);
    _check("execute aggregates exactly the one old row", executed.rows_aggregated == 1, JSON.stringify(executed));
    const remaining = await dblayer.getQueryOrThrow("SELECT * FROM product_event WHERE org_id=?", [freshOrg]);
    _check("only the recent raw row survives", remaining.length == 1 && remaining[0].occurred_at == recent, JSON.stringify(remaining));
    const agg = await dblayer.getQueryOrThrow(
        "SELECT * FROM product_event_daily_agg WHERE org_id=? AND action='timer.started'", [freshOrg]);
    _check("the old row survives as a daily aggregate count", agg.length == 1 && agg[0].event_count == 1, JSON.stringify(agg));

    await dblayer.runCmdBestEffortAsync("DELETE FROM product_event WHERE org_id=?", [freshOrg]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM product_event_daily_agg WHERE org_id=?", [freshOrg]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [freshOrg]);
    for (const table of ["role_capability", "role", "capability_grant"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [freshOrg]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [freshOrg]);
}

async function _seed(org_id, action, person_id, occurred_at, detail) {
    await dblayer.runCmdOrThrow(
        `INSERT INTO product_event (event_id, org_id, action, person_ref, occurred_at, source, schema_version, detail, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
        [serverutils.generateUUID(false), org_id, action, `ref-${person_id}`, occurred_at, "web", 1, JSON.stringify(detail), _now()]);
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Events test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave"])
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.events.${stamp}@example.invalid`});

    const line = {alice: people.bob.person_id, bob: null, carol: null, dave: null};
    for (const who of Object.keys(people))
        await spine.recordEmploymentAsync({org_id: org.org_id, person_id: people[who].person_id,
            status: "active", jurisdiction: "GB", manager_person_id: line[who], contract_type: "employee",
            valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);

    return {org_id: org.org_id, stamp, ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["product_event", "product_event_daily_agg", "task_relation", "task_event", "task",
        "leave_ledger_entry", "leave_request", "leave_policy_pointer", "leave_policy_version",
        "time_entry_event", "timesheet", "wiki_page", "notification", "audit_event",
        "role_capability", "role", "capability_grant", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
