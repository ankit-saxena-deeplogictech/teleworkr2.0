/**
 * Telemeet — video rooms (wireframe F1).
 *
 * Audio and video are peer-to-peer WebRTC between the browsers in the room, in
 * a full mesh, so a room is capped at six people. This module is only the
 * rendezvous: who is invited, who is in, the short-lived signalling messages
 * (offers, answers, ICE candidates) the browsers pass through us, and the
 * shared notes. The server never receives, records or stores media — which is
 * why disclosure.js can say so plainly. Recording and a whiteboard are out of
 * scope, as are a live cost counter and an SFU; the wireframe itself leaves
 * "self-hosted WebRTC vs a vendor" open.
 *
 * Access is by invitation only: a room's invitees (the scheduled meeting's
 * attendees plus anyone added). There is no admin or HR way into a room.
 *
 * Presence is a heartbeat. A participant with no heartbeat for 30 seconds is
 * treated as gone, and the next call that touches the room finalises their stay
 * — so a closed laptop lid still produces a correct time entry, ended at the
 * last moment they were seen.
 *
 * Write-back (F1: "on leaving, the time logs to the task and the notes attach
 * to it"):
 *   - leaving logs that stay to the ledger for that person (category "meeting",
 *     not billable, idempotent client_event_id), against the task if the room
 *     has one. Stays under a minute are not logged.
 *   - when the room ends (the owner ends it, or the last person leaves) the
 *     notes post to the task as a comment, every Action line becomes a task,
 *     every Decision line becomes part of that comment (no decision log exists
 *     to hold them), and invitees who never joined — typically because they
 *     were asleep — are sent a summary notification. With no task, the notes
 *     stay on the room, readable by its invitees.
 * Side effects run after the claim that ends the room commits, each in its own
 * try/catch, and none runs inside a transaction (dblayer's serial queue would
 * deadlock a read made from inside a transaction callback).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const windows = require(`${TELEWORKR_CONSTANTS.LIBDIR}/windows.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);
const tasks = require(`${TELEWORKR_CONSTANTS.LIBDIR}/tasks.js`);
const notifications = require(`${TELEWORKR_CONSTANTS.LIBDIR}/notifications.js`);

const MAX_PARTICIPANTS = 6;             // full-mesh limit
const MAX_INVITEES = 50;
const STALE_SECONDS = 30;
const SIGNAL_TTL_SECONDS = 900;
const MAX_SIGNAL_BYTES = 60000;
const MAX_PENDING_SIGNALS = 300;        // per recipient, a runaway guard
const MIN_LOGGED_SECONDS = 60;
const MAX_NOTE_LENGTH = 500;
const MAX_NOTE_LINES = 200;
const NOTE_KINDS = Object.freeze(["note", "action", "decision"]);
const SIGNAL_KINDS = Object.freeze(["offer", "answer", "ice"]);
const DEFAULT_ICE = Object.freeze([{urls: "stun:stun.l.google.com:19302"}]);

const _now = _ => Math.floor(Date.now()/1000);
const _uuid = _ => serverutils.generateUUID(false);
const _dateOf = epoch => new Date(epoch*1000).toISOString().substring(0, 10);

async function _requireJoinAsync(org_id, actor_person_id) {
    await permissions.requireAsync({org_id, actor_person_id, capability: "telemeet.join"});
}

async function _roomRowAsync(org_id, room_id) {
    const room = (await dblayer.getQueryOrThrow("SELECT * FROM meeting_room WHERE org_id=? AND room_id=?", [org_id, room_id]))[0];
    if (!room) throw new Error("No such room.");
    return room;
}

/** The room, provided the actor was invited to it. Invitation is the only way in. */
async function _roomForInviteeAsync(org_id, room_id, person_id) {
    await _requireJoinAsync(org_id, person_id);
    const room = await _roomRowAsync(org_id, room_id);
    const invited = (await dblayer.getQueryOrThrow("SELECT 1 AS x FROM room_invitee WHERE room_id=? AND person_id=?", [room_id, person_id]))[0];
    if (!invited) throw new Error("You weren't invited to this room.");
    return room;
}

