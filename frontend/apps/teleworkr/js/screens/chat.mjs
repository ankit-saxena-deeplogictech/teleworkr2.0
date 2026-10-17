/**
 * Team chat — direct messages, groups and channels.
 *
 * The page skeleton is drawn once; polling then updates only the conversation
 * list and the message list, so a half-typed message is never clobbered. The
 * open thread is polled every few seconds and the list a little less often;
 * both stop the moment the screen leaves the DOM or the tab is hidden.
 *
 * Conversation content is visible to its members only — there is no admin or
 * HR view, and the screen says nothing that implies one. Text and emoji only:
 * attachments need a file store this product does not have yet.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apiman} from "../apiclient.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "chat", API_CALENDAR = "calendar";
const THREAD_POLL_MS = 3000, LIST_POLL_MS = 12000;
const EMOJI = ["👍", "🙏", "😀", "😂", "😍", "🎉", "👀", "✅", "❌", "🔥", "💡", "❤️", "😅", "🤔", "👏", "🚀"];

const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
/** The server JSON-parses every GET value ("42" -> 42, "true" -> true, "null" -> null), so free text is sent
 *  JSON-encoded and arrives as exactly the string typed. */
const _text = value => JSON.stringify(String(value ?? ""));
const _time = ts => new Date(ts*1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
const _dayLabel = ts => new Date(ts*1000).toLocaleDateString([], {weekday: "short", day: "numeric", month: "short"});
const _initial = name => (name||"?").trim()[0]?.toUpperCase() || "?";

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    _stop();
    const shell = (await import("../shell.mjs")).shell;
    const caps = shell.projection?.capabilities || [];
    state = {root, shell, myId: shell.projection?.person?.person_id, canCreateChannel: caps.includes("chat.channel.create"),
        roster: [], conversations: [], activeId: null, messages: [], latestSeq: 0, newOpen: false, newKind: "dm",
        channels: null, editingId: null, emojiOpen: false, suggest: [], listTick: 0, busy: false, timer: null};

    root.innerHTML = `<div class="page ch">
        <div class="ch-body" id="ch-body">
            <div class="ch-list">
                <div class="ch-list-head"><h2 class="disp" style="font-size:15px">Team chat</h2>
                    <button class="btn pri push" data-ch="new">+ New</button></div>
                <div id="ch-new-host"></div>
                <div class="ch-list-scroll" id="ch-list-scroll">${states.loading({rows: 4})}</div>
            </div>
            <div class="ch-thread" id="ch-thread"></div>
        </div></div>`;
    root.querySelector("[data-ch=\"new\"]").addEventListener("click", _ => {
        state.newOpen = !state.newOpen; _renderNew();});

    state.roster = (await _call(API_CALENDAR, "roster", {date: _today()}))?.roster || [];
    await _loadConversations();
    _renderThreadShell();
    state.timer = setInterval(_tick, THREAD_POLL_MS);
}

function _stop() {if (state?.timer) clearInterval(state.timer); if (state) state.timer = null;}

async function _tick() {
    if (!state?.root?.isConnected) {_stop(); return;}
    if (document.hidden || state.busy) return;
    state.busy = true;
    try {
        if (state.activeId) await _pollThread();
        state.listTick += THREAD_POLL_MS;
        if (state.listTick >= LIST_POLL_MS) {state.listTick = 0; await _loadConversations(true);}
    } finally {state.busy = false;}
}

const _nameOf = id => state.roster.find(p => p.person_id == id)?.display_name || "Former colleague";

// ---------------------------------------------------------------------------
// conversation list
// ---------------------------------------------------------------------------

