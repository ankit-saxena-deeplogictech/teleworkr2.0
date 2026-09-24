/**
 * Tests L1 — org bootstrap in one transaction, assertion-driven provisioning,
 * the mover sync, the org API, and the degraded IdP naming. The questions under
 * test are the Phase 0 gate: create an org, sign in via IdP, read jurisdiction
 * and manager from the assertion — with L1's rule that a missing attribute
 * flags the account rather than inventing a value.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests identity
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const identity = require(`${TELEWORKR_CONSTANTS.LIBDIR}/identity.js`);
const loginhandler = require(`${TELEWORKR_CONSTANTS.LIBDIR}/loginhandler.js`);
const loginapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/login.js`);
const orgapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/org.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Identity test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "identity")) {
        LOG.console("Skipping identity test case, not called.\n"); return true;
    }
    LOG.console("\nL1 identity\n");

    await dblayer.readyAsync();
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Identity test ${stamp}`, home_jurisdiction: "GB"});
    const world = {org_id: org.org_id, stamp, org_ids: [org.org_id]};
    const originalTkmloginApi = TELEWORKR_CONSTANTS.CONF.tkmlogin_api;

    try {
        await _testBootstrap(world);
        await _testProvisioning(world);
        await _testMoverSync(world);
        await _testOrgAPI(world);
        await _buildAdminWorld(world);
        await _testAttributeMapAndProvider(world);
        await _testMfaPolicy(world);
        await _testFlaggedQueueAndResolve(world);
        await _testMovementView(world);
        await _testMoverSyncWiredToLogin(world);
        await _testCapabilityRefusals(world);
        await _testDegradedIdP(world);
    } catch (err) {
        failed++; LOG.console(`  FAIL  identity tests threw: ${err}\n`); LOG.error(`Identity tests threw: ${err.stack}`);
    } finally {
        TELEWORKR_CONSTANTS.CONF.tkmlogin_api = originalTkmloginApi;
        for (const org_id of world.org_ids) await _cleanup(org_id);
        for (const email of world.emails||[]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE email=?", [email]);
    }

    LOG.console(`\nIdentity tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------
// org bootstrap
// ---------------------------------------------------------------------------

async function _testBootstrap(w) {
    LOG.console("\n org bootstrap — one transaction\n");
    const adminEmail = `bootstrap.${w.stamp}@example.invalid`;
    w.emails = [...(w.emails||[]), adminEmail];

    const bootstrapped = await identity.bootstrapOrgAsync({
        org: {name: `Boot ${w.stamp}`, home_jurisdiction: "GB"},
        admin: {email: adminEmail, display_name: "First Admin", employment_status: "active",
            jurisdiction: "GB", start_date: "2026-01-01", contract_type: "employee",
            manager: null, home_timezone: "Europe/London"}});
    w.org_ids.push(bootstrapped.org.org_id);

    _check("the org exists", Boolean(await spine.getOrgAsync(bootstrapped.org.org_id)));
    _check("the first admin exists as a person", Boolean(await spine.getPersonByEmailAsync(adminEmail)));
    const employment = await spine.employmentAsOfAsync(bootstrapped.org.org_id, bootstrapped.person.person_id, "2026-06-15");
    _check("the admin's employment carries jurisdiction from the assertion",
        employment?.jurisdiction == "GB", employment?.jurisdiction);
    _check("all five built-in roles were seeded", Object.keys(bootstrapped.roles).length == 5);

    const canGrant = await permissions.checkAsync({org_id: bootstrapped.org.org_id,
        actor_person_id: bootstrapped.person.person_id, capability: "capability.grant", asOf: "2026-06-15"});
    _check("the first admin holds org-admin capability", canGrant.allowed, canGrant.outcome);

    const createdRows = await dblayer.getQueryOrThrow("SELECT * FROM audit_event WHERE org_id=? AND action='org.created'",
        [bootstrapped.org.org_id]);
    _check("the creation is audited inside the same transaction", createdRows.length == 1);
    _check("the chain verifies after bootstrap", (await audit.verifyIntegrityAsync(bootstrapped.org.org_id)).ok);

    await _checkThrows("a first admin missing a required attribute is refused, naming it", _ =>
        identity.bootstrapOrgAsync({org: {name: `Missing ${w.stamp}`},
            admin: {email: `missing.${w.stamp}@example.invalid`, jurisdiction: "GB",
                start_date: "2026-01-01", contract_type: "employee"}}));
    await _checkThrows("an unknown employment status is refused", _ =>
        identity.bootstrapOrgAsync({org: {name: `Status ${w.stamp}`},
            admin: {email: `status.${w.stamp}@example.invalid`, employment_status: "vibing",
                jurisdiction: "GB", start_date: "2026-01-01", contract_type: "employee"}}));

    // A failure part-way rolls the whole bootstrap back — no half-created org
    const brokenOrgId = `broken-${w.stamp}`;
    await _checkThrows("a bootstrap that fails part-way rolls back", _ =>
        identity.bootstrapOrgAsync({org: {name: `Broken ${w.stamp}`, org_id: brokenOrgId},
            admin: {email: `broken.${w.stamp}@example.invalid`, employment_status: "active",
                jurisdiction: "GB", start_date: "01/06/2026", contract_type: "employee"}}));
    _check("the rolled-back org does not exist", (await spine.getOrgAsync(brokenOrgId)) === null);
    _check("the rolled-back admin does not exist",
        (await spine.getPersonByEmailAsync(`broken.${w.stamp}@example.invalid`)) === null);
    _check("the rolled-back org has no roles",
        (await dblayer.getQueryOrThrow("SELECT * FROM role WHERE org_id=?", [brokenOrgId])).length == 0);

    await _checkThrows("a second bootstrap over the same org id is refused", _ =>
        identity.bootstrapOrgAsync({org: {name: `Dup ${w.stamp}`, org_id: bootstrapped.org.org_id},
            admin: {email: `dup.${w.stamp}@example.invalid`, employment_status: "active",
                jurisdiction: "GB", start_date: "2026-01-01", contract_type: "employee"}}));
    _check("the original org survived the refused duplicate",
        (await spine.getOrgAsync(bootstrapped.org.org_id))?.name.startsWith("Boot"));
}

// ---------------------------------------------------------------------------
// provisioning from the assertion
// ---------------------------------------------------------------------------

async function _testProvisioning(w) {
    LOG.console("\n assertion provisioning — never silently defaulted\n");
    const manager = await spine.createPersonAsync(
        {display_name: "Mgr", email: `mgr.${w.stamp}@example.invalid`});
    w.emails.push(manager.email);

    const email = `Ally.${w.stamp}@Example.Invalid`;   // deliberately mixed case
    w.emails.push(email.toLowerCase());
    const assertion = {tokenflag: true, id: email, org: w.org_id, employment_status: "active",
        jurisdiction: "IN", start_date: "2026-01-01", contract_type: "employee",
        manager: manager.email, home_timezone: "Asia/Kolkata"};

    const first = {...assertion};
    _check("a first sign-in with a complete assertion provisions employment",
        await identity.provisionFromAssertionAsync(first));
    _check("the person was created with a lower-cased email",
        Boolean(await spine.getPersonByEmailAsync(email.toLowerCase())));
    _check("jurisdiction is read from the assertion", first.jurisdiction == "IN");
    _check("the manager resolves to a person by email",
        first.manager_person_id == manager.person_id, first.manager_person_id);
    _check("the assertion is flagged complete", first.provisioning_status == "complete");

    const person = await spine.getPersonByEmailAsync(email.toLowerCase());
    const employment = await spine.getOpenEmploymentAsync(w.org_id, person.person_id);
    _check("the employment is sourced from the IdP", employment.source == "idp");
    const provisioned = await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='employment.provisioned' AND object_ref=?",
        [w.org_id, employment.employment_id]);
    _check("provisioning is audited", provisioned.length == 1);

    const second = {...assertion};
    _check("a second sign-in is idempotent", await identity.provisionFromAssertionAsync(second));
    _check("no second person was created",
        (await dblayer.getQueryOrThrow("SELECT * FROM person WHERE email=?", [email.toLowerCase()])).length == 1);
    _check("no second employment period was created",
        (await spine.getOpenEmploymentAsync(w.org_id, person.person_id)).employment_id == employment.employment_id);

    // the record wins over the assertion once a period is in force
    const changed = {...assertion, jurisdiction: "DE"};
    await identity.provisionFromAssertionAsync(changed);
    _check("the record wins over a later assertion — jurisdiction still reads IN", changed.jurisdiction == "IN");

    // missing attribute: account created, flagged, notified, never defaulted
    const partialEmail = `partial.${w.stamp}@example.invalid`;
    w.emails.push(partialEmail);
    const partial = {tokenflag: true, id: partialEmail, org: w.org_id, employment_status: "active",
        start_date: "2026-01-01", contract_type: "employee"};   // no jurisdiction
    _check("a missing attribute refuses to provision", !(await identity.provisionFromAssertionAsync(partial)));
    const partialPerson = await spine.getPersonByEmailAsync(partialEmail);
    _check("but the account was still created", Boolean(partialPerson));
    _check("and no employment was invented for it",
        (await spine.getOpenEmploymentAsync(w.org_id, partialPerson.person_id)) === null);
    _check("the flag names exactly the missing attribute",
        partialPerson.provisioning_status == "jurisdiction", partialPerson.provisioning_status);
    _check("no jurisdiction was invented on the login result", partial.jurisdiction === undefined);
    const flagged = await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='provisioning.incomplete' AND object_ref=?",
        [w.org_id, partialPerson.person_id]);
    _check("the incomplete assertion is audited with the missing list",
        flagged.length == 1 && flagged[0].detail == JSON.stringify({missing: ["jurisdiction"]}), flagged[0]?.detail);

    // an unknown status value is treated as missing, not stored
    const oddEmail = `odd.${w.stamp}@example.invalid`;
    w.emails.push(oddEmail);
    const odd = {tokenflag: true, id: oddEmail, org: w.org_id, employment_status: "vibing",
        jurisdiction: "GB", start_date: "2026-01-01", contract_type: "employee"};
    await identity.provisionFromAssertionAsync(odd);
    _check("an unknown employment status flags the account rather than storing it",
        (await spine.getPersonByEmailAsync(oddEmail)).provisioning_status == "employment_status");

    // the flagged account repairs on the next complete assertion
    const repaired = {tokenflag: true, id: partialEmail, org: w.org_id, employment_status: "active",
        jurisdiction: "GB", start_date: "2026-01-01", contract_type: "employee"};
    _check("a later complete assertion repairs the flagged account",
        await identity.provisionFromAssertionAsync(repaired) && repaired.provisioning_status == "complete");
    _check("the flag is cleared on repair",
        (await spine.getPersonByEmailAsync(partialEmail)).provisioning_status === null);

    // a future start date provisions the open record but nothing in force today
    const futureEmail = `future.${w.stamp}@example.invalid`;
    w.emails.push(futureEmail);
    const future = {tokenflag: true, id: futureEmail, org: w.org_id, employment_status: "active",
        jurisdiction: "GB", start_date: "2030-01-01", contract_type: "employee"};
    await identity.provisionFromAssertionAsync(future);
    const futurePerson = await spine.getPersonByEmailAsync(futureEmail);
    _check("a future start date records the period without it being in force today",
        (await spine.employmentAsOfAsync(w.org_id, futurePerson.person_id)) === null &&
        (await spine.getOpenEmploymentAsync(w.org_id, futurePerson.person_id)) !== null);
    await identity.provisionFromAssertionAsync({...future});
    _check("and a second sign-in does not duplicate the future period",
        (await spine.employmentHistoryAsync(w.org_id, futurePerson.person_id)).length == 1);

    // an org the assertion names but does not exist is refused, not invented
    const ghost = {tokenflag: true, id: `ghost.${w.stamp}@example.invalid`, org: "ghost-org"};
    _check("a sign-in naming an unknown org is refused and named",
        !(await identity.provisionFromAssertionAsync(ghost)) && ghost.provisioning_status == "no_org");
    _check("no person was created for the ghost org",
        (await spine.getPersonByEmailAsync(`ghost.${w.stamp}@example.invalid`)) === null);

    // the login listener is wired to the same path
    const viaListener = {tokenflag: true, id: `listener.${w.stamp}@example.invalid`, org: w.org_id,
        employment_status: "active", jurisdiction: "GB", start_date: "2026-01-01", contract_type: "employee"};
    w.emails.push(viaListener.id);
    _check("the login listener provisions through the same path",
        await loginhandler.employmentInjector(viaListener) && viaListener.jurisdiction == "GB");
}

// ---------------------------------------------------------------------------
// the mover sync
// ---------------------------------------------------------------------------

async function _testMoverSync(w) {
    LOG.console("\n the mover path supersedes, never edits\n");
    const moverEmail = `mover.${w.stamp}@example.invalid`;
    w.emails.push(moverEmail);
    const person = await spine.createPersonAsync({display_name: "Mover", email: moverEmail});
    await spine.recordEmploymentAsync({org_id: w.org_id, person_id: person.person_id,
        status: "active", jurisdiction: "GB", contract_type: "employee",
        valid_from: "2026-01-01", source: "idp"});

    _check("a sync with nothing changed supersedes nothing",
        (await identity.syncEmploymentFromAssertionAsync(w.org_id, person.person_id,
            {jurisdiction: "GB", employment_status: "active", contract_type: "employee"})) === null);

    const moved = await identity.syncEmploymentFromAssertionAsync(w.org_id, person.person_id,
        {jurisdiction: "IN", start_date: "2026-04-01"});
    _check("a jurisdiction change opens a new period", Boolean(moved));
    const history = await spine.employmentHistoryAsync(w.org_id, person.person_id);
    _check("both periods are retained", history.length == 2);
    _check("the old period was closed where the new one began",
        history[0].valid_to == "2026-04-01" && history[1].valid_to === null);
    _check("the old jurisdiction is still answerable for March",
        (await spine.jurisdictionAsOfAsync(w.org_id, person.person_id, "2026-03-15")) == "GB");
    _check("and the new one answers for May",
        (await spine.jurisdictionAsOfAsync(w.org_id, person.person_id, "2026-05-15")) == "IN");

    const newManager = await spine.createPersonAsync({display_name: "Mgr2", email: `mgr2.${w.stamp}@example.invalid`});
    w.emails.push(newManager.email);
    await identity.syncEmploymentFromAssertionAsync(w.org_id, person.person_id,
        {manager: newManager.email, start_date: "2026-05-01"});
    _check("a manager change re-routes to the new manager",
        (await spine.managerAsOfAsync(w.org_id, person.person_id, "2026-06-15")) == newManager.person_id);
}

// ---------------------------------------------------------------------------
// the org API
// ---------------------------------------------------------------------------

async function _testOrgAPI(w) {
    LOG.console("\n the org API\n");
    const email = `apiadmin.${w.stamp}@example.invalid`;
    w.emails.push(email);
    const orgId = `api-org-${w.stamp}`;
    w.org_ids.push(orgId);

    const created = await orgapi.doService({op: "create", id: email, org: orgId,
        name: `API org ${w.stamp}`, home_jurisdiction: "IN", employment_status: "active",
        jurisdiction: "IN", start_date: "2026-01-01", contract_type: "employee"});
    _check("op create bootstraps the org and answers true", created.result === true, JSON.stringify(created.reason||""));
    _check("the answer carries the org and the seeded roles",
        created.org?.org_id == orgId && created.roles.length == 5);
    _check("the created admin holds org-admin capability",
        (await permissions.checkAsync({org_id: orgId, actor_person_id: created.person_id,
            capability: "capability.grant", asOf: "2026-06-15"})).allowed);

    const duplicate = await orgapi.doService({op: "create", id: email, org: orgId,
        name: "Again", employment_status: "active", jurisdiction: "GB",
        start_date: "2026-01-01", contract_type: "employee"});
    _check("a duplicate org claim is refused with a reason",
        duplicate.result === false && /already exists/.test(duplicate.reason||""), duplicate.reason);

    const incomplete = await orgapi.doService({op: "create", id: email, org: `half-${w.stamp}`, name: "Half"});
    _check("a request missing required attributes is refused",
        incomplete.result === false && !incomplete.reason);
}

// ---------------------------------------------------------------------------
// L1's admin screen — attribute map, provider status, MFA policy, the
// flagged queue, movement, and the mover-sync wiring fix
// ---------------------------------------------------------------------------

async function _buildAdminWorld(w) {
    await permissions.ensureBuiltinRolesAsync(w.org_id);
    const adminEmail = `idadmin.${w.stamp}@example.invalid`, employeeEmail = `idemployee.${w.stamp}@example.invalid`;
    w.emails.push(adminEmail, employeeEmail);
    const admin = await spine.createPersonAsync({display_name: "Admin", email: adminEmail});
    const employee = await spine.createPersonAsync({display_name: "Employee", email: employeeEmail});
    for (const person of [admin, employee]) await spine.recordEmploymentAsync({org_id: w.org_id, person_id: person.person_id,
        status: "active", jurisdiction: "IN", contract_type: "employee", valid_from: "2026-01-01", source: "manual"});
    await permissions.assignRoleAsync(w.org_id, admin.person_id, "admin", {granted_by: "system", valid_from: "2026-01-01"});
    await permissions.assignRoleAsync(w.org_id, employee.person_id, "employee", {granted_by: "system", valid_from: "2026-01-01"});
    w.admin = admin.person_id; w.employee = employee.person_id;
}

async function _testAttributeMapAndProvider(w) {
    LOG.console("\n attribute map and provider status — real data only, no invented multi-provider catalogue\n");
    const map = identity.attributeMap();
    _check("all six wireframe attributes are present", map.length == 6, JSON.stringify(map.map(r => r.attribute)));
    _check("the four hard-required ones are flagged required, from the single source of truth",
        map.filter(r => r.required).map(r => r.attribute).sort().join(",") ==
            [...identity.REQUIRED_ASSERTION_ATTRIBUTES].sort().join(","), JSON.stringify(map));

    const status = await identity.providerStatusAsync(w.org_id);
    _check("the one real provider is reported configured (tkmlogin_api is set in test config)",
        status.configured === true, JSON.stringify(status));
    _check("people_via_idp never exceeds people_total", status.people_via_idp <= status.people_total, JSON.stringify(status));
}

async function _testMfaPolicy(w) {
    LOG.console("\n MFA policy — declared, defaults until an org overrides one\n");
    const before = await identity.mfaPolicyAsync(w.org_id, w.admin);
    _check("all three tiers report the default strength initially", before.policy.every(row => row.is_default), JSON.stringify(before.policy));

    const updated = await identity.updateMfaPolicyAsync({org_id: w.org_id, actor_person_id: w.admin,
        role_tier: "critical", strength: "phishing_resistant"});
    _check("updating a tier succeeds", updated.strength == "phishing_resistant", JSON.stringify(updated));

    const after = await identity.mfaPolicyAsync(w.org_id, w.admin);
    const critical = after.policy.find(row => row.role_tier == "critical");
    _check("the updated tier is no longer flagged default", critical.strength == "phishing_resistant" && !critical.is_default, JSON.stringify(critical));
    const standard = after.policy.find(row => row.role_tier == "standard");
    _check("an untouched tier still reads its default", standard.is_default && standard.strength == "idp_enforced", JSON.stringify(standard));

    await _checkThrows("an unknown role tier is refused", _ =>
        identity.updateMfaPolicyAsync({org_id: w.org_id, actor_person_id: w.admin, role_tier: "nope", strength: "hardware_key"}));
    await _checkThrows("an unknown strength is refused", _ =>
        identity.updateMfaPolicyAsync({org_id: w.org_id, actor_person_id: w.admin, role_tier: "standard", strength: "nope"}));
}

async function _testFlaggedQueueAndResolve(w) {
    LOG.console("\n the flagged queue, and closing the loop by resolving one\n");
    const flagEmail = `flag.${w.stamp}@example.invalid`;
    w.emails.push(flagEmail);
    await identity.provisionFromAssertionAsync({tokenflag: true, id: flagEmail, org: w.org_id,
        employment_status: "active", start_date: "2026-01-01", contract_type: "employee"});   // no jurisdiction

    const flagged = await identity.flaggedPeopleAsync(w.org_id, w.admin);
    const row = flagged.people.find(p => p.email == flagEmail.toLowerCase());
    _check("the flagged person appears in the (uncapped) queue with the missing attribute named",
        row && row.missing.includes("jurisdiction"), JSON.stringify(row));

    const person = await spine.getPersonByEmailAsync(flagEmail.toLowerCase());
    await _checkThrows("resolving without every required attribute is refused", _ =>
        identity.resolveFlaggedPersonAsync({org_id: w.org_id, actor_person_id: w.admin, person_id: person.person_id,
            employment_status: "active", contract_type: "employee", start_date: "2026-01-01"}));   // still no jurisdiction

    const resolved = await identity.resolveFlaggedPersonAsync({org_id: w.org_id, actor_person_id: w.admin,
        person_id: person.person_id, employment_status: "active", jurisdiction: "IN",
        contract_type: "employee", start_date: "2026-01-01"});
    _check("resolving with everything supplied succeeds", Boolean(resolved.employment_id), JSON.stringify(resolved));

    const repaired = await spine.getPersonAsync(person.person_id);
    _check("the flag is cleared", repaired.provisioning_status === null, JSON.stringify(repaired));
    _check("employment is now in force — the only prior path was waiting for a corrected IdP assertion",
        Boolean(await spine.employmentAsOfAsync(w.org_id, person.person_id)));

    const afterQueue = await identity.flaggedPeopleAsync(w.org_id, w.admin);
    _check("the resolved person no longer appears in the queue",
        !afterQueue.people.some(p => p.person_id == person.person_id), JSON.stringify(afterQueue.people.map(p => p.person_id)));

    await _checkThrows("resolving an already-resolved person is refused", _ =>
        identity.resolveFlaggedPersonAsync({org_id: w.org_id, actor_person_id: w.admin, person_id: person.person_id,
            employment_status: "active", jurisdiction: "IN", contract_type: "employee", start_date: "2026-01-01"}));

    const auditRows = await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='identity.provisioning_resolved' AND object_ref=?",
        [w.org_id, person.person_id]);
    _check("the resolution is audited", auditRows.length == 1, JSON.stringify(auditRows));
}

async function _testMovementView(w) {
    LOG.console("\n joiners, movers and leavers\n");

    const joinerEmail = `joiner.${w.stamp}@example.invalid`;
    w.emails.push(joinerEmail);
    const joinerPerson = await spine.createPersonAsync({display_name: "Joiner", email: joinerEmail});
    await spine.recordEmploymentAsync({org_id: w.org_id, person_id: joinerPerson.person_id, status: "active",
        jurisdiction: "IN", contract_type: "employee", valid_from: "2099-01-01", source: "idp"});

    const moverEmail = `move2.${w.stamp}@example.invalid`;
    w.emails.push(moverEmail);
    const moverPerson = await spine.createPersonAsync({display_name: "Mover2", email: moverEmail});
    await spine.recordEmploymentAsync({org_id: w.org_id, person_id: moverPerson.person_id, status: "active",
        jurisdiction: "GB", contract_type: "employee", valid_from: "2026-01-01", source: "idp"});
    await identity.syncEmploymentFromAssertionAsync(w.org_id, moverPerson.person_id,
        {employment_status: "probation", jurisdiction: "GB", start_date: "2026-02-01"});

    const leaverEmail = `leaver.${w.stamp}@example.invalid`;
    w.emails.push(leaverEmail);
    const leaverPerson = await spine.createPersonAsync({display_name: "Leaver", email: leaverEmail});
    await spine.recordEmploymentAsync({org_id: w.org_id, person_id: leaverPerson.person_id, status: "notice",
        jurisdiction: "IN", contract_type: "employee", valid_from: "2026-01-01", source: "idp"});

    const view = await identity.joinersMoversLeaversAsync(w.org_id, w.admin);
    _check("the future-dated joiner appears — dormant until their start date, no new engine work needed for that",
        view.joiners.some(j => j.person_id == joinerPerson.person_id), JSON.stringify(view.joiners.map(j => j.person_id)));

    const mover = view.movers.find(m => m.person_id == moverPerson.person_id);
    _check("the status-only mover is detected", Boolean(mover), JSON.stringify(view.movers));
    _check("the mover's diff names the status change",
        mover?.changes.some(c => c.field == "status" && c.from == "active" && c.to == "probation"), JSON.stringify(mover?.changes));

    _check("the notice-status leaver appears",
        view.leavers.some(l => l.person_id == leaverPerson.person_id), JSON.stringify(view.leavers.map(l => l.person_id)));
}

async function _testMoverSyncWiredToLogin(w) {
    LOG.console("\n the mover path now fires from the real login listener, not only from its own tests\n");
    const email = `wired.${w.stamp}@example.invalid`;
    w.emails.push(email);
    await loginhandler.employmentInjector({tokenflag: true, id: email, org: w.org_id, employment_status: "active",
        jurisdiction: "IN", start_date: "2026-01-01", contract_type: "employee"});
    const person = await spine.getPersonByEmailAsync(email.toLowerCase());
    _check("employment is in force after the first sign-in", Boolean(await spine.employmentAsOfAsync(w.org_id, person.person_id)));

    // a status-only change on a second sign-in — exactly the case the assertion.status vs
    // assertion.employment_status field-name bug silently swallowed before the fix
    await loginhandler.employmentInjector({tokenflag: true, id: email, org: w.org_id, employment_status: "probation",
        jurisdiction: "IN", start_date: "2026-06-01", contract_type: "employee"});
    const history = await spine.employmentHistoryAsync(w.org_id, person.person_id);
    _check("a status change on a later sign-in opens a new period through the real login path",
        history.length == 2 && history[1].status == "probation", JSON.stringify(history));
    _check("the earlier period is still answerable for its own dates",
        (await spine.employmentAsOfAsync(w.org_id, person.person_id, "2026-03-01"))?.status == "active");
}

async function _testCapabilityRefusals(w) {
    LOG.console("\n capability refusals — an employee cannot touch any of L1's admin screen\n");
    await _checkThrows("an employee cannot read the MFA policy", _ => identity.mfaPolicyAsync(w.org_id, w.employee));
    await _checkThrows("an employee cannot update the MFA policy", _ =>
        identity.updateMfaPolicyAsync({org_id: w.org_id, actor_person_id: w.employee, role_tier: "standard", strength: "hardware_key"}));
    await _checkThrows("an employee cannot read the flagged queue", _ => identity.flaggedPeopleAsync(w.org_id, w.employee));

    // an actually-flagged target, so this genuinely exercises the capability gate
    // rather than tripping the "not flagged" guard for the wrong reason
    const stillFlaggedEmail = `stillflag.${w.stamp}@example.invalid`;
    w.emails.push(stillFlaggedEmail);
    await identity.provisionFromAssertionAsync({tokenflag: true, id: stillFlaggedEmail, org: w.org_id,
        employment_status: "active", start_date: "2026-01-01", contract_type: "employee"});   // no jurisdiction
    const stillFlagged = await spine.getPersonByEmailAsync(stillFlaggedEmail.toLowerCase());
    await _checkThrows("an employee cannot resolve a flagged person", _ =>
        identity.resolveFlaggedPersonAsync({org_id: w.org_id, actor_person_id: w.employee, person_id: stillFlagged.person_id,
            employment_status: "active", jurisdiction: "IN", contract_type: "employee", start_date: "2026-01-01"}));
    _check("and the flag is still there afterwards — the refused call changed nothing",
        (await spine.getPersonAsync(stillFlagged.person_id)).provisioning_status != null);

    await _checkThrows("an employee cannot read joiners/movers/leavers", _ => identity.joinersMoversLeaversAsync(w.org_id, w.employee));
}

// ---------------------------------------------------------------------------
// degraded IdP naming
// ---------------------------------------------------------------------------

async function _testDegradedIdP(w) {
    LOG.console("\n the IdP as a degraded dependency\n");
    TELEWORKR_CONSTANTS.CONF.tkmlogin_api = "http://127.0.0.1:9/validate";   // nothing listens here
    const unreachable = await loginapi.doService({op: "verify", jwt: "header.payload.signature"});
    _check("an unreachable IdP is named as idp_unreachable",
        unreachable.result === false && unreachable.degraded == "idp_unreachable", unreachable.degraded);

    const invalid = await loginapi.doService({op: "verify"});
    _check("an invalid request stays a plain refusal without a degraded name",
        invalid.result === false && invalid.degraded === undefined);
}

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

async function _cleanup(org_id) {
    if (!org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM identity_mfa_policy WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [org_id]);
}