async function _liveParticipantsAsync(room_id) {
    return await dblayer.getQueryOrThrow(
        "SELECT * FROM room_participant WHERE room_id=? AND left_at IS NULL AND last_seen_at >= ? ORDER BY joined_at ASC",
        [room_id, _now() - STALE_SECONDS]);
}

function _iceServers() {
    const configured = TELEWORKR_CONSTANTS.CONF?.ice_servers;
    return Array.isArray(configured) && configured.length ? configured : DEFAULT_ICE;
}

// ---------------------------------------------------------------------------
// creating and listing rooms
// ---------------------------------------------------------------------------

/**
 * Creates a room, or returns the open one that already exists for the meeting.
 * @param {object} request {org_id, actor_person_id, meeting_id, task_ref, title, invitee_person_ids}
 *      From a scheduled meeting: its attendees are invited and its title used (the actor must be one of them).
 *      Instant: a title and at least one other invitee.
 * @returns {object} {room, created}
 */
exports.createRoomAsync = async function(request) {
    const {org_id, actor_person_id} = request;
    await _requireJoinAsync(org_id, actor_person_id);
    const roster = await spine.rosterAsOfAsync(org_id);
    const inRoster = id => roster.some(p => p.person_id == id);

    let title = (request.title || "").trim(), invitees = new Set([actor_person_id]);
    if (request.meeting_id) {
        const meeting = (await dblayer.getQueryOrThrow("SELECT * FROM meeting WHERE org_id=? AND meeting_id=?", [org_id, request.meeting_id]))[0];
        if (!meeting) throw new Error("No such meeting.");
        if (meeting.status != "scheduled") throw new Error("That meeting was cancelled.");
        const attendees = JSON.parse(meeting.attendees);
        if (!attendees.includes(actor_person_id)) throw new Error("You aren't an attendee of that meeting.");

        const open = (await dblayer.getQueryOrThrow(
            "SELECT * FROM meeting_room WHERE org_id=? AND meeting_id=? AND ended_at IS NULL", [org_id, request.meeting_id]))[0];
        if (open) return {room: open, created: false};
        attendees.forEach(id => invitees.add(id));
        title = title || meeting.title;
    }
    for (const id of request.invitee_person_ids || []) {
        if (!inRoster(id)) throw new Error(`${id} is not a person in this org.`);
        invitees.add(id);
    }
    if (!title) throw new Error("A call needs a title.");
    if (title.length > 120) throw new Error("A call title may be at most 120 characters.");
    if (invitees.size < 2) throw new Error("Invite at least one other person.");
    if (invitees.size > MAX_INVITEES) throw new Error(`A room may invite at most ${MAX_INVITEES} people.`);

    let task_ref = null;
    if (request.task_ref) {
        const task = await tasks.taskSummaryAsync({org_id, actor_person_id, task_ref: request.task_ref});
        if (!task) throw new Error(`Task ${request.task_ref} was not found.`);
        task_ref = task.task_ref;
    }

    const room = {room_id: _uuid(), org_id, meeting_id: request.meeting_id || null, task_ref, title,
        created_by: actor_person_id, created_at: _now(), started_at: null, ended_at: null, ended_by: null};
    await dblayer.runInTransactionAsync(async exec => {
        await exec.runCmd(`INSERT INTO meeting_room (room_id, org_id, meeting_id, task_ref, title, created_by, created_at)
            VALUES (?,?,?,?,?,?,?)`, [room.room_id, org_id, room.meeting_id, task_ref, title, actor_person_id, room.created_at]);
        for (const person_id of invitees)
            await exec.runCmd("INSERT INTO room_invitee (room_id, person_id, org_id) VALUES (?,?,?)", [room.room_id, person_id, org_id]);
    });
    return {room, created: true};
}

