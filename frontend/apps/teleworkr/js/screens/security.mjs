/**
 * L4 — sessions & devices, and incident mode. My sessions (everyone with
 * session.read_own — every built-in role but guest) is the default tab;
 * Detection and Incidents only appear when the viewer also holds
 * session.manage / incident.manage — same per-capability internal
 * tabbing wellbeing.mjs already established, not a role fork.
 *
 * "Sign out" and bulk revoke mark the session record. Tokens are verified
 * statelessly against an external IdP with no revocation-list check on
 * the per-request auth path, so this is durable evidence of the action,
 * not a live kill switch — stated in the UI, not hidden.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "security", API_CALENDAR = "calendar";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
const _when = ts => ts ? new Date(ts*1000).toLocaleString() : "—";

const SIGNAL_LABELS = {new_device: "new device", outside_declared_window: "outside declared working window"};

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    const caps = (await import("../shell.mjs")).shell.projection?.capabilities || [];
    state = {root, tab: "mine", canManageSessions: caps.includes("session.manage"),
        canManageIncidents: caps.includes("incident.manage"), roster: null,
        newIncidentOpen: false, openIncidentId: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">
            <button class="tr-tab${state.tab == "mine" ? " on" : ""}" data-sc="tab" data-tab="mine">My sessions</button>
            ${state.canManageSessions ? `<button class="tr-tab${state.tab == "detection" ? " on" : ""}" data-sc="tab" data-tab="detection">Detection</button>` : ""}
            ${state.canManageIncidents ? `<button class="tr-tab${state.tab == "incidents" ? " on" : ""}" data-sc="tab" data-tab="incidents">Incidents</button>` : ""}
        </div>
        <div class="tr-view" id="sc-view"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-sc=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#sc-view");
    try {
        if (state.tab == "detection" && state.canManageSessions) return await _detection(view);
        if (state.tab == "incidents" && state.canManageIncidents) {
            if (!state.roster) state.roster = (await _call(API_CALENDAR, "roster", {date: _today()}))?.roster || [];
            return await _incidents(view);
        }
        return await _mine(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load sessions & security", what: err.message,
            safe: "Nothing was changed.", reference: `L4-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

const _nameOf = person_id => state.roster.find(p => p.person_id == person_id)?.display_name || person_id;
const _signalText = signals => signals.length ? signals.map(s => SIGNAL_LABELS[s] || s).join(", ") : "none";

// ---------------------------------------------------------------------------
// My sessions
// ---------------------------------------------------------------------------

async function _mine(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const result = await _rest("my_sessions");
    if (!result) return;
    _renderMine(root, result.sessions);
}

function _renderMine(root, sessionRows) {
    root.innerHTML = `<div class="tr-card">
        <div class="up t3">Your sessions</div>
        ${sessionRows.length ? sessionRows.map(s => `<div class="tr-track-row">
            <span class="grow"><b>${states.esc(s.device_label)}</b> — ${states.esc(s.ip || "unknown address")}
                <br><span class="sm t3">signed in ${_when(s.signed_in_at)}${s.revoked_at ? ` · signed out ${_when(s.revoked_at)}` : ""}${
                    s.signals.length ? ` · ${states.esc(_signalText(s.signals))}` : ""}</span></span>
            ${!s.revoked_at ? `<button class="btn" data-sc="sign-out" data-id="${states.esc(s.session_id)}" style="padding:3px 7px">Sign out</button>` :
                `<span class="sm t3">signed out</span>`}
        </div>`).join("") : `<div class="tr-empty">No sessions recorded yet.</div>`}
        <div class="sm t3" style="margin-top:8px">Signing out marks the record — tokens are verified against an external identity provider with no live revocation list, so this is the durable evidence of the action, not an instant kill switch.</div>
    </div>`;

    for (const button of root.querySelectorAll("[data-sc=\"sign-out\"]")) button.addEventListener("click", async _ => {
        const result = await _rest("sign_out", {session_id: button.getAttribute("data-id")});
        if (result) {states.toast({message: "Signed out."}); await _mine(root);}
    });
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const TIER_COLOR = {review: "var(--ember)", quiet: "var(--t3)"};

async function _detection(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    if (!state.roster) state.roster = (await _call(API_CALENDAR, "roster", {date: _today()}))?.roster || [];
    const result = await _rest("detection_feed");
    if (!result) return;
    _renderDetection(root, result.sessions);
}

function _renderDetection(root, sessionRows) {
    root.innerHTML = `<div class="tr-card">
        <div class="up t3">Recent sign-ins — last 14 days</div>
        ${sessionRows.length ? sessionRows.map(s => `<div class="tr-track-row">
            <span class="grow"><b>${states.esc(s.display_name || s.email)}</b> — ${states.esc(s.device_label)} · ${states.esc(s.ip || "unknown address")}
                <br><span class="sm t3">${_when(s.signed_in_at)} · ${states.esc(_signalText(s.signals))}</span></span>
            <span class="sm" style="color:${TIER_COLOR[s.tier]}">${states.esc(s.tier)}</span>
        </div>`).join("") : `<div class="tr-empty">No sign-ins in the window.</div>`}
    </div>

    <div class="tr-card" style="margin-top:10px">
        <div class="up t3">Bulk revoke</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <select class="inp" id="sc-revoke-target">
                <option value="person">One person</option>
                <option value="role">Everyone holding a role</option>
                <option value="org">The whole org</option>
            </select>
            <select class="inp" id="sc-revoke-person" style="width:200px">${state.roster.map(p =>
                `<option value="${states.esc(p.person_id)}">${states.esc(p.display_name)}</option>`).join("")}</select>
            <input class="inp" id="sc-revoke-role" placeholder="Role name" style="width:160px;display:none">
        </div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp grow" id="sc-revoke-reason" placeholder="Reason">
            <button class="btn danger" data-sc="do-revoke">Revoke</button>
        </div>
    </div>`;

    const targetSelect = root.querySelector("#sc-revoke-target");
    const personSelect = root.querySelector("#sc-revoke-person");
    const roleInput = root.querySelector("#sc-revoke-role");
    const refresh = _ => {
        personSelect.style.display = targetSelect.value == "person" ? "" : "none";
        roleInput.style.display = targetSelect.value == "role" ? "" : "none";
    };
    targetSelect.addEventListener("change", refresh); refresh();

    root.querySelector("[data-sc=\"do-revoke\"]").addEventListener("click", async _ => {
        const target = targetSelect.value;
        const reason = root.querySelector("#sc-revoke-reason").value.trim();
        const label = target == "person" ? _nameOf(personSelect.value) : target == "role" ? `everyone holding ${roleInput.value}` : "the whole org";
        const confirmed = await states.confirmDestructive({title: `Revoke sessions for ${label}?`,
            body: "This marks every one of their active sessions revoked.", confirmLabel: "Revoke"});
        if (!confirmed) return;
        const result = await _rest("revoke_for", {person_id: target == "person" ? personSelect.value : undefined,
            role_name: target == "role" ? roleInput.value.trim() : undefined, whole_org: target == "org" || undefined, reason});
        if (result) {states.toast({message: `Revoked ${result.revoked_count} session(s).`}); await _detection(root);}
    });
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

async function _incidents(root) {
    if (state.openIncidentId) return await _incidentDetail(root);
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const result = await _rest("incidents");
    if (!result) return;
    _renderIncidents(root, result.incidents);
}

function _renderIncidents(root, incidentRows) {
    root.innerHTML = `
        <div class="row wrap"><span class="push"></span>
            <button class="btn pri" data-sc="new-incident">${state.newIncidentOpen ? "Close" : "+ New incident"}</button>
        </div>
        ${state.newIncidentOpen ? `<div class="tr-card" style="margin-top:10px">
            <div class="up t3">New incident</div>
            <div class="row wrap" style="gap:6px;margin-top:6px">
                <input class="inp grow" id="sc-incident-title" placeholder="Title">
                <input class="inp" id="sc-incident-aware" type="date" title="First aware on (optional, defaults to now)">
                <button class="btn pri" data-sc="do-open-incident">Open</button>
            </div>
        </div>` : ""}

        <div class="tr-card" style="margin-top:10px">
            ${incidentRows.length ? incidentRows.map(i => `<div class="tr-track-row">
                <span class="grow"><b>${states.esc(i.title)}</b>
                    <br><span class="sm t3">opened ${_when(i.opened_at)}${i.closed_at ? ` · closed ${_when(i.closed_at)}` : ""}</span></span>
                <span class="sm" style="color:${i.status == "open" ? "var(--ember)" : "var(--mint)"}">${states.esc(i.status)}</span>
                <button class="btn" data-sc="open-incident" data-id="${states.esc(i.incident_id)}" style="padding:3px 7px">Open</button>
            </div>`).join("") : `<div class="tr-empty">No incidents recorded.</div>`}
        </div>`;

    root.querySelector("[data-sc=\"new-incident\"]").addEventListener("click", _ => {
        state.newIncidentOpen = !state.newIncidentOpen; _renderIncidents(root, incidentRows);});
    root.querySelector("[data-sc=\"do-open-incident\"]")?.addEventListener("click", async _ => {
        const title = root.querySelector("#sc-incident-title").value.trim();
        const awareDate = root.querySelector("#sc-incident-aware").value;
        if (!title) {states.toast({message: "A title is required."}); return;}
        const awareness_at = awareDate ? Math.floor(Date.parse(`${awareDate}T00:00:00Z`)/1000) : undefined;
        const result = await _rest("open_incident", {title, awareness_at});
        if (result) {states.toast({message: "Incident opened."}); state.newIncidentOpen = false;
            state.openIncidentId = result.incident.incident_id; await _incidents(root);}
    });
    for (const button of root.querySelectorAll("[data-sc=\"open-incident\"]")) button.addEventListener("click", _ => {
        state.openIncidentId = button.getAttribute("data-id"); _incidents(root);});
}

async function _incidentDetail(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const result = await _rest("incident_detail", {incident_id: state.openIncidentId});
    if (!result) return;
    _renderIncidentDetail(root, result);
}

function _renderIncidentDetail(root, {incident, actions, regulatory_clock_seconds, regulatory_clock_breached}) {
    const clockHours = Math.floor(regulatory_clock_seconds / 3600);
    root.innerHTML = `
        <div class="row wrap"><button class="btn" data-sc="back">← All incidents</button></div>

        <div class="tr-card" style="margin-top:10px${regulatory_clock_breached ? ";border-color:var(--ember)" : ""}">
            <div class="up t3">${states.esc(incident.title)} — <span style="color:${incident.status == "open" ? "var(--ember)" : "var(--mint)"}">${states.esc(incident.status)}</span></div>
            <div class="sm t3" style="margin-top:4px">Regulatory clock: ${clockHours}h since awareness${
                regulatory_clock_breached ? ` — <b style="color:var(--ember)">past 72h</b>` : " (72h limit)"}</div>
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Timeline</div>
            ${actions.length ? actions.map(a => `<div class="tr-track-row">
                <span class="grow"><b>${states.esc(a.kind)}</b> — ${states.esc(JSON.stringify(a.detail))}</span>
                <span class="sm t3">${_when(a.occurred_at)}</span>
            </div>`).join("") : `<div class="tr-empty">No actions logged yet.</div>`}
        </div>

        ${incident.status == "open" ? `
        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Contain</div>
            <div class="row wrap" style="gap:6px;margin-top:6px">
                <select class="inp" id="sc-contain-target">
                    <option value="person">One person</option>
                    <option value="role">Everyone holding a role</option>
                    <option value="org">The whole org</option>
                </select>
                <select class="inp" id="sc-contain-person" style="width:200px">${state.roster.map(p =>
                    `<option value="${states.esc(p.person_id)}">${states.esc(p.display_name)}</option>`).join("")}</select>
                <input class="inp" id="sc-contain-role" placeholder="Role name" style="width:140px;display:none">
                <input class="inp grow" id="sc-contain-reason" placeholder="Reason">
                <button class="btn danger" data-sc="do-contain">Revoke sessions</button>
            </div>
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Assess — what did this person touch</div>
            <div class="row wrap" style="gap:6px;margin-top:6px">
                <select class="inp" id="sc-assess-person" style="width:200px">${state.roster.map(p =>
                    `<option value="${states.esc(p.person_id)}">${states.esc(p.display_name)}</option>`).join("")}</select>
                <input class="inp" id="sc-assess-from" type="date">
                <input class="inp" id="sc-assess-to" type="date">
                <button class="btn" data-sc="do-assess">Assess</button>
            </div>
            <div id="sc-assess-result" class="sm t3" style="margin-top:6px"></div>
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Notify</div>
            <div class="row wrap" style="gap:6px;margin-top:6px">
                <select class="inp" id="sc-notify-people" multiple style="height:80px;width:220px">${state.roster.map(p =>
                    `<option value="${states.esc(p.person_id)}">${states.esc(p.display_name)}</option>`).join("")}</select>
                <textarea class="inp grow" id="sc-notify-message" placeholder="Message" style="min-height:80px"></textarea>
            </div>
            <button class="btn" data-sc="do-notify" style="margin-top:6px">Record notification</button>
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Note</div>
            <div class="row wrap" style="gap:6px;margin-top:6px">
                <input class="inp grow" id="sc-note-text" placeholder="Add a note to the timeline">
                <button class="btn" data-sc="do-note">Add</button>
            </div>
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Close</div>
            <div class="row wrap" style="gap:6px;margin-top:6px">
                <input class="inp grow" id="sc-close-conclusion" placeholder="Conclusion (required)">
                <button class="btn pri" data-sc="do-close">Close incident</button>
            </div>
        </div>` : ""}`;

    root.querySelector("[data-sc=\"back\"]").addEventListener("click", _ => {state.openIncidentId = null; _incidents(root);});
    if (incident.status != "open") return;

    const containTarget = root.querySelector("#sc-contain-target");
    const containPerson = root.querySelector("#sc-contain-person");
    const containRole = root.querySelector("#sc-contain-role");
    const refreshContain = _ => {
        containPerson.style.display = containTarget.value == "person" ? "" : "none";
        containRole.style.display = containTarget.value == "role" ? "" : "none";
    };
    containTarget.addEventListener("change", refreshContain); refreshContain();

    root.querySelector("[data-sc=\"do-contain\"]").addEventListener("click", async _ => {
        const target = containTarget.value;
        const reason = root.querySelector("#sc-contain-reason").value.trim();
        const label = target == "person" ? _nameOf(containPerson.value) : target == "role" ? `everyone holding ${containRole.value}` : "the whole org";
        const confirmed = await states.confirmDestructive({title: `Revoke sessions for ${label}?`, confirmLabel: "Revoke"});
        if (!confirmed) return;
        const result = await _rest("contain_sessions", {incident_id: incident.incident_id,
            person_id: target == "person" ? containPerson.value : undefined,
            role_name: target == "role" ? containRole.value.trim() : undefined, whole_org: target == "org" || undefined, reason});
        if (result) {states.toast({message: `Revoked ${result.revoked_count} session(s).`}); await _incidentDetail(root);}
    });

    root.querySelector("[data-sc=\"do-assess\"]").addEventListener("click", async _ => {
        const person_id = root.querySelector("#sc-assess-person").value;
        const fromDate = root.querySelector("#sc-assess-from").value, toDate = root.querySelector("#sc-assess-to").value;
        if (!fromDate || !toDate) {states.toast({message: "Both dates are required."}); return;}
        const from = Math.floor(Date.parse(`${fromDate}T00:00:00Z`)/1000), to = Math.floor(Date.parse(`${toDate}T23:59:59Z`)/1000);
        const result = await _rest("assess", {incident_id: incident.incident_id, person_id, from, to});
        if (!result) return;
        root.querySelector("#sc-assess-result").textContent = `${result.events.length} event(s) in that window.`;
        await _incidentDetail(root);
    });

    root.querySelector("[data-sc=\"do-notify\"]").addEventListener("click", async _ => {
        const person_ids = [...root.querySelector("#sc-notify-people").selectedOptions].map(o => o.value);
        const message = root.querySelector("#sc-notify-message").value.trim();
        if (!person_ids.length || !message) {states.toast({message: "Select at least one person and write a message."}); return;}
        const result = await _rest("notify", {incident_id: incident.incident_id, person_ids, message});
        if (result) {states.toast({message: "Recorded."}); await _incidentDetail(root);}
    });

    root.querySelector("[data-sc=\"do-note\"]").addEventListener("click", async _ => {
        const text = root.querySelector("#sc-note-text").value.trim();
        if (!text) return;
        const result = await _rest("add_note", {incident_id: incident.incident_id, text});
        if (result) await _incidentDetail(root);
    });

    root.querySelector("[data-sc=\"do-close\"]").addEventListener("click", async _ => {
        const conclusion = root.querySelector("#sc-close-conclusion").value.trim();
        if (!conclusion) {states.toast({message: "A conclusion is required."}); return;}
        const result = await _rest("close_incident", {incident_id: incident.incident_id, conclusion});
        if (result) {states.toast({message: "Closed."}); await _incidentDetail(root);}
    });
}

// ---------------------------------------------------------------------------

const _rest = (op, extra = {}) => _call(API, op, extra);

async function _call(api, op, extra = {}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${api}`, "GET", {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`${api} op ${op} failed: ${err}`);}
    if (!response?.result) {
        states.toast({message: response?.reason || `The ${api} service did not respond.`, ms: 8000});
        return null;
    }
    return response;
}
