/**
 * Team chat — direct messages, groups and channels.
 *
 * Content is readable by a conversation's members and nobody else. There is no
 * admin or HR read path, no org-wide search and no export of someone else's
 * conversation: capabilities.js keeps message.read_content in CEILING ("message
 * content is never read by the product"), and every read here is gated on
 * active membership rather than on a capability that could be granted wider.
 * A channel is public in the sense that anyone with chat.use may join it, but
 * its history is still only readable after joining.
 *
 * Reads and the seq bump: each message takes the next per-conversation seq
 * inside one transaction, and clients poll "after_seq". Read state is a
 * watermark (last_read_seq), never a per-message flag. The transaction does no
 * plain dblayer call inside its callback (dblayer's single serial queue would
 * deadlock the transaction), so everything else is read first.
 *
 * Mentions: "@Display Name" is resolved against the org roster, and only
 * members of the conversation can be mentioned. Each mention raises the
 * existing comment_mention notification (batched into the brief bucket by the
 * A9 router, so it honours a person's working window) unless that person has
 * muted the conversation. The notification names the conversation and sender,
 * never the message text. Raising it is best effort and can never fail a send.
 *
 * Narrowed, deliberately: text only (no file storage exists to attach to), no
 * threads or reactions, no org-wide search, and no retention sweep — the
 * entity register declares a 2-year keep for messages, but nothing in this app
 * runs scheduled purges yet.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const notifications = require(`${TELEWORKR_CONSTANTS.LIBDIR}/notifications.js`);

const KINDS = Object.freeze({DM: "dm", GROUP: "group", CHANNEL: "channel"});
const MAX_BODY = 4000;
const MAX_TITLE = 80;
const MAX_GROUP_MEMBERS = 50;
const PAGE_SIZE = 50;
const MUTED_FOREVER = 9999999999;

const _now = _ => Math.floor(Date.now()/1000);
const _uuid = _ => serverutils.generateUUID(false);
const _dmKey = (a, b) => [a, b].sort().join(":");

async function _requireUseAsync(org_id, actor_person_id) {
    await permissions.requireAsync({org_id, actor_person_id, capability: "chat.use"});
}

async function _conversationAsync(org_id, conversation_id) {
    const row = (await dblayer.getQueryOrThrow(
        "SELECT * FROM chat_conversation WHERE org_id=? AND conversation_id=?", [org_id, conversation_id]))[0];
    if (!row) throw new Error("No such conversation.");
    return row;
}

async function _membershipAsync(conversation_id, person_id) {
    return (await dblayer.getQueryOrThrow(
        "SELECT * FROM chat_member WHERE conversation_id=? AND person_id=? AND left_at IS NULL", [conversation_id, person_id]))[0] || null;
}

/** Content access rule: an active member, nothing else — no capability widens it. */
async function _requireMemberAsync(org_id, conversation_id, person_id) {
    const conversation = await _conversationAsync(org_id, conversation_id);
    const member = await _membershipAsync(conversation_id, person_id);
    if (!member) throw new Error("You are not a member of this conversation.");
    return {conversation, member};
}

async function _rosterAsync(org_id) {
    return await spine.rosterAsOfAsync(org_id);
}

function _cleanTitle(title, label) {
    const clean = (title || "").trim();
    if (!clean) throw new Error(`A ${label} needs a name.`);
    if (clean.length > MAX_TITLE) throw new Error(`A ${label} name may be at most ${MAX_TITLE} characters.`);
    return clean;
}

// ---------------------------------------------------------------------------
// creating conversations
// ---------------------------------------------------------------------------

/**
 * Opens (or returns the existing) one-to-one conversation.
 * @param {object} request {org_id, actor_person_id, other_person_id}
 */
