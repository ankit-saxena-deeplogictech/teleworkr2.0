/**
 * Tests Telemeet (telemeet.js): invitation-only access, the six-person mesh
 * cap, targeted signalling, heartbeat expiry, the roster's local times and
 * "asleep" rows, shared notes, and the write-back — call time to the ledger,
 * notes to the task, actions to tasks, summaries to people who never joined.
 * Media itself is browser-to-browser and cannot be tested here.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests telemeet
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const meetings = require(`${TELEWORKR_CONSTANTS.LIBDIR}/meetings.js`);
const disclosure = require(`${TELEWORKR_CONSTANTS.LIBDIR}/disclosure.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);
const telemeet = require(`${TELEWORKR_CONSTANTS.LIBDIR}/telemeet.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Telemeet test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 100)}`, true);}
}
const _now = () => Math.floor(Date.now()/1000);

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "telemeet")) {
        LOG.console("Skipping telemeet test case, not called.\n"); return true;
    }
    LOG.console("\nTelemeet\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testCapabilitiesAndCreate(w);
        await _testInvitationOnly(w);
        await _testJoinAndCap(w);
        await _testRoster(w);
        await _testSignalling(w);
        await _testNotes(w);
        await _testStaleAndLeave(w);
        await _testEndAndWriteBack(w);
        await _testDisclosure(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  telemeet tests threw: ${err}\n`); LOG.error(`Telemeet tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nTelemeet tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

const A = w => ({org_id: w.org_id});

async function _testCapabilitiesAndCreate(w) {
    LOG.console("\n who may call, and creating rooms\n");
    _check("employee, lead, hr and admin hold telemeet.join; guest does not",
        ["employee", "lead", "hr", "admin"].every(r => capabilities.BUILTIN_ROLES[r].capabilities.some(([c]) => c == "telemeet.join")) &&
        !capabilities.BUILTIN_ROLES.guest.capabilities.some(([c]) => c == "telemeet.join"));
    await _checkThrows("a guest cannot start a call", _ =>
        telemeet.createRoomAsync({...A(w), actor_person_id: w.gina, title: "x", invitee_person_ids: [w.alice]}));
    await _checkThrows("a call needs a title", _ =>
        telemeet.createRoomAsync({...A(w), actor_person_id: w.alice, title: " ", invitee_person_ids: [w.bob]}));
    await _checkThrows("a call needs someone else invited", _ =>
        telemeet.createRoomAsync({...A(w), actor_person_id: w.alice, title: "solo", invitee_person_ids: []}));
    await _checkThrows("invitees must be in the org", _ =>
        telemeet.createRoomAsync({...A(w), actor_person_id: w.alice, title: "x", invitee_person_ids: ["nobody"]}));
    await _checkThrows("a task link must exist", _ =>
        telemeet.createRoomAsync({...A(w), actor_person_id: w.alice, title: "x", invitee_person_ids: [w.bob], task_ref: "TASK-999999"}));

    w.task = (await tasks.createTaskAsync({...A(w), actor_person_id: w.alice, title: "Pricing page"})).task_ref;
    const made = await telemeet.createRoomAsync({...A(w), actor_person_id: w.alice, title: "Pricing sync",
        invitee_person_ids: [w.bob, w.carol, w.dana], task_ref: w.task});
    w.room = made.room.room_id;
    _check("an instant room is created linked to the task", made.created && made.room.task_ref == w.task);

    const start = _now() + 3600;
    const meeting = await meetings.createAsync({...A(w), owner_person_id: w.alice, title: "Weekly", starts_at: start,
        ends_at: start + 1800, attendee_person_ids: [w.bob]});
    const fromMeeting = await telemeet.createRoomAsync({...A(w), actor_person_id: w.alice, meeting_id: meeting.meeting_id});
    const again = await telemeet.createRoomAsync({...A(w), actor_person_id: w.bob, meeting_id: meeting.meeting_id});
    _check("a room from a meeting uses its title and invites its attendees",
        fromMeeting.room.title == "Weekly" && fromMeeting.created);
    _check("asking again for the same meeting returns the open room, not a second one",
        !again.created && again.room.room_id == fromMeeting.room.room_id);
    await _checkThrows("a non-attendee can't open a room for someone else's meeting", _ =>
        telemeet.createRoomAsync({...A(w), actor_person_id: w.carol, meeting_id: meeting.meeting_id}));
    w.meetingRoom = fromMeeting.room.room_id;
}

async function _testInvitationOnly(w) {
    LOG.console("\n invitation only\n");
    for (const [who, label] of [[w.erin, "an uninvited employee"], [w.admin, "an admin"]]) {
        await _checkThrows(`${label} can't see the room`, _ => telemeet.roomAsync({...A(w), actor_person_id: who, room_id: w.room}));
        await _checkThrows(`${label} can't join it`, _ => telemeet.joinAsync({...A(w), actor_person_id: who, room_id: w.room}));
        await _checkThrows(`${label} can't poll its signals`, _ => telemeet.signalPollAsync({...A(w), actor_person_id: who, room_id: w.room}));
    }
    const listed = await telemeet.myRoomsAsync(w.org_id, w.erin);
    _check("an uninvited person's room list is empty of it", !listed.rooms.some(r => r.room_id == w.room));
    _check("an invitee sees it in their list", (await telemeet.myRoomsAsync(w.org_id, w.bob)).rooms.some(r => r.room_id == w.room));
}

async function _testJoinAndCap(w) {
    LOG.console("\n joining and the six-person cap\n");
    const first = await telemeet.joinAsync({...A(w), actor_person_id: w.alice, room_id: w.room});
    _check("the first person in has no peers to call", first.peers.length == 0 && first.me_in_call);
    _check("ICE servers are returned for the browser", Array.isArray(first.ice_servers) && first.ice_servers.length > 0 && first.ice_servers[0].urls);
    const second = await telemeet.joinAsync({...A(w), actor_person_id: w.bob, room_id: w.room});
    _check("the second person is told to call the first", JSON.stringify(second.peers) == JSON.stringify([w.alice]), JSON.stringify(second.peers));

    const ids = [w.alice, w.bob, w.carol, w.dana, w.erin, w.frank, w.gary];
    const big = (await telemeet.createRoomAsync({...A(w), actor_person_id: w.alice, title: "All hands", invitee_person_ids: ids.slice(1)})).room.room_id;
    for (const id of ids.slice(0, telemeet.MAX_PARTICIPANTS)) await telemeet.joinAsync({...A(w), actor_person_id: id, room_id: big});
    await _checkThrows("a seventh person is refused — the mesh holds six", _ =>
        telemeet.joinAsync({...A(w), actor_person_id: ids[6], room_id: big}));
    const rejoin = await telemeet.joinAsync({...A(w), actor_person_id: w.alice, room_id: big});
    _check("someone already in can rejoin even when full", rejoin.me_in_call && rejoin.participants.length == 6);
    w.bigRoom = big;
}

async function _testRoster(w) {
    LOG.console("\n the roster — local times and deliberate absence\n");
    const nowMin = Math.floor((_now() % 86400)/60);
    const start = [60, 400, 800, 1200].find(c => !(nowMin >= c && nowMin < c + 60));
    await windows.setWindowAsync({org_id: w.org_id, person_id: w.dana, timezone: "UTC", start_minute: start,
        end_minute: start + 60, days: [1, 2, 3, 4, 5, 6, 7], valid_from: "2026-01-01"});
    const state = await telemeet.roomAsync({...A(w), actor_person_id: w.alice, room_id: w.room});
    const dana = state.people.find(p => p.person_id == w.dana), bob = state.people.find(p => p.person_id == w.bob);
    _check("dana, outside her declared hours and not in the call, reads as asleep with a local time",
        dana.asleep && /^\d\d:\d\d$/.test(dana.local_time), JSON.stringify(dana));
    _check("bob is in the call and is never shown as asleep", bob.in_call && !bob.asleep);
    _check("the roster marks me and the owner", state.people.find(p => p.person_id == w.alice).is_me &&
        state.people.find(p => p.person_id == w.alice).is_owner);
}

async function _testSignalling(w) {
    LOG.console("\n signalling\n");
    await telemeet.signalSendAsync({...A(w), actor_person_id: w.bob, room_id: w.room, to_person_id: w.alice, kind: "offer", payload: {sdp: "o1"}});
    await telemeet.signalSendAsync({...A(w), actor_person_id: w.bob, room_id: w.room, to_person_id: w.alice, kind: "ice", payload: {candidate: "c1"}});
    const got = await telemeet.signalPollAsync({...A(w), actor_person_id: w.alice, room_id: w.room, after: 0});
    _check("alice gets both messages, in order, from bob", got.signals.length == 2 && got.signals[0].kind == "offer" &&
        got.signals[1].kind == "ice" && got.signals.every(s => s.from_person_id == w.bob), JSON.stringify(got.signals.map(s => s.kind)));
    _check("payloads round-trip", got.signals[0].payload.sdp == "o1");
    const rest = await telemeet.signalPollAsync({...A(w), actor_person_id: w.alice, room_id: w.room, after: got.signals[0].signal_id});
    _check("polling after a signal id returns only newer ones", rest.signals.length == 1 && rest.signals[0].kind == "ice");
    const again = await telemeet.signalPollAsync({...A(w), actor_person_id: w.alice, room_id: w.room, after: 0});
    _check("polling is idempotent — a repeat returns the same messages", again.signals.length == 2);
    const bobsOwn = await telemeet.signalPollAsync({...A(w), actor_person_id: w.bob, room_id: w.room, after: 0});
    _check("bob doesn't receive a message addressed to alice", bobsOwn.signals.length == 0);

    await _checkThrows("you can't signal someone who isn't in the call", _ =>
        telemeet.signalSendAsync({...A(w), actor_person_id: w.alice, room_id: w.room, to_person_id: w.carol, kind: "offer", payload: {}}));
    await _checkThrows("you can't signal yourself", _ =>
        telemeet.signalSendAsync({...A(w), actor_person_id: w.alice, room_id: w.room, to_person_id: w.alice, kind: "offer", payload: {}}));
    await _checkThrows("an unknown signal kind is refused", _ =>
        telemeet.signalSendAsync({...A(w), actor_person_id: w.alice, room_id: w.room, to_person_id: w.bob, kind: "video", payload: {}}));
    await _checkThrows("an oversized signal is refused", _ =>
        telemeet.signalSendAsync({...A(w), actor_person_id: w.alice, room_id: w.room, to_person_id: w.bob, kind: "offer", payload: "x".repeat(70000)}));
    await _checkThrows("you must be in the call to signal", _ =>
        telemeet.signalSendAsync({...A(w), actor_person_id: w.carol, room_id: w.room, to_person_id: w.alice, kind: "offer", payload: {}}));
}

async function _testNotes(w) {
    LOG.console("\n shared notes\n");
    await _checkThrows("someone not in the call can't add notes", _ =>
        telemeet.noteAddAsync({...A(w), actor_person_id: w.carol, room_id: w.room, text: "hi"}));
    await telemeet.noteAddAsync({...A(w), actor_person_id: w.alice, room_id: w.room, text: "Pricing strip ships with three tiers"});
    const decision = (await telemeet.noteAddAsync({...A(w), actor_person_id: w.bob, room_id: w.room, kind: "decision", text: "Launch moves to 12 July"})).line;
    await telemeet.noteAddAsync({...A(w), actor_person_id: w.bob, room_id: w.room, kind: "action", text: "Finish the fold before Thursday", assignee_person_id: w.bob});
    await _checkThrows("an action can only go to someone invited", _ =>
        telemeet.noteAddAsync({...A(w), actor_person_id: w.alice, room_id: w.room, kind: "action", text: "x", assignee_person_id: w.erin}));
    await _checkThrows("an unknown kind is refused", _ => telemeet.noteAddAsync({...A(w), actor_person_id: w.alice, room_id: w.room, kind: "idea", text: "x"}));
    await _checkThrows("an empty line is refused", _ => telemeet.noteAddAsync({...A(w), actor_person_id: w.alice, room_id: w.room, text: "  "}));
    await _checkThrows("a too-long line is refused", _ => telemeet.noteAddAsync({...A(w), actor_person_id: w.alice, room_id: w.room, text: "x".repeat(501)}));

    await telemeet.noteEditAsync({...A(w), actor_person_id: w.alice, room_id: w.room, line_id: decision.line_id, text: "Launch moves to 14 July"});
    const state = await telemeet.roomAsync({...A(w), actor_person_id: w.carol, room_id: w.room});
    _check("anyone in the call can edit a line, and invitees see the notes", state.notes.length == 3 &&
        state.notes.find(n => n.line_id == decision.line_id).text == "Launch moves to 14 July" &&
        state.notes.find(n => n.line_id == decision.line_id).updated_by == w.alice);
    await telemeet.noteAddAsync({...A(w), actor_person_id: w.alice, room_id: w.room, text: "scratch"});
    const scratch = (await telemeet.roomAsync({...A(w), actor_person_id: w.alice, room_id: w.room})).notes.find(n => n.text == "scratch");
    await telemeet.noteEditAsync({...A(w), actor_person_id: w.bob, room_id: w.room, line_id: scratch.line_id, remove: true});
    _check("a removed line disappears", !(await telemeet.roomAsync({...A(w), actor_person_id: w.alice, room_id: w.room})).notes.some(n => n.text == "scratch"));
}

async function _testStaleAndLeave(w) {
    LOG.console("\n presence, leaving, and logging the time\n");
    // bob "closed his laptop": joined an hour ago, last seen ten minutes into the call
    const t = _now();
    await dblayer.runCmdOrThrow("UPDATE room_participant SET joined_at=?, last_seen_at=? WHERE room_id=? AND person_id=? AND left_at IS NULL",
        [t - 3600, t - 3000, w.room, w.bob]);
    const state = await telemeet.roomAsync({...A(w), actor_person_id: w.alice, room_id: w.room});
    _check("a participant with no heartbeat for 30s is no longer in the call", !state.participants.some(p => p.person_id == w.bob));
    const stay = (await dblayer.getQueryOrThrow("SELECT * FROM room_participant WHERE room_id=? AND person_id=?", [w.room, w.bob]))[0];
    _check("their stay was closed at the last moment they were seen", stay.left_at == t - 3000, `${stay.left_at} vs ${t - 3000}`);
    const entry = (await dblayer.getQueryOrThrow("SELECT * FROM time_entry_event WHERE org_id=? AND client_event_id=?", [w.org_id, `telemeet:${stay.participant_id}`]))[0];
    _check("the stay went to the time ledger against the task, 10 minutes, non-billable, category meeting",
        entry && entry.duration_seconds == 600 && entry.task_ref == w.task && entry.category == "meeting" && entry.billable == 0, JSON.stringify(entry));
    await telemeet.roomAsync({...A(w), actor_person_id: w.alice, room_id: w.room});
    const count = (await dblayer.getQueryOrThrow("SELECT COUNT(*) AS n FROM time_entry_event WHERE org_id=? AND client_event_id=?", [w.org_id, `telemeet:${stay.participant_id}`]))[0].n;
    _check("reading the room again does not log it twice", count == 1);

    // a quick pop-in is not worth a ledger row
    await telemeet.joinAsync({...A(w), actor_person_id: w.carol, room_id: w.room});
    const left = await telemeet.leaveAsync({...A(w), actor_person_id: w.carol, room_id: w.room});
    const carolEntries = (await dblayer.getQueryOrThrow("SELECT COUNT(*) AS n FROM time_entry_event WHERE org_id=? AND person_id=?", [w.org_id, w.carol]))[0].n;
    _check("leaving works and a stay under a minute isn't logged", left.left && !left.ended && carolEntries == 0);
    const leftAgain = await telemeet.leaveAsync({...A(w), actor_person_id: w.carol, room_id: w.room});
    _check("leaving twice is harmless", !leftAgain.left);
    await _checkThrows("after leaving you can't signal", _ =>
        telemeet.signalSendAsync({...A(w), actor_person_id: w.carol, room_id: w.room, to_person_id: w.alice, kind: "offer", payload: {}}));
}

async function _testEndAndWriteBack(w) {
    LOG.console("\n ending the call — the write-back\n");
    await _checkThrows("only whoever started the call can end it for everyone", _ => telemeet.endAsync({...A(w), actor_person_id: w.bob, room_id: w.room}));
    await telemeet.joinAsync({...A(w), actor_person_id: w.bob, room_id: w.room});
    const tasksBefore = (await dblayer.getQueryOrThrow("SELECT COUNT(*) AS n FROM task WHERE org_id=?", [w.org_id]))[0].n;
    const ended = await telemeet.endAsync({...A(w), actor_person_id: w.alice, room_id: w.room});
    _check("the owner can end it", ended.ended);

    const tasksAfter = (await dblayer.getQueryOrThrow("SELECT COUNT(*) AS n FROM task WHERE org_id=?", [w.org_id]))[0].n;
    _check("the one action line became exactly one task", tasksAfter == tasksBefore + 1, `${tasksBefore} -> ${tasksAfter}`);
    const actionTask = (await dblayer.getQueryOrThrow("SELECT * FROM task WHERE org_id=? AND title=?", [w.org_id, "Finish the fold before Thursday"]))[0];
    _check("that task is assigned to the person named in the line", actionTask && actionTask.assignee_person_id == w.bob);
    const line = (await dblayer.getQueryOrThrow("SELECT task_ref_created FROM room_note_line WHERE room_id=? AND kind='action'", [w.room]))[0];
    _check("the action line records which task it became", line.task_ref_created == actionTask.task_ref);

    const comment = (await dblayer.getQueryOrThrow(
        "SELECT c.body FROM task_comment c JOIN task t ON t.task_id=c.task_id WHERE t.org_id=? AND t.task_ref=?", [w.org_id, w.task]))[0];
    _check("the notes and decisions were posted to the linked task",
        comment && comment.body.includes("Pricing strip ships with three tiers") && comment.body.includes("Launch moves to 14 July") &&
        comment.body.includes("Decisions"), comment && comment.body.substring(0, 200));

    const summary = await dblayer.getQueryOrThrow(
        "SELECT recipient_person_id FROM notification WHERE org_id=? AND object_ref=? AND category='comment_mention'", [w.org_id, w.room]);
    const got = summary.map(r => r.recipient_person_id);
    _check("the person who never joined (dana) got the summary; everyone who joined, even briefly, did not",
        got.includes(w.dana) && !got.includes(w.alice) && !got.includes(w.bob) && !got.includes(w.carol), JSON.stringify(got));

    await telemeet.endAsync({...A(w), actor_person_id: w.alice, room_id: w.room});
    const tasksFinal = (await dblayer.getQueryOrThrow("SELECT COUNT(*) AS n FROM task WHERE org_id=?", [w.org_id]))[0].n;
    _check("ending twice does not create the task twice", tasksFinal == tasksAfter);
    await _checkThrows("an ended room can't be joined", _ => telemeet.joinAsync({...A(w), actor_person_id: w.bob, room_id: w.room}));
    await _checkThrows("an ended room's notes are read-only", _ => telemeet.noteAddAsync({...A(w), actor_person_id: w.alice, room_id: w.room, text: "late"}));
    const after = await telemeet.roomAsync({...A(w), actor_person_id: w.dana, room_id: w.room});
    _check("an invitee can still read the ended room's notes", after.notes.length == 3 && after.room.ended_at);

    // the last person leaving ends a room by itself
    await telemeet.joinAsync({...A(w), actor_person_id: w.alice, room_id: w.meetingRoom});
    const last = await telemeet.leaveAsync({...A(w), actor_person_id: w.alice, room_id: w.meetingRoom});
    _check("the last person to leave ends the room", last.ended === true);
}

async function _testDisclosure(w) {
    LOG.console("\n what employees are told\n");
    const mirror = await disclosure.mirrorAsync({org_id: w.org_id, person_id: w.alice, viewer_person_id: w.alice});
    _check("the mirror states that call audio and video is never recorded or stored",
        mirror.does_not_see.some(item => item.item == "call audio and video" && /never receives, records or stores/.test(item.why)));
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Telemeet test ${stamp}`, home_jurisdiction: "IN"});
    const roleOf = {alice: "employee", bob: "employee", carol: "lead", dana: "employee", erin: "employee",
        frank: "employee", gary: "employee", admin: "admin", gina: "guest"};
    const people = {};
    for (const who of Object.keys(roleOf))
        people[who] = await spine.createPersonAsync({display_name: who, email: `${who}.${stamp}@example.invalid`});
    for (const who of Object.keys(people)) await spine.recordEmploymentAsync({org_id: org.org_id,
        person_id: people[who].person_id, status: "active", jurisdiction: "IN", contract_type: "employee",
        valid_from: "2026-01-01", source: "manual"});
    await permissions.ensureBuiltinRolesAsync(org.org_id);
    const from = {granted_by: "system", valid_from: "2026-01-01"};
    for (const [who, role] of Object.entries(roleOf)) await permissions.assignRoleAsync(org.org_id, people[who].person_id, role, from);
    return {org_id: org.org_id, stamp, ...Object.fromEntries(Object.entries(people).map(([name, p]) => [name, p.person_id]))};
}

async function _cleanup(w) {
    if (!w?.org_id) return;
    for (const table of ["room_signal", "room_note_line", "room_participant", "room_invitee", "meeting_room", "meeting",
        "time_entry_event", "notification", "audit_event", "working_window",
        "capability_grant", "role_capability", "role", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    for (const table of ["task_event", "task_comment", "task_watcher"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    for (const table of ["task_relation", "task"]) await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dana", "erin", "frank", "gary", "admin", "gina"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
