/**
 * Tests A9 + B4 — the notification spine and the clock-in brief. The working
 * window is the send window with exactly two breakers; events off the catalogue
 * do not notify; the brief ranks the overnight feed by who is awake, in four
 * buckets, with the quiet and chronological states.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests brief
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const notifications = require(`${TELEWORKR_CONSTANTS.LIBDIR}/notifications.js`);
const brief = require(`${TELEWORKR_CONSTANTS.LIBDIR}/brief.js`);
const notificationsapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/notifications.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Brief test failed: ${label} ${detail||""}`);}
}

const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success"); return null;}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 80)}`, true); return err;}
}

const _today = () => new Date().toISOString().substring(0, 10);
const _yesterday = () => new Date(Date.now() - 86400000).toISOString().substring(0, 10);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "brief")) {
        LOG.console("Skipping brief test case, not called.\n"); return true;
    }
    LOG.console("\nA9 notifications + B4 brief\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testSendWindow(w);
        await _testVolume(w);
        await _testBrief(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  brief tests threw: ${err}\n`); LOG.error(`Brief tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nBrief tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

/** The working window is the send window — with exactly two breakers. */
async function _testSendWindow(w) {
    LOG.console("\n the window routes, the catalogue gates\n");
    const inWindow = await notifications.notifyAsync({org_id: w.org_id,
        category: "approval_sla", recipient_person_id: w.alice});
    _check("inside the window an approval SLA delivers",
        inWindow.status == "delivered" && inWindow.within_window === true);

    const out = await notifications.notifyAsync({org_id: w.org_id,
        category: "approval_sla", recipient_person_id: w.bob});
    _check("outside the window the same event waits in the digest",
        out.status == "digest" && out.within_window === false);

    const blocker = await notifications.notifyAsync({org_id: w.org_id,
        category: "became_blocker", recipient_person_id: w.bob});
    _check("an in-app-only event outside the window waits in the brief",
        blocker.status == "brief");

    const security = await notifications.notifyAsync({org_id: w.org_id,
        category: "security_incident", recipient_person_id: w.bob, payload: {why: "test"}});
    _check("a security incident breaches the window", security.status == "delivered");

    await _checkThrows("an event not on the catalogue does not notify", _ =>
        notifications.notifyAsync({org_id: w.org_id, category: "pizza_arrived",
            recipient_person_id: w.alice}));
}

/** One volume control per category; the fixed two have no dial. */
async function _testVolume(w) {
    LOG.console("\n the volume dial, and what is fixed\n");
    await notifications.setVolumeAsync(w.org_id, w.alice, "approval_sla", "off");
    const muted = await notifications.notifyAsync({org_id: w.org_id,
        category: "approval_sla", recipient_person_id: w.alice});
    _check("a muted category holds its send", muted.status == "muted");

    const stats = await notifications.volumeStatsAsync(w.org_id);
    const sla = stats.per_category.find(entry => entry.category == "approval_sla");
    _check("the mute share is measured per category", sla?.mute_share == 100 && sla.muted >= 1,
        JSON.stringify(sla));

    await _checkThrows("a fixed category refuses to be muted", _ =>
        notifications.setVolumeAsync(w.org_id, w.alice, "security_incident", "off"));
    await notifications.setVolumeAsync(w.org_id, w.alice, "approval_sla", "live");
}

/** B4: four buckets ranked by who is awake, plus quiet and chronological states. */
async function _testBrief(w) {
    LOG.console("\n the clock-in brief\n");
    const t1 = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.dave,
        title: "Pricing strip", assignee_person_id: w.alice});
    const t2 = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.dave,
        title: "DS integration", assignee_person_id: w.bob});
    const t3 = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.dave,
        title: "Fold work", assignee_person_id: w.alice});
    const t4 = await tasks.createTaskAsync({org_id: w.org_id, actor_person_id: w.dave,
        title: "Schema migration", assignee_person_id: w.bob});

    await tasks.addCommentAsync({org_id: w.org_id, actor_person_id: w.bob,
        task_ref: t1.task_ref, body: "Is the pricing strip shipping without the annual toggle?"});
    await tasks.addWatcherAsync({org_id: w.org_id, actor_person_id: w.alice, task_ref: t2.task_ref});
    await tasks.updateTaskAsync({org_id: w.org_id, actor_person_id: w.bob,
        task_ref: t2.task_ref, changes: {status: "in_review"}});
    await tasks.assignTaskAsync({org_id: w.org_id, actor_person_id: w.bob,
        task_ref: t2.task_ref, assignee_person_id: w.carol});
    await tasks.addBlockAsync({org_id: w.org_id, actor_person_id: w.bob,
        blocker_task_ref: t4.task_ref, blocked_task_ref: t1.task_ref,
        reason: "the schema migration failed"});
    await tasks.updateTaskAsync({org_id: w.org_id, actor_person_id: w.bob,
        task_ref: t1.task_ref, changes: {due_date: _today()}});
    await tasks.updateTaskAsync({org_id: w.org_id, actor_person_id: w.bob,
        task_ref: t3.task_ref, changes: {due_date: _yesterday()}});

    await notifications.notifyAsync({org_id: w.org_id, category: "task_assigned",
        recipient_person_id: w.alice, actor_person_id: w.bob,
        object_ref: t3.task_ref, payload: {task_ref: t3.task_ref}});

    const morning = await brief.briefAsync({org_id: w.org_id, person_id: w.alice});
    const buckets = morning.items.reduce((map, item) => {
        map[item.bucket] = (map[item.bucket] || 0) + 1; return map;}, {});
    _check("the four buckets carry exactly their events",
        buckets.blocks_you == 1 && buckets.needs_reply == 1 &&
        buckets.moved == 1 && buckets.decided == 1, JSON.stringify(buckets));
    _check("the block names its reason",
        morning.items.find(item => item.bucket == "blocks_you")?.why.includes("schema migration failed"));
    _check("the reply names who and whether they are awake",
        morning.items.find(item => item.bucket == "needs_reply")?.by_name == "bob" &&
        morning.items.find(item => item.bucket == "needs_reply")?.other_availability.online_now === false);
    _check("the day strip is real arithmetic, with meetings honestly zero",
        morning.summary.due_today == 1 && morning.summary.overdue == 1 &&
        morning.summary.blocked_tasks == 1 && morning.summary.meetings === 0,
        JSON.stringify(morning.summary));
    _check("no awake replies means unblocking comes first",
        morning.suggested_order[0]?.task_ref == t1.task_ref &&
        /Unblock/.test(morning.suggested_order[0].action),
        JSON.stringify(morning.suggested_order));
    _check("a normal morning is named normal", morning.state == "normal");
    _check("the brief bucket from A9 feeds the same screen",
        morning.notifications.length == 1 && morning.notifications[0].category == "task_assigned");

    await notifications.ackBriefAsync(w.org_id, w.alice);
    _check("showing the brief drains its bucket",
        (await notifications.briefQueueAsync(w.org_id, w.alice)).length == 0);

    const quiet = await brief.briefAsync({org_id: w.org_id, person_id: w.dave});
    _check("a quiet night is one line, not a card",
        quiet.state == "quiet" && quiet.items.length == 0);

    const fallback = await brief.briefAsync({org_id: w.org_id, person_id: w.erin});
    _check("no declared window falls back to the chronological feed",
        fallback.state == "chronological" && fallback.summary === null &&
        fallback.suggested_order === null);
}

