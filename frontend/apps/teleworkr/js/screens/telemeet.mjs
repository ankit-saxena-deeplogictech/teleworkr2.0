/**
 * Telemeet — video rooms (wireframe F1). A lobby (start a call, open calls), and the room: a video
 * stage with mic / camera / share / leave, the roster with local times and the deliberate "asleep"
 * rows, and shared notes with typed Action / Decision lines.
 *
 * Media is peer-to-peer WebRTC in a full mesh (so at most six people); the server only passes the
 * short signalling messages and never receives audio or video. Negotiation follows the "perfect
 * negotiation" pattern: the person with the larger id is the polite peer, and whoever joins makes the
 * first offers to the people already there.
 *
 * Leaving this screen leaves the call — the media lives in this page, and the room says so.
 * A person without a camera or microphone (or on plain http, where browsers withhold them) joins as a
 * listener and can still use the notes.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apiman} from "../apiclient.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "telemeet", API_POST = "telemeetpost", API_CALENDAR = "calendar";
const HEARTBEAT_MS = 8000, SIGNAL_MS = 1000, DEGRADED_AFTER_MS = 6000;

const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
const _initial = name => (name||"?").trim()[0]?.toUpperCase() || "?";
/** The server JSON-parses every GET value, so free text is sent JSON-encoded and arrives exactly as typed. */
const _text = value => JSON.stringify(String(value ?? ""));
const _mins = seconds => `${Math.max(1, Math.round(seconds/60))} min`;

let state = null;    // the screen
let rtc = null;      // the live call, if any

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    await _teardownCall(false);
    const shell = (await import("../shell.mjs")).shell;
    state = {root, shell, myId: shell.projection?.person?.person_id, roster: [], view: "lobby", data: null};
    state.roster = (await _call(API_CALENDAR, "roster", {date: _today()}))?.roster || [];

    const pending = window.__tw_join_room; window.__tw_join_room = null;
    if (pending) return await _enter(pending);
    await _lobby();
}

const _nameOf = id => state.roster.find(p => p.person_id == id)?.display_name || "Former colleague";

// ---------------------------------------------------------------------------
// lobby
// ---------------------------------------------------------------------------

async function _lobby() {
    state.view = "lobby"; state.data = null;
    const root = state.root;
    root.innerHTML = `<div class="page tmt">
        <div class="tmt-card"><h2 class="disp" style="font-size:16px">Start a call</h2>
            <div class="row wrap" style="gap:8px">
                <input class="inp" id="tmt-title" placeholder="What's it about?" maxlength="120" style="width:260px">
                <input class="inp" id="tmt-task" placeholder="Task, e.g. TASK-1042 (optional)" style="width:230px">
            </div>
            <div class="up t3">Invite — up to five others join live</div>
            <div class="tmt-pick">${state.roster.filter(p => p.person_id != state.myId).map(p => `
                <label><input type="checkbox" value="${states.esc(p.person_id)}"> ${states.esc(p.display_name)}</label>`).join("") ||
                `<span class="sm t3">No one else is in this org yet.</span>`}</div>
            <div class="row"><button class="btn pri" id="tmt-start">Start call</button>
                <span class="sm t3">Audio and video go directly between you and the others. Nothing is recorded or stored.</span></div>
        </div>
        <div class="tmt-card"><h2 class="disp" style="font-size:16px">Open calls</h2><div id="tmt-open">${states.loading({rows: 2})}</div></div>
    </div>`;
    root.querySelector("#tmt-start").addEventListener("click", async _ => {
        const ids = [...root.querySelectorAll(".tmt-pick input:checked")].map(i => i.value);
        const response = await _call(API, "create_room", {title: _text(root.querySelector("#tmt-title").value),
            task_ref: root.querySelector("#tmt-task").value.trim() ? _text(root.querySelector("#tmt-task").value.trim()) : undefined,
            invitee_person_ids: JSON.stringify(ids)});
        if (response) await _enter(response.room.room_id);
    });
    const response = await _call(API, "my_rooms");
    const host = root.querySelector("#tmt-open"); if (!host) return;
    const rooms = response?.rooms || [];
    host.innerHTML = rooms.length ? rooms.map(room => `<div class="tr-track-row">
        <span class="grow"><b>${states.esc(room.title)}</b>${room.task_ref ? ` <span class="chip">${states.esc(room.task_ref)}</span>` : ""}
            <br><span class="sm t3">started by ${states.esc(room.owner_name)} · ${room.live_count} in the call now</span></span>
        <button class="btn pri" data-join="${states.esc(room.room_id)}">${room.in_it ? "Rejoin" : "Join"}</button></div>`).join("") :
        `<div class="tr-empty">No open calls. Start one above, or press <b>Join call</b> on a meeting in your calendar.</div>`;
    for (const button of host.querySelectorAll("[data-join]")) button.addEventListener("click", _ => _enter(button.getAttribute("data-join")));
}

