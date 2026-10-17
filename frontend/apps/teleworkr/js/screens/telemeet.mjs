/**
 * Telemeet — video rooms (wireframe F1). A lobby (start a call, open calls), and the room: a video
 * stage with mic / camera / share / leave, the roster with local times and the deliberate "asleep"
 * rows, shared notes with typed Action / Decision lines, raise-hand, a chat for the call, and a local
 * recording. Recording is made in the recorder's own browser (a canvas of the tiles plus the mixed audio, saved
 * as a file on their computer); the server is only told that it is happening so everyone else sees it.
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
const HEARTBEAT_MS = 4000, SIGNAL_MS = 1000, DEGRADED_AFTER_MS = 6000;

const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
const _initial = name => (name||"?").trim()[0]?.toUpperCase() || "?";
/** The server JSON-parses every GET value, so free text is sent JSON-encoded and arrives exactly as typed. */
const _text = value => JSON.stringify(String(value ?? ""));
const _clock = epoch => new Date(epoch*1000).toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
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
                <span class="sm t3">Audio and video go directly between you and the others and are never stored by Teleworkr. Anyone can save a copy to their own computer; everyone on the call is told.</span></div>
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
        degraded: new Map(), polling: false, draftKind: "note", handUp: false, recorder: null, encrypted: {ok: 0, total: 0}, chatSeen: 0};
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
    rtc.handUp = Boolean(response.people.find(p => p.is_me)?.hand_raised);
    _checkEncryption();
    const live = new Set(response.participants.map(p => p.person_id));
    for (const [pid, peer] of rtc.peers) if (!live.has(pid)) {peer.pc.close(); rtc.peers.delete(pid); rtc.tiles.get(pid)?.remove(); rtc.tiles.delete(pid); rtc.degraded.delete(pid);}
    if (response.room.ended_at || !response.me_in_call) {await _finishCall(response.room.ended_at ? "ended" : "dropped"); return;}
    _renderSide(); _renderGrid(); _renderBanners(); _paintControls();
}

/** Asks each connection whether its DTLS handshake finished — media only flows once it has, and the keys never leave the browsers. */
async function _checkEncryption() {
    const call = rtc; if (!call) return;
    let ok = 0;
    for (const {pc} of call.peers.values()) try {
        const report = await pc.getStats();
        for (const stat of report.values()) if (stat.type == "transport" && stat.dtlsState == "connected") {ok++; break;}
    } catch (err) {LOG.error(`Could not read connection stats: ${err}`);}
    call.encrypted = {ok, total: call.peers.size};
    const chip = state.root?.querySelector("#tmt-enc"); if (chip) _paintEncryption(chip);
}

