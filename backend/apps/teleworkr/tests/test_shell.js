/**
 * Tests A7 — the role projection behind the A2 shell.
 *
 * The property under test is that roles are a projection and not a fork: one
 * surface catalogue, and four people see four different products out of it
 * without any of them getting a second copy of a screen. The other half is that
 * hiding is never mistaken for authorization — a hidden surface is still refused
 * by the engine when called directly.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests shell
 *
 * (C) 2026 Tekmonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);
const shell = require(`${TELEWORKR_CONSTANTS.LIBDIR}/shell.js`);
const shellapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/shell.js`);

const TODAY = "2026-06-15";
let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Shell test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true);}
}

const _ids = projection => [...projection.tabs.map(s => s.id),
    ...projection.consoles.flatMap(g => g.surfaces.map(s => s.id))];

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "shell")) {
        LOG.console("Skipping shell test case, not called.\n"); return true;
    }
    LOG.console("\nA7 shell projection\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testCatalogue(w);
        await _testProjection(w);
        await _testHidingIsNotAuthorization(w);
        await _testNoEmployment(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  shell tests threw: ${err}\n`); LOG.error(`Shell tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nShell tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Shell test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "frank"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`, home_timezone: "Europe/London"});

    const line = {alice: people.bob.person_id, bob: null, carol: null, dave: null, frank: null};
    for (const who of ["alice", "bob", "carol", "dave"]) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "GB",
        manager_person_id: line[who], contract_type: "employee", valid_from: "2026-01-01", source: "manual"});
    // frank is a person with no employment in this org - a candidate or an external reader

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);

    return {org_id: org.org_id, stamp,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _testCatalogue(_w) {
    LOG.console("\n the surface catalogue\n");
    _check("every surface names a real capability", shell.validateCatalogueSync());

    const ceilingSurfaces = Object.values(shell.SURFACES).filter(s =>
        [...(s.any_of||[]), ...(s.capability?[s.capability]:[])].some(c => capabilities.isCeiling(c)));
    _check("no surface is gated on a ceiling capability", ceilingSurfaces.length == 0);

    _check("every surface declares a classification",
        Object.values(shell.SURFACES).every(s => Object.values(shell.CLASS).includes(s.classification)));
    _check("every surface is either a tab or lives in a console",
        Object.values(shell.SURFACES).every(s => Boolean(s.tab) !== Boolean(s.console)));
    _check("no surface claims a tab outside the five A1 fixes",
        Object.values(shell.SURFACES).filter(s => s.tab).every(s => shell.TABS.includes(s.tab)));
}

async function _testProjection(w) {
    LOG.console("\n four people, one screen set\n");
    const asOf = TODAY;
    const employee = await shell.projectAsync({org_id: w.org_id, person_id: w.alice, asOf});
    const lead = await shell.projectAsync({org_id: w.org_id, person_id: w.bob, asOf});
    const hr = await shell.projectAsync({org_id: w.org_id, person_id: w.carol, asOf});
    const admin = await shell.projectAsync({org_id: w.org_id, person_id: w.dave, asOf});

    _check("an employee sees the shared surfaces", _ids(employee).includes("day") && _ids(employee).includes("team"));
    _check("the day board is a header tab, not a console entry",
        employee.tabs.some(t => t.id == "day") && employee.tabs.every(t => t.console === null));
    _check("the leave console is not a tab",
        hr.consoles.some(g => g.surfaces.some(s => s.id == "policy")));
    _check("an employee does not see approvals", !_ids(employee).includes("approvals"));
    _check("an employee does not see the audit log", !_ids(employee).includes("audit"));
    _check("an employee does not see people and import", !_ids(employee).includes("people"));

    _check("a lead sees approvals", _ids(lead).includes("approvals"));
    _check("a lead does not see the leave policy editor", !_ids(lead).includes("policy"));

    _check("HR sees the leave policy editor", _ids(hr).includes("policy"));
    _check("HR sees scheduled runs", _ids(hr).includes("runs"));

    _check("an admin sees people and import", _ids(admin).includes("people"));
    _check("an admin sees the audit log", _ids(admin).includes("audit"));

    _check("everyone sees the same day board surface id, not a per-role copy",
        [employee, lead, hr, admin].every(p => _ids(p).includes("day")));

    const screens = [employee, lead, hr, admin].flatMap(p =>
        [...p.tabs, ...p.consoles.flatMap(g => g.surfaces)].map(s => `${s.id}:${s.screen}`));
    const bySurface = {};
    for (const pair of screens) {const [id, screen] = pair.split(":"); (bySurface[id] ||= new Set()).add(screen);}
    _check("no surface resolves to two different screens across roles",
        Object.values(bySurface).every(set => set.size == 1));

    LOG.console("\n entry point varies, screen identity does not\n");
    _check("an employee lands on the day board", employee.home == "day", employee.home);
    _check("a lead lands on the team surface", lead.home == "team", lead.home);
    _check("HR lands on leave", hr.home == "leave", hr.home);
    _check("an admin lands on people and import", admin.home == "people", admin.home);
    _check("home is always a surface the person can actually see",
        [employee, lead, hr, admin].every(p => _ids(p).includes(p.home)));

    LOG.console("\n coverage, so what a person's product is stays answerable\n");
    _check("coverage counts visible against the whole catalogue",
        employee.coverage.total == Object.keys(shell.SURFACES).length &&
        employee.coverage.visible == _ids(employee).length);
    _check("an admin's product is larger than an employee's",
        admin.coverage.visible > employee.coverage.visible,
        `${admin.coverage.visible} vs ${employee.coverage.visible}`);

    LOG.console("\n the projection follows the grants\n");
    _check("the employee holds no approval capability",
        !employee.capabilities.includes("timesheet.approve"));

    const elevation = await permissions.grantAsync({org_id: w.org_id, person_id: w.alice,
        capability: "leave.approve", scope_type: "org", granted_by: w.dave,
        reason: "covering while the lead is away", valid_from: "2026-06-01", valid_to: "2026-06-30"});
    const elevated = await shell.projectAsync({org_id: w.org_id, person_id: w.alice, asOf: "2026-06-15"});
    _check("an elevation makes approvals appear", _ids(elevated).includes("approvals"));

    const after = await shell.projectAsync({org_id: w.org_id, person_id: w.alice, asOf: "2026-07-15"});
    _check("and it disappears again when the elevation expires, with no cleanup job",
        !_ids(after).includes("approvals"));
    await permissions.revokeAsync(elevation.grant_id);

    const deny = await permissions.grantAsync({org_id: w.org_id, person_id: w.bob,
        capability: "task.read", scope_type: "org", effect: "deny", granted_by: w.dave,
        reason: "under investigation", valid_from: "2026-01-01"});
    const denied = await shell.projectAsync({org_id: w.org_id, person_id: w.bob, asOf: TODAY});
    _check("an org-wide deny removes the surface, not just the action",
        !_ids(denied).includes("tasks"));
    await permissions.revokeAsync(deny.grant_id);
}

async function _testHidingIsNotAuthorization(w) {
    LOG.console("\n hiding is a courtesy, the refusal is the control\n");
    const employee = await shell.projectAsync({org_id: w.org_id, person_id: w.alice, asOf: TODAY});
    _check("the audit surface is hidden from the employee", !_ids(employee).includes("audit"));

    const decision = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.alice,
        capability: "audit.read_all", asOf: TODAY});
    _check("and calling it anyway is still refused by the engine",
        !decision.allowed, decision.outcome);

    const leadDecision = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob,
        capability: "timesheet.approve", subject_person_id: w.carol, asOf: TODAY});
    _check("a visible surface still refuses a target outside its scope",
        !leadDecision.allowed, leadDecision.outcome);
}

async function _testNoEmployment(w) {
    LOG.console("\n signed in with nothing in force\n");
    const projection = await shell.projectAsync({org_id: w.org_id, person_id: w.frank, asOf: TODAY});
    _check("no employment yields no tabs and no consoles",
        projection.tabs.length == 0 && projection.consoles.length == 0);
    _check("and a blocked banner rather than an empty screen with no explanation",
        projection.banners.length == 1 && projection.banners[0].level == "blocked");
    _check("the banner says what to do next", Boolean(projection.banners[0].what_to_do));
    _check("home is null rather than a surface they cannot open", projection.home === null);

    await _checkThrows("a projection for an unknown person is refused", _ =>
        shell.projectAsync({org_id: w.org_id, person_id: "not-a-person", asOf: TODAY}));
}

async function _testAPI(w) {
    LOG.console("\n the API surface\n");
    const email = `carol.${w.stamp}@example.invalid`;
    const result = await shellapi.doService({op: "bootstrap", id: email, org: w.org_id, asOf: TODAY});
    _check("bootstrap returns the caller's projection", result.result && result.home == "leave", result.reason);
    _check("it carries the person and their employment",
        result.person?.person_id == w.carol && result.employment?.jurisdiction == "GB");
    _check("it carries the banner slot even when empty", Array.isArray(result.banners));

    const surfaces = await shellapi.doService({op: "surfaces", id: email, org: w.org_id});
    _check("the catalogue lists what each surface requires",
        surfaces.result && surfaces.surfaces.length == Object.keys(shell.SURFACES).length &&
        surfaces.surfaces.every(s => Array.isArray(s.requires)));
    _check("the catalogue publishes the five fixed tabs",
        Array.isArray(surfaces.tabs) && surfaces.tabs.length == 5 && surfaces.tabs.includes("timeline"));

    const unknown = await shellapi.doService({op: "bootstrap", id: "nobody@example.invalid", org: w.org_id});
    _check("an unprovisioned caller is refused with a reason",
        !unknown.result && Boolean(unknown.reason), JSON.stringify(unknown));

    const bad = await shellapi.doService({op: "nonsense", id: email, org: w.org_id});
    _check("an unknown op is refused", !bad.result);
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["role_capability", "role", "capability_grant", "employment", "org"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "frank"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