/** Open rooms the actor is invited to, with how many are in each right now. */
exports.myRoomsAsync = async function(org_id, actor_person_id) {
    await _requireJoinAsync(org_id, actor_person_id);
    const rooms = await dblayer.getQueryOrThrow(
        `SELECT r.room_id, r.title, r.task_ref, r.meeting_id, r.created_by, r.created_at FROM meeting_room r
            JOIN room_invitee i ON i.room_id=r.room_id WHERE r.org_id=? AND i.person_id=? AND r.ended_at IS NULL
            ORDER BY r.created_at DESC`, [org_id, actor_person_id]);
    const roster = await spine.rosterAsOfAsync(org_id);
    const out = [];
    for (const room of rooms) {
        const live = await _liveParticipantsAsync(room.room_id);
        out.push({...room, owner_name: roster.find(p => p.person_id == room.created_by)?.display_name || "Someone",
            live_count: live.length, in_it: live.some(p => p.person_id == actor_person_id)});
    }
    return {rooms: out};
}

// ---------------------------------------------------------------------------
// state, joining, presence
// ---------------------------------------------------------------------------

/** Local time and whether it is inside the person's declared working window, for the roster. */
async function _presenceFactsAsync(org_id, person, at) {
    const facts = {local_time: null, asleep: false};
    try {
        const status = await windows.withinWindowAtAsync(org_id, person.person_id, at);
        const timezone = status.window?.timezone || person.home_timezone;
        if (timezone) facts.local_time = new Intl.DateTimeFormat("en-GB", {timeZone: timezone, hour: "2-digit", minute: "2-digit"}).format(new Date(at*1000));
        facts.asleep = Boolean(status.window) && !status.within;
    } catch (err) {LOG.error(`Could not read presence facts for ${person.person_id}: ${err}`);}
    return facts;
}

/**
 * The whole room as the actor should see it — participants, the roster of invitees with local
 * times and the deliberate "asleep" rows, notes and ICE servers. Also the heartbeat's response.
 * @param {object} request {org_id, actor_person_id, room_id}
 */
exports.roomAsync = async function(request) {
    const {org_id, actor_person_id, room_id} = request;
    const room = await _roomForInviteeAsync(org_id, room_id, actor_person_id);
    if (!room.ended_at) await _expireStaleAsync(room);
    const fresh = await _roomRowAsync(org_id, room_id);

    const roster = await spine.rosterAsOfAsync(org_id);
    const invitees = (await dblayer.getQueryOrThrow("SELECT person_id FROM room_invitee WHERE room_id=?", [room_id])).map(r => r.person_id);
    const live = fresh.ended_at ? [] : await _liveParticipantsAsync(room_id);
    const liveIds = new Set(live.map(p => p.person_id));
    const at = _now();

    const people = [];
    for (const person_id of invitees) {
        const person = roster.find(p => p.person_id == person_id) || {person_id, display_name: "Former colleague"};
        const facts = await _presenceFactsAsync(org_id, person, at);
        const joinedEver = (await dblayer.getQueryOrThrow("SELECT 1 AS x FROM room_participant WHERE room_id=? AND person_id=? LIMIT 1", [room_id, person_id]))[0];
        people.push({person_id, display_name: person.display_name, is_me: person_id == actor_person_id,
            is_owner: person_id == fresh.created_by, in_call: liveIds.has(person_id), has_joined: Boolean(joinedEver),
            local_time: facts.local_time, asleep: facts.asleep && !liveIds.has(person_id)});
    }
    const notes = (await dblayer.getQueryOrThrow(
        "SELECT * FROM room_note_line WHERE room_id=? AND deleted_at IS NULL ORDER BY created_at ASC", [room_id]))
        .map(line => ({...line, mine: line.created_by == actor_person_id}));
    return {room: fresh, me_in_call: liveIds.has(actor_person_id), participants: live.map(p => ({person_id: p.person_id,
        joined_at: p.joined_at})), people, notes, ice_servers: _iceServers(), max_participants: MAX_PARTICIPANTS,
        server_time: at, is_owner: fresh.created_by == actor_person_id};
}

