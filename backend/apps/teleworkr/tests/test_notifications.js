/**
 * Tests A9 — the notification spine's feed and read watermark, the bits
 * added for the bell: feedAsync's delivered/digest-only filter (brief and
 * muted rows stay out, B4's and the person's own volume choice both
 * respected), markReadAsync's watermark semantics, the two new API ops,
 * and a cheap shape check over the whole declarative CATALOGUE.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests notifications
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const notifications = require(`${TELEWORKR_CONSTANTS.LIBDIR}/notifications.js`);
const notificationsapi = require(`${TELEWORKR_CONSTANTS.APIDIR}/notifications.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Notifications test failed: ${label} ${detail||""}`);}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "notifications")) {
        LOG.console("Skipping notifications test case, not called.\n"); return true;
    }
    LOG.console("\nA9 notification spine — feed & read watermark\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        _testCatalogueShape();
        await _testFeedAndRead(w);
        await _testAPI(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  notifications tests threw: ${err}\n`); LOG.error(`Notifications tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nNotifications tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

// ---------------------------------------------------------------------------
// the catalogue's own shape
// ---------------------------------------------------------------------------

function _testCatalogueShape() {
    LOG.console("\n the catalogue's own shape\n");
    const REQUIRED = ["label", "reaches", "channels", "timing", "breaks_window", "mutable"];
    for (const [name, entry] of Object.entries(notifications.CATALOGUE)) {
        _check(`${name} declares every required field`, REQUIRED.every(field => field in entry), JSON.stringify(entry));
        _check(`${name}'s channels is a non-empty array`, Array.isArray(entry.channels) && entry.channels.length > 0);
    }
    _check("timesheet_reminder is declared, for C7's nudge", Boolean(notifications.CATALOGUE.timesheet_reminder));
    _check("leave_decision is declared, for the requester-facing notice", Boolean(notifications.CATALOGUE.leave_decision));
}

// ---------------------------------------------------------------------------
// the feed and its read watermark
// ---------------------------------------------------------------------------

async function _testFeedAndRead(w) {
    LOG.console("\n the feed and its read watermark\n");

    const incident1 = await notifications.notifyAsync({org_id: w.org_id, category: "security_incident",
        recipient_person_id: w.alice, actor_person_id: w.bob, payload: {}, object_ref: "inc-1"});
    _check("a breaks_window category is delivered immediately", incident1.status == "delivered");

    const digestOne = await notifications.notifyAsync({org_id: w.org_id, category: "page_past_review",
        recipient_person_id: w.alice, actor_person_id: w.bob, payload: {}, object_ref: "page-1"});
    _check("a digest-channel category lands as digest with no declared window",
        digestOne.status == "digest", digestOne.status);

    const briefOne = await notifications.notifyAsync({org_id: w.org_id, category: "task_assigned",
        recipient_person_id: w.alice, actor_person_id: w.bob, payload: {}, object_ref: "task-1"});
    _check("a brief-only category never reaches delivered or digest — B4's own bucket",
        briefOne.status == "brief", briefOne.status);

    await notifications.setVolumeAsync(w.org_id, w.alice, "page_past_review", "off");
    const mutedOne = await notifications.notifyAsync({org_id: w.org_id, category: "page_past_review",
        recipient_person_id: w.alice, actor_person_id: w.bob, payload: {}, object_ref: "page-2"});
    _check("a category the person turned off is muted, not delivered", mutedOne.status == "muted");

    const feed1 = await notifications.feedAsync(w.org_id, w.alice);
    _check("the feed carries delivered and digest rows",
        feed1.notifications.some(n => n.notification_id == incident1.notification_id) &&
        feed1.notifications.some(n => n.notification_id == digestOne.notification_id));
    _check("the feed excludes brief rows — those are B4's, not the bell's",
        !feed1.notifications.some(n => n.notification_id == briefOne.notification_id));
    _check("the feed excludes muted rows — the person opted out",
        !feed1.notifications.some(n => n.notification_id == mutedOne.notification_id));
    _check("everything is unread before any watermark is ever set",
        feed1.read_until == 0 && feed1.unread_count == 2, JSON.stringify(feed1));

    // Both rows above were raised inside the same real second — indistinguishable
    // by timestamp from each other, which is the honest granularity of this
    // watermark. Test the boundary the watermark actually draws (before the
    // batch vs. at-or-after it), not an ordering within it that doesn't exist.
    const incident1Row = (await dblayer.getQueryOrThrow(
        "SELECT * FROM notification WHERE notification_id=?", [incident1.notification_id]))[0];

    await notifications.markReadAsync(w.org_id, w.alice, incident1Row.raised_at - 10);
    const feedBefore = await notifications.feedAsync(w.org_id, w.alice);
    _check("a watermark strictly before the batch leaves it entirely unread",
        feedBefore.unread_count == 2, JSON.stringify(feedBefore));

    const readUntil = await notifications.markReadAsync(w.org_id, w.alice, incident1Row.raised_at);
    _check("marking read returns the watermark it stored", readUntil == incident1Row.raised_at);

    const feedAfter = await notifications.feedAsync(w.org_id, w.alice);
    _check("a watermark at the batch's own timestamp clears it",
        feedAfter.unread_count == 0 && feedAfter.read_until == incident1Row.raised_at, JSON.stringify(feedAfter));

    _check("the feed respects a limit",
        (await notifications.feedAsync(w.org_id, w.alice, {limit: 1})).notifications.length == 1);

    _check("a stranger's feed is empty, not an error",
        (await notifications.feedAsync(w.org_id, w.bob)).notifications.length == 0);
}

// ---------------------------------------------------------------------------
// the API surface
// ---------------------------------------------------------------------------

async function _testAPI(w) {
    LOG.console("\n the notifications API\n");

    const feedApi = await notificationsapi.doService({op: "feed", id: w.aliceEmail, org: w.org_id});
    _check("op feed answers true with notifications, read_until and unread_count",
        feedApi.result === true && Array.isArray(feedApi.notifications) &&
        typeof feedApi.read_until == "number" && typeof feedApi.unread_count == "number");

    const markApi = await notificationsapi.doService({op: "mark_read", id: w.aliceEmail, org: w.org_id});
    _check("op mark_read answers true with the new watermark",
        markApi.result === true && typeof markApi.read_until == "number");

    const feedAfterMark = await notificationsapi.doService({op: "feed", id: w.aliceEmail, org: w.org_id});
    _check("the feed reflects the mark immediately", feedAfterMark.unread_count == 0);

    const invalid = await notificationsapi.doService({op: "frobnicate", id: w.aliceEmail, org: w.org_id});
    _check("an unknown op is refused", invalid.result === false);
}

// ---------------------------------------------------------------------------
// world and cleanup
// ---------------------------------------------------------------------------

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Notifications test ${stamp}`, home_jurisdiction: "GB"});
    const alice = await spine.createPersonAsync({display_name: "alice", email: `alice.${stamp}@example.invalid`});
    const bob = await spine.createPersonAsync({display_name: "bob", email: `bob.${stamp}@example.invalid`});
    return {org_id: org.org_id, stamp, alice: alice.person_id, bob: bob.person_id, aliceEmail: `alice.${stamp}@example.invalid`};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    await dblayer.runCmdBestEffortAsync("DELETE FROM notification WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM notification_setting WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM notification_read WHERE org_id=?", [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    if (w.alice) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w.alice]);
    if (w.bob) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w.bob]);
}
