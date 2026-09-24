/**
 * Tests L2 — the permissions screen. Almost everything here exercises
 * `permissions.js`/`capabilities.js` through the thin `lib/access.js`
 * wrappers — the engine itself is already covered by every other test
 * suite this session; these tests are about `access.js` wiring the right
 * capability, the right subject_person_id (so SOD rules can actually see
 * what they're checking), and the right non-transactional pattern for the
 * two engine calls that don't accept an `exec`.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests access
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const access = require(`${TELEWORKR_CONSTANTS.LIBDIR}/access.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Access test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 100)}`, true);}
}
const _now = () => Math.floor(Date.now()/1000);
const _inDays = days => new Date(Date.now() + days*86400000).toISOString().substring(0, 10);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "access")) {
        LOG.console("Skipping access test case, not called.\n"); return true;
    }
    LOG.console("\nL2 permissions\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testRoles(w);
        await _testElevationDiscipline(w);
        await _testRevoke(w);
        await _testAssignRole(w);
        await _testWhoCan(w);
        await _testAccessReview(w);
        await _testSelfRoleChangeBlocked(w);
        await _testCapabilityRefusals(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  access tests threw: ${err}\n`); LOG.error(`Access tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nAccess tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

async function _testRoles(w) {
    LOG.console("\n roles — built-in plus custom, with holder counts\n");
    const before = await access.rolesAsync(w.org_id, w.dave);
    _check("all five built-in roles are listed", ["employee","lead","hr","admin","guest"].every(
        name => before.roles.some(r => r.name == name)), JSON.stringify(before.roles.map(r => r.name)));
    const hrRole = before.roles.find(r => r.name == "hr");
    _check("hr shows at least one holder (carol)", hrRole.holder_count >= 1, JSON.stringify(hrRole));

    const created = await access.createRoleAsync({org_id: w.org_id, actor_person_id: w.dave,
        name: `Reviewer-${w.stamp}`, description: "Two capabilities admin also holds, among many more of admin's own",
        capabilities: [["task.delete", "org"], ["people.import", "org"]]});
    _check("a role that's a small fraction of any existing role's bundle creates with no overlap warning",
        created.role.name == `Reviewer-${w.stamp}` && created.warnings.length == 0, JSON.stringify(created));

    // near-identical to the built-in "guest" role (same single capability) — should warn
    const overlapping = await access.createRoleAsync({org_id: w.org_id, actor_person_id: w.dave,
        name: `Guest-clone-${w.stamp}`, description: "", capabilities: [["audit.read_own", "self"]]});
    _check("a role overlapping an existing one by >90% warns, but still succeeds",
        overlapping.role.role_id && overlapping.warnings.length > 0, JSON.stringify(overlapping.warnings));

    const after = await access.rolesAsync(w.org_id, w.dave);
    _check("both custom roles now appear in the listing",
        after.roles.some(r => r.name == created.role.name) && after.roles.some(r => r.name == overlapping.role.name));
}

async function _testElevationDiscipline(w) {
    LOG.console("\n elevation — time-boxed and reasoned, enforced through access.js\n");
    await _checkThrows("an elevation with no expiry is refused",
        _ => access.grantElevationAsync({org_id: w.org_id, actor_person_id: w.dave, person_id: w.alice,
            capability: "task.delete", scope_type: "org", reason: "Temporary cleanup duty."}));
    await _checkThrows("an elevation with no reason is refused",
        _ => access.grantElevationAsync({org_id: w.org_id, actor_person_id: w.dave, person_id: w.alice,
            capability: "task.delete", scope_type: "org", valid_to: _inDays(14)}));

    const granted = await access.grantElevationAsync({org_id: w.org_id, actor_person_id: w.dave, person_id: w.alice,
        capability: "task.delete", scope_type: "org", valid_to: _inDays(14), reason: "Temporary cleanup duty."});
    _check("a properly time-boxed, reasoned elevation succeeds", Boolean(granted.grant_id), JSON.stringify(granted));

    const decision = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.alice, capability: "task.delete"});
    _check("the elevated person now holds the capability", decision.allowed, JSON.stringify(decision));
    w.elevationGrantId = granted.grant_id;
}

async function _testRevoke(w) {
    LOG.console("\n revoke — closes the grant, writes an audit entry\n");
    await access.revokeGrantAsync({org_id: w.org_id, actor_person_id: w.dave, grant_id: w.elevationGrantId});
    const stillActive = await permissions.activeGrantsAsync(w.org_id, w.alice, {capability: "task.delete"});
    _check("the revoked grant no longer appears as active", !stillActive.some(g => g.grant_id == w.elevationGrantId),
        JSON.stringify(stillActive));
    const decision = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.alice, capability: "task.delete"});
    _check("the elevated person no longer holds the capability", !decision.allowed);
    const entries = await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='capability.revoked' AND object_ref=?",
        [w.org_id, w.elevationGrantId]);
    _check("revoking wrote its own audit entry", entries.length == 1, JSON.stringify(entries));
}

async function _testAssignRole(w) {
    LOG.console("\n assigning a role materialises its full bundle\n");
    const before = await permissions.activeGrantsAsync(w.org_id, w.george);
    _check("a fresh, unassigned person starts with no grants", before.length == 0, JSON.stringify(before));
    await access.assignRoleAsync({org_id: w.org_id, actor_person_id: w.dave, person_id: w.george,
        role_name: "lead", valid_from: "2026-01-01"});
    const after = await permissions.activeGrantsAsync(w.org_id, w.george);
    const leadRole = (await permissions.getRoleAsync(w.org_id, "lead")).capabilities;
    _check("assigning lead materialises every one of its capabilities as a grant tagged source_role=lead",
        after.length == leadRole.length && after.every(g => g.source_role == "lead"),
        `${after.length} vs ${leadRole.length}`);
}

async function _testWhoCan(w) {
    LOG.console("\n who can — the reverse lookup\n");
    const orgWide = await access.whoCanAsync(w.org_id, w.dave, "leave.approve");
    _check("org-scoped holders of leave.approve include hr (carol)", orgWide.holders.some(h => h.person_id == w.carol),
        JSON.stringify(orgWide.holders.map(h => h.person_id)));

    // george (now lead, from the previous test) holds leave.approve at direct_reports —
    // only covers alice if george is actually alice's manager
    await spine.recordEmploymentAsync({org_id: w.org_id, person_id: w.alice, status: "active", jurisdiction: "IN",
        contract_type: "employee", manager_person_id: w.george, valid_from: "2026-02-01", source: "manual"});
    const forAlice = await access.whoCanAsync(w.org_id, w.dave, "leave.approve", w.alice);
    _check("scoped to a subject, direct_reports holders only list that subject's actual manager",
        forAlice.holders.some(h => h.person_id == w.george) && forAlice.holders.some(h => h.person_id == w.carol),
        JSON.stringify(forAlice.holders.map(h => h.person_id)));
    const forErin = await access.whoCanAsync(w.org_id, w.dave, "leave.approve", w.erin);
    _check("george (not erin's manager) does not cover erin, even though he holds the same capability",
        !forErin.holders.some(h => h.person_id == w.george), JSON.stringify(forErin.holders.map(h => h.person_id)));
}

async function _testAccessReview(w) {
    LOG.console("\n the quarterly access review — the same list as elevations\n");
    const recent = await access.grantElevationAsync({org_id: w.org_id, actor_person_id: w.dave, person_id: w.erin,
        capability: "task.delete", scope_type: "org", valid_to: _inDays(30), reason: "Covering a migration."});
    const stale = await access.grantElevationAsync({org_id: w.org_id, actor_person_id: w.dave, person_id: w.erin,
        capability: "people.import", scope_type: "org", valid_to: _inDays(30), reason: "One-off import."});
    await dblayer.runCmdOrThrow("UPDATE capability_grant SET last_used_at=? WHERE grant_id=?", [_now(), recent.grant_id]);
    await dblayer.runCmdOrThrow("UPDATE capability_grant SET last_used_at=? WHERE grant_id=?",
        [_now() - 120*86400, stale.grant_id]);

    const review = await access.accessReviewAsync(w.org_id, w.dave, {unused_days: 90});
    const recentRow = review.grants.find(g => g.grant_id == recent.grant_id);
    const staleRow = review.grants.find(g => g.grant_id == stale.grant_id);
    _check("a grant used within the window is not proposed for removal", recentRow && !recentRow.propose_removal, JSON.stringify(recentRow));
    _check("a grant unused past the window is proposed for removal, and says why", staleRow && staleRow.propose_removal && staleRow.why,
        JSON.stringify(staleRow));
    _check("each row carries a resolved person name, not a bare id", staleRow.person_name && staleRow.person_name != staleRow.person_id);
}

async function _testSelfRoleChangeBlocked(w) {
    LOG.console("\n SOD — self-role-change reaches through access.js, not just the raw engine\n");
    await _checkThrows("an admin cannot grant themselves a new capability",
        _ => access.grantElevationAsync({org_id: w.org_id, actor_person_id: w.dave, person_id: w.dave,
            capability: "task.delete", scope_type: "org", valid_to: _inDays(14), reason: "Self grant attempt."}));
    await _checkThrows("an admin cannot assign themselves a role",
        _ => access.assignRoleAsync({org_id: w.org_id, actor_person_id: w.dave, person_id: w.dave, role_name: "hr"}));

    // dave does hold capability.revoke — inserted directly (bypassing the
    // self-grant block already confirmed above) so this exercises the
    // self-revoke SOD path specifically, not just "no capability at all".
    const selfGrantId = `elev-${w.stamp}-self`;
    await dblayer.runCmdOrThrow(
        `INSERT INTO capability_grant (grant_id, org_id, person_id, capability, scope_type, effect,
            granted_by, reason, valid_from, valid_to) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [selfGrantId, w.org_id, w.dave, "task.delete", "org", "allow", w.dave, "Direct insert for the SOD test.",
            "2026-01-01", _inDays(14)]);
    await _checkThrows("an admin holding capability.revoke still cannot revoke their own grant (sod.self_role_change)",
        _ => access.revokeGrantAsync({org_id: w.org_id, actor_person_id: w.dave, grant_id: selfGrantId}));
    const stillThere = await dblayer.getQueryOrThrow("SELECT * FROM capability_grant WHERE grant_id=? AND revoked_at IS NULL",
        [selfGrantId]);
    _check("the self-grant is still active — the SOD rule blocked the revoke, not a missing capability",
        stillThere.length == 1, JSON.stringify(stillThere));
}

async function _testCapabilityRefusals(w) {
    LOG.console("\n capability refusals\n");
    await _checkThrows("an employee cannot read roles", _ => access.rolesAsync(w.org_id, w.alice));
    await _checkThrows("an employee cannot read the catalogue", _ => access.catalogueAsync(w.org_id, w.alice));
    await _checkThrows("an employee cannot read the access review", _ => access.accessReviewAsync(w.org_id, w.alice));
    await _checkThrows("an employee cannot use the who-can lookup", _ => access.whoCanAsync(w.org_id, w.alice, "leave.approve"));
    await _checkThrows("an employee cannot create a role",
        _ => access.createRoleAsync({org_id: w.org_id, actor_person_id: w.alice, name: "Should fail",
            capabilities: [["audit.read_own", "self"]]}));
    await _checkThrows("an employee cannot grant an elevation",
        _ => access.grantElevationAsync({org_id: w.org_id, actor_person_id: w.alice, person_id: w.erin,
            capability: "task.delete", scope_type: "org", valid_to: _inDays(14), reason: "Should fail."}));
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Access test ${stamp}`, home_jurisdiction: "IN"});
    const roleOf = {alice: "employee", carol: "hr", erin: "employee", dave: "admin", frank: "employee"};
    const people = {};
    for (const who of [...Object.keys(roleOf), "george"])
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN", contract_type: "employee",
        valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    // george deliberately gets no role assignment here — the one genuinely
    // grant-less person, for the "assigning a role materialises its bundle"
    // test. Everyone else (including frank) starts with their own role's
    // grants already in place, which is what makes them wrong for that test.
    for (const [who, role] of Object.entries(roleOf)) await permissions.assignRoleAsync(org.org_id, people[who].person_id, role, from);

    return {org_id: org.org_id, stamp, ...Object.fromEntries(Object.entries(people).map(([name, person]) => [name, person.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["audit_event", "capability_grant", "role_capability", "role", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "carol", "erin", "dave", "frank", "george"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
