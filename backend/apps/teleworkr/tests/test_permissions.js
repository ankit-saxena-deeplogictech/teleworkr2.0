/**
 * Tests the L2 permission engine — capability x scope, deny winning everywhere,
 * separation of duties naming itself, elevation expiring, and the ceiling holding.
 *
 * The ceiling tests are the ones that matter most. H3 promises in plain language
 * that nobody can read another person's minute-level activity; these are the tests
 * that make the promise survive the first customer who asks for an exception.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests permissions
 *
 * (C) 2026 Tekmonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);

const {SCOPES} = capabilities, {OUTCOMES} = permissions;
const TODAY = "2026-06-15";

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Permission test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true);}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "permissions")) {
        LOG.console("Skipping permissions test case, not called.\n"); return true;
    }
    LOG.console("\nL2 permissions\n");

    // built inside the try, so a failure while building still cleans up after itself
    const world = {};
    try {
        Object.assign(world, await _buildWorld());
        await _testCeiling(world);
        await _testGrantValidation(world);
        await _testScope(world);
        await _testDenyWins(world);
        await _testSeparationOfDuties(world);
        await _testElevation(world);
        await _testRolesAndReview(world);
    } catch (err) {
        failed++; LOG.console(`  FAIL  permission tests threw: ${err}\n`); LOG.error(`Permission tests threw: ${err.stack}`);
    } finally {
        await _cleanup(world);
    }

    LOG.console(`\nPermission tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Perm test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});

    // erin manages bob and carol; bob manages alice; dave manages nobody
    const line = {alice: people.bob.person_id, bob: people.erin.person_id, carol: people.erin.person_id,
        dave: null, erin: null};
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: who == "carol" ? "IN" : "GB",
        manager_person_id: line[who], contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};   // in force for the dates these tests ask about
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);

    return {org_id: org.org_id, ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _testCeiling(w) {
    LOG.console("\n the ceiling\n");
    const asAdmin = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.dave,
        capability: "activity.read_minute_level", subject_person_id: w.alice, asOf: TODAY});
    _check("an org admin cannot read another person's minute-level activity",
        !asAdmin.allowed && asAdmin.outcome == OUTCOMES.CEILING, asAdmin.outcome);
    _check("the refusal says nobody can, not that this person cannot",
        /Nobody/i.test(asAdmin.who_can||""), asAdmin.who_can);

    await _checkThrows("minute-level activity cannot be granted at all", _ =>
        permissions.grantAsync({org_id: w.org_id, person_id: w.dave, capability: "activity.read_minute_level",
            scope_type: SCOPES.ORG, granted_by: w.dave, reason: "customer asked", valid_to: "2026-12-31"}));

    await _checkThrows("it cannot be smuggled in as a deny either", _ =>
        permissions.grantAsync({org_id: w.org_id, person_id: w.dave, capability: "activity.read_minute_level",
            scope_type: SCOPES.ORG, effect: "deny", granted_by: w.dave}));

    _check("nobody holds it on the reverse lookup",
        (await permissions.whoCanAsync(w.org_id, "activity.read_minute_level")).length == 0);

    for (const never of ["keystrokes.read", "screen.read", "sentiment.analyse", "message.read_content", "session.proctor"]) {
        const d = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.dave,
            capability: never, subject_person_id: w.alice, asOf: TODAY});
        _check(`${never} is structurally refused`, !d.allowed && d.outcome == OUTCOMES.CEILING);
    }
}

async function _testGrantValidation(w) {
    LOG.console("\n a capability with no scope is not a valid grant\n");
    await _checkThrows("a grant with no scope is refused", _ =>
        permissions.grantAsync({org_id: w.org_id, person_id: w.alice, capability: "timesheet.approve",
            granted_by: w.dave, reason: "x", valid_to: "2026-12-31"}));

    await _checkThrows("a capability at a scope it does not allow is refused", _ =>
        permissions.grantAsync({org_id: w.org_id, person_id: w.alice, capability: "time.read_own",
            scope_type: SCOPES.ORG, granted_by: w.dave, reason: "x", valid_to: "2026-12-31"}));

    await _checkThrows("a scope that names a thing needs a scope_ref", _ =>
        permissions.grantAsync({org_id: w.org_id, person_id: w.carol, capability: "leave_policy.publish",
            scope_type: SCOPES.JURISDICTION, granted_by: w.dave, reason: "x", valid_to: "2026-12-31"}));

    await _checkThrows("a capability outside the catalogue is refused", _ =>
        permissions.grantAsync({org_id: w.org_id, person_id: w.alice, capability: "invented.capability",
            scope_type: SCOPES.ORG, granted_by: w.dave, reason: "x", valid_to: "2026-12-31"}));
}

async function _testScope(w) {
    LOG.console("\n scope is the second axis\n");
    const own = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.alice,
        capability: "time.read_own", subject_person_id: w.alice, asOf: TODAY});
    _check("an employee reads their own time", own.allowed, own.outcome);

    const notMine = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.alice,
        capability: "timesheet.approve", subject_person_id: w.bob, asOf: TODAY});
    _check("an employee cannot approve a timesheet", !notMine.allowed && notMine.outcome == OUTCOMES.NO_GRANT, notMine.outcome);

    const direct = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob,
        capability: "timesheet.approve", subject_person_id: w.alice, asOf: TODAY});
    _check("a lead approves a direct report's timesheet", direct.allowed, direct.reason);

    const notReport = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob,
        capability: "timesheet.approve", subject_person_id: w.carol, asOf: TODAY});
    _check("a lead cannot approve someone who is not their report",
        !notReport.allowed && notReport.outcome == OUTCOMES.OUT_OF_SCOPE, notReport.outcome);
    _check("the refusal names who can do it instead", Boolean(notReport.who_can), notReport.who_can);

    // scope is evaluated as of a date, so a reorg does not rewrite March
    await spine.recordEmploymentAsync({org_id: w.org_id, person_id: w.alice, status: "active",
        jurisdiction: "GB", manager_person_id: w.carol, contract_type: "employee",
        valid_from: "2026-07-01", source: "manual"});
    _check("after a reorg the old manager still had scope in June",
        (await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob, capability: "timesheet.approve",
            subject_person_id: w.alice, asOf: "2026-06-15"})).allowed);
    _check("and does not have scope in August",
        !(await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob, capability: "timesheet.approve",
            subject_person_id: w.alice, asOf: "2026-08-15"})).allowed);

    // reporting_line reaches further than direct_reports
    const skip = await permissions.grantAsync({org_id: w.org_id, person_id: w.erin,
        capability: "timesheet.approve", scope_type: SCOPES.REPORTING_LINE, granted_by: w.dave,
        reason: "skip-level cover", valid_from: "2026-01-01", valid_to: "2026-12-31"});
    _check("a skip-level manager reaches through the reporting line",
        (await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.erin, capability: "timesheet.approve",
            subject_person_id: w.alice, asOf: TODAY})).allowed);
    await permissions.revokeAsync(skip.grant_id);

    // an unresolvable scope refuses rather than guessing
    const teamGrant = await permissions.grantAsync({org_id: w.org_id, person_id: w.alice,
        capability: "candidate.read", scope_type: SCOPES.TEAM, scope_ref: "platform",
        granted_by: w.dave, reason: "panel member", valid_from: "2026-01-01", valid_to: "2026-12-31"});
    const unresolved = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.alice,
        capability: "candidate.read", subject_person_id: w.bob, asOf: TODAY});
    _check("an unresolvable scope refuses rather than allowing",
        !unresolved.allowed && unresolved.outcome == OUTCOMES.SCOPE_UNRESOLVABLE, unresolved.outcome);
    await permissions.revokeAsync(teamGrant.grant_id);
}

async function _testDenyWins(w) {
    LOG.console("\n deny wins at every level\n");
    _check("the lead can approve their report before the deny",
        (await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob,
            capability: "timesheet.approve", subject_person_id: w.alice, asOf: TODAY})).allowed);

    const deny = await permissions.grantAsync({org_id: w.org_id, person_id: w.bob,
        capability: "timesheet.approve", scope_type: SCOPES.ORG, effect: "deny",
        granted_by: w.dave, reason: "under investigation", valid_from: "2026-01-01"});

    const denied = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob,
        capability: "timesheet.approve", subject_person_id: w.alice, asOf: TODAY});
    _check("a wider deny beats a narrower role-derived allow",
        !denied.allowed && denied.outcome == OUTCOMES.DENIED_BY_GRANT, denied.outcome);

    await permissions.revokeAsync(deny.grant_id);
    _check("revoking the deny restores the allow",
        (await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob,
            capability: "timesheet.approve", subject_person_id: w.alice, asOf: TODAY})).allowed);

    const rows = await dblayer.getQueryOrThrow("SELECT * FROM capability_grant WHERE grant_id=?", [deny.grant_id]);
    _check("a revoked grant is closed, not deleted", rows.length == 1 && rows[0].revoked_at !== null);
}

async function _testSeparationOfDuties(w) {
    LOG.console("\n separation of duties, naming itself\n");
    const selfApprove = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob,
        capability: "timesheet.approve", subject_person_id: w.bob, asOf: TODAY});
    _check("approving your own timesheet is blocked, and says so rather than saying out of scope",
        !selfApprove.allowed && selfApprove.outcome == OUTCOMES.BLOCKED_BY_RULE, selfApprove.outcome);
    _check("the block names the rule that fired", selfApprove.rule == "sod.self_approval", selfApprove.rule);
    _check("the block says who can do it instead", Boolean(selfApprove.who_can), selfApprove.who_can);

    const selfRole = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.dave,
        capability: "capability.grant", subject_person_id: w.dave, asOf: TODAY});
    _check("changing your own capabilities is blocked",
        selfRole.outcome == OUTCOMES.BLOCKED_BY_RULE && selfRole.rule == "sod.self_role_change", selfRole.rule);

    const delegate = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob,
        capability: "leave.approve", subject_person_id: w.alice, asOf: TODAY,
        context: {delegated_for: w.bob}});
    _check("approving as the delegate for yourself is blocked",
        delegate.outcome == OUTCOMES.BLOCKED_BY_RULE && delegate.rule == "sod.delegate_and_requester", delegate.rule);

    // erin gets revoke rights without becoming an admin, so she can attempt the removal
    await permissions.grantAsync({org_id: w.org_id, person_id: w.erin, capability: "capability.revoke",
        scope_type: SCOPES.ORG, granted_by: w.dave, reason: "compliance cover", valid_from: "2026-01-01", valid_to: "2026-12-31"});

    const lastAdmin = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.erin,
        capability: "capability.revoke", subject_person_id: w.dave, asOf: TODAY,
        context: {removes_admin_from: w.dave}});
    _check("removing the last org admin is blocked",
        lastAdmin.outcome == OUTCOMES.BLOCKED_BY_RULE && lastAdmin.rule == "sod.last_org_admin", lastAdmin.rule);

    await permissions.assignRoleAsync(w.org_id, w.carol, "admin", {granted_by: w.dave, valid_from: "2026-01-01"});
    const nowFine = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.erin,
        capability: "capability.revoke", subject_person_id: w.dave, asOf: TODAY,
        context: {removes_admin_from: w.dave}});
    _check("with a second admin in place the removal is allowed", nowFine.allowed, nowFine.outcome);
}

async function _testElevation(w) {
    LOG.console("\n elevation carries an expiry and a reason\n");
    await _checkThrows("a direct grant with no expiry is refused", _ =>
        permissions.grantAsync({org_id: w.org_id, person_id: w.bob, capability: "leave.approve",
            scope_type: SCOPES.ORG, granted_by: w.dave, reason: "covering Priya"}));

    await _checkThrows("a direct grant with no reason is refused", _ =>
        permissions.grantAsync({org_id: w.org_id, person_id: w.bob, capability: "leave.approve",
            scope_type: SCOPES.ORG, granted_by: w.dave, valid_to: "2026-09-14"}));

    const elevation = await permissions.grantAsync({org_id: w.org_id, person_id: w.bob,
        capability: "leave.approve", scope_type: SCOPES.ORG, granted_by: w.dave,
        reason: "covering Priya, parental leave", valid_from: "2026-06-01", valid_to: "2026-09-14"});
    _check("a time-boxed elevation with a reason is accepted", Boolean(elevation.grant_id));

    _check("the elevation applies inside its window",
        (await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob, capability: "leave.approve",
            subject_person_id: w.carol, asOf: "2026-07-01"})).allowed);

    const expired = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob,
        capability: "leave.approve", subject_person_id: w.carol, asOf: "2026-10-01"});
    _check("and auto-revokes after it, with no cleanup job", !expired.allowed, expired.outcome);
}

async function _testRolesAndReview(w) {
    LOG.console("\n roles as bundles, and the access review\n");
    const effective = await permissions.effectivePermissionsAsync(w.org_id, w.bob, TODAY);
    _check("the effective permission set is a serialisable snapshot for H4 to pin",
        Array.isArray(effective) && effective.length > 0 && Boolean(effective[0].capability));
    const sorted = [...effective].map(e => `${e.capability}${e.scope_type}${e.scope_ref||""}`);
    _check("and is stably ordered", JSON.stringify(sorted) == JSON.stringify([...sorted].sort()));

    // union of capabilities: a lead who is also an interviewer
    const {role, warnings} = await permissions.createCustomRoleAsync(w.org_id,
        {name: "interviewer", description: "Panel member", capabilities: [["candidate.read", SCOPES.ORG]]},
        {created_by: w.dave});
    _check("a custom role is composed from capabilities", Boolean(role.role_id) && warnings.length == 0);

    await permissions.assignRoleAsync(w.org_id, w.bob, "interviewer", {granted_by: w.dave, valid_from: "2026-01-01"});
    _check("holding two roles is a union of capabilities",
        (await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob, capability: "candidate.read",
            subject_person_id: w.alice, asOf: TODAY})).allowed &&
        (await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.bob, capability: "timesheet.approve",
            subject_person_id: w.alice, asOf: "2026-06-15"})).allowed);

    const clone = await permissions.createCustomRoleAsync(w.org_id,
        {name: "interviewer copy", capabilities: [["candidate.read", SCOPES.ORG]]}, {created_by: w.dave});
    _check("a role that overlaps an existing one by more than 90% warns",
        clone.warnings.length > 0, JSON.stringify(clone.warnings));

    await _checkThrows("a role with no capabilities is refused", _ =>
        permissions.createCustomRoleAsync(w.org_id, {name: "empty role", capabilities: []}, {created_by: w.dave}));

    const neverUsed = await permissions.grantAsync({org_id: w.org_id, person_id: w.alice,
        capability: "person_data.export", scope_type: SCOPES.REPORTING_LINE, granted_by: w.dave,
        reason: "one-off audit request that never happened", valid_from: "2026-01-01", valid_to: "2026-12-31"});

    const review = await permissions.accessReviewAsync(w.org_id, {unused_days: 90});
    _check("the access review lists grants outside the built-in roles",
        review.length > 0 && review.every(r => r.source_role === null));
    _check("a grant that was never used is proposed for removal",
        review.some(r => r.grant_id == neverUsed.grant_id && r.propose_removal && /Unused/.test(r.why)));
    _check("role-derived grants are excluded from the review",
        !review.some(r => r.source_role));

    const holders = await permissions.whoCanAsync(w.org_id, "timesheet.approve", {subject_person_id: w.alice, asOf: TODAY});
    _check("the reverse lookup answers who can do this to this person",
        holders.length > 0 && holders.every(h => Boolean(h.through.grant_id)),
        `${holders.length} holder(s)`);
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
