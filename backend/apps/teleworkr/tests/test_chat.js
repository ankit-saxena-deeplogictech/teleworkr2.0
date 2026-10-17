/**
 * Tests team chat (chat.js): DM idempotency, groups and channels, membership
 * gating on every read and write, the no-admin-read rule, mentions and the
 * notification they raise, mute, edit/delete, unread watermarks.
 *
 * Run: <monkshu>/backend/server/testing/runTests.sh.bat <app>/tests chat
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const chat = require(`${TELEWORKR_CONSTANTS.LIBDIR}/chat.js`);
const capabilities = require(`${TELEWORKR_CONSTANTS.LIBDIR}/capabilities.js`);

let passed = 0, failed = 0;

const _check = (label, condition, detail) => {
    if (condition) {passed++; LOG.console(`  ok    ${label}\n`);}
    else {failed++; LOG.console(`  FAIL  ${label}${detail?` — ${detail}`:""}\n`); LOG.error(`Chat test failed: ${label} ${detail||""}`);}
}
const _checkThrows = async (label, fn) => {
    try {await fn(); _check(label, false, "expected a refusal, got success");}
    catch (err) {_check(`${label} — refused: ${err.message.substring(0, 100)}`, true);}
}

exports.runTestsAsync = async function(argv) {
    if ((!argv[0]) || (argv[0].toLowerCase() != "chat")) {
        LOG.console("Skipping chat test case, not called.\n"); return true;
    }
    LOG.console("\nTeam chat\n");

    await dblayer.readyAsync();
    let w;
    try {
        w = await _buildWorld();
        await _testCapabilities(w);
        await _testDirectMessages(w);
        await _testGroups(w);
        await _testChannels(w);
        await _testMentionsAndMute(w);
        await _testEditDeleteAndUnread(w);
        await _testNoOutsideReads(w);
    } catch (err) {
        failed++; LOG.console(`  FAIL  chat tests threw: ${err}\n`); LOG.error(`Chat tests threw: ${err.stack}`);
    } finally {
        if (w) await _cleanup(w);
        LOG.console(`\nChat tests: ${passed} passed, ${failed} failed.\n`);
        return failed == 0;
    }
}

async function _testCapabilities(w) {
    LOG.console("\n who may chat\n");
    _check("every role but guest holds chat.use", ["employee", "lead", "hr", "admin"].every(role =>
        capabilities.BUILTIN_ROLES[role].capabilities.some(([c]) => c == "chat.use")) &&
        !capabilities.BUILTIN_ROLES.guest.capabilities.some(([c]) => c == "chat.use"));
    _check("only lead, hr and admin may create channels", ["lead", "hr", "admin"].every(role =>
        capabilities.BUILTIN_ROLES[role].capabilities.some(([c]) => c == "chat.channel.create")) &&
        !capabilities.BUILTIN_ROLES.employee.capabilities.some(([c]) => c == "chat.channel.create"));
    await _checkThrows("a guest cannot list conversations", _ => chat.conversationsAsync(w.org_id, w.gina));
    await _checkThrows("an employee cannot create a channel", _ =>
        chat.createChannelAsync({org_id: w.org_id, actor_person_id: w.bob, title: "nope"}));
}

async function _testDirectMessages(w) {
    LOG.console("\n direct messages\n");
    const first = await chat.openDmAsync({org_id: w.org_id, actor_person_id: w.alice, other_person_id: w.bob});
    const again = await chat.openDmAsync({org_id: w.org_id, actor_person_id: w.bob, other_person_id: w.alice});
    _check("opening the same DM from either side returns one conversation",
        first.created && !again.created && first.conversation.conversation_id == again.conversation.conversation_id);
    w.dm = first.conversation.conversation_id;
    await _checkThrows("you can't DM yourself", _ => chat.openDmAsync({org_id: w.org_id, actor_person_id: w.alice, other_person_id: w.alice}));
    await _checkThrows("you can't DM someone outside the org", _ =>
        chat.openDmAsync({org_id: w.org_id, actor_person_id: w.alice, other_person_id: "nobody"}));

    await chat.sendAsync({org_id: w.org_id, actor_person_id: w.alice, conversation_id: w.dm, body: "  hello bob  "});
    const bobList = await chat.conversationsAsync(w.org_id, w.bob);
    const asBob = bobList.conversations.find(c => c.conversation_id == w.dm);
    _check("the DM is titled by the other person", asBob.title == "alice", asBob.title);
    _check("bob has one unread message and a trimmed preview", asBob.unread == 1 && asBob.last_message.preview == "hello bob", JSON.stringify(asBob));
    const aliceList = await chat.conversationsAsync(w.org_id, w.alice);
    _check("the sender's own message is never unread for the sender", aliceList.conversations.find(c => c.conversation_id == w.dm).unread == 0);
    await _checkThrows("an empty message is refused", _ => chat.sendAsync({org_id: w.org_id, actor_person_id: w.alice, conversation_id: w.dm, body: "   "}));
    await _checkThrows("an over-long message is refused", _ =>
        chat.sendAsync({org_id: w.org_id, actor_person_id: w.alice, conversation_id: w.dm, body: "x".repeat(4001)}));
    await _checkThrows("a DM can't be left", _ => chat.leaveAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.dm}));
}

async function _testGroups(w) {
    LOG.console("\n groups\n");
    await _checkThrows("a group needs at least two other people", _ =>
        chat.createGroupAsync({org_id: w.org_id, actor_person_id: w.alice, title: "tiny", member_person_ids: [w.bob]}));
    await _checkThrows("a group needs a name", _ =>
        chat.createGroupAsync({org_id: w.org_id, actor_person_id: w.alice, title: " ", member_person_ids: [w.bob, w.carol]}));
    const group = (await chat.createGroupAsync({org_id: w.org_id, actor_person_id: w.alice, title: "Launch crew",
        member_person_ids: [w.bob, w.carol]})).conversation;
    w.group = group.conversation_id;
    const carolList = await chat.conversationsAsync(w.org_id, w.carol);
    _check("members see the group", carolList.conversations.some(c => c.conversation_id == w.group && c.kind == "group"));

    await chat.sendAsync({org_id: w.org_id, actor_person_id: w.carol, conversation_id: w.group, body: "kickoff at 10"});
    const dana = w.dana;
    await _checkThrows("a non-member can't add people", _ =>
        chat.addMembersAsync({org_id: w.org_id, actor_person_id: dana, conversation_id: w.group, person_ids: [dana]}));
    const added = await chat.addMembersAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.group, person_ids: [dana]});
    _check("a member can add someone", added.added.length == 1);
    const history = await chat.messagesAsync({org_id: w.org_id, actor_person_id: dana, conversation_id: w.group});
    _check("a new member's read position starts at the latest message, so old messages aren't unread",
        (await chat.conversationsAsync(w.org_id, dana)).conversations.find(c => c.conversation_id == w.group).unread == 0);
    _check("a new member can read the history", history.messages.length == 1);
    await chat.leaveAsync({org_id: w.org_id, actor_person_id: dana, conversation_id: w.group});
    await _checkThrows("after leaving, the history is closed", _ =>
        chat.messagesAsync({org_id: w.org_id, actor_person_id: dana, conversation_id: w.group}));
}

async function _testChannels(w) {
    LOG.console("\n channels\n");
    const made = (await chat.createChannelAsync({org_id: w.org_id, actor_person_id: w.carol, title: "#general"})).conversation;
    w.channel = made.conversation_id;
    _check("the leading # is dropped from the channel name", made.title == "general", made.title);
    await _checkThrows("a channel name is unique, ignoring case", _ =>
        chat.createChannelAsync({org_id: w.org_id, actor_person_id: w.carol, title: "General"}));
    const listed = await chat.channelsAsync(w.org_id, w.bob);
    const row = listed.channels.find(c => c.conversation_id == w.channel);
    _check("a channel shows in the directory before you join, flagged as not-a-member", row && row.is_member === false && row.member_count == 1);
    await _checkThrows("reading a channel needs joining first", _ =>
        chat.messagesAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.channel}));
    _check("joining works", (await chat.joinChannelAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.channel})) == "joined");
    _check("joining twice is harmless", (await chat.joinChannelAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.channel})) == "already_member");
    await _checkThrows("a group can't be joined, only invited into", _ =>
        chat.joinChannelAsync({org_id: w.org_id, actor_person_id: w.dana, conversation_id: w.group}));
}

async function _testMentionsAndMute(w) {
    LOG.console("\n mentions and mute\n");
    const count = async person => (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS n FROM notification WHERE org_id=? AND recipient_person_id=? AND category='comment_mention'", [w.org_id, person]))[0].n;

    const before = await count(w.bob);
    const sent = await chat.sendAsync({org_id: w.org_id, actor_person_id: w.carol, conversation_id: w.channel, body: "hey @Bob, look at this"});
    _check("@Name resolves to the member's id", JSON.stringify(sent.message.mentions) == JSON.stringify([w.bob]), JSON.stringify(sent.message.mentions));
    _check("a mention raises one comment_mention notification", await count(w.bob) == before + 1);
    const notif = (await dblayer.getQueryOrThrow(
        "SELECT payload FROM notification WHERE org_id=? AND recipient_person_id=? AND category='comment_mention' ORDER BY raised_at DESC, rowid DESC LIMIT 1", [w.org_id, w.bob]))[0];
    _check("the notification names the conversation and sender but never the message text",
        !notif.payload.includes("look at this") && notif.payload.includes("carol"), notif.payload);

    const aliceBefore = await count(w.alice);
    const notMember = await chat.sendAsync({org_id: w.org_id, actor_person_id: w.carol, conversation_id: w.channel, body: "cc @Alice"});
    _check("mentioning someone who isn't in the conversation resolves to nobody and notifies nobody",
        notMember.message.mentions.length == 0 && await count(w.alice) == aliceBefore);
    const prefix = await chat.sendAsync({org_id: w.org_id, actor_person_id: w.carol, conversation_id: w.channel, body: "@Bobby is not bob"});
    _check("a longer word starting with a name is not a mention", prefix.message.mentions.length == 0);
    const self = await chat.sendAsync({org_id: w.org_id, actor_person_id: w.carol, conversation_id: w.channel, body: "note to @carol"});
    _check("mentioning yourself doesn't notify you", await count(w.carol) == 0 && self.message.mentions.includes(w.carol));

    await chat.muteAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.channel, until: "forever"});
    const mutedBefore = await count(w.bob);
    await chat.sendAsync({org_id: w.org_id, actor_person_id: w.carol, conversation_id: w.channel, body: "again @Bob"});
    _check("a muted conversation stores the mention but doesn't notify", await count(w.bob) == mutedBefore);
    const summary = await chat.unreadSummaryAsync(w.org_id, w.bob);
    _check("muted unread is counted apart from the badge number", summary.muted_unread > 0 &&
        !summary.by_conversation.find(c => c.conversation_id == w.channel && !c.muted));
    await chat.muteAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.channel, until: null});
    _check("unmuting restores it", (await chat.conversationsAsync(w.org_id, w.bob)).conversations.find(c => c.conversation_id == w.channel).muted === false);
    await _checkThrows("a mute time in the past is refused", _ =>
        chat.muteAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.channel, until: 5}));
}

async function _testEditDeleteAndUnread(w) {
    LOG.console("\n edit, delete and the read watermark\n");
    const sent = await chat.sendAsync({org_id: w.org_id, actor_person_id: w.alice, conversation_id: w.dm, body: "typo hre"});
    const id = sent.message.message_id;
    await _checkThrows("bob can't edit alice's message", _ => chat.editAsync({org_id: w.org_id, actor_person_id: w.bob, message_id: id, body: "x"}));
    await _checkThrows("bob can't delete alice's message", _ => chat.deleteAsync({org_id: w.org_id, actor_person_id: w.bob, message_id: id}));
    await chat.editAsync({org_id: w.org_id, actor_person_id: w.alice, message_id: id, body: "typo here"});
    let msgs = (await chat.messagesAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.dm})).messages;
    const edited = msgs.find(m => m.message_id == id);
    _check("an edit changes the text and is flagged edited", edited.body == "typo here" && edited.edited);

    const unreadBefore = (await chat.conversationsAsync(w.org_id, w.bob)).conversations.find(c => c.conversation_id == w.dm).unread;
    _check("bob has unread messages from alice", unreadBefore >= 2, String(unreadBefore));
    await chat.markReadAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.dm});
    _check("marking read clears the unread count", (await chat.conversationsAsync(w.org_id, w.bob)).conversations.find(c => c.conversation_id == w.dm).unread == 0);
    const wm = await chat.markReadAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.dm, seq: 1});
    _check("the watermark never moves backward", wm.last_read_seq >= 2, JSON.stringify(wm));

    await chat.deleteAsync({org_id: w.org_id, actor_person_id: w.alice, message_id: id});
    msgs = (await chat.messagesAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.dm})).messages;
    const gone = msgs.find(m => m.message_id == id);
    _check("a deleted message stays as a tombstone with no body", gone.deleted && gone.body === null);
    await _checkThrows("a deleted message can't be edited", _ => chat.editAsync({org_id: w.org_id, actor_person_id: w.alice, message_id: id, body: "back"}));

    const after = await chat.messagesAsync({org_id: w.org_id, actor_person_id: w.bob, conversation_id: w.dm, after_seq: 1});
    _check("polling after a seq returns only newer messages, in order", after.messages.length >= 1 &&
        after.messages.every((m, i) => m.seq > 1 && (i == 0 || m.seq > after.messages[i-1].seq)));
}

async function _testNoOutsideReads(w) {
    LOG.console("\n content is for members only\n");
    for (const [who, label] of [[w.dana, "a non-member employee"], [w.admin, "an admin"], [w.hrp, "HR"]]) {
        await _checkThrows(`${label} can't read someone else's DM`, _ =>
            chat.messagesAsync({org_id: w.org_id, actor_person_id: who, conversation_id: w.dm}));
        await _checkThrows(`${label} can't send into someone else's DM`, _ =>
            chat.sendAsync({org_id: w.org_id, actor_person_id: who, conversation_id: w.dm, body: "hi"}));
    }
    _check("an admin's conversation list holds none of others' DMs",
        !(await chat.conversationsAsync(w.org_id, w.admin)).conversations.some(c => c.conversation_id == w.dm));
    const decision = await permissions.checkAsync({org_id: w.org_id, actor_person_id: w.admin,
        capability: "message.read_content", subject_person_id: w.alice});
    _check("message.read_content is still ceiling-refused for the admin", !decision.allowed && decision.outcome == permissions.OUTCOMES.CEILING, decision.outcome);
}

async function _buildWorld() {
    const stamp = Date.now();
    const org = await spine.createOrgAsync({name: `Chat test ${stamp}`, home_jurisdiction: "IN"});
    const roleOf = {alice: "employee", bob: "employee", carol: "lead", dana: "employee", admin: "admin", hrp: "hr", gina: "guest"};
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
    for (const table of ["chat_message", "chat_member", "chat_conversation", "notification", "audit_event",
        "capability_grant", "role_capability", "role", "employment"])
        await dblayer.runCmdBestEffortAsync(`DELETE FROM ${table} WHERE org_id=?`, [w.org_id]);
    await dblayer.runCmdBestEffortAsync("DELETE FROM org WHERE org_id=?", [w.org_id]);
    for (const who of ["alice", "bob", "carol", "dana", "admin", "hrp", "gina"])
        if (w[who]) await dblayer.runCmdBestEffortAsync("DELETE FROM person WHERE person_id=?", [w[who]]);
}
