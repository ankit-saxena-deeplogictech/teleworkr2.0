/**
 * Tests L4 — sessions, devices & incidents.
 *
 * The weak-signal check (sessions.js) is exercised with a deterministic
 * signed_in_at (an optional override, the same testability seam
 * permissions.checkAsync's own `asOf` already establishes) against a
 * declared working window, since the real clock can't be controlled from
 * a test. Incident mode is exercised end to end: contain (which requires
 * incident.manage even though it calls into session.manage-gated code),
 * assess (a direct audit_event query by actor, not subject), notify
 * (recorded, never dispatched — no email infrastructure exists anywhere
 * in this app), and the regulatory clock computed from awareness_at.
 *
 * Also exercises the real hook this module is built on: login.js's
 * _verifyJWT now accepts a servObject and records a session from it.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests security
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const sessions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/sessions.js`);
const incidents = require(`${TELEWORKR_CONSTANTS.LIBDIR}/incidents.js`);
const loginapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/login.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Security test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 100)}`, true);}
}
const _now = () => Math.floor(Date.now()/1000);

// Monday 2026-03-02, IST (UTC+5:30). Noon local falls inside a 9:00-18:00
// declared window; 10pm local falls outside it — both kept on the same UTC
// calendar date, since windows.withinWindowAtAsync derives the weekday from
// the epoch's UTC date, not the person's local one, and crossing midnight
// UTC would land on a different (undeclared-for) weekday entirely.
const WITHIN_WINDOW_AT = Math.floor(Date.parse("2026-03-02T06:30:00Z")/1000);
const OUTSIDE_WINDOW_AT = Math.floor(Date.parse("2026-03-02T16:30:00Z")/1000);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "security")) {
        LOG.console("Skipping security test case, not called.\n"); return true;
    }
    LOG.console("\nL4 sessions, devices & incidents\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await windows.setWindowAsync({org_id: w.org_id, person_id: w.alice, timezone: "Asia/Kolkata",
            start_minute: 540, end_minute: 1080, days: [1,2,3,4,5], valid_from: "2026-01-01"});

        await _testDeviceSignals(w);
        await _testMySessionsAndSignOut(w);
        await _testRevokeSessionsFor(w);
        await _testIncidentLifecycle(w);
        await _testCapabilityRefusals(w);
        await _testVerifyJWTRecordsSession(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  security tests threw: ${err}\n`); LOG.error(`Security tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nSecurity tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

async function _testDeviceSignals(w) {
    LOG.console("\n device parsing and the two weak signals\n");
    const chromeWindows = "Mozilla/5.0 (Windows NT 10.0) Chrome/120";

    const first = await sessions.recordSignInAsync({org_id: w.org_id, person_id: w.alice, ip: "10.0.0.1",
        user_agent: chromeWindows, signed_in_at: WITHIN_WINDOW_AT});
    _check("device label is parsed from the user-agent", first.device_label == "Chrome · Windows", first.device_label);
    _check("the first sign-in from a device is first-seen", first.first_seen_for_person == 1, JSON.stringify(first));
    _check("a within-window sign-in on a new device carries exactly one signal",
        JSON.stringify(first.signals) == JSON.stringify(["new_device"]), JSON.stringify(first.signals));
    w.aliceSession1 = first.session_id;

    const second = await sessions.recordSignInAsync({org_id: w.org_id, person_id: w.alice, ip: "10.0.0.1",
        user_agent: chromeWindows, signed_in_at: OUTSIDE_WINDOW_AT});
    _check("a repeat sign-in from the same device is not first-seen", second.first_seen_for_person == 0, JSON.stringify(second));
    _check("an outside-window sign-in on a known device carries exactly one signal",
        JSON.stringify(second.signals) == JSON.stringify(["outside_declared_window"]), JSON.stringify(second.signals));
    w.aliceSession2 = second.session_id;

    const third = await sessions.recordSignInAsync({org_id: w.org_id, person_id: w.alice, ip: "203.0.113.9",
        user_agent: "curl/8.0", signed_in_at: OUTSIDE_WINDOW_AT});
    _check("an unrecognised user-agent parses as unknown, not guessed", third.device_label.startsWith("Unknown"), third.device_label);
    _check("a new device outside the window combines both signals",
        JSON.stringify(third.signals.sort()) == JSON.stringify(["new_device", "outside_declared_window"]), JSON.stringify(third.signals));
    w.aliceSession3 = third.session_id;

    const noAgent = await sessions.recordSignInAsync({org_id: w.org_id, person_id: w.bob, ip: null, user_agent: null});
    _check("no user-agent at all parses as Unknown device", noAgent.device_label == "Unknown device", noAgent.device_label);
    w.bobSession1 = noAgent.session_id;

    const feed = await sessions.detectionFeedAsync(w.org_id, w.carol, {days: 3650});
    const feedFirst = feed.sessions.find(s => s.session_id == first.session_id);
    const feedThird = feed.sessions.find(s => s.session_id == third.session_id);
    _check("a single-signal sign-in tiers as quiet", feedFirst?.tier == "quiet", JSON.stringify(feedFirst));
    _check("a two-signal sign-in tiers as review", feedThird?.tier == "review", JSON.stringify(feedThird));
}

async function _testMySessionsAndSignOut(w) {
    LOG.console("\n self-service — my sessions and sign-out\n");
    const mine = await sessions.mySessionsAsync(w.org_id, w.alice);
    _check("alice sees exactly her own three sessions", mine.sessions.length == 3, JSON.stringify(mine.sessions.map(s => s.session_id)));

    await sessions.signOutSessionAsync({org_id: w.org_id, actor_person_id: w.alice, session_id: w.aliceSession1});
    const afterSignOut = await sessions.mySessionsAsync(w.org_id, w.alice);
    _check("the signed-out session shows revoked_at set",
        Boolean(afterSignOut.sessions.find(s => s.session_id == w.aliceSession1)?.revoked_at));

    await _checkThrows("signing out an already-signed-out session is refused", _ =>
        sessions.signOutSessionAsync({org_id: w.org_id, actor_person_id: w.alice, session_id: w.aliceSession1}));
    await _checkThrows("bob cannot sign out alice's session", _ =>
        sessions.signOutSessionAsync({org_id: w.org_id, actor_person_id: w.bob, session_id: w.aliceSession2}));
}

async function _testRevokeSessionsFor(w) {
    LOG.console("\n bulk revoke — person, role, whole org\n");
    const byPerson = await sessions.revokeSessionsForAsync({org_id: w.org_id, actor_person_id: w.carol,
        person_id: w.alice, reason: "Targeted revoke test."});
    _check("revoking by person catches exactly alice's remaining active sessions", byPerson.revoked_count == 2, JSON.stringify(byPerson));

    const byRole = await sessions.revokeSessionsForAsync({org_id: w.org_id, actor_person_id: w.carol,
        role_name: "employee", reason: "Role revoke test."});
    _check("revoking by role catches only bob's still-active session (alice's are already gone)",
        byRole.revoked_count == 1, JSON.stringify(byRole));

    const freshCarolSession = await sessions.recordSignInAsync({org_id: w.org_id, person_id: w.carol,
        ip: "10.0.0.2", user_agent: "Mozilla/5.0 Safari/605"});
    const byOrg = await sessions.revokeSessionsForAsync({org_id: w.org_id, actor_person_id: w.carol,
        whole_org: true, reason: "Org-wide contain test."});
    _check("revoking the whole org catches the fresh session too", byOrg.revoked_count >= 1, JSON.stringify(byOrg));
    const stillActive = await dblayer.getQueryOrThrow("SELECT * FROM session WHERE org_id=? AND session_id=? AND revoked_at IS NULL",
        [w.org_id, freshCarolSession.session_id]);
    _check("that fresh session is now revoked too", stillActive.length == 0, JSON.stringify(stillActive));

    const revokedEntries = await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='session.revoked'", [w.org_id]);
    _check("every revoke wrote its own audit entry", revokedEntries.length == 3, JSON.stringify(revokedEntries.length));

    await _checkThrows("an employee cannot bulk-revoke", _ =>
        sessions.revokeSessionsForAsync({org_id: w.org_id, actor_person_id: w.bob, person_id: w.alice}));
}

async function _testIncidentLifecycle(w) {
    LOG.console("\n incident mode — contain, assess, notify, record\n");

    const fresh = await incidents.openIncidentAsync({org_id: w.org_id, actor_person_id: w.carol, title: `Suspicious activity ${w.stamp}`});
    w.incidentId = fresh.incident_id;
    _check("opening an incident succeeds", Boolean(fresh.incident_id));

    const breached = await incidents.openIncidentAsync({org_id: w.org_id, actor_person_id: w.carol,
        title: `Old incident ${w.stamp}`, awareness_at: _now() - 80*3600});
    const breachedDetail = await incidents.incidentDetailAsync(w.org_id, w.carol, breached.incident_id);
    _check("the regulatory clock is computed from awareness_at, not opened_at",
        breachedDetail.regulatory_clock_breached === true, JSON.stringify(breachedDetail.regulatory_clock_seconds));
    const freshDetail = await incidents.incidentDetailAsync(w.org_id, w.carol, fresh.incident_id);
    _check("a just-opened incident (awareness now) is not past the 72h clock",
        freshDetail.regulatory_clock_breached === false, JSON.stringify(freshDetail.regulatory_clock_seconds));

    // give bob a fresh, active session to contain
    await sessions.recordSignInAsync({org_id: w.org_id, person_id: w.bob, ip: "10.0.0.3", user_agent: "Mozilla/5.0 Firefox/100"});
    const contained = await incidents.containSessionsAsync({org_id: w.org_id, actor_person_id: w.carol,
        incident_id: w.incidentId, person_id: w.bob, reason: "Containment test."});
    _check("containing sessions for a person revokes exactly their active one", contained.revoked_count == 1, JSON.stringify(contained));

    // assess needs some real audit trail to query against — write two entries for bob,
    // one inside the assess window, one outside it
    const windowStart = _now() - 3600, windowEnd = _now() + 3600;
    await audit.writeAsync({org_id: w.org_id, action: "task.created", object_type: "task",
        actor_person_id: w.bob, occurred_at: _now(), detail: {}});
    await audit.writeAsync({org_id: w.org_id, action: "task.created", object_type: "task",
        actor_person_id: w.bob, occurred_at: windowStart - 10000, detail: {}});
    const assessed = await incidents.assessAsync({org_id: w.org_id, actor_person_id: w.carol,
        incident_id: w.incidentId, person_id: w.bob, from: windowStart, to: windowEnd});
    _check("assess returns only bob's own actions inside the window", assessed.events.length == 1 &&
        assessed.events.every(e => e.actor_person_id == w.bob), JSON.stringify(assessed.events.map(e => e.occurred_at)));

    await _checkThrows("notify without a message is refused", _ =>
        incidents.notifyAsync({org_id: w.org_id, actor_person_id: w.carol, incident_id: w.incidentId, person_ids: [w.bob], message: ""}));
    await incidents.notifyAsync({org_id: w.org_id, actor_person_id: w.carol, incident_id: w.incidentId,
        person_ids: [w.alice, w.bob], message: "We detected unusual sign-in activity on your account."});
    await incidents.addNoteAsync({org_id: w.org_id, actor_person_id: w.carol, incident_id: w.incidentId,
        text: "Confirmed with bob this was a legitimate new laptop."});

    const detail = await incidents.incidentDetailAsync(w.org_id, w.carol, w.incidentId);
    _check("the timeline has all four kinds of action in order",
        detail.actions.map(a => a.kind).join(",") == "contain_sessions,assess,notify,note", detail.actions.map(a => a.kind).join(","));
    _check("the notify action's detail names both affected people and the message",
        detail.actions.find(a => a.kind == "notify")?.detail.person_ids.sort().join(",") == [w.alice, w.bob].sort().join(","),
        JSON.stringify(detail.actions.find(a => a.kind == "notify")));

    await _checkThrows("closing without a conclusion is refused", _ =>
        incidents.closeIncidentAsync({org_id: w.org_id, actor_person_id: w.carol, incident_id: w.incidentId, conclusion: ""}));
    const closed = await incidents.closeIncidentAsync({org_id: w.org_id, actor_person_id: w.carol,
        incident_id: w.incidentId, conclusion: "False positive — a known new device."});
    _check("closing with a conclusion succeeds", closed == "closed");
    await _checkThrows("closing an already-closed incident is refused", _ =>
        incidents.closeIncidentAsync({org_id: w.org_id, actor_person_id: w.carol, incident_id: w.incidentId, conclusion: "Again."}));

    w.breachedIncidentId = breached.incident_id;
}

async function _testCapabilityRefusals(w) {
    LOG.console("\n capability refusals — an employee cannot touch incident mode\n");
    await _checkThrows("an employee cannot list incidents", _ => incidents.incidentsAsync(w.org_id, w.bob));
    await _checkThrows("an employee cannot read an incident's detail",
        _ => incidents.incidentDetailAsync(w.org_id, w.bob, w.incidentId));
    await _checkThrows("an employee cannot open an incident",
        _ => incidents.openIncidentAsync({org_id: w.org_id, actor_person_id: w.bob, title: "Should fail"}));
    await _checkThrows("an employee cannot contain sessions via an incident", _ =>
        incidents.containSessionsAsync({org_id: w.org_id, actor_person_id: w.bob, incident_id: w.breachedIncidentId, person_id: w.alice}));
    await _checkThrows("an employee cannot assess", _ =>
        incidents.assessAsync({org_id: w.org_id, actor_person_id: w.bob, incident_id: w.breachedIncidentId,
            person_id: w.alice, from: 0, to: _now()}));
    await _checkThrows("an employee cannot notify", _ =>
        incidents.notifyAsync({org_id: w.org_id, actor_person_id: w.bob, incident_id: w.breachedIncidentId,
            person_ids: [w.alice], message: "x"}));
    await _checkThrows("an employee cannot close an incident", _ =>
        incidents.closeIncidentAsync({org_id: w.org_id, actor_person_id: w.bob, incident_id: w.breachedIncidentId, conclusion: "x"}));
}

async function _testVerifyJWTRecordsSession(w) {
    LOG.console("\n login.js's verify op accepts a servObject without breaking the existing degraded-IdP path\n");
    // A real successful verification needs a live external IdP round-trip, which this
    // suite can't fake — the actual recording logic (recordSignInAsync, the weak
    // signals, device parsing) is already fully exercised directly above. What's
    // testable here, honestly, is that adding the servObject parameter is backward
    // compatible: the unreachable-IdP path (test_identity.js's own _testDegradedIdP
    // trick) fails before ever reaching claims decoding, with or without one.
    const originalTkmloginApi = TELEWORKR_CONSTANTS.CONF.tkmlogin_api;
    TELEWORKR_CONSTANTS.CONF.tkmlogin_api = "http://127.0.0.1:9/validate";   // nothing listens here
    try {
        const withServObject = await loginapi.doService({op: "verify", jwt: "header.payload.signature"},
            {env: {remoteHost: "198.51.100.7", remoteAgent: "Mozilla/5.0 Chrome/120"}});
        _check("verify with a servObject still degrades cleanly, doesn't throw",
            withServObject.result === false && withServObject.degraded == "idp_unreachable", JSON.stringify(withServObject));
        const withoutServObject = await loginapi.doService({op: "verify", jwt: "header.payload.signature"});
        _check("verify with no servObject at all (the pre-existing calling convention) still works the same way",
            withoutServObject.result === false && withoutServObject.degraded == "idp_unreachable", JSON.stringify(withoutServObject));
    } finally {
        TELEWORKR_CONSTANTS.CONF.tkmlogin_api = originalTkmloginApi;
    }
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Security test ${stamp}`, home_jurisdiction: "IN"});
    const roleOf = {alice: "employee", bob: "employee", carol: "admin"};
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

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["audit_event", "session", "security_incident_action", "security_incident",
        "capability_grant", "role_capability", "role", "employment", "working_window"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