// ---------------------------------------------------------------------------
// entering, and the live call
// ---------------------------------------------------------------------------

async function _acquireMedia() {
    if (!navigator.mediaDevices?.getUserMedia)
        return {stream: null, note: "This browser can't reach a camera or microphone (they need https). You joined as a listener and can still use the notes."};
    try {return {stream: await navigator.mediaDevices.getUserMedia({audio: true, video: {width: {ideal: 640}, height: {ideal: 360}}})};}
    catch (err) {LOG.error(`Camera and microphone unavailable: ${err}`);}
    try {return {stream: await navigator.mediaDevices.getUserMedia({audio: true}), note: "Camera unavailable — you joined with audio only."};}
    catch (err) {LOG.error(`Microphone unavailable: ${err}`);}
    return {stream: null, note: "Microphone and camera are blocked — you joined as a listener. Allow them in the browser to speak."};
}

async function _enter(room_id) {
    state.view = "room";
    state.root.innerHTML = `<div class="page tmt"><div class="tmt-card">${states.loading({rows: 2})}</div></div>`;
    const media = await _acquireMedia();
    const joined = await _call(API, "join", {room_id});
    if (!joined) {media.stream?.getTracks().forEach(t => t.stop()); await _lobby(); return;}

    rtc = {room_id, stream: media.stream, note: media.note || null, ice: joined.ice_servers, peers: new Map(), tiles: new Map(),
        lastSignal: 0, sharing: false, screenStream: null, timers: [], ended: false, joinedAt: Math.floor(Date.now()/1000),
        degraded: new Map(), polling: false, draftKind: "note"};
    state.data = joined;
    for (const pid of joined.peers) _makePeer(pid);
    rtc.timers.push(setInterval(_pollSignals, SIGNAL_MS), setInterval(_heartbeat, HEARTBEAT_MS));
    _renderRoom();
}

function _makePeer(pid) {
    const pc = new RTCPeerConnection({iceServers: rtc.ice});
    const peer = {pid, pc, polite: state.myId > pid, makingOffer: false, ignoreOffer: false, stream: new MediaStream(), pendingIce: []};
    rtc.peers.set(pid, peer);

    for (const kind of ["audio", "video"]) {
        const track = rtc.stream?.getTracks().find(t => t.kind == kind);
        if (track) pc.addTrack(track, rtc.stream); else pc.addTransceiver(kind, {direction: "recvonly"});
    }
    pc.ontrack = ({track, streams}) => {
        if (streams[0]) peer.stream = streams[0]; else peer.stream.addTrack(track);
        _renderGrid();
    };
    pc.onicecandidate = ({candidate}) => {if (candidate) _signal(pid, "ice", candidate.toJSON());};
    pc.onnegotiationneeded = async _ => {
        try {peer.makingOffer = true; await pc.setLocalDescription(); await _signal(pid, "offer", pc.localDescription.toJSON());}
        catch (err) {LOG.error(`Offer to ${pid} failed: ${err}`);} finally {peer.makingOffer = false;}
    };
    pc.oniceconnectionstatechange = _ => {if (pc.iceConnectionState == "failed") pc.restartIce();};
    pc.onconnectionstatechange = _ => {
        if (["failed", "disconnected"].includes(pc.connectionState)) rtc.degraded.set(pid, Date.now());
        else rtc.degraded.delete(pid);
        _renderBanners();
    };
    return peer;
}

