/**
 * L3 — data governance: export, retention & erasure. Admin-facing throughout
 * (data.manage_requests or data.erase, matching the surface's own gate in
 * shell.js) — the export button, retention table and access log this screen
 * doesn't duplicate already live on H5 (disclosure.mjs), which is every
 * person's own "download everything" / "what your manager sees" screen.
 * This screen is the other half: the DPO's request queue, legal holds, and
 * the one thing nothing in the app could do before it — execute an erasure.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "data", API_CALENDAR = "calendar";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
const _when = ts => ts ? new Date(ts*1000).toLocaleDateString() : "—";

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, tab: "requests", roster: null, requestFormOpen: false, holdFormOpen: false,
        erasePersonId: "", preview: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">
            <button class="tr-tab${state.tab == "requests" ? " on" : ""}" data-dg="tab" data-tab="requests">Requests</button>
            <button class="tr-tab${state.tab == "erasure" ? " on" : ""}" data-dg="tab" data-tab="erasure">Erasure</button>
            <button class="tr-tab${state.tab == "holds" ? " on" : ""}" data-dg="tab" data-tab="holds">Legal holds</button>
        </div>
        <div class="tr-view" id="dg-view"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-dg=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#dg-view");
    try {
        if (!state.roster) state.roster = (await _call(API_CALENDAR, "roster", {date: _today()}))?.roster || [];
        if (state.tab == "erasure") return await _erasure(view);
        if (state.tab == "holds") return await _holds(view);
        return await _requests(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load data governance", what: err.message,
            safe: "Nothing was changed.", reference: `L3-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

const _nameOf = person_id => state.roster.find(p => p.person_id == person_id)?.display_name || person_id;

// ---------------------------------------------------------------------------
// Requests — the DPO queue
// ---------------------------------------------------------------------------

const STATUS_COLOR = {open: "var(--dawn)", completed: "var(--mint)", blocked: "var(--ember)"};

async function _requests(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const result = await _rest("requests");
    if (!result) return;
    _renderRequests(root, result.requests);
}

function _renderRequests(root, requests) {
    root.innerHTML = `
        <div class="row wrap"><span class="push"></span>
            <button class="btn pri" data-dg="new-request">${state.requestFormOpen ? "Close" : "+ New request"}</button>
        </div>
        ${state.requestFormOpen ? _newRequestHtml() : ""}

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">The queue — sorted by due date</div>
            ${requests.length ? requests.map(r => `<div class="tr-track-row" style="align-items:flex-start">
                <span class="grow"><b>${states.esc(r.request_type)}</b> — ${states.esc(_nameOf(r.subject_person_id))}
                    <br><span class="sm t3">due ${states.esc(r.due_date)} · requested by ${states.esc(r.requested_by || "—")}${
                        r.notes ? ` · ${states.esc(r.notes)}` : ""}</span></span>
                <span class="sm" style="color:${STATUS_COLOR[r.status]||"var(--t3)"}">${states.esc(r.status)}</span>
                ${r.status == "open" ? `<button class="btn" data-dg="complete" data-id="${states.esc(r.request_id)}" style="padding:3px 7px">Complete</button>
                <button class="btn" data-dg="block" data-id="${states.esc(r.request_id)}" style="padding:3px 7px">Block</button>` : ""}
            </div>`).join("") : `<div class="tr-empty">Nothing on the queue.</div>`}
        </div>`;

    root.querySelector("[data-dg=\"new-request\"]").addEventListener("click", _ => {
        state.requestFormOpen = !state.requestFormOpen; _renderRequests(root, requests);});
    if (state.requestFormOpen) _wireNewRequest(root, requests);

    for (const button of root.querySelectorAll("[data-dg=\"complete\"]")) button.addEventListener("click", async _ => {
        const notes = prompt("Notes (optional):") || undefined;
        const result = await _rest("complete_request", {request_id: button.getAttribute("data-id"), status: "completed", notes});
        if (result) {states.toast({message: "Marked complete."}); await _requests(root);}
    });
    for (const button of root.querySelectorAll("[data-dg=\"block\"]")) button.addEventListener("click", async _ => {
        const notes = prompt("Why is this request blocked?");
        if (!notes) return;
        const result = await _rest("complete_request", {request_id: button.getAttribute("data-id"), status: "blocked", notes});
        if (result) {states.toast({message: "Marked blocked."}); await _requests(root);}
    });
}

function _newRequestHtml() {
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">New request</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <select class="inp" id="dg-req-type">
                <option value="access">Access</option>
                <option value="erasure">Erasure</option>
                <option value="rectification">Rectification</option>
            </select>
            <select class="inp" id="dg-req-subject">${state.roster.map(p =>
                `<option value="${states.esc(p.person_id)}">${states.esc(p.display_name)}</option>`).join("")}</select>
            <input class="inp" id="dg-req-due" type="date">
        </div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp" id="dg-req-requested-by" placeholder="Requested by (name)">
            <input class="inp grow" id="dg-req-notes" placeholder="Notes">
            <button class="btn pri" data-dg="do-new-request">Open request</button>
        </div>
    </div>`;
}

function _wireNewRequest(root, requests) {
    root.querySelector("[data-dg=\"do-new-request\"]").addEventListener("click", async _ => {
        const request_type = root.querySelector("#dg-req-type").value;
        const subject_person_id = root.querySelector("#dg-req-subject").value;
        const due_date = root.querySelector("#dg-req-due").value;
        const requested_by = root.querySelector("#dg-req-requested-by").value.trim() || undefined;
        const notes = root.querySelector("#dg-req-notes").value.trim() || undefined;
        if (!due_date) {states.toast({message: "A due date is required."}); return;}
        const result = await _rest("create_request", {request_type, subject_person_id, due_date, requested_by, notes});
        if (result) {states.toast({message: "Request opened."}); state.requestFormOpen = false; await _requests(root);}
    });
}

// ---------------------------------------------------------------------------
// Erasure — preview the three-way split, then execute
// ---------------------------------------------------------------------------

async function _erasure(root) {
    root.innerHTML = `
        <div class="row wrap" style="gap:6px">
            <select class="inp" id="dg-erase-person">
                <option value="">Select a person…</option>
                ${state.roster.map(p => `<option value="${states.esc(p.person_id)}"${
                    p.person_id == state.erasePersonId ? " selected" : ""}>${states.esc(p.display_name)}</option>`).join("")}
            </select>
            <button class="btn pri" data-dg="preview">Preview</button>
        </div>
        <div id="dg-erase-result" style="margin-top:10px"></div>`;

    root.querySelector("[data-dg=\"preview\"]").addEventListener("click", async _ => {
        const person_id = root.querySelector("#dg-erase-person").value;
        if (!person_id) {states.toast({message: "Select a person first."}); return;}
        state.erasePersonId = person_id;
        const result = await _rest("preview_erasure", {person_id});
        if (!result) return;
        state.preview = result.preview;
        _renderPreview(root);
    });

    if (state.preview && state.erasePersonId) _renderPreview(root);
}

function _renderPreview(root) {
    const container = root.querySelector("#dg-erase-result");
    const preview = state.preview;
    const personName = _nameOf(state.erasePersonId);
    if (preview.already_pseudonymised) {
        container.innerHTML = `<div class="tr-empty">${states.esc(personName)} was already erased.</div>`;
        return;
    }

    const bucket = (title, color, rows, renderRow) => `<div class="tr-card" style="margin-top:10px${color ? `;border-color:${color}` : ""}">
        <div class="up t3"${color ? ` style="color:${color}"` : ""}>${states.esc(title)}</div>
        ${rows.length ? rows.map(renderRow).join("") : `<div class="tr-empty">None.</div>`}
    </div>`;

    container.innerHTML = `
        ${bucket("Erased", "var(--mint)", preview.erased, e => `<div class="tr-track-row">
            <span class="grow">${states.esc(e.entity)}</span><span class="sm t3">${e.count}</span></div>`)}
        ${bucket("Pseudonymised (informational — the person row alone is what pseudonymises these)", null, preview.pseudonymised,
            e => `<div class="tr-track-row"><span class="grow">${states.esc(e.entity)}</span><span class="sm t3">${e.count}</span></div>`)}
        ${bucket("Blocked", "var(--ember)", preview.blocked, b => `<div class="tr-track-row">
            <span class="grow">${states.esc(b.entity)}</span><span class="sm t3">${states.esc(b.reason)} · ${b.count}</span></div>`)}

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Execute</div>
            <div class="row wrap" style="gap:6px;margin-top:6px">
                <input class="inp grow" id="dg-erase-reason" placeholder="Reason (required)">
            </div>
            <div class="row wrap" style="gap:6px;margin-top:6px">
                <label class="sm t3"><input type="checkbox" id="dg-erase-stepup"> I have re-authenticated for this action</label>
                <button class="btn danger" data-dg="execute">Execute erasure</button>
            </div>
        </div>`;

    container.querySelector("[data-dg=\"execute\"]").addEventListener("click", async _ => {
        const reason = container.querySelector("#dg-erase-reason").value.trim();
        const step_up_verified = container.querySelector("#dg-erase-stepup").checked;
        if (!reason) {states.toast({message: "A reason is required."}); return;}
        if (!step_up_verified) {states.toast({message: "Confirm re-authentication before executing — this is irreversible."}); return;}

        const confirmed = await states.confirmDestructive({title: `Erase ${personName}?`,
            body: "Their name, email and timezone are cleared. The rows below are deleted outright. This cannot be undone.",
            collateral: preview.erased.map(e => `${e.entity}: ${e.count}`),
            confirmLabel: "Erase"});
        if (!confirmed) return;

        const result = await _rest("execute_erasure", {person_id: state.erasePersonId, reason, step_up_verified: true});
        if (result) {
            states.toast({message: `${personName} erased.`});
            state.preview = null; state.erasePersonId = "";
            await _erasure(root);
        }
    });
}

// ---------------------------------------------------------------------------
// Legal holds
// ---------------------------------------------------------------------------

async function _holds(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const result = await _rest("legal_holds");
    if (!result) return;
    _renderHolds(root, result.holds);
}

function _renderHolds(root, holds) {
    root.innerHTML = `
        <div class="row wrap"><span class="push"></span>
            <button class="btn pri" data-dg="new-hold">${state.holdFormOpen ? "Close" : "+ Place hold"}</button>
        </div>
        ${state.holdFormOpen ? _newHoldHtml() : ""}

        <div class="tr-card" style="margin-top:10px">
            ${holds.length ? holds.map(h => `<div class="tr-track-row" style="align-items:flex-start">
                <span class="grow"><b>${states.esc(_nameOf(h.person_id))}</b> — ${states.esc(h.entity || "all entities")}
                    <br><span class="sm t3">${states.esc(h.reason)} · placed by ${states.esc(_nameOf(h.placed_by))} on ${_when(h.placed_at)}${
                        h.released_at ? ` · released ${_when(h.released_at)}` : ""}</span></span>
                ${!h.released_at ? `<button class="btn" data-dg="release" data-id="${states.esc(h.hold_id)}" style="padding:3px 7px">Release</button>` : ""}
            </div>`).join("") : `<div class="tr-empty">No legal holds.</div>`}
        </div>`;

    root.querySelector("[data-dg=\"new-hold\"]").addEventListener("click", _ => {
        state.holdFormOpen = !state.holdFormOpen; _renderHolds(root, holds);});
    if (state.holdFormOpen) _wireNewHold(root, holds);

    for (const button of root.querySelectorAll("[data-dg=\"release\"]")) button.addEventListener("click", async _ => {
        const result = await _rest("release_hold", {hold_id: button.getAttribute("data-id")});
        if (result) {states.toast({message: "Released."}); await _holds(root);}
    });
}

function _newHoldHtml() {
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">Place a legal hold</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <select class="inp" id="dg-hold-person">${state.roster.map(p =>
                `<option value="${states.esc(p.person_id)}">${states.esc(p.display_name)}</option>`).join("")}</select>
            <input class="inp" id="dg-hold-entity" placeholder="Entity (blank = everything)" style="width:220px">
        </div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp grow" id="dg-hold-reason" placeholder="Reason (required)">
            <button class="btn pri" data-dg="do-hold">Place hold</button>
        </div>
    </div>`;
}

function _wireNewHold(root, holds) {
    root.querySelector("[data-dg=\"do-hold\"]").addEventListener("click", async _ => {
        const person_id = root.querySelector("#dg-hold-person").value;
        const entity = root.querySelector("#dg-hold-entity").value.trim() || undefined;
        const reason = root.querySelector("#dg-hold-reason").value.trim();
        if (!reason) {states.toast({message: "A reason is required."}); return;}
        const result = await _rest("place_hold", {person_id, entity, reason});
        if (result) {states.toast({message: "Hold placed."}); state.holdFormOpen = false; await _holds(root);}
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