async function _loadConversations(silent) {
    const response = await _call(API, "conversations", {}, silent);
    if (!response) {
        if (!silent) state.root.querySelector("#ch-list-scroll").innerHTML = states.error({title: "Couldn't load your conversations",
            what: "The chat service did not respond.", safe: "Nothing was changed.", reference: `F6-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        return;
    }
    state.conversations = response.conversations;
    _renderList();
}

function _renderList() {
    const host = state.root.querySelector("#ch-list-scroll");
    const section = (label, kind) => {
        const rows = state.conversations.filter(c => c.kind == kind);
        if (!rows.length) return "";
        return `<div class="ch-group-label">${label}</div>${rows.map(c => `
            <button class="ch-conv${c.conversation_id == state.activeId ? " on" : ""}${c.unread ? " unread" : ""}" data-conv="${states.esc(c.conversation_id)}">
                ${c.kind == "dm" ? `<span class="av">${states.esc(_initial(c.title))}</span>` : `<span class="ch-hash">${c.kind == "channel" ? "#" : "◎"}</span>`}
                <span class="ch-meta"><span class="ch-name">${states.esc(c.title || "")}</span>
                    <span class="ch-prev">${c.last_message ? states.esc((c.last_message.sender_person_id == state.myId ? "You: " : "") + c.last_message.preview) : "No messages yet"}</span></span>
                ${c.unread ? `<span class="ch-unread${c.muted ? " muted" : ""}">${c.unread > 99 ? "99+" : c.unread}</span>` : ""}
            </button>`).join("")}`;
    };
    const html = section("Channels", "channel") + section("Groups", "group") + section("Direct messages", "dm");
    host.innerHTML = html || `<div class="tr-empty" style="padding:18px">No conversations yet. Start one with <b>+ New</b>.</div>`;
    for (const button of host.querySelectorAll("[data-conv]")) button.addEventListener("click", _ => _open(button.getAttribute("data-conv")));
}

// ---------------------------------------------------------------------------
// new conversation / browse channels
// ---------------------------------------------------------------------------

function _renderNew() {
    const host = state.root.querySelector("#ch-new-host");
    if (!state.newOpen) {host.innerHTML = ""; return;}
    const others = state.roster.filter(p => p.person_id != state.myId);
    const tab = (id, label) => `<button class="tr-tab${state.newKind == id ? " on" : ""}" data-nk="${id}">${label}</button>`;
    const people = checkbox => others.map(p => `<label><input type="${checkbox ? "checkbox" : "radio"}" name="ch-pick" value="${states.esc(p.person_id)}"> ${states.esc(p.display_name)}</label>`).join("");
    let body = "";
    if (state.newKind == "dm") body = `<div class="ch-pick">${people(false)}</div><button class="btn pri" data-go="dm">Message</button>`;
    else if (state.newKind == "group") body = `<input class="inp" id="ch-new-title" placeholder="Group name" maxlength="80">
        <div class="ch-pick">${people(true)}</div><button class="btn pri" data-go="group">Create group</button>`;
    else if (state.newKind == "channel") body = state.canCreateChannel ?
        `<input class="inp" id="ch-new-title" placeholder="channel-name" maxlength="80">
         <button class="btn pri" data-go="channel">Create channel</button>` :
        `<div class="sm t3">Creating channels is for team leads, HR and admins. You can still join any channel from <b>Browse</b>.</div>`;
    else body = state.channels === null ? states.loading({rows: 2}) : (state.channels.length ? state.channels.map(c => `
        <div class="tr-track-row"><span class="ch-hash">#</span><span class="grow"><b>${states.esc(c.title)}</b>
            <br><span class="sm t3">${c.member_count} member${c.member_count == 1 ? "" : "s"}</span></span>
            <button class="btn" data-join="${states.esc(c.conversation_id)}">${c.is_member ? "Open" : "Join"}</button></div>`).join("") :
        `<div class="sm t3">No channels yet.</div>`);

    host.innerHTML = `<div class="ch-new" style="margin:8px"><div class="tr-tabs">${tab("dm", "Direct")}${tab("group", "Group")}${tab("channel", "Channel")}${tab("browse", "Browse")}</div>${body}</div>`;
    for (const button of host.querySelectorAll("[data-nk]")) button.addEventListener("click", async _ => {
        state.newKind = button.getAttribute("data-nk");
        if (state.newKind == "browse") {state.channels = null; _renderNew(); state.channels = (await _call(API, "channels"))?.channels || [];}
        _renderNew();
    });
    host.querySelector("[data-go=\"dm\"]")?.addEventListener("click", async _ => {
        const picked = host.querySelector("input[name=\"ch-pick\"]:checked")?.value;
        if (!picked) {states.toast({message: "Pick someone to message."}); return;}
        const response = await _call(API, "open_dm", {other_person_id: picked});
        if (response) {await _afterCreate(response.conversation.conversation_id);}
    });
    host.querySelector("[data-go=\"group\"]")?.addEventListener("click", async _ => {
        const ids = [...host.querySelectorAll("input[name=\"ch-pick\"]:checked")].map(i => i.value);
        const response = await _call(API, "create_group", {title: _text(host.querySelector("#ch-new-title").value), member_person_ids: JSON.stringify(ids)});
        if (response) await _afterCreate(response.conversation.conversation_id);
    });
    host.querySelector("[data-go=\"channel\"]")?.addEventListener("click", async _ => {
        const response = await _call(API, "create_channel", {title: _text(host.querySelector("#ch-new-title").value)});
        if (response) await _afterCreate(response.conversation.conversation_id);
    });
    for (const button of host.querySelectorAll("[data-join]")) button.addEventListener("click", async _ => {
        const id = button.getAttribute("data-join");
        if (await _call(API, "join", {conversation_id: id})) await _afterCreate(id);
    });
}

async function _afterCreate(conversation_id) {
    state.newOpen = false; _renderNew();
    await _loadConversations(true);
    await _open(conversation_id);
}

// ---------------------------------------------------------------------------
// thread
// ---------------------------------------------------------------------------

function _renderThreadShell() {
    const host = state.root.querySelector("#ch-thread");
    const conversation = state.conversations.find(c => c.conversation_id == state.activeId);
    state.root.querySelector("#ch-body").classList.toggle("thread-open", Boolean(conversation));
    if (!conversation) {
        host.innerHTML = `<div class="ch-empty-thread">Pick a conversation, or start a new one.<br>Messages are visible only to the people in them.</div>`;
        return;
    }
    host.innerHTML = `
        <div class="ch-thread-head">
            <button class="btn" data-ch="back" style="display:none" id="ch-back">‹</button>
            <h2 class="disp">${conversation.kind == "channel" ? "# " : ""}${states.esc(conversation.title || "")}</h2>
            <span class="chip">${conversation.kind}</span>
            <span class="push"></span>
            <button class="btn" data-ch="mute">${conversation.muted ? "Unmute" : "Mute"}</button>
            ${conversation.kind != "dm" ? `<button class="btn" data-ch="leave">Leave</button>` : ""}
        </div>
        <div class="ch-msgs" id="ch-msgs"></div>
        <div class="ch-composer">
            <div id="ch-pop"></div>
            <div class="ch-composer-row">
                <textarea class="inp" id="ch-input" rows="1" placeholder="Message ${states.esc(conversation.kind == "channel" ? "#" + conversation.title : conversation.title || "")} — @ to mention"></textarea>
                <button class="btn" data-ch="emoji" title="Emoji">☺</button>
                <button class="btn pri" data-ch="send">Send</button>
            </div>
        </div>`;
    const input = host.querySelector("#ch-input");
    host.querySelector("[data-ch=\"send\"]").addEventListener("click", _ => _send());
    input.addEventListener("keydown", event => {
        if (event.key == "Enter" && !event.shiftKey) {event.preventDefault(); _send();}
    });
    input.addEventListener("input", _ => _updateSuggest(input));
    host.querySelector("[data-ch=\"emoji\"]").addEventListener("click", _ => {state.emojiOpen = !state.emojiOpen; _renderPop(input);});
    host.querySelector("[data-ch=\"mute\"]").addEventListener("click", async _ => {
        const muted = conversation.muted;
        if (await _call(API, "mute", {conversation_id: conversation.conversation_id, until: muted ? "null" : "forever"}))
            {await _loadConversations(true); _renderThreadShell(); _renderMessages();}
    });
    host.querySelector("[data-ch=\"leave\"]")?.addEventListener("click", async _ => {
        if (await _call(API, "leave", {conversation_id: conversation.conversation_id})) {
            state.activeId = null; await _loadConversations(true); _renderThreadShell();}
    });
    const back = host.querySelector("#ch-back");
    if (window.matchMedia("(max-width: 760px)").matches) back.style.display = "";
    back.addEventListener("click", _ => {state.activeId = null; _renderList(); _renderThreadShell();});
}

async function _open(conversation_id) {
    state.activeId = conversation_id; state.messages = []; state.latestSeq = 0; state.editingId = null;
    _renderList(); _renderThreadShell();
    const response = await _call(API, "messages", {conversation_id});
    if (!response) return;
    state.messages = response.messages; state.latestSeq = response.latest_seq;
    _renderMessages(true);
    await _markRead();
    state.root.querySelector("#ch-input")?.focus();
}

async function _pollThread() {
    const id = state.activeId;
    const last = state.messages.length ? state.messages[state.messages.length - 1].seq : 0;
    const response = await _call(API, "messages", {conversation_id: id, after_seq: last}, true);
    if (!response || id != state.activeId || !response.messages.length) return;
    state.messages.push(...response.messages); state.latestSeq = response.latest_seq;
    _renderMessages(true);
    await _markRead();
}

async function _markRead() {
    if (!state.latestSeq || !state.activeId) return;
    await _call(API, "mark_read", {conversation_id: state.activeId, seq: state.latestSeq}, true);
    const conversation = state.conversations.find(c => c.conversation_id == state.activeId);
    if (conversation?.unread) {conversation.unread = 0; _renderList();}
    state.shell.refreshChatBadge?.();
}

/** Escapes, then highlights @Name for the people the server resolved as mentioned. */
function _bodyHtml(message) {
    let html = states.esc(message.body || "");
    for (const person_id of message.mentions || []) {
        const name = states.esc(_nameOf(person_id));
        html = html.replace(new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gi"), match => `<span class="ch-at">${match}</span>`);
    }
    return html;
}

function _renderMessages(stickToBottom) {
    const host = state.root.querySelector("#ch-msgs");
    if (!host) return;
    const nearBottom = host.scrollHeight - host.scrollTop - host.clientHeight < 80;
    let lastDay = null;
    host.innerHTML = state.messages.length ? state.messages.map(message => {
        const day = _dayLabel(message.created_at);
        const separator = day != lastDay ? `<div class="ch-day">${states.esc(day)}</div>` : "";
        lastDay = day;
        const editing = state.editingId == message.message_id;
        return `${separator}<div class="ch-msg${message.is_mine ? " mine" : ""}${message.mentions_me ? " mention" : ""}${message.deleted ? " gone" : ""}">
            <span class="av">${states.esc(_initial(message.sender_name))}</span>
            <div class="ch-body-col" style="flex:1">
                <div class="ch-who">${states.esc(message.sender_name)}<span class="ch-when">${_time(message.created_at)}${message.edited ? " · edited" : ""}</span>
                    ${message.is_mine && !message.deleted ? `<span class="ch-msg-actions"><button data-edit="${states.esc(message.message_id)}">Edit</button><button data-del="${states.esc(message.message_id)}">Delete</button></span>` : ""}</div>
                ${editing ? `<textarea class="inp" id="ch-edit-input" rows="2" style="width:100%">${states.esc(message.body)}</textarea>
                    <div class="row" style="gap:6px;margin-top:4px"><button class="btn pri" data-save="${states.esc(message.message_id)}">Save</button><button class="btn" data-cancel="1">Cancel</button></div>` :
                `<div class="ch-text">${message.deleted ? "Message deleted" : _bodyHtml(message)}</div>`}
            </div></div>`;
    }).join("") : `<div class="ch-empty-thread">No messages yet. Say hello.</div>`;
    if (stickToBottom && (nearBottom || state.messages.length <= 50)) host.scrollTop = host.scrollHeight;

    for (const button of host.querySelectorAll("[data-edit]")) button.addEventListener("click", _ => {
        state.editingId = button.getAttribute("data-edit"); _renderMessages();});
    for (const button of host.querySelectorAll("[data-cancel]")) button.addEventListener("click", _ => {state.editingId = null; _renderMessages();});
    for (const button of host.querySelectorAll("[data-save]")) button.addEventListener("click", async _ => {
        const body = host.querySelector("#ch-edit-input").value;
        if (await _call(API, "edit", {message_id: button.getAttribute("data-save"), body: _text(body)})) {
            const target = state.messages.find(m => m.message_id == button.getAttribute("data-save"));
            if (target) {target.body = body.trim(); target.edited = true;}
            state.editingId = null; _renderMessages();}
    });
    for (const button of host.querySelectorAll("[data-del]")) button.addEventListener("click", async _ => {
        if (await _call(API, "delete", {message_id: button.getAttribute("data-del")})) {
            const target = state.messages.find(m => m.message_id == button.getAttribute("data-del"));
            if (target) {target.deleted = true; target.body = null;}
            _renderMessages();}
    });
}

async function _send() {
    const input = state.root.querySelector("#ch-input");
    const body = input.value.trim();
    if (!body || !state.activeId) return;
    input.disabled = true;
    const response = await _call(API, "send", {conversation_id: state.activeId, body: _text(body)});
    input.disabled = false;
    if (!response) {input.focus(); return;}
    input.value = ""; state.suggest = []; state.emojiOpen = false; _renderPop(input);
    await _pollThread();
    await _loadConversations(true);
    input.focus();
}

// ---------------------------------------------------------------------------
// composer helpers — emoji and @-mention suggestions
// ---------------------------------------------------------------------------

function _updateSuggest(input) {
    const upToCaret = input.value.substring(0, input.selectionStart);
    const match = upToCaret.match(/(?:^|\s)@([^\s@]*)$/);
    state.suggest = match ? state.roster.filter(p => p.person_id != state.myId &&
        p.display_name.toLowerCase().includes(match[1].toLowerCase())).slice(0, 6) : [];
    _renderPop(input);
}

function _renderPop(input) {
    const host = state.root.querySelector("#ch-pop");
    if (!host) return;
    if (state.suggest.length) {
        host.innerHTML = `<div class="ch-suggest">${state.suggest.map((p, i) =>
            `<button class="${i == 0 ? "on" : ""}" data-at="${states.esc(p.display_name)}">${states.esc(p.display_name)}</button>`).join("")}</div>`;
        for (const button of host.querySelectorAll("[data-at]")) button.addEventListener("click", _ => {
            const before = input.value.substring(0, input.selectionStart).replace(/@[^\s@]*$/, `@${button.getAttribute("data-at")} `);
            input.value = before + input.value.substring(input.selectionStart); state.suggest = []; _renderPop(input); input.focus();
        });
    } else if (state.emojiOpen) {
        host.innerHTML = `<div class="ch-emoji-pop">${EMOJI.map(e => `<button data-emo="${e}">${e}</button>`).join("")}</div>`;
        for (const button of host.querySelectorAll("[data-emo]")) button.addEventListener("click", _ => {
            input.setRangeText(button.getAttribute("data-emo"), input.selectionStart, input.selectionEnd, "end"); input.focus();
        });
    } else host.innerHTML = "";
}

// ---------------------------------------------------------------------------

async function _call(api, op, extra = {}, silent = false) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${api}`, "GET", {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`${api} op ${op} failed: ${err}`);}
    if (!response?.result) {
        if (!silent) states.toast({message: response?.reason || `The ${api} service did not respond.`, ms: 8000});
        return null;
    }
    return response;
}
