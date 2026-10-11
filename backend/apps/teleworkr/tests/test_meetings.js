/**
 * Tests the minimal meeting/calendar-event entity: create/cancel/list, and
 * the meeting_starting lazy notification raise. No cost calculator, no
 * WebRTC room, no async video notes, no handoff notes — those are separate,
 * larger slices (E2/F1-F5), not this entity's job.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests meetings
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const meetings = require(`${TELEWORKR_CONSTANTS.LIBDIR}/meetings.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Meetings test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 120)}`, true);}
}

const _now = _ => Math.floor(Date.now()/1000);
const TODAY = new Date().toISOString().substring(0, 10);
const TOMORROW = new Date(Date.now() + 86400000).toISOString().substring(0, 10);
const YESTERDAY = new Date(Date.now() - 86400000).toISOString().substring(0, 10);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "meetings")) {
        LOG.console("Skipping meetings test case, not called.\n"); return true;
    }
    LOG.console("\nMeeting/calendar-event entity\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testValidation(w);
        await _testCreateAndList(w);
        await _testCancel(w);
        await _testStartingSoon(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  meetings tests threw: ${err}\n`); LOG.error(`Meetings tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
    }

    LOG.console(`\nMeetings tests: ${passed} passed, ${failed} failed.\n`);
    return failed == 0;
}

async function _testValidation(w) {
    LOG.console("\n validation\n");
    const start = _now() + 3600;
    await _checkThrows("an empty title is refused", _ =>
        meetings.createAsync({org_id: w.org_id, owner_person_id: w.alice, title: "  ",
            starts_at: start, ends_at: start + 1800}));
    await _checkThrows("starts_at at or after ends_at is refused", _ =>
        meetings.createAsync({org_id: w.org_id, owner_person_id: w.alice, title: "Sync",
            starts_at: start, ends_at: start}));
    await _checkThrows("an attendee not in the org roster is refused", _ =>
        meetings.createAsync({org_id: w.org_id, owner_person_id: w.alice, title: "Sync",
            starts_at: start, ends_at: start + 1800, attendee_person_ids: ["no-such-person"]}));
}

async function _testCreateAndList(w) {
    LOG.console("\n create, and list by range for owner and attendee\n");
    const start = Math.floor(new Date(`${TOMORROW}T10:00:00Z`).getTime()/1000);
    const meeting = await meetings.createAsync({org_id: w.org_id, owner_person_id: w.alice,
        title: "Sprint sync", starts_at: start, ends_at: start + 1800, attendee_person_ids: [w.bob]});
    _check("the owner is folded into the stored attendee list", meeting.attendees.includes(w.alice), JSON.stringify(meeting.attendees));
    _check("the named attendee is stored too", meeting.attendees.includes(w.bob), JSON.stringify(meeting.attendees));

    const forOwner = await meetings.forRangeAsync(w.org_id, w.alice, TOMORROW, TOMORROW);
    _check("the owner sees it in their range", forOwner.some(m => m.meeting_id == meeting.meeting_id), JSON.stringify(forOwner));
    _check("is_owner is true for the owner's own view",
        forOwner.find(m => m.meeting_id == meeting.meeting_id)?.is_owner === true);
    const forAttendee = await meetings.forRangeAsync(w.org_id, w.bob, TOMORROW, TOMORROW);
    _check("the attendee sees it too", forAttendee.some(m => m.meeting_id == meeting.meeting_id), JSON.stringify(forAttendee));
    _check("is_owner is false for an attendee who isn't the owner",
        forAttendee.find(m => m.meeting_id == meeting.meeting_id)?.is_owner === false);
    const forOutsider = await meetings.forRangeAsync(w.org_id, w.carol, TOMORROW, TOMORROW);
    _check("someone neither owner nor attendee does not see it", !forOutsider.some(m => m.meeting_id == meeting.meeting_id));
    const forYesterday = await meetings.forRangeAsync(w.org_id, w.alice, YESTERDAY, YESTERDAY);
    _check("it does not appear outside its own date", !forYesterday.some(m => m.meeting_id == meeting.meeting_id));

    w.ownedMeetingId = meeting.meeting_id;
}

async function _testCancel(w) {
    LOG.console("\n cancel — owner only\n");
    await _checkThrows("a non-owner cannot cancel", _ =>
        meetings.cancelAsync({org_id: w.org_id, meeting_id: w.ownedMeetingId, actor_person_id: w.bob}));
    await meetings.cancelAsync({org_id: w.org_id, meeting_id: w.ownedMeetingId, actor_person_id: w.alice});
    const after = await meetings.forRangeAsync(w.org_id, w.alice, TOMORROW, TOMORROW);
    _check("a cancelled meeting drops out of the range listing", !after.some(m => m.meeting_id == w.ownedMeetingId), JSON.stringify(after));
}

async function _testStartingSoon(w) {
    LOG.console("\n meeting_starting — lazy, 10 minutes out, deduped\n");
    const soon = await meetings.createAsync({org_id: w.org_id, owner_person_id: w.carol,
        title: "Starting soon", starts_at: _now() + 300, ends_at: _now() + 1800});
    const later = await meetings.createAsync({org_id: w.org_id, owner_person_id: w.carol,
        title: "Not yet", starts_at: _now() + 3600, ends_at: _now() + 5400});

    await meetings.raiseStartingSoonNotificationsAsync(w.org_id, w.carol);
    const soonRows = await dblayer.getQueryOrThrow(
        "SELECT * FROM notification WHERE org_id=? AND category='meeting_starting' AND recipient_person_id=? AND object_ref=?",
        [w.org_id, w.carol, soon.meeting_id]);
    _check("a meeting starting in 5 minutes raises meeting_starting", soonRows.length == 1, JSON.stringify(soonRows));
    const laterRows = await dblayer.getQueryOrThrow(
        "SELECT * FROM notification WHERE org_id=? AND category='meeting_starting' AND recipient_person_id=? AND object_ref=?",
        [w.org_id, w.carol, later.meeting_id]);
    _check("a meeting an hour out does not raise yet", laterRows.length == 0, JSON.stringify(laterRows));

    await meetings.raiseStartingSoonNotificationsAsync(w.org_id, w.carol);
    const afterSecondPoll = await dblayer.getQueryOrThrow(
        "SELECT * FROM notification WHERE org_id=? AND category='meeting_starting' AND recipient_person_id=? AND object_ref=?",
        [w.org_id, w.carol, soon.meeting_id]);
    _check("a second poll within the dedup window does not duplicate the notification", afterSecondPoll.length == 1, JSON.stringify(afterSecondPoll));
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Meetings test ${stamp}`, home_jurisdiction: "GB"});
    const people = {};
    for (const who of ["alice", "bob", "carol"])
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people))
        await spine.recordEmploymentAsync({org_id: org.org_id, person_id: people[who].person_id,
            status: "active", jurisdiction: "GB", manager_person_id: null, contract_type: "employee",
            valid_from: "2026-01-01", source: "manual"});

    return {org_id: org.org_id, stamp, ...Object.fromEntries(Object.entries(people).map(([k, v]) => [k, v.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["meeting", "notification", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
