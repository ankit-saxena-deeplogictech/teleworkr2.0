/**
 * Tests the admin day-level activity viewer (activity.js).
 *
 * Built on a fixed range of three past days with seeded rows (sessions, app
 * launches, time entries, breaks), so nothing depends on the machine date.
 * The privacy property is asserted structurally: no returned row may carry a
 * clock-in/out or launch time, and the ceiling capability stays refused.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests activity
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);
const activity = require(`${TELEWORKR_CONSTANTS.LIBDIR}/activity.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Activity test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 100)}`, true);}
}
const _uuid = _ => serverutils.generateUUID(false);
const _epoch = iso => Math.floor(Date.parse(iso)/1000);

const D1 = "2026-03-02", D2 = "2026-03-03", D3 = "2026-03-04";     // a fixed Mon-Wed
const FORBIDDEN_KEYS = ["started_at", "ended_at", "occurred_at", "launched_at"];

const _keysDeep = (value, out = new Set()) => {
    if (Array.isArray(value)) value.forEach(v => _keysDeep(v, out));
    else if (value && typeof value == "object") for (const [k, v] of Object.entries(value)) {out.add(k); _keysDeep(v, out);}
    return out;
};

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "activity")) {
        LOG.console("Skipping activity test case, not called.\n"); return true;
    }
    LOG.console("\nAdmin activity & logs\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testLoginLog(w);
        await _testPersonDays(w);
        await _testAppLog(w);
        await _testNoMinuteLevelData(w);
        await _testRefusalsAndAudit(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  activity tests threw: ${err}\n`); LOG.error(`Activity tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nActivity tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

async function _testLoginLog(w) {
    LOG.console("\n the org-wide login log\n");
    const all = await activity.loginLogAsync({org_id: w.org_id, actor_person_id: w.carol, from: D1, to: D3});
    _check("the log holds all three seeded sign-ins in range", all.sessions.length == 3, String(all.sessions.length));
    _check("newest first", all.sessions[0].signed_in_at >= all.sessions[2].signed_in_at);
    _check("a two-signal sign-in tiers as review, a one-signal one as quiet",
        all.sessions.find(s => s.session_id == w.sRisky).tier == "review" && all.sessions.find(s => s.session_id == w.sQuiet).tier == "quiet");
    const flagged = await activity.loginLogAsync({org_id: w.org_id, actor_person_id: w.carol, from: D1, to: D3, flagged_only: true});
    _check("flagged_only keeps just the review tier", flagged.sessions.length == 1 && flagged.sessions[0].session_id == w.sRisky);
    const bobOnly = await activity.loginLogAsync({org_id: w.org_id, actor_person_id: w.carol, from: D1, to: D3, person_id: w.bob});
    _check("person filter narrows to bob", bobOnly.sessions.length == 1 && bobOnly.sessions[0].person_id == w.bob);
    const narrow = await activity.loginLogAsync({org_id: w.org_id, actor_person_id: w.carol, from: D3, to: D3});
    _check("the range bounds are respected", narrow.sessions.length == 1 && narrow.sessions[0].session_id == w.sRisky);
    await _checkThrows("a range over 92 days is refused", _ =>
        activity.loginLogAsync({org_id: w.org_id, actor_person_id: w.carol, from: "2026-01-01", to: "2026-06-01"}));
    await _checkThrows("a malformed date is refused", _ =>
        activity.loginLogAsync({org_id: w.org_id, actor_person_id: w.carol, from: "yesterday", to: D3}));
}

async function _testPersonDays(w) {
    LOG.console("\n one person's days\n");
    const result = await activity.personDaysAsync({org_id: w.org_id, actor_person_id: w.carol, person_id: w.alice, from: D1, to: D3});
    _check("every day in the range appears, newest first",
        result.days.map(d => d.date).join(",") == [D3, D2, D1].join(","), result.days.map(d => d.date).join(","));
    const d1 = result.days.find(d => d.date == D1), d2 = result.days.find(d => d.date == D2), d3 = result.days.find(d => d.date == D3);
    _check("worked time is the day's current entries — the superseded original does not double-count",
        d1.worked_seconds == 5400, String(d1.worked_seconds));
    _check("billable is split out", d1.billable_seconds == 3600, String(d1.billable_seconds));
    _check("the second day's entry is counted separately", d2.worked_seconds == 1800, String(d2.worked_seconds));
    _check("a launch burst within one day collapses to a count", d1.app_launches["Test App"] == 3, JSON.stringify(d1.app_launches));
    _check("breaks are counted, not timed", d1.breaks == 1, String(d1.breaks));
    _check("the seeded late sign-in lands on the third day", d3.sign_ins == 1 && d3.flagged_sign_ins == 1, JSON.stringify(d3));
    const wider = await activity.personDaysAsync({org_id: w.org_id, actor_person_id: w.carol, person_id: w.alice, from: "2026-02-27", to: D1});
    const quiet = wider.days.find(d => d.date == "2026-02-28");
    _check("a day with nothing recorded reads as quiet, not missing",
        quiet && quiet.sign_ins == 0 && quiet.worked_seconds == 0 && quiet.breaks == 0 && Object.keys(quiet.app_launches).length == 0,
        JSON.stringify(quiet));
    _check("sign-ins and distinct devices are counted", d1.sign_ins == 1 && d1.devices.join() == "Chrome · Windows", JSON.stringify(d1));
    _check("the covering timesheet's status is shown", d1.timesheet_status == "submitted", String(d1.timesheet_status));
    await _checkThrows("person_days without a person is refused", _ =>
        activity.personDaysAsync({org_id: w.org_id, actor_person_id: w.carol, from: D1, to: D3}));
}

async function _testAppLog(w) {
    LOG.console("\n the per-app log\n");
    const result = await activity.appLogAsync({org_id: w.org_id, actor_person_id: w.carol, from: D1, to: D3});
    const row = result.days.find(d => d.date == D1 && d.name == "Test App");
    _check("launches and distinct users are aggregated per app per day", row?.launches == 4 && row?.distinct_users == 2, JSON.stringify(row));
    const other = await activity.appLogAsync({org_id: w.org_id, actor_person_id: w.carol, from: D1, to: D3, app_id: "no-such-app"});
    _check("an app filter with no match is empty, not an error", other.days.length == 0);
}

async function _testNoMinuteLevelData(w) {
    LOG.console("\n no minute-level data leaks through the day-level views\n");
    const people = await activity.personDaysAsync({org_id: w.org_id, actor_person_id: w.carol, person_id: w.alice, from: D1, to: D3});
    const apps = await activity.appLogAsync({org_id: w.org_id, actor_person_id: w.carol, from: D1, to: D3});
    for (const [label, result] of [["person days", people], ["app log", apps]]) {
        const leaked = FORBIDDEN_KEYS.filter(k => _keysDeep(result).has(k));
        _check(`${label} carries no clock-in/out or launch times`, leaked.length == 0, leaked.join(","));
    }
    const decision = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.carol,
        capability: "activity.read_minute_level", subject_person_id: w.alice, asOf: D1});
    _check("minute-level activity is still ceiling-refused, even for the admin",
        !decision.allowed && decision.outcome == permissions.OUTCOMES.CEILING, decision.outcome);
}

async function _testRefusalsAndAudit(w) {
    LOG.console("\n refusals and the audit trail\n");
    for (const [who, label] of [[w.bob, "an employee"], [w.dave, "a lead"]]) {
        await _checkThrows(`${label} cannot read the login log`, _ =>
            activity.loginLogAsync({org_id: w.org_id, actor_person_id: who, from: D1, to: D3}));
        await _checkThrows(`${label} cannot read person days`, _ =>
            activity.personDaysAsync({org_id: w.org_id, actor_person_id: who, person_id: w.alice, from: D1, to: D3}));
        await _checkThrows(`${label} cannot read the app log`, _ =>
            activity.appLogAsync({org_id: w.org_id, actor_person_id: who, from: D1, to: D3}));
    }
    const count = async _ => (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS n FROM audit_event WHERE org_id=? AND action='activity.viewed'", [w.org_id]))[0].n;
    const before = await count();
    try {await activity.loginLogAsync({org_id: w.org_id, actor_person_id: w.bob, from: D1, to: D3});} catch (_) {}
    _check("a refused read writes no audit entry", before >= 1 && await count() == before);
    await activity.personDaysAsync({org_id: w.org_id, actor_person_id: w.carol, person_id: w.alice, from: D1, to: D3});
    const entries = await dblayer.getQueryOrThrow(
        "SELECT * FROM audit_event WHERE org_id=? AND action='activity.viewed' AND subject_person_id=? ORDER BY occurred_at DESC, rowid DESC",
        [w.org_id, w.alice]);
    _check("viewing alice's days wrote an activity.viewed entry with her as the subject, the admin as actor",
        entries.length >= 1 && entries[0].actor_person_id == w.carol, JSON.stringify(entries[0]));
    _check("the entry carries shapes and counts only, not the activity itself",
        JSON.parse(entries[0].detail).view == "person_days" && JSON.parse(entries[0].detail).rows == 3, entries[0].detail);
    const visibleToAlice = await audit.queryAsync({org_id: w.org_id, actor_person_id: w.alice});
    _check("alice can see, in her own audit log, that the admin looked",
        visibleToAlice.some(e => e.action == "activity.viewed" && e.actor_person_id == w.carol));
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Activity test ${stamp}`, home_jurisdiction: "IN"});
    const roleOf = {alice: "employee", bob: "employee", carol: "admin", dave: "lead"};
    const people = {};
    for (const who of Object.keys(roleOf))
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN", contract_type: "employee",
        valid_from: "2026-01-01", source: "manual"});
    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const [who, role] of Object.entries(roleOf)) await permissions.assignRoleAsync(org.org_id, people[who].person_id, role, from);

    const w = {org_id: org.org_id, stamp, ...Object.fromEntries(Object.entries(people).map(([name, p]) => [name, p.person_id]))};
    await _seed(w);
    return w;
}

async function _seed(w) {
    const run = (sql, params) => dblayer.runCmdOrThrow(sql, params);
    w.appId = `app-${w.stamp}`;
    await run(`INSERT INTO app_catalogue (app_id, org_id, name, category, launch_url, launch_label, requires_request, created_at)
        VALUES (?,?,?,?,?,?,?,?)`, [w.appId, w.org_id, "Test App", "other", "https://example.invalid", "Open", 0, _epoch(`${D1}T00:00:00Z`)]);

    const session = async (key, person, at, signals, device) => {
        w[key] = _uuid();
        await run(`INSERT INTO session (session_id, org_id, person_id, ip, user_agent, device_label, first_seen_for_person,
            signals, signed_in_at, last_seen_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [w[key], w.org_id, person, "10.0.0.1", "ua", device, 1, JSON.stringify(signals), at, at]);
    };
    await session("sQuiet", w.alice, _epoch(`${D1}T09:00:00Z`), ["new_device"], "Chrome · Windows");
    await session("sBob", w.bob, _epoch(`${D2}T09:00:00Z`), [], "Firefox · Linux");
    await session("sRisky", w.alice, _epoch(`${D3}T23:00:00Z`), ["new_device", "outside_declared_window"], "Unknown device");

    const launch = (person, at) => run("INSERT INTO app_launch_event (event_id, org_id, app_id, person_id, occurred_at) VALUES (?,?,?,?,?)",
        [_uuid(), w.org_id, w.appId, person, at]);
    for (const hour of ["08", "09", "10"]) await launch(w.alice, _epoch(`${D1}T${hour}:00:00Z`));
    await launch(w.bob, _epoch(`${D1}T11:00:00Z`));

    const entry = (id, person, date, seconds, billable, supersedes) => run(
        `INSERT INTO time_entry_event (entry_event_id, org_id, person_id, entry_date, billable, started_at, ended_at,
            duration_seconds, source, supersedes_entry_event_id, recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, w.org_id, person, date, billable, _epoch(`${date}T08:00:00Z`), _epoch(`${date}T08:00:00Z`) + seconds, seconds, "manual",
            supersedes || null, _epoch(`${date}T20:00:00Z`) + (supersedes ? 60 : 0)]);
    await entry("orig-" + w.stamp, w.alice, D1, 1000, 1);                       // superseded below
    await entry("edit-" + w.stamp, w.alice, D1, 3600, 1, "orig-" + w.stamp);    // billable 1h replaces it
    await entry("nb-" + w.stamp, w.alice, D1, 1800, 0);                         // non-billable 30m
    await entry("d2-" + w.stamp, w.alice, D2, 1800, 1);

    await run(`INSERT INTO clock_break (break_id, org_id, person_id, entry_date, started_at, ended_at, source, recorded_at)
        VALUES (?,?,?,?,?,?,?,?)`, [_uuid(), w.org_id, w.alice, D1, _epoch(`${D1}T12:00:00Z`), _epoch(`${D1}T12:15:00Z`), "clock", _epoch(`${D1}T12:15:00Z`)]);
    await run(`INSERT INTO timesheet (timesheet_id, org_id, person_id, week_start, week_end, status) VALUES (?,?,?,?,?,?)`,
        [_uuid(), w.org_id, w.alice, "2026-03-02", "2026-03-08", "submitted"]);
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["audit_event", "session", "app_launch_event", "app_catalogue", "time_entry_event", "clock_break",
        "timesheet", "capability_grant", "role_capability", "role", "employment", "notification"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