async function _handleSignal(signal) {
    const peer = rtc.peers.get(signal.from_person_id) || _makePeer(signal.from_person_id);
    const pc = peer.pc;
    try {
        if (signal.kind == "ice") {
            if (!pc.remoteDescription) {peer.pendingIce.push(signal.payload); return;}
            try {await pc.addIceCandidate(signal.payload);} catch (err) {if (!peer.ignoreOffer) throw err;}
            return;
        }
        const description = signal.payload;
        const collision = description.type == "offer" && (peer.makingOffer || pc.signalingState != "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(description);
        for (const candidate of peer.pendingIce.splice(0)) try {await pc.addIceCandidate(candidate);} catch (err) {LOG.error(`ICE: ${err}`);}
        if (description.type == "offer") {
            await pc.setLocalDescription();
            await _signal(signal.from_person_id, "answer", pc.localDescription.toJSON());
        }
    } catch (err) {LOG.error(`Handling ${signal.kind} from ${signal.from_person_id} failed: ${err}`);}
}

/** POST first — an offer is far too large for a URL — and GET as the fallback if the route isn't there. */
async function _signal(to, kind, payload) {
    const request = {op: "signal_send", ..._me(), room_id: rtc.room_id, to_person_id: to, kind, payload: JSON.stringify(payload)};
    try {
        const response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_POST}`, "POST", request, true);
        if (response?.result) return;
    } catch (err) {LOG.error(`Signal POST failed, trying GET: ${err}`);}
    try {await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET", request, true);}
    catch (err) {LOG.error(`Signal to ${to} failed: ${err}`);}
}

async function _pollSignals() {
    if (!rtc || rtc.polling || rtc.ended) return;
    if (!state.root.isConnected) {await _teardownCall(false); return;}   // navigated away: leave the call, stop the audio
    rtc.polling = true;
    try {
        const response = await _call(API, "signal_poll", {room_id: rtc.room_id, after: rtc.lastSignal}, true);
        for (const signal of response?.signals || []) {
            rtc.lastSignal = Math.max(rtc.lastSignal, signal.signal_id);
            await _handleSignal(signal);
        }
    } finally {if (rtc) rtc.polling = false;}
}

async function _heartbeat() {
    if (!rtc || rtc.ended) return;
    if (!state.root.isConnected) {await _teardownCall(false); return;}
    const response = await _call(API, "heartbeat", {room_id: rtc.room_id}, true);
    if (!response || !rtc) return;
    state.data = response;
    const live = new Set(response.participants.map(p => p.person_id));
    for (const [pid, peer] of rtc.peers) if (!live.has(pid)) {peer.pc.close(); rtc.peers.delete(pid); rtc.tiles.get(pid)?.remove(); rtc.tiles.delete(pid); rtc.degraded.delete(pid);}
    if (response.room.ended_at || !response.me_in_call) {await _finishCall(response.room.ended_at ? "ended" : "dropped"); return;}
    _renderSide(); _renderGrid(); _renderBanners();
}

// ---------------------------------------------------------------------------
// the room view
// ---------------------------------------------------------------------------

function _renderRoom() {
    const data = state.data, room = data.room;
    state.root.innerHTML = `<div class="page tmt"><div class="tmt-room">
        <div class="tmt-stage">
            <div class="tmt-head"><h2 class="disp">${states.esc(room.title)}</h2>
                ${room.task_ref ? `<span class="chip">linked to ${states.esc(room.task_ref)}</span>` : ""}
                <span class="push"></span>
                ${data.is_owner ? `<button class="btn" id="tmt-end">End for everyone</button>` : ""}</div>
            <div id="tmt-banners"></div>
            <div class="tmt-grid" id="tmt-grid"></div>
            <div class="tmt-controls">
                <button class="tmt-ctl" id="tmt-mic">Mic</button>
                <button class="tmt-ctl" id="tmt-cam">Camera</button>
                <button class="tmt-ctl" id="tmt-share">Share screen</button>
                <button class="tmt-ctl leave" id="tmt-leave">Leave</button>
            </div>
            <div class="sm t3" style="text-align:center">Audio and video are peer-to-peer and never recorded. Leaving this screen leaves the call.</div>
        </div>
        <div class="tmt-side" id="tmt-side"></div>
    </div></div>`;
    const root = state.root;
    root.querySelector("#tmt-mic").addEventListener("click", _ => _toggle("audio"));
    root.querySelector("#tmt-cam").addEventListener("click", _ => _toggle("video"));
    root.querySelector("#tmt-share").addEventListener("click", _ => _toggleShare());
    root.querySelector("#tmt-leave").addEventListener("click", _ => _leaveClicked());
    root.querySelector("#tmt-end")?.addEventListener("click", async _ => {
        if (await _call(API, "end", {room_id: rtc.room_id})) await _finishCall("ended");});
    _renderSide(true); _renderGrid(); _renderBanners(); _paintControls();
}

function _paintControls() {
    const root = state.root; if (!root || !rtc) return;
    const track = kind => rtc.stream?.getTracks().find(t => t.kind == kind);
    const mic = root.querySelector("#tmt-mic"), cam = root.querySelector("#tmt-cam"), share = root.querySelector("#tmt-share");
    if (!mic) return;
    mic.textContent = !track("audio") ? "No mic" : (track("audio").enabled ? "Mute" : "Unmute");
    mic.classList.toggle("off", Boolean(track("audio")) && !track("audio").enabled); mic.disabled = !track("audio");
    cam.textContent = !track("video") ? "No camera" : (track("video").enabled ? "Camera off" : "Camera on");
    cam.classList.toggle("off", Boolean(track("video")) && !track("video").enabled); cam.disabled = !track("video");
    share.textContent = rtc.sharing ? "Stop sharing" : "Share screen"; share.classList.toggle("on", rtc.sharing);
    share.disabled = !navigator.mediaDevices?.getDisplayMedia;
}

function _toggle(kind) {
    const track = rtc.stream?.getTracks().find(t => t.kind == kind);
    if (!track) return;
    track.enabled = !track.enabled; _paintControls(); _renderGrid();
}

async function _toggleShare() {
    if (rtc.sharing) return await _stopShare();
    try {
        rtc.screenStream = await navigator.mediaDevices.getDisplayMedia({video: true});
    } catch (err) {LOG.error(`Screen share cancelled: ${err}`); return;}
    const track = rtc.screenStream.getVideoTracks()[0];
    track.onended = _ => _stopShare();
    await _replaceVideo(track);
    rtc.sharing = true; _paintControls(); _renderGrid();
}

async function _stopShare() {
    rtc.screenStream?.getTracks().forEach(t => t.stop()); rtc.screenStream = null; rtc.sharing = false;
    await _replaceVideo(rtc.stream?.getVideoTracks()[0] || null);
    _paintControls(); _renderGrid();
}

/** Swaps the outgoing video on every connection; a listener's receive-only video slot becomes send-receive to carry a share. */
async function _replaceVideo(track) {
    for (const {pc} of rtc.peers.values()) {
        const transceiver = pc.getTransceivers().find(t => t.receiver.track.kind == "video");
        if (!transceiver) continue;
        if (track && transceiver.direction == "recvonly") transceiver.direction = "sendrecv";
        try {await transceiver.sender.replaceTrack(track);} catch (err) {LOG.error(`Could not swap video: ${err}`);}
    }
}

function _renderBanners() {
    const host = state.root?.querySelector("#tmt-banners"); if (!host || !rtc) return;
    const banners = [];
    if (rtc.note) banners.push(`<div class="tmt-banner info">${states.esc(rtc.note)}</div>`);
    const now = Date.now();
    const bad = [...rtc.degraded].filter(([, since]) => now - since > DEGRADED_AFTER_MS).map(([pid]) => _nameOf(pid));
    if (bad.length) banners.push(`<div class="tmt-banner">Connection degraded with ${states.esc(bad.join(", "))}. ${
        rtc.stream?.getVideoTracks().some(t => t.enabled) ? `<button class="btn" id="tmt-audioonly">Switch to audio only</button>` : "Trying to reconnect…"}</div>`);
    host.innerHTML = banners.join("");
    host.querySelector("#tmt-audioonly")?.addEventListener("click", _ => {
        rtc.stream?.getVideoTracks().forEach(t => t.enabled = false); _paintControls(); _renderGrid(); _renderBanners();});
}

/** Tiles are kept between renders so a playing video is never torn down by a poll. */
function _renderGrid() {
    const grid = state.root?.querySelector("#tmt-grid"); if (!grid || !rtc) return;
    const ensure = (pid, local) => {
        let tile = rtc.tiles.get(pid);
        if (!tile) {
            tile = document.createElement("div");
            tile.className = `tmt-tile${local ? " me" : ""}`;
            tile.innerHTML = `<span class="av">${states.esc(_initial(_nameOf(pid)))}</span><video autoplay playsinline ${local ? "muted" : ""}></video>
                <span class="tmt-name">${states.esc(local ? "You" : _nameOf(pid))}</span>`;
            rtc.tiles.set(pid, tile); grid.appendChild(tile);
        }
        return tile;
    };
    const paint = (tile, stream, enabled, sharing) => {
        const video = tile.querySelector("video");
        if (video.srcObject !== stream) video.srcObject = stream;
        const hasVideo = Boolean(stream) && stream.getVideoTracks().some(t => t.readyState == "live") && enabled;
        tile.classList.toggle("has-video", hasVideo);
        tile.classList.toggle("sharing", Boolean(sharing));
    };
    const mine = ensure(state.myId, true);
    const shown = rtc.sharing ? rtc.screenStream : rtc.stream;
    paint(mine, shown, rtc.sharing || Boolean(rtc.stream?.getVideoTracks().some(t => t.enabled)), rtc.sharing);
    for (const [pid, peer] of rtc.peers) paint(ensure(pid, false), peer.stream, true, false);
}

function _renderSide(full) {
    const side = state.root?.querySelector("#tmt-side"); if (!side) return;
    const data = state.data;
    if (full || !side.querySelector("#tmt-people")) side.innerHTML = `
        <div class="tmt-card"><div class="up t3">In this call</div><div id="tmt-people"></div></div>
        <div class="tmt-card"><div class="up t3">Shared notes</div><div class="tmt-notes" id="tmt-notes"></div>
            <div class="tmt-add">
                <input class="inp" id="tmt-note-text" placeholder="Type a note…" maxlength="500">
                <select class="inp" id="tmt-note-assignee" style="display:none;width:120px"><option value="">Assign to…</option>${
                    data.people.map(p => `<option value="${states.esc(p.person_id)}">${states.esc(p.display_name)}</option>`).join("")}</select>
            </div>
            <div class="row" style="gap:6px"><button class="btn" data-add="note">Add note</button>
                <button class="btn" data-add="action">＋ Action</button><button class="btn" data-add="decision">＋ Decision</button></div>
            <div class="sm t3">Anyone in the call can edit. On ending, actions become tasks and everything is saved${
                data.room.task_ref ? ` to ${states.esc(data.room.task_ref)}` : " with the room"}. Your time in the call is logged for you.</div>
        </div>`;
    side.querySelector("#tmt-people").innerHTML = data.people.map(p => `<div class="tmt-person">
        <span class="av">${states.esc(_initial(p.display_name))}</span>
        <div><div style="font-size:12.5px">${states.esc(p.display_name)}${p.is_me ? " · you" : ""}${p.is_owner ? " · host" : ""}</div>
            <div class="tmt-sub">${p.local_time ? `${states.esc(p.local_time)} local` : "local time unknown"}${
                p.asleep ? " · outside their hours — gets the notes in their brief" : ""}</div></div>
        <span class="tmt-chip ${p.in_call ? "in" : (p.asleep ? "asleep" : "invited")}">${p.in_call ? "in call" : (p.asleep ? "asleep" : "invited")}</span></div>`).join("");

    const notes = side.querySelector("#tmt-notes");
    notes.innerHTML = data.notes.length ? data.notes.map(n => `<div class="tmt-line" data-line="${states.esc(n.line_id)}">
        <span class="tmt-kind ${n.kind}">${n.kind}</span>
        <span style="flex:1;word-break:break-word">${states.esc(n.text)}${n.assignee_person_id ? ` <span class="t3">→ ${states.esc(_nameOf(n.assignee_person_id))}</span>` : ""}</span>
        <span class="tmt-actions"><button data-edit="${states.esc(n.line_id)}">Edit</button><button data-remove="${states.esc(n.line_id)}">✕</button></span></div>`).join("") :
        `<div class="sm t3">Nothing yet. Type a note, or mark a line as an Action or a Decision.</div>`;
    for (const button of notes.querySelectorAll("[data-edit]")) button.addEventListener("click", _ => _editLine(button.getAttribute("data-edit")));
    for (const button of notes.querySelectorAll("[data-remove]")) button.addEventListener("click", async _ => {
        if (await _call(API, "note_edit", {room_id: rtc.room_id, line_id: button.getAttribute("data-remove"), remove: true})) await _heartbeat();});
    if (full) {
        const assignee = side.querySelector("#tmt-note-assignee");
        for (const button of side.querySelectorAll("[data-add]")) button.addEventListener("click", async _ => {
            const kind = button.getAttribute("data-add"), input = side.querySelector("#tmt-note-text");
            if (kind == "action") assignee.style.display = "";
            if (!input.value.trim()) {input.focus(); return;}
            const response = await _call(API, "note_add", {room_id: rtc.room_id, kind, text: _text(input.value),
                assignee_person_id: kind == "action" && assignee.value ? assignee.value : undefined});
            if (response) {input.value = ""; assignee.value = ""; await _heartbeat();}
        });
    }
}

async function _editLine(line_id) {
    const line = state.data.notes.find(n => n.line_id == line_id); if (!line) return;
    const row = state.root.querySelector(`[data-line="${CSS.escape(line_id)}"]`);
    row.innerHTML = `<input class="inp" style="flex:1" value="${states.esc(line.text)}" maxlength="500"><button class="btn pri" data-save="1">Save</button><button class="btn" data-cancel="1">Cancel</button>`;
    const input = row.querySelector("input"); input.focus();
    row.querySelector("[data-cancel]").addEventListener("click", _ => _renderSide());
    row.querySelector("[data-save]").addEventListener("click", async _ => {
        if (await _call(API, "note_edit", {room_id: rtc.room_id, line_id, text: _text(input.value)})) await _heartbeat();});
}

// ---------------------------------------------------------------------------
// leaving
// ---------------------------------------------------------------------------

async function _leaveClicked() {
    const draft = state.root.querySelector("#tmt-note-text")?.value.trim();
    if (draft && !window.confirm("You have a note you haven't added. Leave anyway?")) return;
    await _call(API, "leave", {room_id: rtc.room_id}, true);
    await _finishCall("left");
}

/** Stops every timer, connection and track. `silent` is for entering the screen afresh. */
async function _teardownCall(silent) {
    if (!rtc) return;
    const call = rtc; rtc = null;
    call.ended = true; call.timers.forEach(clearInterval);
    for (const {pc} of call.peers.values()) pc.close();
    call.stream?.getTracks().forEach(t => t.stop()); call.screenStream?.getTracks().forEach(t => t.stop());
    if (!silent) try {await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET", {op: "leave", ..._me(), room_id: call.room_id}, true);}
        catch (err) {LOG.error(`Leave on teardown failed: ${err}`);}
    return call;
}

async function _finishCall(why) {
    const call = rtc ? {room_id: rtc.room_id, joinedAt: rtc.joinedAt} : null;
    await _teardownCall(true);
    if (!call || !state?.root?.isConnected) return;
    const room = await _call(API, "room", {room_id: call.room_id}, true);
    const seconds = Math.floor(Date.now()/1000) - call.joinedAt;
    const notes = room?.notes || [];
    state.view = "ended";
    state.root.innerHTML = `<div class="page tmt"><div class="tmt-card">
        <h2 class="disp" style="font-size:16px">${why == "dropped" ? "You were disconnected" : "You left the call"}${room?.room?.ended_at ? " — the call has ended" : ""}</h2>
        <div class="sm">${seconds >= 60 ? `${_mins(seconds)} on the call${room?.room?.task_ref ? ` was logged to ${states.esc(room.room.task_ref)}` : " was logged to your timesheet"}.` : "Calls under a minute aren't logged."}</div>
        ${notes.length ? `<div class="up t3">Notes${room.room.ended_at ? "" : " so far"}</div><div class="tmt-notes">${notes.map(n => `<div class="tmt-line">
            <span class="tmt-kind ${n.kind}">${n.kind}</span><span style="flex:1">${states.esc(n.text)}${n.assignee_person_id ? ` <span class="t3">→ ${states.esc(_nameOf(n.assignee_person_id))}</span>` : ""}${
                n.task_ref_created ? ` <span class="chip">became ${states.esc(n.task_ref_created)}</span>` : ""}</span></div>`).join("")}</div>` : ""}
        <div class="row"><button class="btn pri" id="tmt-again">Back to calls</button>
            ${!room?.room?.ended_at ? `<button class="btn" id="tmt-rejoin">Rejoin</button>` : ""}</div></div></div>`;
    state.root.querySelector("#tmt-again").addEventListener("click", _ => _lobby());
    state.root.querySelector("#tmt-rejoin")?.addEventListener("click", _ => _enter(call.room_id));
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
