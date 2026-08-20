/**
 * Tests H4 — the audit log write path, the A8 atomicity contract, the hash
 * chain, and the read levels. Plus the dblayer serial queue that makes the
 * whole thing hold: the Monkshu SQLite driver shares one connection per
 * database per process, and without the queue a concurrent query can interleave
 * inside an open transaction — the exact corruption hit in increment 2.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests audit
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const entityshapes = require(`${TELEWORKR_CONSTANTS.LIBDIR}/entityshapes.js`);

const {SCOPES} = capabilities;
const SCRATCH = "audit_test_scratch";
const BASE = 1750000000;    // occurred_at values for the seeded read tests

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Audit test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn, onError) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "audit")) {
        LOG.console("Skipping audit test case, not called.\n"); return true;
    }
    LOG.console("\nH4 audit + the serial queue\n");

    await dblayer.readyAsync();
    await dblayer.runCmdOrThrow(`CREATE TABLE IF NOT EXISTS ${SCRATCH} (id varchar not null primary key, note varchar)`, []);

    const worlds = {main: null, read: null};
    try {
        await _testTransactionIsolation();
        worlds.main = await _buildWorld();
        await _testWriteAndChain(worlds.main);
        await _testPerform(worlds.main);
        worlds.read = await _buildReadWorld(worlds.main);
        await _testReadLevels(worlds.read);
        await _testCoverage();
    } catch (err) {
        failed++; LOG.console(`  FAIL  audit tests threw: ${err}\n`); LOG.error(`Audit tests threw: ${err.stack}`);
    } finally {
        if (worlds.read) await _cleanup(worlds.read.org_id);
        if (worlds.main) await _cleanup(worlds.main.org_id);
        if (worlds.main) for (const who of ["alice", "bob", "carol", "dave", "erin"])
            if (worlds.main[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [worlds.main[who]]);
        await dblayer.runCmdBestEffortAsync(`DROP TABLE IF EXISTS ${SCRATCH}`, []);
    }

    LOG.console(`\nAudit tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------
// the serial queue
// ---------------------------------------------------------------------------

async function _testTransactionIsolation() {
    LOG.console("\n transactions are atomic by construction\n");
    await dblayer.runCmdOrThrow(`DELETE FROM ${SCRATCH}`, []);

    let started; const startedP = new Promise(resolve => started = resolve);
    const txPromise = dblayer.runInTransactionAsync(async exec => {
        await exec.runCmd(`INSERT INTO ${SCRATCH} (id, note) VALUES (?,?)`, ["tx-1", "first"]);
        started();
        await new Promise(resolve => setTimeout(resolve, 250));     // hold the transaction open
        await exec.runCmd(`INSERT INTO ${SCRATCH} (id, note) VALUES (?,?)`, ["tx-2", "second"]);
        return "committed";
    });
    await startedP;

    let settled = false;
    const queryPromise = dblayer.getQueryOrThrow(`SELECT COUNT(*) AS c FROM ${SCRATCH}`, [])
        .then(rows => {settled = true; return rows;});
    await new Promise(resolve => setTimeout(resolve, 80));
    _check("a query issued while a transaction is in flight waits for it", !settled);

    const rows = await queryPromise;
    _check("and then reads the committed state", rows[0].c == 2, `saw ${rows[0].c}`);
    _check("the transaction returned its result", await txPromise == "committed");

    await dblayer.runCmdOrThrow(`DELETE FROM ${SCRATCH}`, []);
    await _checkThrows("a transaction that throws rolls back", _ => dblayer.runInTransactionAsync(async exec => {
        await exec.runCmd(`INSERT INTO ${SCRATCH} (id, note) VALUES (?,?)`, ["rx-1", "x"]);
        throw new Error("deliberate failure");
    }));
    _check("its inserts left no residue",
        (await dblayer.getQueryOrThrow(`SELECT COUNT(*) AS c FROM ${SCRATCH}`, []))[0].c == 0);
    _check("the queue keeps serving after a failed transaction",
        (await dblayer.getQueryOrThrow(`SELECT COUNT(*) AS c FROM ${SCRATCH}`, []))[0].c == 0);

    await _checkThrows("a statement failing inside a transaction leaves no partial rows", _ =>
        dblayer.runTransactionOrThrow([
            {cmd: `INSERT INTO ${SCRATCH} (id, note) VALUES (?,?)`, params: ["rq-1", "x"]},
            {cmd: "THIS IS NOT SQL", params: []}]));
    _check("no partial row survived the failed runTransactionOrThrow",
        (await dblayer.getQueryOrThrow(`SELECT COUNT(*) AS c FROM ${SCRATCH}`, []))[0].c == 0);
    await dblayer.runCmdOrThrow(`DELETE FROM ${SCRATCH}`, []);
}

// ---------------------------------------------------------------------------
// the write path and the chain
// ---------------------------------------------------------------------------

async function _testWriteAndChain(w) {
    LOG.console("\n the write path\n");

    await _checkThrows("an action not in A10 object.action naming is refused", _ =>
        audit.writeAsync({org_id: w.org_id, action: "Not A Proper Name!", object_type: "thing", actor_person_id: w.alice}));
    await _checkThrows("an entry with no object_type is refused", _ =>
        audit.writeAsync({org_id: w.org_id, action: "thing.done", actor_person_id: w.alice}));
    await _checkThrows("a person actor without an actor_person_id is refused", _ =>
        audit.writeAsync({org_id: w.org_id, action: "thing.done", object_type: "thing", actor_kind: "person"}));
    await _checkThrows("an unknown actor kind is refused", _ =>
        audit.writeAsync({org_id: w.org_id, action: "thing.done", object_type: "thing", actor_kind: "robot"}));

    const circular = {}; circular.self = circular;
    await _checkThrows("detail that cannot be serialised is refused", _ =>
        audit.writeAsync({org_id: w.org_id, action: "thing.done", object_type: "thing", actor_person_id: w.alice, detail: circular}));

    const pinned = await audit.writeAsync({org_id: w.org_id, action: "timesheet.approved",
        object_type: "timesheet", object_ref: "W24", actor_person_id: w.bob, subject_person_id: w.alice,
        detail: {total: "39:30"}, occurred_at: BASE+1});
    const effective = JSON.parse(pinned.effective_permissions);
    _check("an entry pins the actor's effective permission set",
        effective.some(g => g.capability == "timesheet.approve") && effective.some(g => g.capability == "audit.read_own"));
    _check("the pinned set is stably ordered",
        JSON.stringify(effective.map(g => `${g.capability}${g.scope_type}${g.scope_ref||""}`)) ==
        JSON.stringify([...effective].map(g => `${g.capability}${g.scope_type}${g.scope_ref||""}`).sort()));

    const feb29 = Math.floor(new Date("2024-02-29T12:00:00Z").getTime()/1000);
    const leap = await audit.writeAsync({org_id: w.org_id, action: "session.new_device_signed_in",
        object_type: "session", actor_person_id: w.alice, occurred_at: feb29});
    _check("retention is seven years from the event, leap-safe",
        leap.retention_until == "2031-02-28", leap.retention_until);

    const sys = await audit.writeAsync({org_id: w.org_id, action: "integration.connected",
        object_type: "integration", object_ref: "payroll", actor_kind: "system"});
    _check("a system actor needs no person and pins an empty set",
        sys.actor_kind == "system" && JSON.parse(sys.effective_permissions).length == 0);

    _check("the audit entity has no in-place update path",
        (_ => {try {entityshapes.assertUpdatable("audit_event"); return false;} catch (err) {return true;}})());

    LOG.console("\n the hash chain\n");
    _check("the chain verifies after several writes",
        (await audit.verifyIntegrityAsync(w.org_id)).ok);
    await dblayer.runCmdBestEffortAsync("UPDATE audit_event SET reason=? WHERE audit_id=?", ["tampered", pinned.audit_id]);
    const broken = await audit.verifyIntegrityAsync(w.org_id);
    _check("an entry edited in place breaks the chain at exactly that entry",
        !broken.ok && broken.broken_at == pinned.audit_id, JSON.stringify(broken.why||broken));
}

// ---------------------------------------------------------------------------
// performAsync — the A8 contract
// ---------------------------------------------------------------------------

async function _testPerform(w) {
    LOG.console("\n performAsync — permission, reason, step-up, pre-check, one transaction\n");

    const auditCount = async _ => (await dblayer.getQueryOrThrow("SELECT COUNT(*) AS c FROM audit_event WHERE org_id=?", [w.org_id]))[0].c;

    const grantSpec = {org_id: w.org_id, actor_person_id: w.dave, capability: "capability.grant",
        subject_person_id: w.bob, reason: "covering Priya",
        audit: {action: "capability.granted", object_type: "capability", object_ref: "leave.approve"}};
    const result = await audit.performAsync({...grantSpec, action: async exec => {
        await exec.runCmd(`INSERT INTO ${SCRATCH} (id, note) VALUES (?,?)`, ["grant-ok", "x"]);
        return "granted";
    }});
    _check("an allowed sensitive action runs, logs, and returns its result", result == "granted");
    const row = (await audit.queryAsync({org_id: w.org_id, actor_person_id: w.dave, action: "capability.granted"}))[0];
    _check("the entry records actor, subject and reason",
        row.actor_person_id == w.dave && row.subject_person_id == w.bob && row.reason == "covering Priya");
    _check("the entry pins the actor's grants at the moment of the action",
        JSON.parse(row.effective_permissions).some(g => g.capability == "capability.grant"));

    // A8: if the audit write fails, the action fails — same transaction.
    await audit.writeAsync({org_id: w.org_id, action: "thing.done", object_type: "thing",
        audit_id: "fixed-id-123", actor_person_id: w.dave, occurred_at: BASE+10});
    const before = await auditCount();
    await _checkThrows("a failed audit write fails the action", _ => audit.performAsync({...grantSpec,
        audit: {...grantSpec.audit, audit_id: "fixed-id-123"},
        action: async exec => {await exec.runCmd(`INSERT INTO ${SCRATCH} (id, note) VALUES (?,?)`, ["must-rollback", "x"]);}}));
    _check("the action's own write was rolled back with it",
        (await dblayer.getQueryOrThrow(`SELECT COUNT(*) AS c FROM ${SCRATCH} WHERE id='must-rollback'`, []))[0].c == 0);
    _check("no audit entry was added by the failed pair", (await auditCount()) == before);

    // refusal before anything runs
    const refused = await _checkThrows("a caller without the capability is refused", _ =>
        audit.performAsync({org_id: w.org_id, actor_person_id: w.alice, capability: "capability.grant",
            subject_person_id: w.bob, reason: "x", audit: grantSpec.audit,
            action: async _ => {}}));
    _check("the refusal carries the permission decision", refused?.decision?.outcome == "no_grant", refused?.decision?.outcome);

    await _checkThrows("a capability whose actions require a reason refuses without one", _ =>
        audit.performAsync({org_id: w.org_id, actor_person_id: w.dave, capability: "capability.grant",
            subject_person_id: w.bob, audit: grantSpec.audit, action: async _ => {}}));
    await _checkThrows("an always-audited capability refuses a call site with no audit entry", _ =>
        audit.performAsync({org_id: w.org_id, actor_person_id: w.dave, capability: "capability.grant",
            subject_person_id: w.bob, reason: "x", action: async _ => {}}));

    await _checkThrows("a step-up capability refuses without step-up proof", _ =>
        audit.performAsync({org_id: w.org_id, actor_person_id: w.carol, capability: "leave_policy.publish",
            audit: {action: "leave_policy.published", object_type: "leave_policy", object_ref: "v4"},
            action: async _ => {}}));
    _check("with step-up proof it proceeds", (await audit.performAsync({
        org_id: w.org_id, actor_person_id: w.carol, capability: "leave_policy.publish", step_up_verified: true,
        audit: {action: "leave_policy.published", object_type: "leave_policy", object_ref: "v4"},
        action: async _ => "published"})) == "published");

    await _checkThrows("an irreversible action with no pre-check refuses", _ =>
        audit.performAsync({org_id: w.org_id, actor_person_id: w.dave, capability: "wiki.publish_public",
            step_up_verified: true, audit: {action: "wiki.published", object_type: "page", object_ref: "P-1"},
            action: async _ => {}}));
    await _checkThrows("an irreversible action with a failing pre-check refuses", _ =>
        audit.performAsync({org_id: w.org_id, actor_person_id: w.dave, capability: "wiki.publish_public",
            step_up_verified: true, precheck: async _ => false,
            audit: {action: "wiki.published", object_type: "page", object_ref: "P-1"}, action: async _ => {}}));
    await _checkThrows("an irreversible action refuses when its pre-check is down", _ =>
        audit.performAsync({org_id: w.org_id, actor_person_id: w.dave, capability: "wiki.publish_public",
            step_up_verified: true, precheck: async _ => {throw new Error("scanner down");},
            audit: {action: "wiki.published", object_type: "page", object_ref: "P-1"}, action: async _ => {}}));
    const published = await audit.performAsync({org_id: w.org_id, actor_person_id: w.dave,
        capability: "wiki.publish_public", step_up_verified: true, precheck: async _ => true,
        audit: {action: "wiki.published", object_type: "page", object_ref: "P-1"},
        action: async exec => {await exec.runCmd(`INSERT INTO ${SCRATCH} (id, note) VALUES (?,?)`, ["wiki-ok", "x"]); return "live";}});
    _check("with a passing pre-check the irreversible action proceeds", published == "live");

    // an approval is a signature, with the totals as they stood
    await audit.performAsync({org_id: w.org_id, actor_person_id: w.bob, capability: "timesheet.approve",
        subject_person_id: w.alice, audit: {action: "timesheet.approved", object_type: "timesheet",
            object_ref: "W24", detail: {total: "39:30"}},
        action: async _ => "approved"});
    const approval = (await audit.queryAsync({org_id: w.org_id, actor_person_id: w.dave, action: "timesheet.approved"}))[0];
    _check("an approval entry carries the snapshot it approved", approval.detail == JSON.stringify({total: "39:30"}));

    // separation of duties names itself through the wrapper
    const sod = await _checkThrows("self-approval is blocked, naming the rule", _ =>
        audit.performAsync({org_id: w.org_id, actor_person_id: w.bob, capability: "timesheet.approve",
            subject_person_id: w.bob, audit: {action: "timesheet.approved", object_type: "timesheet", object_ref: "W24"},
            action: async _ => {}}));
    _check("the block names the rule that fired", sod?.decision?.rule == "sod.self_approval", sod?.decision?.rule);

    // HR's correction power: edit someone else's time entry, with reason, always audited
    await audit.performAsync({org_id: w.org_id, actor_person_id: w.carol, capability: "time_entry.edit_other",
        subject_person_id: w.alice, reason: "added the fold work I forgot to time",
        audit: {action: "time_entry.edited", object_type: "time_entry", object_ref: "TASK-1042",
            detail: {from: "2:30", to: "3:20"}},
        action: async _ => "edited"});
    const edit = (await audit.queryAsync({org_id: w.org_id, actor_person_id: w.dave, action: "time_entry.edited"}))[0];
    _check("a correction records its reason and the before and after",
        edit.reason == "added the fold work I forgot to time" && edit.detail == JSON.stringify({from: "2:30", to: "3:20"}));
}

// ---------------------------------------------------------------------------
// the read levels
// ---------------------------------------------------------------------------

async function _testReadLevels(w) {
    LOG.console("\n who can read it\n");

    // seed six entries in a dedicated org so the assertions below are exact
    const seed = [
        {action: "timesheet.approved", object_type: "timesheet", object_ref: "W24", actor: w.bob, subject: w.alice, at: BASE+1},
        {action: "session.new_device_signed_in", object_type: "session", actor: w.alice, subject: null, at: BASE+2},
        {action: "role.assigned", object_type: "role", object_ref: "lead", actor: w.dave, subject: w.carol, at: BASE+3},
        {action: "leave_policy.published", object_type: "leave_policy", object_ref: "v4", actor: w.carol, subject: null, at: BASE+4},
        {action: "timesheet.exported", object_type: "timesheet", object_ref: "Q2", actor: w.dave, subject: w.bob, at: BASE+5},
        {action: "time_entry.edited", object_type: "time_entry", object_ref: "TASK-1042", actor: w.carol, subject: w.alice, at: BASE+6}
    ];
    for (const e of seed) await audit.writeAsync({org_id: w.org_id, action: e.action, object_type: e.object_type,
        object_ref: e.object_ref, actor_person_id: e.actor, subject_person_id: e.subject, occurred_at: e.at});

    const asAlice = await audit.queryAsync({org_id: w.org_id, actor_person_id: w.alice});
    _check("a person reads the entries about themselves, including their own sign-ins",
        asAlice.length == 3 && asAlice.every(r => r.subject_person_id == w.alice || r.actor_person_id == w.alice),
        `${asAlice.length} row(s)`);
    _check("and nothing about anyone else",
        !asAlice.some(r => r.subject_person_id && r.subject_person_id != w.alice));

    const refused = await _checkThrows("a caller with no read capability is refused rather than emptied", _ =>
        audit.queryAsync({org_id: w.org_id, actor_person_id: w.erin}));
    _check("the refusal carries the decision and names nobody-can",
        Boolean(refused?.decision?.who_can), refused?.decision?.who_can);

    const asHr = await audit.queryAsync({org_id: w.org_id, actor_person_id: w.carol});
    _check("HR sees compliance and policy entries",
        asHr.length == 3 && asHr.every(r => audit.HR_VISIBLE(r.action)),
        `${asHr.length} row(s): ${asHr.map(r => r.action).join(", ")}`);
    _check("and not the permission and access entries",
        !asHr.some(r => r.action == "role.assigned" || r.action == "session.new_device_signed_in"));

    const asAdmin = await audit.queryAsync({org_id: w.org_id, actor_person_id: w.dave});
    _check("an org admin sees everything", asAdmin.length == 6, `${asAdmin.length} row(s)`);
    _check("newest first", asAdmin[0].action == "time_entry.edited" && asAdmin[5].action == "timesheet.approved");
    _check("filters narrow by window",
        (await audit.queryAsync({org_id: w.org_id, actor_person_id: w.dave, from: BASE+3, to: BASE+5})).length == 3);
    _check("and by object type",
        (await audit.queryAsync({org_id: w.org_id, actor_person_id: w.dave, object_type: "timesheet"})).length == 2);
    _check("limit caps the result", (await audit.queryAsync({org_id: w.org_id, actor_person_id: w.dave, limit: 2})).length == 2);

    // deny beats allow on the read path too, and the fallback never widens
    const deny = await permissions.grantAsync({org_id: w.org_id, person_id: w.dave,
        capability: "audit.read_all", scope_type: SCOPES.ORG, effect: "deny",
        granted_by: w.carol, reason: "read access suspended", valid_from: "2026-01-01"});
    const narrowed = await audit.queryAsync({org_id: w.org_id, actor_person_id: w.dave});
    _check("a deny on read_all narrows an admin to their own entries only",
        narrowed.length == 0 || narrowed.every(r => r.subject_person_id == w.dave || r.actor_person_id == w.dave),
        `${narrowed.length} row(s)`);
    await permissions.revokeAsync(deny.grant_id);
    _check("revoking the deny restores the full read",
        (await audit.queryAsync({org_id: w.org_id, actor_person_id: w.dave})).length == 6);
}

// ---------------------------------------------------------------------------
// the published list
// ---------------------------------------------------------------------------

async function _testCoverage() {
    LOG.console("\n the published logged-event list\n");
    const coverage = audit.coverage();
    _check("every always-audited capability is in the published list",
        ["capability.grant", "timesheet.approve", "wiki.publish_public"].every(c =>
            coverage.always_audited.some(e => e.capability == c)));
    _check("the fixed events are published",
        coverage.fixed_events.includes("session.new_device_signed_in") &&
        coverage.fixed_events.includes("record.deleted"));
    _check("the categories are published", coverage.categories.length >= 7);
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Audit test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});

    const line = {alice: people.bob.person_id, bob: null, carol: null, dave: null, erin: null};
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "GB",
        manager_person_id: line[who], contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);

    return {org_id: org.org_id, ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

/**
 * A second org for the read tests, sharing the same global people but with its
 * own grants, so the result sets are exact rather than shared with the write
 * tests. erin again gets nothing.
 */
async function _buildReadWorld(main) {
    const org = await spine.createOrgAsync({name: `Audit read test ${Date.now()}`, home_jurisdiction: "GB"});
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const who of ["alice", "bob", "carol", "dave", "erin"]) await spine.recordEmploymentAsync(
        {org_id: org.org_id, person_id: main[who], status: "active", jurisdiction: "GB",
            contract_type: "employee", valid_from: "2026-01-01", source: "manual"});
    await permissions.ensureBuiltinRolesAsync(org.org_id);
    await permissions.assignRoleAsync(org.org_id, main.alice, "employee", from);
    await permissions.assignRoleAsync(org.org_id, main.bob, "lead", from);
    await permissions.assignRoleAsync(org.org_id, main.carol, "hr", from);
    await permissions.assignRoleAsync(org.org_id, main.dave, "admin", from);
    return {org_id: org.org_id, alice: main.alice, bob: main.bob, carol: main.carol, dave: main.dave, erin: main.erin};
}

async function _cleanup(org_id) {
    if (!org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [org_id]);
}