function _paintEncryption(chip) {
    const {ok, total} = rtc.encrypted;
    chip.className = `chip${total && ok == total ? " ok" : ""}`;
    chip.textContent = !total ? "Waiting for others" : (ok == total ? `Encrypted browser-to-browser · ${ok} of ${total} verified` : `Securing connections · ${ok} of ${total}`);
    chip.title = "Audio and video are encrypted with keys negotiated directly between the browsers (DTLS-SRTP). The server only passes the setup messages and never holds the keys.";
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
                <span class="chip" id="tmt-enc"></span>
                <span class="push"></span>
                ${data.is_owner ? `<button class="btn" id="tmt-end">End for everyone</button>` : ""}</div>
            <div id="tmt-banners"></div>
            <div class="tmt-grid" id="tmt-grid"></div>
            <div class="tmt-controls">
                <button class="tmt-ctl" id="tmt-mic">Mic</button>
                <button class="tmt-ctl" id="tmt-cam">Camera</button>
                <button class="tmt-ctl" id="tmt-share">Share screen</button>
                <button class="tmt-ctl" id="tmt-hand">Raise hand</button>
                <button class="tmt-ctl" id="tmt-rec">Record</button>
                <button class="tmt-ctl leave" id="tmt-leave">Leave</button>
            </div>
            <div class="sm t3" style="text-align:center">Audio and video go directly between the people on the call; the server never receives or stores them. Anyone can save a copy to their own computer, and everyone is told when they do. Leaving this screen leaves the call.</div>
        </div>
        <div class="tmt-side" id="tmt-side"></div>
    </div></div>`;
    const root = state.root;
    root.querySelector("#tmt-mic").addEventListener("click", _ => _toggle("audio"));
    root.querySelector("#tmt-cam").addEventListener("click", _ => _toggle("video"));
    root.querySelector("#tmt-share").addEventListener("click", _ => _toggleShare());
    root.querySelector("#tmt-hand").addEventListener("click", _ => _toggleHand());
    root.querySelector("#tmt-rec").addEventListener("click", _ => _toggleRecording());
    root.querySelector("#tmt-leave").addEventListener("click", _ => _leaveClicked());
    root.querySelector("#tmt-end")?.addEventListener("click", async _ => {
        if (await _call(API, "end", {room_id: rtc.room_id})) await _finishCall("ended");});
    _renderSide(true); _renderGrid(); _renderBanners(); _paintControls(); _paintEncryption(root.querySelector("#tmt-enc")); _checkEncryption();
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
    const hand = root.querySelector("#tmt-hand"), rec = root.querySelector("#tmt-rec");
    hand.textContent = rtc.handUp ? "Lower hand" : "Raise hand"; hand.classList.toggle("on", rtc.handUp);
    rec.textContent = rtc.recorder ? "Stop recording" : "Record"; rec.classList.toggle("on", Boolean(rtc.recorder));
    rec.disabled = !(window.MediaRecorder && window.AudioContext && HTMLCanvasElement.prototype.captureStream);
}

async function _toggleHand() {
    const response = await _call(API, "hand", {room_id: rtc.room_id, raised: !rtc.handUp});
    if (response) {rtc.handUp = response.raised; _paintControls(); await _heartbeat();}
}

// ---------------------------------------------------------------------------
// recording — local to this browser
// ---------------------------------------------------------------------------

async function _toggleRecording() {
    if (rtc.recorder) return await _stopRecording(true);
    if (!window.confirm("Record this call on your computer?\n\nThe recording is made in your browser and saved to your own downloads — Teleworkr never receives it. " +
        "Everyone on the call will be told you are recording. Make sure you have their agreement where your policy requires it.")) return;
    const told = await _call(API, "recording", {room_id: rtc.room_id, on: true});
    if (!told) return;
    try {rtc.recorder = _startRecorder();}
    catch (err) {
        LOG.error(`Could not start recording: ${err}`);
        await _call(API, "recording", {room_id: rtc.room_id, on: false}, true);
        states.toast({message: "This browser couldn't start a recording.", ms: 6000}); return;
    }
    _paintControls(); _renderBanners(); await _heartbeat();
}

/** Draws every tile onto one canvas and mixes every audio track into one stream, then records that. */
function _startRecorder() {
    const W = 1280, H = 720, canvas = document.createElement("canvas"); canvas.width = W; canvas.height = H;
    const g = canvas.getContext("2d"), audio = new AudioContext(), mix = audio.createMediaStreamDestination(), fed = new Map();
    const draw = _ => {
        if (!rtc) return;
        for (const peerStream of [rtc.stream, ...[...rtc.peers.values()].map(p => p.stream)]) {   // new arrivals join the mix as they appear
            if (!peerStream || fed.has(peerStream.id) || !peerStream.getAudioTracks().length) continue;
            fed.set(peerStream.id, true);
            try {audio.createMediaStreamSource(new MediaStream(peerStream.getAudioTracks())).connect(mix);} catch (err) {LOG.error(`Audio mix: ${err}`);}
        }
        const ids = [state.myId, ...rtc.peers.keys()], cols = Math.ceil(Math.sqrt(ids.length)), rows = Math.ceil(ids.length/cols);
        const w = W/cols, h = H/rows;
        g.fillStyle = "#0b0d12"; g.fillRect(0, 0, W, H);
        ids.forEach((pid, i) => {
            const x = (i % cols)*w, y = Math.floor(i/cols)*h, tile = rtc.tiles.get(pid), video = tile?.querySelector("video");
            if (video && tile.classList.contains("has-video") && video.videoWidth) {
                const scale = Math.min(w/video.videoWidth, h/video.videoHeight), dw = video.videoWidth*scale, dh = video.videoHeight*scale;
                g.drawImage(video, x + (w - dw)/2, y + (h - dh)/2, dw, dh);
            } else {g.fillStyle = "#e6e8ee"; g.font = "28px sans-serif"; g.textAlign = "center"; g.fillText(pid == state.myId ? "You" : _nameOf(pid), x + w/2, y + h/2);}
        });
    };
    draw(); const timer = setInterval(draw, 100);
    const out = new MediaStream([...canvas.captureStream(10).getVideoTracks(), ...mix.stream.getAudioTracks()]);
    const mime = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find(m => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(out, mime ? {mimeType: mime} : undefined), chunks = [], title = state.data.room.title;
    recorder.ondataavailable = event => {if (event.data.size) chunks.push(event.data);};
    recorder.start(2000);
    return {recorder, chunks, timer, audio, title, mime: recorder.mimeType || "video/webm"};
}

/** Stops the recording and saves it to this computer. `tell` is false when the call is already over. */
async function _stopRecording(tell) {
    const rec = rtc?.recorder; if (!rec) return;
    rtc.recorder = null;
    clearInterval(rec.timer);
    await new Promise(resolve => {rec.recorder.onstop = resolve; try {rec.recorder.stop();} catch (_) {resolve();}});
    rec.audio.close().catch(_ => {});
    if (tell) await _call(API, "recording", {room_id: rtc.room_id, on: false}, true);
    const blob = new Blob(rec.chunks, {type: rec.mime}), link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${rec.title.replace(/[^\w\- ]+/g, "").trim() || "call"} ${new Date().toISOString().substring(0, 16).replace(/[:T]/g, "-")}.webm`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(_ => URL.revokeObjectURL(link.href), 60000);
    if (rtc) {_paintControls(); _renderBanners();}
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
    const recorders = (state.data?.people || []).filter(p => p.recording && !p.is_me).map(p => p.display_name);
    if (rtc.recorder) banners.push(`<div class="tmt-banner">You are recording this call. The file is saved to your computer when you stop or leave.</div>`);
    if (recorders.length) banners.push(`<div class="tmt-banner">${states.esc(recorders.join(", "))} ${recorders.length > 1 ? "are" : "is"} recording this call on ${recorders.length > 1 ? "their own computers" : "their own computer"}.</div>`);
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
        <div class="tmt-card"><div class="up t3">Chat — deleted when the call ends</div><div class="tmt-chat" id="tmt-chat"></div>
            <div class="tmt-add"><input class="inp" id="tmt-chat-text" placeholder="Message everyone in the call…" maxlength="500"></div>
            <button class="btn" id="tmt-chat-send">Send</button></div>
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
        <div><div style="font-size:12.5px">${states.esc(p.display_name)}${p.is_me ? " · you" : ""}${p.is_owner ? " · host" : ""}${p.hand_raised ? ` · <b class="tmt-hand">hand up</b>` : ""}${p.recording ? ` · <b class="tmt-rec">REC</b>` : ""}</div>
            <div class="tmt-sub">${p.local_time ? `${states.esc(p.local_time)} local` : "local time unknown"}${
                p.asleep ? " · outside their hours — gets the notes in their brief" : ""}</div></div>
        ${p.hand_raised && data.is_owner && !p.is_me ? `<button class="btn" data-lower="${states.esc(p.person_id)}">Lower</button>` : ""}
        <span class="tmt-chip ${p.in_call ? "in" : (p.asleep ? "asleep" : "invited")}">${p.in_call ? "in call" : (p.asleep ? "asleep" : "invited")}</span></div>`).join("");
    for (const button of side.querySelectorAll("[data-lower]")) button.addEventListener("click", async _ => {
        if (await _call(API, "hand", {room_id: rtc.room_id, raised: false, target_person_id: button.getAttribute("data-lower")})) await _heartbeat();});

    const chat = side.querySelector("#tmt-chat"), atEnd = chat.scrollTop + chat.clientHeight >= chat.scrollHeight - 8;
    chat.innerHTML = (data.chat || []).length ? data.chat.map(m => `<div class="tmt-msg${m.person_id == state.myId ? " mine" : ""}">
        <b>${states.esc(m.person_id == state.myId ? "You" : _nameOf(m.person_id))}</b> <span class="t3">${states.esc(_clock(m.created_at))}</span><br>${states.esc(m.text)}</div>`).join("") :
        `<div class="sm t3">No messages yet.</div>`;
    if (atEnd) chat.scrollTop = chat.scrollHeight;

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
        const send = async _ => {
            const input = side.querySelector("#tmt-chat-text"); if (!input.value.trim()) return;
            if (await _call(API, "chat_send", {room_id: rtc.room_id, text: _text(input.value)})) {input.value = ""; await _heartbeat();}
        };
        side.querySelector("#tmt-chat-send").addEventListener("click", send);
        side.querySelector("#tmt-chat-text").addEventListener("keydown", event => {if (event.key == "Enter") send();});
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
    if (call.recorder) {   // don't lose a recording because the call ended or the page closed
        rtc = call; try {await _stopRecording(false);} catch (err) {LOG.error(`Could not save the recording: ${err}`);} rtc = null;
    }
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
