/**
 * Tests G1 — the app catalogue, self-service access requests, manual
 * per-task deep links, launch attribution, and the admin seat-usage view.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests apps
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const apps = require(`${TELEWORKR_CONSTANTS.LIBDIR}/apps.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Apps test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 120)}`, true);}
}

const _today = () => new Date().toISOString().substring(0, 10);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "apps")) {
        LOG.console("Skipping apps test case, not called.\n"); return true;
    }
    LOG.console("\nG1 apps catalogue, access requests and seats\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testCatalogueGate(w);
        await _testCatalogueStates(w);
        await _testRequestFlow(w);
        await _testLaunchAttribution(w);
        await _testTaskLinks(w);
        await _testCohortFallback(w);
        await _testUsageReport(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  apps tests threw: ${err}\n`); LOG.error(`Apps tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nApps tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------
// admin gate
// ---------------------------------------------------------------------------

async function _testCatalogueGate(w) {
    LOG.console("\n the admin gate on catalogue management\n");
    await _checkThrows("an employee cannot save a catalogue entry", _ =>
        apps.saveAppAsync({org_id: w.org_id, actor_person_id: w.alice, name: "Sneaky app"}));
    await _checkThrows("an employee cannot read the usage report", _ =>
        apps.usageReportAsync(w.org_id, w.alice));
}

// ---------------------------------------------------------------------------
// catalogue states for one viewer
// ---------------------------------------------------------------------------

async function _testCatalogueStates(w) {
    LOG.console("\n catalogue access states\n");
    // bob (the approver) was never granted either app in setup — a clean "none" viewer.
    const bobView = await apps.catalogueAsync(w.org_id, w.bob);
    const figmaForBob = bobView.apps.find(a => a.app_id == w.figmaId);
    _check("an app with no request requirement shows access 'none' but is open to all",
        figmaForBob && figmaForBob.access == "none" && !figmaForBob.requires_request);

    const view = await apps.catalogueAsync(w.org_id, w.alice);
    const illustrator = view.apps.find(a => a.app_id == w.illustratorId);
    _check("an app requiring a request shows its cost",
        illustrator && illustrator.cost_per_seat_minor == 2200 && illustrator.cost_currency == "GBP");
    _check("carol, who already has illustrator, is named as a colleague who has it",
        illustrator.colleagues_with_access.includes("carol"));
}

// ---------------------------------------------------------------------------
// request -> named approver decides
// ---------------------------------------------------------------------------

async function _testRequestFlow(w) {
    LOG.console("\n the request -> named-approver-decides flow\n");

    await _checkThrows("a request with no reason is refused", _ =>
        apps.requestAccessAsync({org_id: w.org_id, actor_person_id: w.alice, app_id: w.illustratorId, reason: "  "}));

    const request = await apps.requestAccessAsync({org_id: w.org_id, actor_person_id: w.alice,
        app_id: w.illustratorId, reason: "print handoff needs .ai files"});
    _check("the request is created pending, routed to the app's named approver",
        request.status == "pending" && request.approver_person_id == w.bob);

    await _checkThrows("a second request for the same app while one is pending is refused", _ =>
        apps.requestAccessAsync({org_id: w.org_id, actor_person_id: w.alice, app_id: w.illustratorId, reason: "again"}));

    const bobQueue = await apps.pendingRequestsForApproverAsync(w.org_id, w.bob);
    _check("the named approver sees the request in their queue",
        bobQueue.requests.some(r => r.request_id == request.request_id));
    const carolQueue = await apps.pendingRequestsForApproverAsync(w.org_id, w.carol);
    _check("someone who holds the capability but isn't named sees nothing",
        carolQueue.requests.length == 0);

    await _checkThrows("the capability alone, without being the named approver, cannot decide it", _ =>
        apps.decideRequestAsync({org_id: w.org_id, actor_person_id: w.carol,
            request_id: request.request_id, decision: "approved"}));

    await _checkThrows("a denial with no reason is refused", _ =>
        apps.decideRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
            request_id: request.request_id, decision: "denied"}));

    const denied = await apps.decideRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
        request_id: request.request_id, decision: "denied", decision_reason: "budget frozen this quarter"});
    _check("a denial is recorded with its reason, and grants nothing", denied.status == "denied");

    const afterDenial = await apps.catalogueAsync(w.org_id, w.alice);
    const illustratorAfterDenial = afterDenial.apps.find(a => a.app_id == w.illustratorId);
    _check("the viewer sees their own denial and its reason",
        illustratorAfterDenial.access == "denied" && illustratorAfterDenial.decision_reason == "budget frozen this quarter");

    const second = await apps.requestAccessAsync({org_id: w.org_id, actor_person_id: w.alice,
        app_id: w.illustratorId, reason: "still needed"});
    const approved = await apps.decideRequestAsync({org_id: w.org_id, actor_person_id: w.bob,
        request_id: second.request_id, decision: "approved"});
    _check("approval is recorded", approved.status == "approved");

    const afterApproval = await apps.catalogueAsync(w.org_id, w.alice);
    _check("the viewer now shows granted access",
        afterApproval.apps.find(a => a.app_id == w.illustratorId).access == "granted");

    const auditRow = (await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='integration.access_granted' ORDER BY occurred_at DESC LIMIT 1",
        [w.org_id]))[0];
    _check("the grant is audited under the access category (integration.* prefix) with the requester as subject",
        auditRow && auditRow.subject_person_id == w.alice);
}

// ---------------------------------------------------------------------------
// launch attribution — resolved server-side, never from the client
// ---------------------------------------------------------------------------

async function _testLaunchAttribution(w) {
    LOG.console("\n launch events attribute the actually-running task\n");

    const noTaskEvent = await apps.recordLaunchAsync(w.org_id, w.carol, w.figmaId);
    _check("with nothing running, a launch carries no task", noTaskEvent.task_ref === null);

    await time.recordEventAsync({org_id: w.org_id, person_id: w.carol, entry_date: _today(),
        task_ref: w.taskRef, started_at: Math.floor(Date.now()/1000) - 60, source: "manual"});
    const view = await apps.catalogueAsync(w.org_id, w.carol);
    _check("the catalogue reports the actually-running task, resolved server-side",
        view.running_task_ref == w.taskRef);

    const boundEvent = await apps.recordLaunchAsync(w.org_id, w.carol, w.figmaId);
    _check("a launch while a timer is running attributes that task, not a client-supplied one",
        boundEvent.task_ref == w.taskRef);
}

// ---------------------------------------------------------------------------
// manual per-task deep links
// ---------------------------------------------------------------------------

async function _testTaskLinks(w) {
    LOG.console("\n the manual 'apps you've connected yourself' deep link\n");

    await _checkThrows("a connection needs a label and a URL", _ =>
        apps.linkTaskAsync({org_id: w.org_id, actor_person_id: w.carol, app_id: w.figmaId,
            task_ref: w.taskRef, label: "", url: ""}));

    await apps.linkTaskAsync({org_id: w.org_id, actor_person_id: w.carol, app_id: w.figmaId,
        task_ref: w.taskRef, label: "apibot-hero-v3", url: "https://figma.example/hero-v3"});

    const view = await apps.catalogueAsync(w.org_id, w.carol);
    const figma = view.apps.find(a => a.app_id == w.figmaId);
    _check("the catalogue surfaces the deep link for the currently-running task",
        figma.open_link?.label == "apibot-hero-v3" && figma.open_link?.url == "https://figma.example/hero-v3");

    const mine = await apps.myLinksAsync(w.org_id, w.carol);
    _check("the person's own connections list includes it", mine.links.length == 1);

    await _checkThrows("only the person who made a connection can remove it", _ =>
        apps.removeLinkAsync(w.org_id, w.alice, mine.links[0].link_id));
    await apps.removeLinkAsync(w.org_id, w.carol, mine.links[0].link_id);
    const afterRemove = await apps.myLinksAsync(w.org_id, w.carol);
    _check("removal actually removes it", afterRemove.links.length == 0);
}

// ---------------------------------------------------------------------------
// colleague cohort — peers, not reports
// ---------------------------------------------------------------------------

async function _testCohortFallback(w) {
    LOG.console("\n the colleague cohort: siblings, else the org roster minus self\n");
    // bob has no manager and was never granted illustrator himself, so the fallback
    // (org roster minus self) is both exercised and visible in his own "none" row —
    // dave and admin have no manager either, but both already hold illustrator
    // themselves, which would hide colleagues_with_access behind their own "granted" state.
    const bobView = await apps.catalogueAsync(w.org_id, w.bob);
    const illustrator = bobView.apps.find(a => a.app_id == w.illustratorId);
    _check("someone with no manager falls back to the whole org roster rather than an empty cohort",
        illustrator.colleagues_with_access.includes("alice") || illustrator.colleagues_with_access.includes("carol"));
}

// ---------------------------------------------------------------------------
// admin seat usage
// ---------------------------------------------------------------------------

async function _testUsageReport(w) {
    LOG.console("\n the admin seat-usage report\n");
    const report = await apps.usageReportAsync(w.org_id, w.admin);
    const figma = report.apps.find(a => a.app_id == w.figmaId);
    const illustrator = report.apps.find(a => a.app_id == w.illustratorId);

    _check("figma has the two seats granted in setup, with launches recorded so it isn't idle",
        figma.seats == 2 && figma.launches_60d >= 1 && figma.idle === false);
    _check("illustrator's seats include the two from setup plus alice's approved request, idle since nothing was launched",
        illustrator.seats == 3 && illustrator.idle === true);
}

// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Apps test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "admin"])
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});

    // alice and carol report to bob; dave and admin have no manager (the cohort fallback case)
    const line = {alice: people.bob.person_id, carol: people.bob.person_id, bob: null, dave: null, admin: null};
    for (const who of Object.keys(people))
        await spine.recordEmploymentAsync({org_id: org.org_id, person_id: people[who].person_id,
            status: "active", jurisdiction: "GB", manager_person_id: line[who], contract_type: "employee",
            valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const who of ["alice", "bob", "carol", "dave"]) await permissions.assignRoleAsync(org.org_id, people[who].person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.admin.person_id, "admin", from);

    const figma = await apps.saveAppAsync({org_id: org.org_id, actor_person_id: people.admin.person_id,
        name: "Figma", category: "Design", launch_url: "https://figma.example", launch_label: "Open",
        requires_request: false});
    const illustrator = await apps.saveAppAsync({org_id: org.org_id, actor_person_id: people.admin.person_id,
        name: "Adobe Illustrator", category: "Design", launch_url: "https://adobe.example", launch_label: "Open",
        requires_request: true, cost_per_seat_minor: 2200, cost_currency: "GBP",
        approver_person_id: people.bob.person_id});

    // carol and dave already hold seats — carol surfaces as "a colleague who has it" for alice (her
    // sibling under bob); dave's own seat is what alice's catalogue counts for figma's usage report
    const now = Math.floor(Date.now()/1000);
    await dblayer.runCmdOrThrow(
        "INSERT INTO app_access (org_id, app_id, person_id, granted_at, granted_by) VALUES (?,?,?,?,?)",
        [org.org_id, illustrator.app_id, people.carol.person_id, now, "system"]);
    await dblayer.runCmdOrThrow(
        "INSERT INTO app_access (org_id, app_id, person_id, granted_at, granted_by) VALUES (?,?,?,?,?)",
        [org.org_id, illustrator.app_id, people.dave.person_id, now, "system"]);
    await dblayer.runCmdOrThrow(
        "INSERT INTO app_access (org_id, app_id, person_id, granted_at, granted_by) VALUES (?,?,?,?,?)",
        [org.org_id, figma.app_id, people.alice.person_id, now, "system"]);
    await dblayer.runCmdOrThrow(
        "INSERT INTO app_access (org_id, app_id, person_id, granted_at, granted_by) VALUES (?,?,?,?,?)",
        [org.org_id, figma.app_id, people.carol.person_id, now, "system"]);
    await apps.recordLaunchAsync(org.org_id, people.alice.person_id, figma.app_id);

    const task = await tasks.createTaskAsync({org_id: org.org_id, actor_person_id: people.bob.person_id,
        title: "apibot hero banner", assignee_person_id: people.carol.person_id});

    return {org_id: org.org_id, stamp, figmaId: figma.app_id, illustratorId: illustrator.app_id,
        taskRef: task.task_ref, ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["app_launch_event", "app_task_link", "app_access_request", "app_access",
        "app_catalogue", "task_event", "task", "role_capability", "role", "capability_grant", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "admin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
