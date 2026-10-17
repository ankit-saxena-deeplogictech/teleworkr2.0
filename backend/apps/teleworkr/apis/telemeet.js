/**
 * The Telemeet API — video rooms. The actor is the token's id (their email).
 * Media is peer-to-peer between browsers; this API is the rendezvous only.
 *
 * Operations:
 *  op - create_room  - create a room, or get the open one for a meeting (meeting_id, task_ref, title, invitee_person_ids)
 *  op - my_rooms     - open rooms the actor is invited to
 *  op - room         - the room's state: people, roster with local times, notes, ICE servers
 *  op - join         - join the call (returns the peers to make offers to)
 *  op - heartbeat    - mark present; returns the room state
 *  op - leave        - leave; the last person out ends the room
 *  op - end          - the owner ends the call for everyone
 *  op - signal_send  - pass a WebRTC message to one person in the call (to_person_id, kind, payload)
 *  op - signal_poll  - WebRTC messages for the actor after a signal_id (after)
 *  op - note_add     - add a note / action / decision line (kind, text, assignee_person_id)
 *  op - note_edit    - edit or remove a line (line_id, text | remove)
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const telemeet = require(`${TELEWORKR_CONSTANTS.LIBDIR}/telemeet.js`);

const _list = value => {
    if (Array.isArray(value)) return value;
    if (typeof value != "string" || !value) return [];
    try {const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed;} catch (_) {}
    return value.split(",").map(item => item.trim()).filter(Boolean);
}
const _bool = value => value === true || value === "true" || value === "1";

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        const base = {org_id: jsonReq.org, actor_person_id: actor.person_id, room_id: jsonReq.room_id};
        switch (jsonReq.op) {
            case "create_room": return {...CONSTANTS.TRUE_RESULT, ...(await telemeet.createRoomAsync({...base,
                meeting_id: jsonReq.meeting_id, task_ref: jsonReq.task_ref, title: jsonReq.title,
                invitee_person_ids: _list(jsonReq.invitee_person_ids)}))};
            case "my_rooms": return {...CONSTANTS.TRUE_RESULT, ...(await telemeet.myRoomsAsync(jsonReq.org, actor.person_id))};
            case "room": return {...CONSTANTS.TRUE_RESULT, ...(await telemeet.roomAsync(base))};
            case "join": return {...CONSTANTS.TRUE_RESULT, ...(await telemeet.joinAsync(base))};
            case "heartbeat": return {...CONSTANTS.TRUE_RESULT, ...(await telemeet.heartbeatAsync(base))};
            case "leave": return {...CONSTANTS.TRUE_RESULT, ...(await telemeet.leaveAsync(base))};
            case "end": return {...CONSTANTS.TRUE_RESULT, ...(await telemeet.endAsync(base))};
            case "signal_send": return {...CONSTANTS.TRUE_RESULT, result: await telemeet.signalSendAsync({...base,
                to_person_id: jsonReq.to_person_id, kind: jsonReq.kind, payload: jsonReq.payload})};
            case "signal_poll": return {...CONSTANTS.TRUE_RESULT, ...(await telemeet.signalPollAsync({...base,
                after: jsonReq.after === undefined ? 0 : Number(jsonReq.after)}))};
            case "note_add": return {...CONSTANTS.TRUE_RESULT, ...(await telemeet.noteAddAsync({...base,
                kind: jsonReq.kind, text: jsonReq.text, assignee_person_id: jsonReq.assignee_person_id}))};
            case "note_edit": return {...CONSTANTS.TRUE_RESULT, result: await telemeet.noteEditAsync({...base,
                line_id: jsonReq.line_id, text: jsonReq.text, remove: _bool(jsonReq.remove)})};
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Telemeet operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["create_room", "my_rooms", "room", "join", "heartbeat", "leave", "end", "signal_send", "signal_poll",
    "note_add", "note_edit"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