exports.openDmAsync = async function(request) {
    const {org_id, actor_person_id, other_person_id} = request;
    await _requireUseAsync(org_id, actor_person_id);
    if (!other_person_id || other_person_id == actor_person_id) throw new Error("Pick someone else to message.");
    const roster = await _rosterAsync(org_id);
    if (!roster.some(p => p.person_id == other_person_id)) throw new Error("That person is not in this org.");

    const dm_key = _dmKey(actor_person_id, other_person_id);
    const existing = (await dblayer.getQueryOrThrow(
        "SELECT * FROM chat_conversation WHERE org_id=? AND dm_key=?", [org_id, dm_key]))[0];
    if (existing) {
        await _ensureActiveMembersAsync(existing, [actor_person_id, other_person_id]);
        return {conversation: existing, created: false};
    }

    const conversation = {conversation_id: _uuid(), org_id, kind: KINDS.DM, title: null, task_ref: null, dm_key,
        created_by: actor_person_id, created_at: _now(), archived_at: null, next_seq: 0};
    await dblayer.runInTransactionAsync(async exec => {
        await exec.runCmd(`INSERT INTO chat_conversation (conversation_id, org_id, kind, dm_key, created_by, created_at, next_seq)
            VALUES (?,?,?,?,?,?,?)`, [conversation.conversation_id, org_id, KINDS.DM, dm_key, actor_person_id, conversation.created_at, 0]);
        for (const person_id of [actor_person_id, other_person_id])
            await exec.runCmd(`INSERT INTO chat_member (conversation_id, person_id, org_id, role, joined_at) VALUES (?,?,?,?,?)`,
                [conversation.conversation_id, person_id, org_id, person_id == actor_person_id ? "owner" : "member", conversation.created_at]);
    });
    return {conversation, created: true};
}

/** A DM never "ends": if someone had left through an erased/rejoined state, reopen their seat. */
async function _ensureActiveMembersAsync(conversation, person_ids) {
    for (const person_id of person_ids) {
        const row = (await dblayer.getQueryOrThrow("SELECT left_at FROM chat_member WHERE conversation_id=? AND person_id=?",
            [conversation.conversation_id, person_id]))[0];
        if (!row) await dblayer.runCmdOrThrow(
            "INSERT INTO chat_member (conversation_id, person_id, org_id, role, joined_at) VALUES (?,?,?,?,?)",
            [conversation.conversation_id, person_id, conversation.org_id, "member", _now()]);
        else if (row.left_at) await dblayer.runCmdOrThrow(
            "UPDATE chat_member SET left_at=NULL WHERE conversation_id=? AND person_id=?", [conversation.conversation_id, person_id]);
    }
}

/**
 * Creates a private group conversation.
 * @param {object} request {org_id, actor_person_id, title, member_person_ids}
 */
exports.createGroupAsync = async function(request) {
    const {org_id, actor_person_id} = request;
    await _requireUseAsync(org_id, actor_person_id);
    const title = _cleanTitle(request.title, "group");
    const members = Array.from(new Set([actor_person_id, ...(request.member_person_ids || [])]));
    if (members.length < 3) throw new Error("A group needs at least two other people. Use a direct message for one.");
    if (members.length > MAX_GROUP_MEMBERS) throw new Error(`A group may have at most ${MAX_GROUP_MEMBERS} people.`);
    const roster = await _rosterAsync(org_id);
    for (const person_id of members) if (!roster.some(p => p.person_id == person_id))
        throw new Error(`${person_id} is not a person in this org.`);

    return await _createWithMembersAsync({org_id, kind: KINDS.GROUP, title, task_ref: null, created_by: actor_person_id, members});
}

/**
 * Creates a public channel anyone with chat.use may join.
 * @param {object} request {org_id, actor_person_id, title, task_ref}
 */
