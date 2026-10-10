/**
 * Tests I1 — the two genuinely new pieces: the self-service profile edit
 * (spine.js:updateOwnProfileAsync) and the one real Clock & timer
 * preference (clock.js:confirmBeforeSwitchAsync/setConfirmBeforeSwitchAsync).
 * Notification settings and the links-out panel reuse existing, already
 * tested code and aren't retested here.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests settings
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const clock = require(`${TELEWORKR_CONSTANTS.LIBDIR}/clock.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Settings test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 120)}`, true);}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "settings")) {
        LOG.console("Skipping settings test case, not called.\n"); return true;
    }
    LOG.console("\nI1 settings\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testProfile(w);
        await _testConfirmBeforeSwitch(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  settings tests threw: ${err}\n`); LOG.error(`Settings tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nSettings tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _testProfile(w) {
    LOG.console("\n profile — display_name and home_timezone\n");
    const updated = await spine.updateOwnProfileAsync(w.alice, {display_name: "Alice R.", home_timezone: "Asia/Kolkata"});
    _check("display_name and home_timezone are both updated", updated.display_name == "Alice R." &&
        updated.home_timezone == "Asia/Kolkata", JSON.stringify(updated));
    const reread = await spine.getPersonAsync(w.alice);
    _check("the change actually landed", reread.display_name == "Alice R." && reread.home_timezone == "Asia/Kolkata");

    await _checkThrows("an empty display_name is refused", _ =>
        spine.updateOwnProfileAsync(w.alice, {display_name: "   "}));
    await _checkThrows("a bad timezone is refused", _ =>
        spine.updateOwnProfileAsync(w.alice, {home_timezone: "Nowhere/Nothing"}));

    const unchangedEmail = await spine.updateOwnProfileAsync(w.alice, {display_name: "Alice R2."});
    _check("updating only display_name leaves home_timezone and email untouched",
        unchangedEmail.home_timezone == "Asia/Kolkata" && unchangedEmail.email == reread.email,
        JSON.stringify(unchangedEmail));
}

async function _testConfirmBeforeSwitch(w) {
    LOG.console("\n confirm-before-switch — defaults on, togglable\n");
    const initial = await clock.confirmBeforeSwitchAsync(w.org_id, w.alice);
    _check("defaults to on with no row at all", initial === true);

    await clock.setConfirmBeforeSwitchAsync(w.org_id, w.alice, false);
    const off = await clock.confirmBeforeSwitchAsync(w.org_id, w.alice);
    _check("turning it off sticks", off === false);

    await clock.setConfirmBeforeSwitchAsync(w.org_id, w.alice, true);
    const on = await clock.confirmBeforeSwitchAsync(w.org_id, w.alice);
    _check("turning it back on sticks", on === true);

    const rows = await dblayer.getQueryOrThrow(
        "SELECT * FROM clock_preference WHERE org_id=? AND person_id=?", [w.org_id, w.alice]);
    _check("the upsert never duplicates the row — exactly one survives three writes", rows.length == 1, JSON.stringify(rows));

    const otherPerson = await clock.confirmBeforeSwitchAsync(w.org_id, w.bob);
    _check("a different person in the same org gets their own default, unaffected by alice's row", otherPerson === true);
}

// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Settings test ${stamp}`, home_jurisdiction: "GB"});
    const alice = await spine.createPersonAsync({display_name: "Alice", email: `alice.settings.${stamp}@example.invalid`});
    const bob = await spine.createPersonAsync({display_name: "Bob", email: `bob.settings.${stamp}@example.invalid`});
    for (const person of [alice, bob])
        await spine.recordEmploymentAsync({org_id: org.org_id, person_id: person.person_id,
            status: "active", jurisdiction: "GB", contract_type: "employee",
            valid_from: "2026-01-01", source: "manual"});
    await permissions.ensureBuiltinRolesAsync(org.org_id);
    return {org_id: org.org_id, stamp, alice: alice.person_id, bob: bob.person_id};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["clock_preference", "role_capability", "role", "capability_grant", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
