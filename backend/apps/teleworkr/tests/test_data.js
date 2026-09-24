/**
 * Tests L3 — data governance: export, retention & erasure.
 *
 * The export extension (disclosure.js) is checked for isolation — a
 * person's export carries their own leave/wellbeing/wiki rows and nobody
 * else's. Everything else exercises erasure.js: the curated ERASE entities
 * actually go, the register's PSEUDONYMISE entities are left alone (the
 * person row's own clearing is what pseudonymises them), a legal hold —
 * entity-specific or person-wide — blocks exactly what it says, a task
 * with another participant is retained and named rather than silently
 * kept, and the guardrails (step-up, reason, no double-erasure, capability)
 * hold the way every other irreversible action in this app does.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests data
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const wiki = require(`${TELEWORKR_CONSTANTS.LIBDIR}/wiki.js`);
const disclosure = require(`${TELEWORKR_CONSTANTS.LIBDIR}/disclosure.js`);
const erasure = require(`${TELEWORKR_CONSTANTS.LIBDIR}/erasure.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Data test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 100)}`, true);}
}
const _now = () => Math.floor(Date.now()/1000);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "data")) {
        LOG.console("Skipping data test case, not called.\n"); return true;
    }
    LOG.console("\nL3 data governance\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _seedData(w);
        await _testExportIsolation(w);
        await _testCapabilityRefusals(w);
        await _testDataRequestQueue(w);
        await _testPreviewBaseline(w);
        await _testEntityHold(w);
        await _testPersonWideHold(w);
        await _testExecute(w);
        await _testSecondExecuteRefused(w);
        await _testStepUpAndReasonRequired(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  data tests threw: ${err}\n`); LOG.error(`Data tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nData tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

async function _testExportIsolation(w) {
    LOG.console("\n export — leave/wellbeing/wiki now included, and only for the exporting person\n");
    const aliceExport = await disclosure.exportMyDataAsync({org_id: w.org_id, person_id: w.alice});
    _check("alice's export includes her leave request", aliceExport.leave_requests.some(r => r.leave_request_id == w.leaveRequestId),
        JSON.stringify(aliceExport.leave_requests));
    _check("alice's export includes her leave ledger entry", aliceExport.leave_ledger.some(e => e.leave_ledger_entry_id == w.leaveLedgerId));
    _check("alice's export includes her wellbeing signal", aliceExport.wellbeing_signals.some(s => s.signal_ledger_entry_id == w.signalLedgerId));
    _check("alice's export includes the wiki page she owns", aliceExport.wiki_pages.some(p => p.page_id == w.wikiPageId));

    const bobExport = await disclosure.exportMyDataAsync({org_id: w.org_id, person_id: w.bob});
    _check("bob's export carries none of alice's leave requests", !bobExport.leave_requests.some(r => r.leave_request_id == w.leaveRequestId));
    _check("bob's export carries none of alice's leave ledger", !bobExport.leave_ledger.some(e => e.leave_ledger_entry_id == w.leaveLedgerId));
    _check("bob's export carries none of alice's wellbeing signals", !bobExport.wellbeing_signals.some(s => s.signal_ledger_entry_id == w.signalLedgerId));
    _check("bob's export carries none of alice's wiki pages", !bobExport.wiki_pages.some(p => p.page_id == w.wikiPageId));
}

async function _testCapabilityRefusals(w) {
    LOG.console("\n capability refusals — an employee cannot touch any of this\n");
    await _checkThrows("an employee cannot preview an erasure", _ => erasure.previewErasureAsync(w.org_id, w.bob, w.alice));
    await _checkThrows("an employee cannot execute an erasure",
        _ => erasure.executeErasureAsync({org_id: w.org_id, actor_person_id: w.bob, person_id: w.alice,
            reason: "Should fail.", step_up_verified: true}));
    await _checkThrows("an employee cannot place a legal hold",
        _ => erasure.placeLegalHoldAsync({org_id: w.org_id, actor_person_id: w.bob, person_id: w.alice, reason: "Should fail."}));
    await _checkThrows("an employee cannot read legal holds", _ => erasure.legalHoldsAsync(w.org_id, w.bob, w.alice));
    await _checkThrows("an employee cannot open a DSAR request",
        _ => erasure.createDataRequestAsync({org_id: w.org_id, actor_person_id: w.bob, request_type: "access",
            subject_person_id: w.alice, due_date: "2026-05-01"}));
    await _checkThrows("an employee cannot read the DPO queue", _ => erasure.dataRequestsAsync(w.org_id, w.bob));
}

async function _testDataRequestQueue(w) {
    LOG.console("\n the DPO queue — open a request, then complete it\n");
    await _checkThrows("a request with no due_date is refused",
        _ => erasure.createDataRequestAsync({org_id: w.org_id, actor_person_id: w.dave, request_type: "access",
            subject_person_id: w.alice}));

    const req = await erasure.createDataRequestAsync({org_id: w.org_id, actor_person_id: w.dave, request_type: "access",
        subject_person_id: w.alice, due_date: "2026-04-15", notes: "Standard DSAR."});
    _check("a well-formed request opens", Boolean(req.request_id) && req.status == "open", JSON.stringify(req));

    const queue = await erasure.dataRequestsAsync(w.org_id, w.dave);
    _check("it appears on the queue", queue.requests.some(r => r.request_id == req.request_id));

    const completed = await erasure.completeDataRequestAsync({org_id: w.org_id, actor_person_id: w.dave,
        request_id: req.request_id, notes: "Exported and sent."});
    _check("completing sets status and completed_by", completed.status == "completed" && completed.completed_by == w.dave,
        JSON.stringify(completed));
    await _checkThrows("completing an already-completed request is refused",
        _ => erasure.completeDataRequestAsync({org_id: w.org_id, actor_person_id: w.dave, request_id: req.request_id}));
}

async function _testPreviewBaseline(w) {
    LOG.console("\n preview — the three-way split, before any hold\n");
    const preview = await erasure.previewErasureAsync(w.org_id, w.dave, w.alice);

    _check("alice is not already pseudonymised", preview.already_pseudonymised === false, JSON.stringify(preview.already_pseudonymised));

    const erasedNames = preview.erased.map(e => e.entity);
    _check("capability_grant (from her role assignment) is erasable", erasedNames.includes("capability_grant"), JSON.stringify(preview.erased));
    _check("task_watcher (she watches bob's task) is erasable", erasedNames.includes("task_watcher"), JSON.stringify(preview.erased));
    _check("wiki_space_member (she owns her space) is erasable", erasedNames.includes("wiki_space_member"), JSON.stringify(preview.erased));
    _check("signal_ledger_entry is erasable", erasedNames.includes("signal_ledger_entry"), JSON.stringify(preview.erased));

    const taskErased = preview.erased.find(e => e.entity == "task");
    _check("the no-participant task is erasable, count 1", taskErased?.count == 1, JSON.stringify(taskErased));
    const taskBlocked = preview.blocked.find(b => b.entity == "task");
    _check("the task bob commented on is retained and named, not silently kept",
        taskBlocked?.count == 1 && /other person/.test(taskBlocked.reason), JSON.stringify(taskBlocked));

    const pseudoNames = preview.pseudonymised.map(p => p.entity);
    _check("employment (PSEUDONYMISE) is reported, informationally", pseudoNames.includes("employment"), JSON.stringify(preview.pseudonymised));
    _check("nothing is blocked by a hold yet — only the task-participant entry", preview.blocked.every(b => b.entity == "task"),
        JSON.stringify(preview.blocked));

    w.baselineErasedCount = preview.erased.length;
}

async function _testEntityHold(w) {
    LOG.console("\n legal hold — entity-specific blocks only that entity\n");
    const hold = await erasure.placeLegalHoldAsync({org_id: w.org_id, actor_person_id: w.dave, person_id: w.alice,
        entity: "signal_ledger_entry", reason: "Pending litigation review."});
    _check("the hold is placed", Boolean(hold.hold_id), JSON.stringify(hold));

    const preview = await erasure.previewErasureAsync(w.org_id, w.dave, w.alice);
    const blockedSignal = preview.blocked.find(b => b.entity == "signal_ledger_entry");
    _check("the held entity is blocked, quoting the hold's reason",
        blockedSignal && blockedSignal.reason.includes("Pending litigation review."), JSON.stringify(preview.blocked));
    const erasedNames = preview.erased.map(e => e.entity);
    _check("every other entity is still erasable",
        erasedNames.includes("capability_grant") && erasedNames.includes("task_watcher") && !erasedNames.includes("signal_ledger_entry"),
        JSON.stringify(preview.erased));

    await erasure.releaseLegalHoldAsync({org_id: w.org_id, actor_person_id: w.dave, hold_id: hold.hold_id});
    const holds = await erasure.legalHoldsAsync(w.org_id, w.dave, w.alice);
    _check("the released hold shows released_at set", Boolean(holds.holds.find(h => h.hold_id == hold.hold_id)?.released_at),
        JSON.stringify(holds.holds));
    await _checkThrows("releasing an already-released hold is refused",
        _ => erasure.releaseLegalHoldAsync({org_id: w.org_id, actor_person_id: w.dave, hold_id: hold.hold_id}));
}

async function _testPersonWideHold(w) {
    LOG.console("\n legal hold — person-wide (no entity) blocks everything\n");
    const hold = await erasure.placeLegalHoldAsync({org_id: w.org_id, actor_person_id: w.dave, person_id: w.alice,
        reason: "Full hold pending review."});

    const preview = await erasure.previewErasureAsync(w.org_id, w.dave, w.alice);
    _check("nothing is left erasable once a person-wide hold is in force", preview.erased.length == 0, JSON.stringify(preview.erased));
    _check("every previously-erasable entity now shows blocked",
        preview.blocked.some(b => b.entity == "capability_grant") && preview.blocked.some(b => b.entity == "task_watcher")
            && preview.blocked.some(b => b.entity == "task" && b.reason.startsWith("Legal hold")),
        JSON.stringify(preview.blocked));

    await erasure.releaseLegalHoldAsync({org_id: w.org_id, actor_person_id: w.dave, hold_id: hold.hold_id});
}

async function _testExecute(w) {
    LOG.console("\n execute — clears PII, deletes curated rows, PSEUDONYMISE entities survive untouched\n");
    const run = await erasure.executeErasureAsync({org_id: w.org_id, actor_person_id: w.carol, person_id: w.alice,
        reason: "DSAR erasure request.", step_up_verified: true});
    w.erasureRunId = run.erasure_run_id;

    const person = await spine.getPersonAsync(w.alice);
    _check("display_name, email and home_timezone are cleared",
        person.display_name === null && person.email === null && person.home_timezone === null, JSON.stringify(person));
    _check("pseudonymised_at is set", Boolean(person.pseudonymised_at), JSON.stringify(person));

    const grants = await dblayer.getQueryOrThrow("SELECT * FROM capability_grant WHERE org_id=? AND person_id=?", [w.org_id, w.alice]);
    _check("capability_grant rows are gone", grants.length == 0, JSON.stringify(grants));
    const watchers = await dblayer.getQueryOrThrow("SELECT * FROM task_watcher WHERE org_id=? AND person_id=?", [w.org_id, w.alice]);
    _check("task_watcher rows are gone", watchers.length == 0, JSON.stringify(watchers));
    const members = await dblayer.getQueryOrThrow("SELECT * FROM wiki_space_member WHERE org_id=? AND person_id=?", [w.org_id, w.alice]);
    _check("wiki_space_member rows are gone", members.length == 0, JSON.stringify(members));
    const ledger = await dblayer.getQueryOrThrow("SELECT * FROM signal_ledger_entry WHERE org_id=? AND person_id=?", [w.org_id, w.alice]);
    _check("signal_ledger_entry rows are gone", ledger.length == 0, JSON.stringify(ledger));

    const t1Row = await dblayer.getQueryOrThrow("SELECT * FROM task WHERE task_id=?", [w.t1.task_id]);
    _check("the no-participant task is deleted", t1Row.length == 0, JSON.stringify(t1Row));
    const t2Row = await dblayer.getQueryOrThrow("SELECT * FROM task WHERE task_id=?", [w.t2.task_id]);
    _check("the task bob commented on is retained", t2Row.length == 1, JSON.stringify(t2Row));

    const employmentRows = await dblayer.getQueryOrThrow("SELECT * FROM employment WHERE org_id=? AND person_id=?", [w.org_id, w.alice]);
    _check("employment (PSEUDONYMISE) rows survive — still resolvable, now pointing at the pseudonymised person",
        employmentRows.length >= 1, JSON.stringify(employmentRows));

    const runRows = await dblayer.getQueryOrThrow("SELECT * FROM erasure_run WHERE erasure_run_id=?", [run.erasure_run_id]);
    _check("the erasure_run record names the operator and reason",
        runRows.length == 1 && runRows[0].operator_person_id == w.carol && runRows[0].reason == "DSAR erasure request.",
        JSON.stringify(runRows));
    _check("erasure_run.erased matches what executeErasureAsync returned",
        JSON.stringify(JSON.parse(runRows[0].erased)) == JSON.stringify(run.erased),
        JSON.stringify({stored: runRows[0].erased, returned: run.erased}));
}

async function _testSecondExecuteRefused(w) {
    LOG.console("\n a second execute on an already-erased person is refused\n");
    await _checkThrows("re-executing on an already-pseudonymised person is refused",
        _ => erasure.executeErasureAsync({org_id: w.org_id, actor_person_id: w.carol, person_id: w.alice,
            reason: "Retry.", step_up_verified: true}));
}

async function _testStepUpAndReasonRequired(w) {
    LOG.console("\n execute refuses without step-up, and without a reason\n");
    await _checkThrows("execute without step_up_verified is refused",
        _ => erasure.executeErasureAsync({org_id: w.org_id, actor_person_id: w.carol, person_id: w.bob, reason: "Testing."}));
    await _checkThrows("execute without a reason is refused",
        _ => erasure.executeErasureAsync({org_id: w.org_id, actor_person_id: w.carol, person_id: w.bob, step_up_verified: true}));
    const person = await spine.getPersonAsync(w.bob);
    _check("bob was untouched by either refused attempt", !person.pseudonymised_at, JSON.stringify(person));
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Data test ${stamp}`, home_jurisdiction: "IN"});
    const roleOf = {alice: "employee", bob: "employee", carol: "hr", dave: "admin"};
    const people = {};
    for (const who of Object.keys(roleOf))
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN", contract_type: "employee",
        valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const [who, role] of Object.entries(roleOf)) await permissions.assignRoleAsync(org.org_id, people[who].person_id, role, from);

    return {org_id: org.org_id, stamp, ...Object.fromEntries(Object.entries(people).map(([name, person]) => [name, person.person_id]))};
}

/** Seeds one representative row per curated entity family, plus the leave/wellbeing/wiki data the export extension now carries. */
async function _seedData(w) {
    w.leaveRequestId = `lr-${w.stamp}`;
    await dblayer.runCmdOrThrow(
        `INSERT INTO leave_request (leave_request_id, org_id, person_id, leave_type, from_date, to_date, days_requested, status, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
        [w.leaveRequestId, w.org_id, w.alice, "annual", "2026-03-01", "2026-03-03", 3, "approved", _now()]);

    w.leaveLedgerId = `lle-${w.stamp}`;
    await dblayer.runCmdOrThrow(
        `INSERT INTO leave_ledger_entry (leave_ledger_entry_id, org_id, person_id, leave_type, days, kind, entry_date, recorded_at)
            VALUES (?,?,?,?,?,?,?,?)`,
        [w.leaveLedgerId, w.org_id, w.alice, "annual", -3, "deduction", "2026-03-01", _now()]);

    w.signalLedgerId = `sle-${w.stamp}`;
    await dblayer.runCmdOrThrow(
        `INSERT INTO signal_ledger_entry (signal_ledger_entry_id, org_id, person_id, signal_code, signal_definition_id,
            lit, inputs, evaluated_for, evaluated_at, batch_tag) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [w.signalLedgerId, w.org_id, w.alice, "overload", `sd-${w.stamp}`, 0, "{}", "2026-03-01", _now(), `batch-${w.stamp}`]);

    // wiki_space_member (alice becomes a member automatically as the space's owner) and wiki_page
    w.wikiSpace = await wiki.createSpaceAsync({org_id: w.org_id, actor_person_id: w.alice,
        name: `Alice's space ${w.stamp}`, slug: `alice-space-${w.stamp}`});
    w.wikiPageId = `wp-${w.stamp}`;
    await dblayer.runCmdOrThrow(
        `INSERT INTO wiki_page (page_id, org_id, space_id, title, slug, owner_person_id, status, created_at, created_by)
            VALUES (?,?,?,?,?,?,?,?,?)`,
        [w.wikiPageId, w.org_id, w.wikiSpace.space_id, "Alice's page", `alices-page-${w.stamp}`, w.alice, "draft", _now(), w.alice]);

    // task (no other participant) — erasable
    w.t1 = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice, title: `Alice's own draft ${w.stamp}`});
    // task (bob comments on it) — retained, named
    w.t2 = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.alice, title: `Alice's task, bob weighs in ${w.stamp}`});
    await tasks.addCommentAsync({org_id: w.org_id, actor_person_id: w.bob, task_ref: w.t2.task_ref, body: "Bob's input."});
    // task_watcher — alice watches a task she neither created nor owns
    w.t3 = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.bob, title: `Bob's task, alice watches ${w.stamp}`});
    await tasks.addWatcherAsync({org_id: w.org_id, actor_person_id: w.alice, task_ref: w.t3.task_ref});
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["audit_event", "capability_grant", "role_capability", "role", "employment",
        "task_watcher", "task_comment", "task_event", "task", "wiki_space_member", "wiki_page", "wiki_space",
        "leave_request", "leave_ledger_entry", "signal_ledger_entry", "legal_hold", "data_request", "erasure_run"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
