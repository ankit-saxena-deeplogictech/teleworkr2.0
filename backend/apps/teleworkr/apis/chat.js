/**
 * The team chat API. The actor is the token's id (their email).
 *
 * Operations:
 *  op - conversations   - the actor's conversations, with unread counts and last message
 *  op - open_dm         - open (or fetch) a one-to-one conversation (other_person_id)
 *  op - create_group    - create a private group (title, member_person_ids)
 *  op - create_channel  - create a public channel (title, task_ref); needs chat.channel.create
 *  op - channels        - public channels, with whether the actor is a member
 *  op - join            - join a channel (conversation_id)
 *  op - leave           - leave a group or channel (conversation_id)
 *  op - add_members     - add people to a group (conversation_id, person_ids)
 *  op - messages        - a conversation's messages (conversation_id, after_seq | before_seq, limit)
 *  op - send            - send a message (conversation_id, body)
 *  op - edit            - edit the actor's own message (message_id, body)
 *  op - delete          - delete the actor's own message (message_id)
 *  op - mark_read       - move the read watermark (conversation_id, seq)
 *  op - mute            - mute or unmute a conversation (conversation_id, until)
 *  op - unread          - total unread, the badge number
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const chat = require(`${TELEWORKR_CONSTANTS.LIBDIR}/chat.js`);

const _num = value => value === undefined || value === null || value === "" ? undefined : Number(value);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}
    try {
        const actor = await _actorAsync(jsonReq);
        const base = {org_id: jsonReq.org, actor_person_id: actor.person_id};
        switch (jsonReq.op) {
            case "conversations": return {...CONSTANTS.TRUE_RESULT, ...(await chat.conversationsAsync(jsonReq.org, actor.person_id))};
            case "open_dm": return {...CONSTANTS.TRUE_RESULT, ...(await chat.openDmAsync({...base, other_person_id: jsonReq.other_person_id}))};
            case "create_group": return {...CONSTANTS.TRUE_RESULT, ...(await chat.createGroupAsync({...base,
                title: jsonReq.title, member_person_ids: _list(jsonReq.member_person_ids)}))};
            case "create_channel": return {...CONSTANTS.TRUE_RESULT, ...(await chat.createChannelAsync({...base,
                title: jsonReq.title, task_ref: jsonReq.task_ref}))};
            case "channels": return {...CONSTANTS.TRUE_RESULT, ...(await chat.channelsAsync(jsonReq.org, actor.person_id))};
            case "join": return {...CONSTANTS.TRUE_RESULT, result: await chat.joinChannelAsync({...base, conversation_id: jsonReq.conversation_id})};
            case "leave": return {...CONSTANTS.TRUE_RESULT, result: await chat.leaveAsync({...base, conversation_id: jsonReq.conversation_id})};
            case "add_members": return {...CONSTANTS.TRUE_RESULT, ...(await chat.addMembersAsync({...base,
                conversation_id: jsonReq.conversation_id, person_ids: _list(jsonReq.person_ids)}))};
            case "messages": return {...CONSTANTS.TRUE_RESULT, ...(await chat.messagesAsync({...base,
                conversation_id: jsonReq.conversation_id, after_seq: _num(jsonReq.after_seq),
                before_seq: _num(jsonReq.before_seq), limit: _num(jsonReq.limit)}))};
            case "send": return {...CONSTANTS.TRUE_RESULT, ...(await chat.sendAsync({...base,
                conversation_id: jsonReq.conversation_id, body: jsonReq.body}))};
            case "edit": return {...CONSTANTS.TRUE_RESULT, result: await chat.editAsync({...base,
                message_id: jsonReq.message_id, body: jsonReq.body})};
            case "delete": return {...CONSTANTS.TRUE_RESULT, result: await chat.deleteAsync({...base, message_id: jsonReq.message_id})};
            case "mark_read": return {...CONSTANTS.TRUE_RESULT, ...(await chat.markReadAsync({...base,
                conversation_id: jsonReq.conversation_id, seq: _num(jsonReq.seq)}))};
            case "mute": return {...CONSTANTS.TRUE_RESULT, result: await chat.muteAsync({...base,
                conversation_id: jsonReq.conversation_id, until: jsonReq.until === "null" ? null : jsonReq.until})};
            case "unread": return {...CONSTANTS.TRUE_RESULT, ...(await chat.unreadSummaryAsync(jsonReq.org, actor.person_id))};
            default: return CONSTANTS.FALSE_RESULT;
        }
    } catch (err) {
        LOG.error(`Chat operation ${jsonReq.op} failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

/** GET query values arrive as strings or arrays; accept a JSON array string or a comma list too. */
const _list = value => {
    if (Array.isArray(value)) return value;
    if (typeof value != "string" || !value) return [];
    try {const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed;} catch (_) {}
    return value.split(",").map(item => item.trim()).filter(Boolean);
}

const _actorAsync = async jsonReq => {
    const person = await spine.getPersonByEmailAsync((jsonReq.id||"").toLowerCase());
    if (!person) throw new Error(`No person for ${jsonReq.id}. Sign in with a provisioned account.`);
    return person;
}

const OPS = ["conversations", "open_dm", "create_group", "create_channel", "channels", "join", "leave", "add_members",
    "messages", "send", "edit", "delete", "mark_read", "mute", "unread"];

const validateRequest = jsonReq => jsonReq && OPS.includes(jsonReq.op) && jsonReq.id && jsonReq.org;
