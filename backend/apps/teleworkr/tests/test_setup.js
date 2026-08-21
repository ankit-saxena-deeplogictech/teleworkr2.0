/**
 * Tests B5/B6 — the standing setup panel with derived step states, and imports
 * as batches: dry run before every write, provenance on every imported record,
 * opening balances as dated ledger entries rather than a stored balance, and a
 * 24-hour rollback that stops being offered the moment real records exist.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests setup
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const entityshapes = require(`${TELEWORKR_CONSTANTS.LIBDIR}/entityshapes.js`);
const identity = require(`${TELEWORKR_CONSTANTS.LIBDIR}/identity.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const setup = require(`${TELEWORKR_CONSTANTS.LIBDIR}/setup.js`);
const setupapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/setup.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Setup test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "setup")) {
        LOG.console("Skipping setup test case, not called.\n"); return true;
    }
    LOG.console("\nB5/B6 setup and migration\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testStatus(w);
        await _testHealth(w);
        await _testImportPeople(w);
        await _testBalances(w);
        await _testRollback(w);
        await _testMetricsAndAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  setup tests threw: ${err}\n`); LOG.error(`Setup tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nSetup tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _testStatus(w) {
    LOG.console("\n the standing setup panel\n");
    // the required-step assertions belong to a genuinely fresh org
    const fresh = await spine.createOrgAsync({name: `Fresh setup ${Date.now()}`, home_jurisdiction: "GB"});
    try {
        const freshStatus = await setup.setupStatusAsync(fresh.org_id);
        const freshByStep = Object.fromEntries(freshStatus.steps.map(step => [step.step, step]));
        _check("the org step derives done from name and jurisdiction",
            freshByStep.org_jurisdictions.status == "done");
        _check("at least one person is required, and says so",
            freshByStep.import_people.status == "not_started" && /required/.test(freshByStep.import_people.reason));
        _check("the leave policy step states its consequence",
            freshByStep.leave_policy.status == "not_started" && /refuse/.test(freshByStep.leave_policy.reason));
        _check("the invite step names the working-window rule",
            freshByStep.invite.status == "not_started" && /03:00/.test(freshByStep.invite.reason));
        _check("no clock-in yet means no time-to-first-clock-in metric",
            freshStatus.metrics.time_to_first_clock_in_seconds === null);
    } finally {
        await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [fresh.org_id]);
    }

    const status = await setup.setupStatusAsync(w.org_id);

    const marked = await setup.markStepAsync({org_id: w.org_id, actor_person_id: w.dave,
        step: "identity", status: "deferred", marked_default: false});
    _check("an admin mark overrides the derived state", marked.status == "deferred");
    const remarked = await setup.setupStatusAsync(w.org_id);
    const identityStep = remarked.steps.find(step => step.step == "identity");
    _check("the override shows as marked", identityStep.status == "deferred" && identityStep.marked);

    await _checkThrows("marking an unknown step is refused", _ =>
        setup.markStepAsync({org_id: w.org_id, actor_person_id: w.dave, step: "catering", status: "done"}));
    await _checkThrows("marking with a bad status is refused", _ =>
        setup.markStepAsync({org_id: w.org_id, actor_person_id: w.dave, step: "identity", status: "vibing"}));
}

async function _testHealth(w) {
    LOG.console("\n setup health decays\n");
    // a person who is not employed yet signs in with an incomplete assertion —
    // the account is flagged and no employment is invented
    const flaggedEmail = `flagged.${w.stamp}@example.invalid`;
    w.flaggedEmail = flaggedEmail;
    await spine.createPersonAsync({display_name: "Flagged", email: flaggedEmail});
    await identity.provisionFromAssertionAsync({tokenflag: true, id: flaggedEmail, org: w.org_id,
        employment_status: "active", start_date: "2026-01-01", contract_type: "employee"});
    const status = await setup.setupStatusAsync(w.org_id);
    _check("unmapped IdP attributes surface on the health panel",
        status.health.some(item => item.item == "unmapped_attributes" &&
            item.persons.some(person => person.email == flaggedEmail)));
    _check("people with no confirmed window are named",
        status.health.some(item => item.item == "windows_unconfirmed" && item.persons.length > 0));
}

async function _testImportPeople(w) {
    LOG.console("\n people imports preview before they write\n");
    const rows = [
        {email: `imported.${w.stamp}@example.invalid`, display_name: "Imported One",
            start_date: "2026-01-01", jurisdiction: "GB", contract_type: "employee",
            manager_email: "unknown.manager@example.invalid"},
        {email: "", display_name: "No Email", start_date: "2026-01-01",
            jurisdiction: "GB", contract_type: "employee"},
        {email: `imported.${w.stamp}@example.invalid`, display_name: "Duplicate In File",
            start_date: "2026-01-01", jurisdiction: "GB", contract_type: "employee"},
        {email: w.daveEmail, display_name: "Existing Dave", start_date: "2026-01-01",
            jurisdiction: "GB", contract_type: "employee"},
        {email: `imported2.${w.stamp}@example.invalid`, display_name: "Imported Two",
            start_date: "2026-01-01", jurisdiction: "GB", contract_type: "employee",
            manager_email: w.daveEmail}
    ];
    w.importRows = rows;

    const preview = await setup.importPeopleAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows, source: "csv", commit: false});
    _check("the preview passes the clean rows", preview.ok_rows == 2, `${preview.ok_rows}`);
    _check("the preview lists every failure with its row",
        preview.failures.length == 3 && preview.failures.every(failure => failure.row));
    _check("a duplicate email is a decision, not a guess",
        preview.failures.some(failure => /existing person/.test(failure.reason)));
    _check("the preview names downstream consequences",
        preview.warnings.some(warning => /leave policy/.test(warning.reason)));
    _check("the preview names an absent manager",
        preview.warnings.some(warning => /unassigned/.test(warning.reason)));
    _check("a preview writes nothing",
        (await spine.getPersonByEmailAsync(rows[0].email)) === null);

    const committed = await setup.importPeopleAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows, source: "csv", commit: true});
    w.peopleBatchId = committed.batch_id;
    _check("a commit imports the rows that passed and keeps the failures listed",
        committed.ok_rows == 2 && committed.failures.length == 3 && committed.status == "committed");

    const imported = await spine.getPersonByEmailAsync(rows[0].email);
    _check("the imported person exists with provenance",
        imported.source == "csv" && imported.imported_at > 0 && imported.import_batch_id == committed.batch_id);
    const importedEmployment = await spine.getOpenEmploymentAsync(w.org_id, imported.person_id);
    _check("the employment carries its own provenance and batch",
        importedEmployment.source == "csv" && importedEmployment.import_batch_id == committed.batch_id);
    const managed = await spine.getPersonByEmailAsync(rows[4].email);
    const managedEmployment = await spine.getOpenEmploymentAsync(w.org_id, managed.person_id);
    _check("a manager present in the system resolves to their person",
        managedEmployment.manager_person_id == w.dave);
    const orphan = await spine.getOpenEmploymentAsync(w.org_id, imported.person_id);
    _check("an absent manager imports unassigned, flagged",
        orphan.manager_person_id === null &&
        committed.warnings.some(warning => /unassigned/.test(warning.reason)));
    _check("the commit is audited",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM audit_event WHERE org_id=? AND action='people.imported' AND object_ref=?",
            [w.org_id, committed.batch_id])).length == 1);

    const rerun = await setup.importPeopleAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows, source: "csv", commit: true});
    _check("re-running imports only what is new",
        rerun.ok_rows == 0 && rerun.failures.some(failure => /existing person/.test(failure.reason)));

    const refused = await _checkThrows("a person without people.import is refused", _ =>
        setup.importPeopleAsync({org_id: w.org_id, actor_person_id: w.erin, rows, commit: false}));
    _check("the refusal carries the decision", Boolean(refused?.decision));
}

async function _testBalances(w) {
    LOG.console("\n opening balances are ledger entries, never a stored balance\n");
    const imported = await spine.getPersonByEmailAsync(w.importRows[0].email);
    const rows = [
        {email: imported.email, leave_type: "annual", days: 9},
        {email: "ghost@example.invalid", leave_type: "annual", days: 3},
        {email: imported.email, leave_type: "annual", days: 0}
    ];

    const preview = await setup.importBalancesAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows, source: "bamboohr", cutover_date: "2026-08-01", commit: false});
    _check("the balance preview passes only valid rows", preview.ok_rows == 1 && preview.failures.length == 2);
    _check("a balance preview writes nothing",
        (await dblayer.getQueryOrThrow("SELECT * FROM opening_balance_entry WHERE org_id=?", [w.org_id])).length == 0);

    const committed = await setup.importBalancesAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows, source: "bamboohr", cutover_date: "2026-08-01", commit: true});
    w.balanceBatchId = committed.batch_id;
    const entries = await dblayer.getQueryOrThrow(
        "SELECT * FROM opening_balance_entry WHERE import_batch_id=?", [committed.batch_id]);
    _check("the opening balance is one dated assertion per bucket",
        entries.length == 1 && entries[0].cutover_date == "2026-08-01" &&
        entries[0].source == "bamboohr" && entries[0].days == 9);
    _check("the assertion is labelled as what it is",
        /assertion/.test(entityshapes.shapeOf("opening_balance_entry").note));
    _check("opening balances have no in-place update path",
        (_ => {try {entityshapes.assertUpdatable("opening_balance_entry"); return false;} catch (err) {return true;}})());
    _check("the balance import is audited",
        (await dblayer.getQueryOrThrow(
            "SELECT * FROM audit_event WHERE org_id=? AND action='balances.imported'",
            [w.org_id])).length == 1);
    await _checkThrows("a cutover that is not a date is refused", _ =>
        setup.importBalancesAsync({org_id: w.org_id, actor_person_id: w.dave, rows: [],
            cutover_date: "sometime soon", commit: false}));
}

async function _testRollback(w) {
    LOG.console("\n imports are batches, reversible for 24 hours\n");
    await setup.rollbackImportAsync({org_id: w.org_id, actor_person_id: w.dave,
        import_batch_id: w.balanceBatchId});
    _check("a balance batch rolls back whole",
        (await dblayer.getQueryOrThrow("SELECT * FROM opening_balance_entry WHERE import_batch_id=?",
            [w.balanceBatchId])).length == 0);
    _check("the batch records its rollback",
        (await dblayer.getQueryOrThrow("SELECT * FROM import_batch WHERE import_batch_id=?",
            [w.balanceBatchId]))[0].status == "rolled_back");
    await _checkThrows("a rolled-back batch cannot roll back twice", _ =>
        setup.rollbackImportAsync({org_id: w.org_id, actor_person_id: w.dave,
            import_batch_id: w.balanceBatchId}));

    // nothing real may be built on imported people — then rollback stops being offered
    const clockBatch = await setup.importPeopleAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows: [{email: `clock.${w.stamp}@example.invalid`, display_name: "Clocked In",
            start_date: "2026-01-01", jurisdiction: "GB", contract_type: "employee"}],
        source: "csv", commit: true});
    const clocked = await spine.getPersonByEmailAsync(`clock.${w.stamp}@example.invalid`);
    await time.recordEventAsync({org_id: w.org_id, person_id: clocked.person_id,
        entry_date: new Date().toISOString().substring(0, 10), client_event_id: "clock-1",
        duration_seconds: 600, source: "timer"});
    const used = await _checkThrows("rollback refuses once time is recorded against the import", _ =>
        setup.rollbackImportAsync({org_id: w.org_id, actor_person_id: w.dave,
            import_batch_id: clockBatch.batch_id}));
    _check("the refusal says plainly why", /real records/.test(used.message));

    // a fresh batch rolls back cleanly while nothing is built on it
    const cleanBatch = await setup.importPeopleAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows: [{email: `clean.${w.stamp}@example.invalid`, display_name: "Clean",
            start_date: "2026-01-01", jurisdiction: "GB", contract_type: "employee"}],
        source: "csv", commit: true});
    await setup.rollbackImportAsync({org_id: w.org_id, actor_person_id: w.dave,
        import_batch_id: cleanBatch.batch_id});
    _check("an unbuilt-on batch rolls back cleanly",
        (await spine.getPersonByEmailAsync(`clean.${w.stamp}@example.invalid`)) === null);

    // after 24 hours the window closes
    const staleBatch = await setup.importPeopleAsync({org_id: w.org_id, actor_person_id: w.dave,
        rows: [{email: `stale.${w.stamp}@example.invalid`, display_name: "Stale",
            start_date: "2026-01-01", jurisdiction: "GB", contract_type: "employee"}],
        source: "csv", commit: true});
    await dblayer.runCmdBestEffortAsync("UPDATE import_batch SET committed_at=committed_at-90000 WHERE import_batch_id=?",
        [staleBatch.batch_id]);
    const stale = await _checkThrows("the 24-hour window closes plainly", _ =>
        setup.rollbackImportAsync({org_id: w.org_id, actor_person_id: w.dave,
            import_batch_id: staleBatch.batch_id}));
    _check("the closed window says the window closed", /24-hour/.test(stale.message));
}

async function _testMetricsAndAPI(w) {
    LOG.console("\n the metric and the API\n");
    const status = await setup.setupStatusAsync(w.org_id);
    _check("the first clock-in sets the governing metric",
        Number.isInteger(status.metrics.time_to_first_clock_in_seconds) &&
        status.metrics.time_to_first_clock_in_seconds >= 0,
        `${status.metrics.time_to_first_clock_in_seconds}`);

    const viaAPI = await setupapi.doService({op: "status", id: w.daveEmail, org: w.org_id});
    _check("op status answers true with the steps", viaAPI.result === true && Array.isArray(viaAPI.steps));

    const preview = await setupapi.doService({op: "import_people", id: w.daveEmail, org: w.org_id,
        rows: [{email: `api.${w.stamp}@example.invalid`, display_name: "API Person",
            start_date: "2026-01-01", jurisdiction: "GB", contract_type: "employee"}]});
    _check("op import_people previews without a commit flag", preview.result === true && preview.ok_rows == 1 &&
        (await spine.getPersonByEmailAsync(`api.${w.stamp}@example.invalid`)) === null);

    const refused = await setupapi.doService({op: "import_people", id: w.erinEmail, org: w.org_id, rows: []});
    _check("an import through the API without the capability is refused",
        refused.result === false && refused.decision == "no_grant");
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Setup test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["dave", "erin", "alice"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "GB",
        contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin",
        {granted_by: "system", valid_from: "2026-01-01"});

    return {org_id: org.org_id, stamp, daveEmail: `dave.${stamp}@example.invalid`,
        erinEmail: `erin.${stamp}@example.invalid`, aliceEmail: `alice.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM opening_balance_entry WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM import_batch WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org_setup_step WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["dave", "erin", "alice"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
    for (const email of [`imported.${w.stamp}@example.invalid`, `imported2.${w.stamp}@example.invalid`,
        `clock.${w.stamp}@example.invalid`, `stale.${w.stamp}@example.invalid`,
        `flagged.${w.stamp}@example.invalid`, `api.${w.stamp}@example.invalid`])
        await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE email=?", [email]);
}