/**
 * Joins the room. Returns the other people already in it — the joiner makes the offers.
 * @param {object} request {org_id, actor_person_id, room_id}
 */
exports.joinAsync = async function(request) {
    const {org_id, actor_person_id, room_id} = request;
    const room = await _roomForInviteeAsync(org_id, room_id, actor_person_id);
    if (room.ended_at) throw new Error("This call has ended.");
    await _expireStaleAsync(room);

    const live = await _liveParticipantsAsync(room_id);
    const mine = live.find(p => p.person_id == actor_person_id);
    if (!mine && live.length >= MAX_PARTICIPANTS) throw new Error(
        `This room is full — a call holds at most ${MAX_PARTICIPANTS} people.`);

    const now = _now();
    if (mine) {
        // joining again from a second tab or after a refresh: the old stay closes, a new one opens
        await _finaliseStayAsync(room, mine, now);
    }
    await dblayer.runCmdOrThrow(`INSERT INTO room_participant (participant_id, room_id, org_id, person_id, joined_at, last_seen_at)
        VALUES (?,?,?,?,?,?)`, [_uuid(), room_id, org_id, actor_person_id, now, now]);
    if (!room.started_at) await dblayer.runCmdOrThrow("UPDATE meeting_room SET started_at=? WHERE room_id=? AND started_at IS NULL", [now, room_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM room_signal WHERE room_id=? AND (to_person_id=? OR from_person_id=?)",
        [room_id, actor_person_id, actor_person_id]);

    const state = await exports.roomAsync(request);
    return {...state, peers: state.participants.filter(p => p.person_id != actor_person_id).map(p => p.person_id)};
}

/** Marks the actor present. Returns the room, so one poll carries presence, roster and notes. */
exports.heartbeatAsync = async function(request) {
    const {org_id, actor_person_id, room_id} = request;
    await _roomForInviteeAsync(org_id, room_id, actor_person_id);
    await dblayer.runCmdOrThrow("UPDATE room_participant SET last_seen_at=? WHERE room_id=? AND person_id=? AND left_at IS NULL",
        [_now(), room_id, actor_person_id]);
    return await exports.roomAsync(request);
}

// ---------------------------------------------------------------------------
// leaving, ending, and the write-back
// ---------------------------------------------------------------------------

/**
 * Closes one stay and writes it to the ledger. Safe to call twice: the ledger write is idempotent
 * (client_event_id) and the stay is only closed if still open.
 */
async function _finaliseStayAsync(room, participant, endedAt) {
    const left_at = Math.max(participant.joined_at, endedAt);
    await dblayer.runCmdOrThrow("UPDATE room_participant SET left_at=? WHERE participant_id=? AND left_at IS NULL", [left_at, participant.participant_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM room_signal WHERE room_id=? AND (to_person_id=? OR from_person_id=?)",
        [room.room_id, participant.person_id, participant.person_id]);

    const seconds = left_at - participant.joined_at;
    if (participant.time_logged || seconds < MIN_LOGGED_SECONDS) return;
    try {
        await time.recordEventAsync({org_id: room.org_id, person_id: participant.person_id,
            client_event_id: `telemeet:${participant.participant_id}`, entry_date: _dateOf(participant.joined_at),
            task_ref: room.task_ref, source: "manual", category: "meeting", note: `Call — ${room.title}`,
            started_at: participant.joined_at, ended_at: left_at, duration_seconds: seconds, billable: 0});
        await dblayer.runCmdOrThrow("UPDATE room_participant SET time_logged=1 WHERE participant_id=?", [participant.participant_id]);
    } catch (err) {LOG.error(`Could not log call time for ${participant.person_id} in ${room.room_id}: ${err}`);}
}

/** Anyone whose heartbeat stopped is finalised at the last moment they were seen. */
async function _expireStaleAsync(room) {
    const stale = await dblayer.getQueryOrThrow(
        "SELECT * FROM room_participant WHERE room_id=? AND left_at IS NULL AND last_seen_at < ?", [room.room_id, _now() - STALE_SECONDS]);
    for (const participant of stale) await _finaliseStayAsync(room, participant, participant.last_seen_at);
    if (stale.length && !(await _liveParticipantsAsync(room.room_id)).length && !room.ended_at) await _endRoomAsync(room, null);
}

/**
 * Leaves the call. The last person to leave ends the room.
 * @param {object} request {org_id, actor_person_id, room_id}
 */
exports.leaveAsync = async function(request) {
    const {org_id, actor_person_id, room_id} = request;
    const room = await _roomForInviteeAsync(org_id, room_id, actor_person_id);
    const mine = (await dblayer.getQueryOrThrow(
        "SELECT * FROM room_participant WHERE room_id=? AND person_id=? AND left_at IS NULL", [room_id, actor_person_id]))[0];
    if (mine) await _finaliseStayAsync(room, mine, _now());
    let ended = Boolean(room.ended_at);
    if (!ended && !(await _liveParticipantsAsync(room_id)).length) {await _endRoomAsync(room, null); ended = true;}
    return {left: Boolean(mine), ended};
}

/** The owner ends the call for everyone. */
exports.endAsync = async function(request) {
    const {org_id, actor_person_id, room_id} = request;
    const room = await _roomForInviteeAsync(org_id, room_id, actor_person_id);
    if (room.created_by != actor_person_id) throw new Error("Only whoever started the call can end it for everyone.");
    if (room.ended_at) return {ended: true, already: true};
    await _endRoomAsync(room, actor_person_id);
    return {ended: true};
}

/**
 * Ends the room exactly once (the claim), then writes everything back. Side effects are separate
 * try/catch blocks: a failed task comment must not stop the actions becoming tasks.
 */
async function _endRoomAsync(room, ended_by) {
    const claimed = await dblayer.runInTransactionAsync(async exec => {
        const row = (await exec.getQuery("SELECT ended_at FROM meeting_room WHERE room_id=?", [room.room_id]))[0];
        if (!row || row.ended_at) return false;
        await exec.runCmd("UPDATE meeting_room SET ended_at=?, ended_by=? WHERE room_id=?", [_now(), ended_by, room.room_id]);
        return true;
    });
    if (!claimed) return;

    const stillIn = await dblayer.getQueryOrThrow("SELECT * FROM room_participant WHERE room_id=? AND left_at IS NULL", [room.room_id]);
    for (const participant of stillIn) await _finaliseStayAsync(room, participant, _now());
    await dblayer.runCmdBestEffortAsync("DELETE FROM room_signal WHERE room_id=?", [room.room_id]);

    const lines = await dblayer.getQueryOrThrow(
        "SELECT * FROM room_note_line WHERE room_id=? AND deleted_at IS NULL ORDER BY created_at ASC", [room.room_id]);
    const roster = await spine.rosterAsOfAsync(room.org_id);
    const nameOf = id => roster.find(p => p.person_id == id)?.display_name || "Someone";
    const actor = ended_by || room.created_by;

    // actions become tasks
    for (const line of lines.filter(l => l.kind == "action")) {
        try {
            const task = await tasks.createTaskAsync({org_id: room.org_id, actor_person_id: line.created_by, title: line.text.substring(0, 200),
                description: `From the call "${room.title}"${room.task_ref ? ` (${room.task_ref})` : ""}.`,
                assignee_person_id: line.assignee_person_id || line.created_by});
            await dblayer.runCmdOrThrow("UPDATE room_note_line SET task_ref_created=? WHERE line_id=?", [task.task_ref, line.line_id]);
        } catch (err) {LOG.error(`Could not turn call action ${line.line_id} into a task: ${err}`);}
    }

    // notes and decisions go back to the task
    if (room.task_ref && lines.length) try {
        const part = (heading, kind) => {
            const rows = lines.filter(l => l.kind == kind);
            return rows.length ? `${heading}\n${rows.map(l => `- ${l.text}${kind == "action" ? ` (${nameOf(l.assignee_person_id || l.created_by)})` : ""}`).join("\n")}` : "";
        };
        const body = [`Call notes — ${room.title}`, part("Notes", "note"), part("Decisions", "decision"), part("Actions", "action")]
            .filter(Boolean).join("\n\n");
        await tasks.addCommentAsync({org_id: room.org_id, actor_person_id: actor, task_ref: room.task_ref, body});
    } catch (err) {LOG.error(`Could not post call notes to ${room.task_ref}: ${err}`);}

    // the people who were never in it get the summary, in their next brief
    try {
        const invitees = (await dblayer.getQueryOrThrow("SELECT person_id FROM room_invitee WHERE room_id=?", [room.room_id])).map(r => r.person_id);
        const joined = new Set((await dblayer.getQueryOrThrow("SELECT DISTINCT person_id FROM room_participant WHERE room_id=?", [room.room_id])).map(r => r.person_id));
        for (const person_id of invitees.filter(id => !joined.has(id)))
            await notifications.notifyAsync({org_id: room.org_id, category: "comment_mention", recipient_person_id: person_id,
                actor_person_id: actor, object_ref: room.room_id,
                payload: {kind: "call_summary", room_id: room.room_id, title: room.title, task_ref: room.task_ref, note_count: lines.length}});
    } catch (err) {LOG.error(`Could not send call summaries for ${room.room_id}: ${err}`);}
}

// ---------------------------------------------------------------------------
// signalling
// ---------------------------------------------------------------------------

/**
 * Passes one WebRTC message to one other person in the call.
 * @param {object} request {org_id, actor_person_id, room_id, to_person_id, kind, payload}
 */
exports.signalSendAsync = async function(request) {
    const {org_id, actor_person_id, room_id, to_person_id} = request;
    const room = await _roomForInviteeAsync(org_id, room_id, actor_person_id);
    if (room.ended_at) throw new Error("This call has ended.");
    if (!SIGNAL_KINDS.includes(request.kind)) throw new Error(`Unknown signal kind ${JSON.stringify(request.kind)}.`);
    const payload = typeof request.payload == "string" ? request.payload : JSON.stringify(request.payload);
    if (!payload || payload.length > MAX_SIGNAL_BYTES) throw new Error("The signal is empty or too large.");

    const live = new Set((await _liveParticipantsAsync(room_id)).map(p => p.person_id));
    if (!live.has(actor_person_id)) throw new Error("Join the call before signalling.");
    if (!live.has(to_person_id) || to_person_id == actor_person_id) throw new Error("That person isn't in the call.");
    const pending = (await dblayer.getQueryOrThrow("SELECT COUNT(*) AS n FROM room_signal WHERE room_id=? AND to_person_id=?", [room_id, to_person_id]))[0].n;
    if (pending >= MAX_PENDING_SIGNALS) throw new Error("Too many unread signals for that person.");

    await dblayer.runCmdBestEffortAsync("DELETE FROM room_signal WHERE created_at < ?", [_now() - SIGNAL_TTL_SECONDS]);
    await dblayer.runCmdOrThrow(`INSERT INTO room_signal (room_id, org_id, from_person_id, to_person_id, kind, payload, created_at)
        VALUES (?,?,?,?,?,?,?)`, [room_id, org_id, actor_person_id, to_person_id, request.kind, payload, _now()]);
    return "sent";
}

/**
 * Signals addressed to the actor with signal_id greater than `after`, in order. Polling is
 * idempotent: the client advances `after` itself, so a lost response loses nothing.
 */
exports.signalPollAsync = async function(request) {
    const {org_id, actor_person_id, room_id} = request;
    await _roomForInviteeAsync(org_id, room_id, actor_person_id);
    const after = Number.isFinite(request.after) ? request.after : 0;
    const rows = await dblayer.getQueryOrThrow(
        "SELECT signal_id, from_person_id, kind, payload, created_at FROM room_signal WHERE room_id=? AND to_person_id=? AND signal_id > ? ORDER BY signal_id ASC LIMIT 100",
        [room_id, actor_person_id, after]);
    return {signals: rows.map(row => ({signal_id: row.signal_id, from_person_id: row.from_person_id, kind: row.kind,
        payload: JSON.parse(row.payload), created_at: row.created_at}))};
}

// ---------------------------------------------------------------------------
// shared notes
// ---------------------------------------------------------------------------

async function _requirePresentAsync(org_id, room_id, actor_person_id) {
    const room = await _roomForInviteeAsync(org_id, room_id, actor_person_id);
    if (room.ended_at) throw new Error("This call has ended, so its notes are read-only.");
    const present = (await _liveParticipantsAsync(room_id)).some(p => p.person_id == actor_person_id);
    if (!present) throw new Error("Join the call to edit its notes.");
    return room;
}

/**
 * Adds a line to the shared notes. Anyone in the call may.
 * @param {object} request {org_id, actor_person_id, room_id, kind, text, assignee_person_id}
 */
exports.noteAddAsync = async function(request) {
    const {org_id, actor_person_id, room_id} = request;
    await _requirePresentAsync(org_id, room_id, actor_person_id);
    const kind = request.kind || "note";
    if (!NOTE_KINDS.includes(kind)) throw new Error(`Unknown note kind ${JSON.stringify(kind)}.`);
    const text = (request.text || "").trim();
    if (!text) throw new Error("A note line can't be empty.");
    if (text.length > MAX_NOTE_LENGTH) throw new Error(`A note line may be at most ${MAX_NOTE_LENGTH} characters.`);
    const count = (await dblayer.getQueryOrThrow("SELECT COUNT(*) AS n FROM room_note_line WHERE room_id=? AND deleted_at IS NULL", [room_id]))[0].n;
    if (count >= MAX_NOTE_LINES) throw new Error("These notes are full.");

    let assignee = null;
    if (kind == "action" && request.assignee_person_id) {
        const invited = (await dblayer.getQueryOrThrow("SELECT 1 AS x FROM room_invitee WHERE room_id=? AND person_id=?", [room_id, request.assignee_person_id]))[0];
        if (!invited) throw new Error("An action can only be assigned to someone invited to the call.");
        assignee = request.assignee_person_id;
    }
    const now = _now();
    const line = {line_id: _uuid(), room_id, org_id, kind, text, assignee_person_id: assignee,
        created_by: actor_person_id, updated_by: actor_person_id, created_at: now, updated_at: now};
    await dblayer.runCmdOrThrow(`INSERT INTO room_note_line (line_id, room_id, org_id, kind, text, assignee_person_id, created_by, updated_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [line.line_id, room_id, org_id, kind, text, assignee, actor_person_id, actor_person_id, now, now]);
    return {line};
}

/** Edits or removes a line. Anyone in the call may — the notes belong to the room. */
exports.noteEditAsync = async function(request) {
    const {org_id, actor_person_id, room_id, line_id} = request;
    await _requirePresentAsync(org_id, room_id, actor_person_id);
    const line = (await dblayer.getQueryOrThrow("SELECT * FROM room_note_line WHERE room_id=? AND line_id=? AND deleted_at IS NULL", [room_id, line_id]))[0];
    if (!line) throw new Error("No such note line.");
    if (request.remove) {
        await dblayer.runCmdOrThrow("UPDATE room_note_line SET deleted_at=?, updated_by=?, updated_at=? WHERE line_id=?", [_now(), actor_person_id, _now(), line_id]);
        return "removed";
    }
    const text = (request.text || "").trim();
    if (!text) throw new Error("A note line can't be empty.");
    if (text.length > MAX_NOTE_LENGTH) throw new Error(`A note line may be at most ${MAX_NOTE_LENGTH} characters.`);
    await dblayer.runCmdOrThrow("UPDATE room_note_line SET text=?, updated_by=?, updated_at=? WHERE line_id=?", [text, actor_person_id, _now(), line_id]);
    return "edited";
}

exports.MAX_PARTICIPANTS = MAX_PARTICIPANTS;
exports.STALE_SECONDS = STALE_SECONDS;
