/**
 * G1 — the app catalogue. Text-first rows, not an icon wall: launching an
 * app while a timer is running attributes the session to that task (stated
 * here, resolved server-side — never trusted from this screen); apps a
 * person lacks show who nearby already has them and what a seat costs;
 * access is self-service, routed to a named approver.
 *
 * No SSO/OAuth broker exists anywhere in this app, so "Open directly" is
 * either a plain configured launch URL or a deep link the person attached
 * themselves to the task currently running the timer — never one an API
 * discovered. The approver and admin sections below gate from
 * `projection.capabilities`, the same "console differs by entry point,
 * never by screen identity" pattern `approvals.mjs`/`workload.mjs` use —
 * everyone sees the catalogue, only some see who's asking or who's paying.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "apps", API_CALENDAR = "calendar";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
const _money = (minor, currency) => {
    if (minor == null) return null;
    const symbol = currency == "GBP" ? "£" : currency == "USD" ? "$" : currency == "EUR" ? "€" : currency ? `${currency} ` : "";
    return `${symbol}${(minor/100).toFixed(0)}`;
};
const _rel = epochSeconds => {
    if (!epochSeconds) return "—";
    const days = Math.floor((Date.now()/1000 - epochSeconds)/86400);
    if (days <= 0) return "today";
    if (days == 1) return "yesterday";
    if (days < 14) return `${days} days ago`;
    return new Date(epochSeconds*1000).toLocaleDateString();
};
const _hoursText = seconds => seconds < 3600 ? `${Math.max(1, Math.round(seconds/60))} minutes` : `${Math.round(seconds/3600)} hours`;

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    const caps = (await import("../shell.mjs")).shell.projection?.capabilities || [];
    state = {root, q: "", filter: "all", canApprove: caps.includes("app.access.approve"),
        canAdmin: caps.includes("app.catalogue.manage"), openRequest: null, openLink: null,
        openDecision: null, showLinks: false, showAdminForm: false, editingAppId: ""};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 5})}</div>`;
    try {
        const [catalogue, roster] = await Promise.all([
            _rest("catalogue", {}), _call(API_CALENDAR, "roster", {date: _today()})]);
        if (!catalogue) return;
        state.catalogue = catalogue;
        state.roster = roster?.roster || [];

        state.approverQueue = state.canApprove ? (await _rest("pending_requests", {}))?.requests || [] : [];
        state.usageReport = state.canAdmin ? (await _rest("usage_report", {}))?.apps || [] : [];
        if (state.showLinks) state.myLinks = (await _rest("my_links", {}))?.links || [];

        _render(root);
    } catch (err) {
        root.innerHTML = states.error({title: "Couldn't load the app catalogue", what: err.message,
            safe: "Nothing was changed.", reference: `G1-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(root, {retry: _ => _view()});
    }
}

const _nameOf = person_id => state.roster.find(p => p.person_id == person_id)?.display_name || person_id;

function _visibleApps() {
    const q = state.q.toLowerCase();
    return state.catalogue.apps.filter(a => {
        if (q && !(`${a.name} ${a.category||""}`).toLowerCase().includes(q)) return false;
        if (state.filter == "mine" && a.access != "granted") return false;
        if (state.filter == "requestable" && !(a.requires_request && a.access == "none")) return false;
        return true;
    });
}

function _render(root) {
    const apps = _visibleApps();
    root.innerHTML = `<div class="page tr">
        <div class="row wrap" style="gap:8px;align-items:center">
            <span class="up t3">Apps · ${state.catalogue.apps.length} in the catalogue</span>
            <span class="push"></span>
            <input class="inp" id="ap-q" placeholder="Search apps" value="${states.esc(state.q)}" style="width:180px">
            ${["all", "mine", "requestable"].map(f => `<button class="chip${state.filter==f?" warn":""}" data-ap="filter" data-f="${f}">${
                f == "all" ? "All" : f == "mine" ? "Mine" : "Requestable"}</button>`).join("")}
        </div>

        ${state.catalogue.running_task_ref ? `<div class="tr-panel" style="margin-top:10px">
            Timer is running on <b>${states.esc(state.catalogue.running_task_ref)}</b>. Anything you open from here
            attributes its session to that task — you'll confirm it later in reconstruct my day, never silently.
        </div>` : ""}

        <div class="tr-card" style="margin-top:10px">
            ${apps.length ? apps.map(a => _appRowHtml(a)).join("") : `<div class="tr-empty">No apps match.</div>`}
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">What gets recorded</div>
            <p class="sm t2" style="margin-top:6px">That you opened an app, when, for how long, and which task the
                timer was on. <b>Not</b> what you did inside it, not your keystrokes, not your screen.</p>
            <p class="sm t2" style="margin-top:4px">Deep-link titles come from apps you've connected yourself.
                <button class="btn sm" data-ap="toggle-links" style="margin-left:4px">${state.showLinks ? "Hide" : "Manage"} connections</button></p>
            ${state.showLinks ? _linksPanelHtml() : ""}
        </div>

        ${state.canApprove ? _approverSectionHtml() : ""}
        ${state.canAdmin ? _adminSectionHtml() : ""}
    </div>`;
    _wire(root);
}

// ---------------------------------------------------------------------------
// the catalogue rows
// ---------------------------------------------------------------------------

function _appRowHtml(a) {
    let openCol;
    if (a.open_link) openCol = `<span class="chip">${states.esc(a.open_link.label)}</span>`;
    else if (state.catalogue.running_task_ref) openCol = `<button class="btn sm" data-ap="link-toggle" data-id="${states.esc(a.app_id)}">+ Add a link</button>`;
    else openCol = `<span class="t3 sm">—</span>`;

    let accessCol, actionCol;
    if (a.access == "granted") {
        accessCol = `<span class="chip">Yours</span>`;
        actionCol = `<button class="btn sm" data-ap="open" data-id="${states.esc(a.app_id)}">${states.esc(a.open_link ? "Open" : a.launch_label)}</button>`;
    } else if (a.access == "pending") {
        accessCol = `<span class="chip warn">Pending</span>`;
        actionCol = `<span class="t3 sm">Awaiting approval</span>`;
    } else if (a.access == "denied") {
        accessCol = `<span class="chip warn">Denied: ${states.esc(a.decision_reason||"")}</span>`;
        actionCol = `<button class="btn sm" data-ap="request-toggle" data-id="${states.esc(a.app_id)}">Request again</button>`;
    } else if (a.requires_request) {
        const cost = _money(a.cost_per_seat_minor, a.cost_currency);
        const who = a.colleagues_with_access.length ?
            `${a.colleagues_with_access.join(", ")} ${a.colleagues_with_access.length == 1 ? "has" : "have"} it` : "";
        accessCol = `<span class="chip">${states.esc(cost ? `${cost}/mo` : "Needs approval")}</span>${who ? `<div class="t3 xs">${states.esc(who)}</div>` : ""}`;
        actionCol = `<button class="btn sm pri" data-ap="request-toggle" data-id="${states.esc(a.app_id)}">Request</button>`;
    } else {
        accessCol = `<span class="chip">Open to all</span>`;
        actionCol = `<button class="btn sm" data-ap="open" data-id="${states.esc(a.app_id)}">${states.esc(a.launch_label)}</button>`;
    }

    return `<div class="tr-track-row">
        <span class="grow"><b>${states.esc(a.name)}</b><span class="t3 xs" style="display:block">${states.esc(a.category||"")}</span></span>
        <span style="flex:1.4">${openCol}</span>
        <span class="t3 sm" style="flex:.8">${_rel(a.last_used)}</span>
        <span style="flex:1">${accessCol}</span>
        <span style="flex:.8;text-align:right">${actionCol}</span>
    </div>
    ${state.openRequest == a.app_id ? _requestPanelHtml(a) : ""}
    ${state.openLink == a.app_id ? _linkFormHtml() : ""}`;
}

function _requestPanelHtml(a) {
    const cost = _money(a.cost_per_seat_minor, a.cost_currency);
    return `<div class="tr-panel" style="margin-top:4px">
        <div class="sm t2">${states.esc(a.name)}${cost ? ` · ${states.esc(cost)}/month` : ""}${
            a.approver_person_id ? ` · approver: ${states.esc(_nameOf(a.approver_person_id))}` : ""}</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp grow" id="ap-reason" placeholder="Why do you need this?">
            <button class="btn sm pri" data-ap="do-request" data-id="${states.esc(a.app_id)}">Send request</button>
        </div>
        ${a.avg_decision_seconds != null ? `<div class="sm t3" style="margin-top:4px">Typically decided in about ${_hoursText(a.avg_decision_seconds)}.</div>` : ""}
    </div>`;
}

function _linkFormHtml() {
    return `<div class="tr-panel" style="margin-top:4px">
        <div class="sm t2">Attach a link for ${states.esc(state.catalogue.running_task_ref)}</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp" id="ap-link-label" placeholder="Label, e.g. apibot-hero-v3" style="width:220px">
            <input class="inp grow" id="ap-link-url" placeholder="URL">
            <button class="btn sm pri" data-ap="do-link">Save</button>
        </div>
    </div>`;
}

function _linksPanelHtml() {
    if (!state.myLinks?.length) return `<div class="tr-empty" style="margin-top:6px">No connections yet.</div>`;
    return `<div style="margin-top:6px">${state.myLinks.map(l => `<div class="row" style="gap:8px;padding:4px 0">
        <span class="grow sm">${states.esc(l.app_name)} — ${states.esc(l.label)} <span class="t3 xs">on ${states.esc(l.task_ref)}</span></span>
        <button class="btn sm" data-ap="remove-link" data-id="${states.esc(l.link_id)}">Remove</button>
    </div>`).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// approver queue — requests named to this person
// ---------------------------------------------------------------------------

function _approverSectionHtml() {
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">App-access requests waiting on you</div>
        ${state.approverQueue.length ? state.approverQueue.map(r => _approverRowHtml(r)).join("") :
            `<div class="tr-empty">Nothing waiting.</div>`}
    </div>`;
}

function _approverRowHtml(r) {
    const open = state.openDecision == r.request_id;
    return `<div class="tr-track-row">
        <span class="grow"><b>${states.esc(_nameOf(r.requested_by))}</b> wants <b>${states.esc(r.app_name)}</b>
            <br><span class="sm t3">"${states.esc(r.reason)}"</span></span>
        <button class="btn sm pri" data-ap="decide-approve" data-id="${states.esc(r.request_id)}">Approve</button>
        <button class="btn sm" data-ap="decide-open" data-id="${states.esc(r.request_id)}">${open ? "Close" : "Deny"}</button>
    </div>
    ${open ? _denyFormHtml(r.request_id) : ""}`;
}

function _denyFormHtml(requestId) {
    return `<div class="tr-panel" style="margin-top:4px">
        <div class="row wrap" style="gap:6px">
            <input class="inp grow" id="ap-deny-reason" placeholder="Reason, required">
            <button class="btn sm danger" data-ap="do-deny" data-id="${states.esc(requestId)}">Deny</button>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// admin — catalogue management and seat usage
// ---------------------------------------------------------------------------

function _adminSectionHtml() {
    const editing = state.usageReport.find(a => a.app_id == state.editingAppId) || null;
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">Admin — catalogue &amp; seats</div>
        <div class="tr-track-row" style="border-top:none">
            <span class="t3 xs up grow">App</span>
            <span class="t3 xs up" style="flex:.5">Seats</span>
            <span class="t3 xs up" style="flex:.8">Used/60d</span>
            <span style="flex:.6"></span>
        </div>
        ${state.usageReport.map(a => `<div class="tr-track-row">
            <span class="grow">${states.esc(a.name)}${a.deprecated ? ` <span class="chip">Deprecated</span>` : ""}</span>
            <span class="t3 sm" style="flex:.5">${a.seats}</span>
            <span class="t3 sm" style="flex:.8">${a.launches_60d}${a.idle ? ` <span class="chip warn">Idle</span>` : ""}</span>
            <span style="flex:.6;text-align:right"><button class="btn sm" data-ap="admin-edit" data-id="${states.esc(a.app_id)}">Edit</button></span>
        </div>`).join("")}
        <button class="btn sm" data-ap="admin-new" style="margin-top:8px">+ Add an app</button>
        ${state.showAdminForm ? _adminFormHtml(editing) : ""}
    </div>`;
}

function _adminFormHtml(editing) {
    const a = editing || {};
    return `<div class="tr-panel" style="margin-top:8px">
        <div class="up t3">${editing ? `Edit ${states.esc(editing.name)}` : "New app"}</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp" id="ap-f-name" placeholder="Name" value="${states.esc(a.name||"")}" style="width:160px">
            <input class="inp" id="ap-f-category" placeholder="Category" value="${states.esc(a.category||"")}" style="width:140px">
            <input class="inp grow" id="ap-f-url" placeholder="Launch URL" value="${states.esc(a.launch_url||"")}">
            <input class="inp" id="ap-f-label" placeholder="Button label" value="${states.esc(a.launch_label||"Open")}" style="width:120px">
        </div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <label class="sm"><input type="checkbox" id="ap-f-requires"${a.requires_request ? " checked" : ""}> Needs a request</label>
            <input class="inp" id="ap-f-cost" type="number" placeholder="Cost/seat (minor units)" value="${a.cost_per_seat_minor ?? ""}" style="width:180px">
            <input class="inp" id="ap-f-currency" placeholder="GBP" value="${states.esc(a.cost_currency||"")}" style="width:70px">
            <select class="inp" id="ap-f-approver" style="width:190px">
                <option value="">No named approver</option>
                ${state.roster.map(p => `<option value="${states.esc(p.person_id)}"${a.approver_person_id==p.person_id?" selected":""}>${states.esc(p.display_name)}</option>`).join("")}
            </select>
            <label class="sm"><input type="checkbox" id="ap-f-deprecated"${a.deprecated ? " checked" : ""}> Deprecated</label>
        </div>
        <div class="row wrap" style="gap:6px;margin-top:8px">
            <button class="btn sm pri" data-ap="admin-save" data-id="${states.esc(editing?.app_id||"")}">Save</button>
            <button class="btn sm" data-ap="admin-cancel">Cancel</button>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------

function _wire(root) {
    root.querySelector("#ap-q")?.addEventListener("keydown", event => {
        if (event.key == "Enter") {state.q = event.target.value.trim(); _render(root);}
    });
    for (const chip of root.querySelectorAll('[data-ap="filter"]')) chip.addEventListener("click", _ => {
        state.filter = chip.getAttribute("data-f"); _render(root);
    });

    for (const button of root.querySelectorAll('[data-ap="open"]')) button.addEventListener("click", async _ => {
        const id = button.getAttribute("data-id");
        const app = state.catalogue.apps.find(a => a.app_id == id);
        const url = app?.open_link?.url || app?.launch_url;
        if (!url) {states.toast({message: "No launch URL is configured for this app yet."}); return;}
        await _rest("launch", {app_id: id});
        window.open(url, "_blank", "noopener");
    });

    for (const button of root.querySelectorAll('[data-ap="request-toggle"]')) button.addEventListener("click", _ => {
        const id = button.getAttribute("data-id"); state.openRequest = state.openRequest == id ? null : id; _render(root);
    });
    root.querySelector('[data-ap="do-request"]')?.addEventListener("click", async _ => {
        const button = root.querySelector('[data-ap="do-request"]');
        const reason = root.querySelector("#ap-reason").value.trim();
        if (!reason) {states.toast({message: "A reason is required."}); return;}
        const result = await _rest("request_access", {app_id: button.getAttribute("data-id"), reason});
        if (result) {states.toast({message: "Request sent."}); state.openRequest = null; await _view();}
    });

    for (const button of root.querySelectorAll('[data-ap="link-toggle"]')) button.addEventListener("click", _ => {
        const id = button.getAttribute("data-id"); state.openLink = state.openLink == id ? null : id; _render(root);
    });
    root.querySelector('[data-ap="do-link"]')?.addEventListener("click", async _ => {
        const label = root.querySelector("#ap-link-label").value.trim(), url = root.querySelector("#ap-link-url").value.trim();
        if (!label || !url) {states.toast({message: "A label and a URL are both required."}); return;}
        const result = await _rest("link_task", {app_id: state.openLink, task_ref: state.catalogue.running_task_ref, label, url});
        if (result) {states.toast({message: "Connected."}); state.openLink = null; await _view();}
    });

    root.querySelector('[data-ap="toggle-links"]')?.addEventListener("click", async _ => {
        state.showLinks = !state.showLinks;
        if (state.showLinks) state.myLinks = (await _rest("my_links", {}))?.links || [];
        _render(root);
    });
    for (const button of root.querySelectorAll('[data-ap="remove-link"]')) button.addEventListener("click", async _ => {
        const result = await _rest("remove_link", {link_id: button.getAttribute("data-id")});
        if (result) {states.toast({message: "Removed."}); state.myLinks = (await _rest("my_links", {}))?.links || []; _render(root);}
    });

    for (const button of root.querySelectorAll('[data-ap="decide-approve"]')) button.addEventListener("click", async _ => {
        const result = await _rest("decide_request", {request_id: button.getAttribute("data-id"), decision: "approved"});
        if (result) {states.toast({message: "Approved."}); await _view();}
    });
    for (const button of root.querySelectorAll('[data-ap="decide-open"]')) button.addEventListener("click", _ => {
        const id = button.getAttribute("data-id"); state.openDecision = state.openDecision == id ? null : id; _render(root);
    });
    root.querySelector('[data-ap="do-deny"]')?.addEventListener("click", async _ => {
        const button = root.querySelector('[data-ap="do-deny"]');
        const reason = root.querySelector("#ap-deny-reason").value.trim();
        if (!reason) {states.toast({message: "A reason is required."}); return;}
        const result = await _rest("decide_request",
            {request_id: button.getAttribute("data-id"), decision: "denied", decision_reason: reason});
        if (result) {states.toast({message: "Denied."}); await _view();}
    });

    root.querySelector('[data-ap="admin-new"]')?.addEventListener("click", _ => {
        state.showAdminForm = true; state.editingAppId = ""; _render(root);
    });
    for (const button of root.querySelectorAll('[data-ap="admin-edit"]')) button.addEventListener("click", _ => {
        state.showAdminForm = true; state.editingAppId = button.getAttribute("data-id"); _render(root);
    });
    root.querySelector('[data-ap="admin-cancel"]')?.addEventListener("click", _ => {
        state.showAdminForm = false; _render(root);
    });
    root.querySelector('[data-ap="admin-save"]')?.addEventListener("click", async _ => {
        const name = root.querySelector("#ap-f-name").value.trim();
        if (!name) {states.toast({message: "A name is required."}); return;}
        const costRaw = root.querySelector("#ap-f-cost").value;
        const result = await _rest("save_app", {app_id: state.editingAppId || undefined, name,
            category: root.querySelector("#ap-f-category").value.trim() || undefined,
            launch_url: root.querySelector("#ap-f-url").value.trim() || undefined,
            launch_label: root.querySelector("#ap-f-label").value.trim() || undefined,
            requires_request: root.querySelector("#ap-f-requires").checked,
            cost_per_seat_minor: costRaw ? Number(costRaw) : undefined,
            cost_currency: root.querySelector("#ap-f-currency").value.trim() || undefined,
            approver_person_id: root.querySelector("#ap-f-approver").value || undefined,
            deprecated: root.querySelector("#ap-f-deprecated").checked});
        if (result) {states.toast({message: "Saved."}); state.showAdminForm = false; await _view();}
    });
}

async function _rest(op, extra = {}) {
    return await _call(API, op, extra);
}

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