/** The API surface. */
async function _testAPI(w) {
    LOG.console("\n the notifications API\n");
    const morning = await notificationsapi.doService({op: "brief", id: w.aliceEmail, org: w.org_id});
    _check("op brief answers with the ranked feed",
        morning.result === true && Array.isArray(morning.items) && "state" in morning);

    const raised = await notificationsapi.doService({op: "notify", id: w.carolEmail, org: w.org_id,
        category: "leave_decision", recipient_person_id: w.alice, payload: {decision: "approved"}});
    _check("op notify raises through the catalogue",
        raised.result === true && raised.status == "delivered");

    const set = await notificationsapi.doService({op: "set_volume", id: w.aliceEmail, org: w.org_id,
        category: "approval_sla", level: "digest"});
    _check("op set_volume stores the dial", set.result === true && set.level == "digest");

    const settings = await notificationsapi.doService({op: "settings", id: w.aliceEmail, org: w.org_id});
    _check("op settings answers with the whole map",
        settings.result === true && settings.settings.approval_sla == "digest");

    const stats = await notificationsapi.doService({op: "stats", id: w.carolEmail, org: w.org_id});
    _check("op stats answers with the send-and-mute picture",
        stats.result === true && stats.total_raised >= 1 &&
        stats.per_category.some(entry => entry.category == "leave_decision"));
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Brief test ${stamp}`, home_jurisdiction: "IN"});
    const people = {};
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        people[who] = await spine.createPersonAsync(
            {display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN",
        contract_type: "employee", valid_from: "2026-01-01", source: "manual"});

    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    await permissions.assignRoleAsync(org.org_id, people.alice.person_id, "employee", from);
    await permissions.assignRoleAsync(org.org_id, people.bob.person_id, "lead", from);
    await permissions.assignRoleAsync(org.org_id, people.carol.person_id, "hr", from);
    await permissions.assignRoleAsync(org.org_id, people.dave.person_id, "admin", from);
    await permissions.assignRoleAsync(org.org_id, people.erin.person_id, "employee", from);

    // alice, carol, dave: full-day windows — always inside. bob: a one-minute
    // slot starting three hours from now — outside for the test's duration.
    const nowMinutes = Math.floor(Date.now()/1000 % 86400) / 60;
    const bobStart = Math.floor((nowMinutes + 180) % 1440);
    for (const who of ["alice", "carol", "dave"])
        await windows.setWindowAsync({org_id: org.org_id, person_id: people[who].person_id,
            timezone: "Etc/GMT", start_minute: 0, end_minute: 1439, days: [1,2,3,4,5,6,7],
            valid_from: "2026-01-01"});
    await windows.setWindowAsync({org_id: org.org_id, person_id: people.bob.person_id,
        timezone: "Etc/GMT", start_minute: bobStart, end_minute: (bobStart + 1) % 1440,
        days: [1,2,3,4,5,6,7], valid_from: "2026-01-01"});

    return {org_id: org.org_id, stamp, aliceEmail: `alice.${stamp}@example.invalid`,
        carolEmail: `carol.${stamp}@example.invalid`,
        ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM notification WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM notification_setting WHERE org_id=?", [w.org_id]);
    for (const table of ["task_relation", "task_watcher", "task_comment", "task_event", "task"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM working_window WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM time_entry_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM audit_event WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role_capability WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM role WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM capability_grant WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM employment WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dave", "erin"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
