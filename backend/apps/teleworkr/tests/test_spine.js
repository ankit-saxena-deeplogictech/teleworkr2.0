/**
 * Tests the A6 spine — the migration runner, and the effective-dated reads that
 * the rest of the product depends on.
 *
 * The questions under test are the ones A6 says become unanswerable if employment
 * is stored as fields on a person: what was their jurisdiction in March, who was
 * their approver then, and does the record still say so after they have moved.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests spine
 *
 * (C) 2026 Tekmonks. All rights reserved.
 */

const os = require("os");
const fs = require("fs");
const path = require("path");

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const migrations = require(`${TELEWORKR_CONSTANTS.LIBDIR}/migrations.js`);
const entityshapes = require(`${TELEWORKR_CONSTANTS.LIBDIR}/entityshapes.js`);

let passed = 0, failed = 0;

const _check = (label, condition) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}\n`); LOG.error(`Spine test failed: ${label}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false);}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 90)}`, true);}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "spine")) {
        LOG.console("Skipping spine test case, not called.\n"); return true;
    }
    LOG.console("\nA6 spine\n");

    await _testMigrations();
    await _testSpine();

    LOG.console(`\nSpine tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _testMigrations() {
    LOG.console("\n migration runner\n");
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "twspine-"));
    const dbpath = path.join(tmpdir, "migrate_test.db");
    const migdir = path.join(tmpdir, "migrations");
    fs.mkdirSync(migdir);
    fs.writeFileSync(path.join(migdir, "001_first.sql"),
        "-- a comment with an apostrophe: don't split here\nCREATE TABLE widget (id varchar not null primary key, label varchar default 'none');");

    const testdb = require(`${CONSTANTS.LIBDIR}/db.js`).getDBDriver("sqlite", dbpath, []);
    await testdb.init();

    const first = await migrations.migrateAsync(testdb, migdir);
    _check("applies a pending migration", first.applied.length == 1 && first.skipped == 0);

    _check("the migrated table exists",
        (await testdb.getQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='widget'", [])).length == 1);

    const second = await migrations.migrateAsync(testdb, migdir);
    _check("re-running applies nothing", second.applied.length == 0 && second.skipped == 1);

    fs.writeFileSync(path.join(migdir, "002_second.sql"), "ALTER TABLE widget ADD COLUMN note varchar;");
    const third = await migrations.migrateAsync(testdb, migdir);
    _check("a new migration is picked up and ALTER runs", third.applied.length == 1 && third.skipped == 1);

    fs.writeFileSync(path.join(migdir, "001_first.sql"), "CREATE TABLE widget (id varchar not null primary key);");
    await _checkThrows("editing an applied migration is refused", _ => migrations.migrateAsync(testdb, migdir));

    fs.writeFileSync(path.join(migdir, "001_first.sql"),
        "-- a comment with an apostrophe: don't split here\nCREATE TABLE widget (id varchar not null primary key, label varchar default 'none');");
    fs.writeFileSync(path.join(migdir, "003_bad.sql"), "CREATE TABLE ok_one (id varchar);\nTHIS IS NOT SQL;");
    await _checkThrows("a failing migration rolls back", _ => migrations.migrateAsync(testdb, migdir));
    _check("the rolled-back migration left no table behind",
        (await testdb.getQuery("SELECT name FROM sqlite_master WHERE type='table' AND name='ok_one'", [])).length == 0);
    _check("the rolled-back migration was not recorded as applied",
        (await testdb.getQuery("SELECT filename FROM schema_migration WHERE filename='003_bad.sql'", [])).length == 0);

    fs.rmSync(tmpdir, {recursive: true, force: true});
}

async function _testSpine() {
    LOG.console("\n effective-dated employment\n");
    const org = await spine.createOrgAsync({name: `Spine test ${Date.now()}`, home_jurisdiction: "GB"});
    const stamp = Date.now();
    const person = await spine.createPersonAsync(
        {display_name: "Dewar M.", email: `spinetest.${stamp}@example.invalid`, home_timezone: "Europe/London"});

    try {
        await spine.recordEmploymentAsync({org_id: org.org_id, person_id: person.person_id, status: "active",
            jurisdiction: "GB", manager_person_id: "mgr-a", contract_type: "employee",
            valid_from: "2026-01-01", source: "idp"});

        const beforeMove = await spine.employmentAsOfAsync(org.org_id, person.person_id, "2026-03-15");
        _check("jurisdiction in March reads GB", beforeMove.jurisdiction == "GB");

        // they relocate and change manager in April
        await spine.recordEmploymentAsync({org_id: org.org_id, person_id: person.person_id, status: "active",
            jurisdiction: "IN", manager_person_id: "mgr-b", contract_type: "employee",
            valid_from: "2026-04-01", source: "idp"});

        _check("jurisdiction in March still reads GB after the move",
            (await spine.jurisdictionAsOfAsync(org.org_id, person.person_id, "2026-03-15")) == "GB");
        _check("jurisdiction in May reads IN",
            (await spine.jurisdictionAsOfAsync(org.org_id, person.person_id, "2026-05-15")) == "IN");
        _check("the March approver is still answerable in May",
            (await spine.managerAsOfAsync(org.org_id, person.person_id, "2026-03-15")) == "mgr-a");
        _check("the current approver is the new one",
            (await spine.managerAsOfAsync(org.org_id, person.person_id, "2026-05-15")) == "mgr-b");

        const history = await spine.employmentHistoryAsync(org.org_id, person.person_id);
        _check("both periods are retained", history.length == 2);
        _check("the superseded period was closed where the next began",
            history[0].valid_to == "2026-04-01" && history[1].valid_to === null);

        _check("a date before any employment resolves to nothing",
            (await spine.employmentAsOfAsync(org.org_id, person.person_id, "2025-06-01")) === null);

        _check("direct reports are evaluated as of a date",
            (await spine.directReportsAsOfAsync(org.org_id, "mgr-a", "2026-03-15")).length == 1 &&
            (await spine.directReportsAsOfAsync(org.org_id, "mgr-a", "2026-05-15")).length == 0);

        await _checkThrows("a period behind the open one is refused", _ =>
            spine.recordEmploymentAsync({org_id: org.org_id, person_id: person.person_id, status: "active",
                jurisdiction: "GB", contract_type: "employee", valid_from: "2026-02-01", source: "manual"}));

        await _checkThrows("a non-ISO valid_from is refused", _ =>
            spine.recordEmploymentAsync({org_id: org.org_id, person_id: person.person_id, status: "active",
                jurisdiction: "GB", contract_type: "employee", valid_from: "01/06/2026", source: "manual"}));

        // the global-person decision: one human, two orgs
        LOG.console("\n global person, org-scoped employment\n");
        const org2 = await spine.createOrgAsync({name: `Spine test client ${stamp}`, home_jurisdiction: "IN"});
        await spine.recordEmploymentAsync({org_id: org2.org_id, person_id: person.person_id, status: "active",
            jurisdiction: "IN", contract_type: "contractor", valid_from: "2026-02-01", source: "manual"});
        const bothOrgs = await spine.orgsForPersonAsOfAsync(person.person_id, "2026-05-15");
        _check("one person holds employment in two orgs", bothOrgs.length == 2);
        _check("the two employments carry different contract types",
            bothOrgs.filter(e => e.contract_type == "contractor").length == 1 &&
            bothOrgs.filter(e => e.contract_type == "employee").length == 1);

        LOG.console("\n A6 write guards\n");
        _check("every spine table has declared its shape and erasure behaviour",
            ["org", "person", "employment", "capability_grant", "audit_event"]
                .every(e => entityshapes.shapeOf(e)?.shape && entityshapes.shapeOf(e)?.erasure));
        for (const [entity, why] of [["time_entry_event", "append-only"], ["employment", "effective-dated"],
            ["leave_policy_version", "versioned"]])
            _check(`${entity} refuses an in-place update (${why})`,
                (_ => {try {entityshapes.assertUpdatable(entity); return false;} catch (err) {return true;}})());
        _check("an undeclared entity is refused rather than assumed",
            (_ => {try {entityshapes.assertUpdatable("invented_table"); return false;} catch (err) {return true;}})());
        _check("leave_balance is projected, never stored", entityshapes.isProjectedOnly("leave_balance"));

        await _cleanup([org.org_id, org2.org_id], person.person_id);
    } catch (err) {
        failed++; LOG.console(`  FAIL  spine tests threw: ${err}\n`); LOG.error(`Spine tests threw: ${err}`);
        await _cleanup([org.org_id], person.person_id);
    }
}

async function _cleanup(orgIds, person_id) {
    for (const org_id of orgIds) {
        await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [org_id]);
        await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [org_id]);
    }
    await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [person_id]);
}