exports.createChannelAsync = async function(request) {
    const {org_id, actor_person_id} = request;
    await permissions.requireAsync({org_id, actor_person_id, capability: "chat.channel.create"});
    const title = _cleanTitle((request.title || "").replace(/^#/, ""), "channel");
    const clash = (await dblayer.getQueryOrThrow(
        "SELECT 1 AS x FROM chat_conversation WHERE org_id=? AND kind=? AND lower(title)=lower(?)", [org_id, KINDS.CHANNEL, title]))[0];
    if (clash) throw new Error(`A channel called #${title} already exists.`);
    return await _createWithMembersAsync({org_id, kind: KINDS.CHANNEL, title, task_ref: request.task_ref || null,
        created_by: actor_person_id, members: [actor_person_id]});
}

async function _createWithMembersAsync({org_id, kind, title, task_ref, created_by, members}) {
    const conversation = {conversation_id: _uuid(), org_id, kind, title, task_ref, dm_key: null, created_by,
        created_at: _now(), archived_at: null, next_seq: 0};
    await dblayer.runInTransactionAsync(async exec => {
        await exec.runCmd(`INSERT INTO chat_conversation (conversation_id, org_id, kind, title, task_ref, created_by, created_at, next_seq)
            VALUES (?,?,?,?,?,?,?,?)`, [conversation.conversation_id, org_id, kind, title, task_ref, created_by, conversation.created_at, 0]);
        for (const person_id of members)
            await exec.runCmd(`INSERT INTO chat_member (conversation_id, person_id, org_id, role, joined_at) VALUES (?,?,?,?,?)`,
                [conversation.conversation_id, person_id, org_id, person_id == created_by ? "owner" : "member", conversation.created_at]);
    });
    return {conversation};
}

// ---------------------------------------------------------------------------
// membership
// ---------------------------------------------------------------------------

/** Public channels anyone with chat.use could join, with whether the actor already has. */
exports.channelsAsync = async function(org_id, actor_person_id) {
    await _requireUseAsync(org_id, actor_person_id);
    const rows = await dblayer.getQueryOrThrow(
        `SELECT c.conversation_id, c.title, c.task_ref, c.created_at,
            (SELECT COUNT(*) FROM chat_member m WHERE m.conversation_id=c.conversation_id AND m.left_at IS NULL) AS member_count,
            (SELECT COUNT(*) FROM chat_member m WHERE m.conversation_id=c.conversation_id AND m.person_id=? AND m.left_at IS NULL) AS mine
            FROM chat_conversation c WHERE c.org_id=? AND c.kind=? AND c.archived_at IS NULL ORDER BY lower(c.title) ASC`,
        [actor_person_id, org_id, KINDS.CHANNEL]);
    return {channels: rows.map(row => ({...row, is_member: Boolean(row.mine), mine: undefined}))};
}

exports.joinChannelAsync = async function(request) {
    const {org_id, actor_person_id, conversation_id} = request;
    await _requireUseAsync(org_id, actor_person_id);
    const conversation = await _conversationAsync(org_id, conversation_id);
    if (conversation.kind != KINDS.CHANNEL) throw new Error("Only channels can be joined; groups need an invitation.");
    if (conversation.archived_at) throw new Error("This channel is archived.");
    const existing = (await dblayer.getQueryOrThrow("SELECT * FROM chat_member WHERE conversation_id=? AND person_id=?",
        [conversation_id, actor_person_id]))[0];
    if (existing && !existing.left_at) return "already_member";
    if (existing) await dblayer.runCmdOrThrow("UPDATE chat_member SET left_at=NULL, joined_at=? WHERE conversation_id=? AND person_id=?",
        [_now(), conversation_id, actor_person_id]);
    else await dblayer.runCmdOrThrow(
        "INSERT INTO chat_member (conversation_id, person_id, org_id, role, joined_at, last_read_seq) VALUES (?,?,?,?,?,?)",
        [conversation_id, actor_person_id, org_id, "member", _now(), conversation.next_seq]);
    return "joined";
}

exports.leaveAsync = async function(request) {
    const {org_id, actor_person_id, conversation_id} = request;
    const {conversation} = await _requireMemberAsync(org_id, conversation_id, actor_person_id);
    if (conversation.kind == KINDS.DM) throw new Error("A direct message can't be left. Mute it instead.");
    await dblayer.runCmdOrThrow("UPDATE chat_member SET left_at=? WHERE conversation_id=? AND person_id=?",
        [_now(), conversation_id, actor_person_id]);
    return "left";
}

/** Any member may add people to a group; channels are joined, not invited into. */
exports.addMembersAsync = async function(request) {
    const {org_id, actor_person_id, conversation_id} = request;
    const {conversation} = await _requireMemberAsync(org_id, conversation_id, actor_person_id);
    if (conversation.kind != KINDS.GROUP) throw new Error("People can only be added to a group.");
    const roster = await _rosterAsync(org_id);
    const added = [];
    for (const person_id of new Set(request.person_ids || [])) {
        if (!roster.some(p => p.person_id == person_id)) throw new Error(`${person_id} is not a person in this org.`);
        const existing = (await dblayer.getQueryOrThrow("SELECT * FROM chat_member WHERE conversation_id=? AND person_id=?",
            [conversation_id, person_id]))[0];
        if (existing && !existing.left_at) continue;
        const active = (await dblayer.getQueryOrThrow(
            "SELECT COUNT(*) AS n FROM chat_member WHERE conversation_id=? AND left_at IS NULL", [conversation_id]))[0].n;
        if (active + added.length >= MAX_GROUP_MEMBERS) throw new Error(`A group may have at most ${MAX_GROUP_MEMBERS} people.`);
        if (existing) await dblayer.runCmdOrThrow("UPDATE chat_member SET left_at=NULL, joined_at=?, last_read_seq=? WHERE conversation_id=? AND person_id=?",
            [_now(), conversation.next_seq, conversation_id, person_id]);
        else await dblayer.runCmdOrThrow(
            "INSERT INTO chat_member (conversation_id, person_id, org_id, role, joined_at, last_read_seq) VALUES (?,?,?,?,?,?)",
            [conversation_id, person_id, org_id, "member", _now(), conversation.next_seq]);
        added.push(person_id);
    }
    return {added};
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * The actor's conversations with unread counts and the last message, most recent first.
 * Unread counts only other people's messages after the watermark.
 */
exports.conversationsAsync = async function(org_id, actor_person_id) {
    await _requireUseAsync(org_id, actor_person_id);
    const rows = await dblayer.getQueryOrThrow(
        `SELECT c.*, m.last_read_seq, m.muted_until FROM chat_member m
            JOIN chat_conversation c ON c.conversation_id=m.conversation_id
            WHERE m.org_id=? AND m.person_id=? AND m.left_at IS NULL AND c.archived_at IS NULL`, [org_id, actor_person_id]);
    const roster = await _rosterAsync(org_id);
    const nameOf = id => roster.find(p => p.person_id == id)?.display_name || "Former colleague";
    const now = _now();

    const out = [];
    for (const row of rows) {
        const unread = (await dblayer.getQueryOrThrow(
            `SELECT COUNT(*) AS n FROM chat_message WHERE conversation_id=? AND seq > ? AND sender_person_id != ? AND deleted_at IS NULL`,
            [row.conversation_id, row.last_read_seq, actor_person_id]))[0].n;
        const last = (await dblayer.getQueryOrThrow(
            `SELECT sender_person_id, body, created_at, deleted_at FROM chat_message WHERE conversation_id=? ORDER BY seq DESC LIMIT 1`,
            [row.conversation_id]))[0];
        let title = row.title, other_person_id = null;
        if (row.kind == KINDS.DM) {
            other_person_id = row.dm_key.split(":").find(id => id != actor_person_id) || actor_person_id;
            title = nameOf(other_person_id);
        }
        out.push({conversation_id: row.conversation_id, kind: row.kind, title, task_ref: row.task_ref, other_person_id,
            unread, muted: Boolean(row.muted_until && row.muted_until > now), created_at: row.created_at,
            last_message: last ? {sender_person_id: last.sender_person_id, sender_name: nameOf(last.sender_person_id),
                preview: last.deleted_at ? "Message deleted" : last.body.substring(0, 90), created_at: last.created_at} : null});
    }
    out.sort((a, b) => (b.last_message?.created_at || b.created_at) - (a.last_message?.created_at || a.created_at));
    return {conversations: out};
}

/**
 * Messages in a conversation the actor belongs to.
 * @param {object} request {org_id, actor_person_id, conversation_id, after_seq, before_seq, limit}
 *      after_seq returns newer messages ascending (polling); otherwise the newest page, ascending
 */
exports.messagesAsync = async function(request) {
    const {org_id, actor_person_id, conversation_id} = request;
    await _requireUseAsync(org_id, actor_person_id);
    const {conversation, member} = await _requireMemberAsync(org_id, conversation_id, actor_person_id);
    const limit = Math.min(Math.max(Number(request.limit) || PAGE_SIZE, 1), 200);

    let rows;
    if (Number.isFinite(request.after_seq)) rows = await dblayer.getQueryOrThrow(
        `SELECT * FROM chat_message WHERE conversation_id=? AND seq > ? ORDER BY seq ASC LIMIT ${limit}`, [conversation_id, request.after_seq]);
    else {
        const before = Number.isFinite(request.before_seq) ? request.before_seq : Number.MAX_SAFE_INTEGER;
        rows = (await dblayer.getQueryOrThrow(
            `SELECT * FROM chat_message WHERE conversation_id=? AND seq < ? ORDER BY seq DESC LIMIT ${limit}`, [conversation_id, before])).reverse();
    }
    const roster = await _rosterAsync(org_id);
    const nameOf = id => roster.find(p => p.person_id == id)?.display_name || "Former colleague";
    return {conversation_id, last_read_seq: member.last_read_seq, latest_seq: conversation.next_seq,
        messages: rows.map(row => ({message_id: row.message_id, seq: row.seq, sender_person_id: row.sender_person_id,
            sender_name: nameOf(row.sender_person_id), is_mine: row.sender_person_id == actor_person_id,
            body: row.deleted_at ? null : row.body, deleted: Boolean(row.deleted_at), edited: Boolean(row.edited_at),
            mentions: JSON.parse(row.mentions), mentions_me: JSON.parse(row.mentions).includes(actor_person_id),
            created_at: row.created_at}))};
}

// ---------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------

/** The roster people named by "@Display Name" in the text, kept to the people given. */
function _mentionsIn(body, candidates) {
    const lower = body.toLowerCase();
    const found = [];
    for (const person of candidates) {
        const name = (person.display_name || "").trim().toLowerCase();
        if (!name) continue;
        const at = `@${name}`;
        let from = 0, index;
        while ((index = lower.indexOf(at, from)) != -1) {
            const after = lower[index + at.length];
            if (after === undefined || !/[\p{L}\p{N}_]/u.test(after)) {found.push(person.person_id); break;}
            from = index + at.length;
        }
    }
    return found;
}

/**
 * Sends a message. Mentions notify mentioned members who haven't muted the conversation.
 * @param {object} request {org_id, actor_person_id, conversation_id, body}
 */
exports.sendAsync = async function(request) {
    const {org_id, actor_person_id, conversation_id} = request;
    await _requireUseAsync(org_id, actor_person_id);
    const {conversation} = await _requireMemberAsync(org_id, conversation_id, actor_person_id);
    if (conversation.archived_at) throw new Error("This conversation is archived.");
    const body = (request.body || "").trim();
    if (!body) throw new Error("A message can't be empty.");
    if (body.length > MAX_BODY) throw new Error(`A message may be at most ${MAX_BODY} characters.`);

    const roster = await _rosterAsync(org_id);
    const members = await dblayer.getQueryOrThrow(
        "SELECT person_id, muted_until FROM chat_member WHERE conversation_id=? AND left_at IS NULL", [conversation_id]);
    const memberIds = new Set(members.map(m => m.person_id));
    const mentions = _mentionsIn(body, roster.filter(p => memberIds.has(p.person_id)));

    const now = _now();
    const message = await dblayer.runInTransactionAsync(async exec => {
        const current = (await exec.getQuery("SELECT next_seq FROM chat_conversation WHERE conversation_id=?", [conversation_id]))[0];
        const seq = current.next_seq + 1;
        await exec.runCmd("UPDATE chat_conversation SET next_seq=? WHERE conversation_id=?", [seq, conversation_id]);
        const row = {message_id: _uuid(), conversation_id, org_id, seq, sender_person_id: actor_person_id, body,
            mentions: JSON.stringify(mentions), created_at: now};
        await exec.runCmd(`INSERT INTO chat_message (message_id, conversation_id, org_id, seq, sender_person_id, body, mentions, created_at)
            VALUES (?,?,?,?,?,?,?,?)`, [row.message_id, conversation_id, org_id, seq, actor_person_id, body, row.mentions, now]);
        await exec.runCmd("UPDATE chat_member SET last_read_seq=? WHERE conversation_id=? AND person_id=?", [seq, conversation_id, actor_person_id]);
        return row;
    });

    const senderName = roster.find(p => p.person_id == actor_person_id)?.display_name || "Someone";
    for (const person_id of mentions) {
        if (person_id == actor_person_id) continue;
        const muted = members.find(m => m.person_id == person_id)?.muted_until;
        if (muted && muted > now) continue;
        try {
            await notifications.notifyAsync({org_id, category: "comment_mention", recipient_person_id: person_id,
                actor_person_id, object_ref: conversation_id,
                payload: {kind: "chat_mention", conversation_id, conversation_title: conversation.title, from: senderName}});
        } catch (err) {LOG.error(`Could not raise a chat mention for ${conversation_id}: ${err}`);}
    }
    return {message: {message_id: message.message_id, seq: message.seq, body, mentions, created_at: now}};
}

/** Edits the actor's own message. */
exports.editAsync = async function(request) {
    const {org_id, actor_person_id, message_id} = request;
    await _requireUseAsync(org_id, actor_person_id);
    const row = (await dblayer.getQueryOrThrow("SELECT * FROM chat_message WHERE org_id=? AND message_id=?", [org_id, message_id]))[0];
    if (!row) throw new Error("No such message.");
    await _requireMemberAsync(org_id, row.conversation_id, actor_person_id);
    if (row.sender_person_id != actor_person_id) throw new Error("You can only edit your own messages.");
    if (row.deleted_at) throw new Error("That message was deleted.");
    const body = (request.body || "").trim();
    if (!body) throw new Error("A message can't be empty.");
    if (body.length > MAX_BODY) throw new Error(`A message may be at most ${MAX_BODY} characters.`);
    const roster = await _rosterAsync(org_id);
    const members = (await dblayer.getQueryOrThrow("SELECT person_id FROM chat_member WHERE conversation_id=? AND left_at IS NULL",
        [row.conversation_id])).map(m => m.person_id);
    const mentions = _mentionsIn(body, roster.filter(p => members.includes(p.person_id)));
    await dblayer.runCmdOrThrow("UPDATE chat_message SET body=?, mentions=?, edited_at=? WHERE message_id=?",
        [body, JSON.stringify(mentions), _now(), message_id]);
    return "edited";
}

/** Deletes the actor's own message (the row stays as a tombstone so seq stays contiguous). */
exports.deleteAsync = async function(request) {
    const {org_id, actor_person_id, message_id} = request;
    await _requireUseAsync(org_id, actor_person_id);
    const row = (await dblayer.getQueryOrThrow("SELECT * FROM chat_message WHERE org_id=? AND message_id=?", [org_id, message_id]))[0];
    if (!row) throw new Error("No such message.");
    await _requireMemberAsync(org_id, row.conversation_id, actor_person_id);
    if (row.sender_person_id != actor_person_id) throw new Error("You can only delete your own messages.");
    await dblayer.runCmdOrThrow("UPDATE chat_message SET deleted_at=?, body='' WHERE message_id=?", [_now(), message_id]);
    return "deleted";
}

/** Moves the read watermark forward to seq (never backward, never past the latest message). */
exports.markReadAsync = async function(request) {
    const {org_id, actor_person_id, conversation_id} = request;
    const {conversation, member} = await _requireMemberAsync(org_id, conversation_id, actor_person_id);
    const seq = Math.min(Number.isFinite(request.seq) ? request.seq : conversation.next_seq, conversation.next_seq);
    if (seq > member.last_read_seq) await dblayer.runCmdOrThrow(
        "UPDATE chat_member SET last_read_seq=? WHERE conversation_id=? AND person_id=?", [seq, conversation_id, actor_person_id]);
    return {last_read_seq: Math.max(seq, member.last_read_seq)};
}

/**
 * Mutes a conversation: it keeps filling and counting, but mentions stop notifying.
 * @param {object} request {org_id, actor_person_id, conversation_id, until} until: unix seconds | "forever" | null (unmute)
 */
exports.muteAsync = async function(request) {
    const {org_id, actor_person_id, conversation_id} = request;
    await _requireMemberAsync(org_id, conversation_id, actor_person_id);
    let until = null;
    if (request.until === "forever") until = MUTED_FOREVER;
    else if (request.until !== null && request.until !== undefined) {
        until = Number(request.until);
        if (!Number.isFinite(until) || until <= _now()) throw new Error("until must be a time in the future.");
    }
    await dblayer.runCmdOrThrow("UPDATE chat_member SET muted_until=? WHERE conversation_id=? AND person_id=?",
        [until, conversation_id, actor_person_id]);
    return until ? "muted" : "unmuted";
}

/** Total unread across the actor's conversations, split into muted and not — the badge number. */
exports.unreadSummaryAsync = async function(org_id, actor_person_id) {
    const { conversations } = await exports.conversationsAsync(org_id, actor_person_id);
    const loud = conversations.filter(c => !c.muted);
    return {total_unread: loud.reduce((sum, c) => sum + c.unread, 0),
        muted_unread: conversations.filter(c => c.muted).reduce((sum, c) => sum + c.unread, 0),
        by_conversation: conversations.filter(c => c.unread).map(c => ({conversation_id: c.conversation_id, unread: c.unread, muted: c.muted}))};
}
