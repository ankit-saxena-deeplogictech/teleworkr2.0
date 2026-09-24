/**
 * L1 — identity: provisioning status, mover/leaver visibility, and a
 * declared MFA policy. Admin-facing throughout (identity.manage, matching
 * the surface's own gate in shell.js).
 *
 * This is not a multi-provider SSO console — this app has exactly one real
 * identity path (the JWT verify against tkmlogin_api), so the "provider"
 * panel is that one real row, not a catalogue. MFA policy is a declared
 * governance record (this app doesn't enforce MFA itself, the IdP does),
 * same treatment as a signal definition.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "identity";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _when = ts => ts ? new Date(ts*1000).toLocaleDateString() : "—";

const EMPLOYMENT_STATUSES = ["active", "probation", "notice", "suspended", "ended"];
const MFA_STRENGTH_LABELS = {idp_enforced: "IdP-enforced", phishing_resistant: "Phishing-resistant", hardware_key: "Hardware key, no fallback"};
const MFA_STRENGTHS = Object.keys(MFA_STRENGTH_LABELS);
const TIER_LABELS = {standard: "Employee · Team lead", elevated: "HR · anyone who can read another person's record",
    critical: "Org admin · service accounts"};

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, tab: "overview", resolveOpenFor: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">
            <button class="tr-tab${state.tab == "overview" ? " on" : ""}" data-id="tab" data-tab="overview">Overview</button>
            <button class="tr-tab${state.tab == "flagged" ? " on" : ""}" data-id="tab" data-tab="flagged">Flagged</button>
            <button class="tr-tab${state.tab == "movement" ? " on" : ""}" data-id="tab" data-tab="movement">Movement</button>
        </div>
        <div class="tr-view" id="id-view"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-id=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#id-view");
    try {
        if (state.tab == "flagged") return await _flagged(view);
        if (state.tab == "movement") return await _movement(view);
        return await _overview(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load identity", what: err.message,
            safe: "Nothing was changed.", reference: `L1-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// Overview — the one real provider, the attribute map, MFA policy
// ---------------------------------------------------------------------------

async function _overview(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const result = await _rest("overview");
    if (!result) return;
    _renderOverview(root, result);
}

function _renderOverview(root, {provider, attribute_map, mfa_policy}) {
    root.innerHTML = `
        <div class="tr-card">
            <div class="up t3">Identity provider</div>
            <div class="tr-track-row">
                <span class="grow"><b>${provider.configured ? states.esc(provider.host) : "Not configured"}</b>
                    <br><span class="sm t3">${provider.people_via_idp} of ${provider.people_total} current employments trace to it</span></span>
                <span class="sm" style="color:${provider.configured ? "var(--mint)" : "var(--ember)"}">${provider.configured ? "Configured" : "Unconfigured"}</span>
            </div>
            <div class="sm t3" style="margin-top:6px">This app has one real identity path — not a multi-provider catalogue. A second provider, local break-glass accounts and certificate rotation are open questions this screen doesn't invent answers for.</div>
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">What the assertion carries, and what breaks without it</div>
            ${attribute_map.map(row => `<div class="tr-track-row">
                <span class="grow"><b>${states.esc(row.attribute)}</b>${row.required ? ` <span class="sm t3">required</span>` : ` <span class="sm t3">optional</span>`}
                    <br><span class="sm t3">${states.esc(row.breaks)}</span></span>
            </div>`).join("")}
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Multi-factor policy — declared, not enforced by this app</div>
            ${mfa_policy.map(row => `<div class="tr-track-row">
                <span class="grow">${states.esc(TIER_LABELS[row.role_tier] || row.role_tier)}${row.is_default ? ` <span class="sm t3">default</span>` : ""}</span>
                <select class="inp" data-id="mfa-strength" data-tier="${states.esc(row.role_tier)}" style="width:220px">
                    ${MFA_STRENGTHS.map(s => `<option value="${s}"${s == row.strength ? " selected" : ""}>${MFA_STRENGTH_LABELS[s]}</option>`).join("")}
                </select>
            </div>`).join("")}
        </div>`;

    for (const select of root.querySelectorAll("[data-id=\"mfa-strength\"]")) select.addEventListener("change", async event => {
        const result = await _rest("update_mfa_policy", {role_tier: select.getAttribute("data-tier"), strength: event.target.value});
        if (result) {states.toast({message: "MFA policy updated."}); await _overview(root);}
    });
}

// ---------------------------------------------------------------------------
// Flagged — the provisioning-incomplete queue
// ---------------------------------------------------------------------------

async function _flagged(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const result = await _rest("flagged");
    if (!result) return;
    _renderFlagged(root, result.people);
}

function _renderFlagged(root, people) {
    root.innerHTML = `<div class="tr-card">
        <div class="up t3">People with an incomplete assertion — employment withheld until resolved</div>
        ${people.length ? people.map(person => `<div class="tr-track-row" style="align-items:flex-start;flex-direction:column;gap:4px">
            <div class="row wrap" style="width:100%">
                <span class="grow"><b>${states.esc(person.display_name || person.email)}</b> — ${states.esc(person.email)}
                    <br><span class="sm t3">missing: ${states.esc(person.missing.join(", "))} · flagged ${_when(person.flagged_at)}</span></span>
                <button class="btn" data-id="resolve-toggle" data-person="${states.esc(person.person_id)}" style="padding:3px 7px">
                    ${state.resolveOpenFor == person.person_id ? "Close" : "Resolve"}</button>
            </div>
            ${state.resolveOpenFor == person.person_id ? _resolveFormHtml(person) : ""}
        </div>`).join("") : `<div class="tr-empty">Nobody is flagged.</div>`}
    </div>`;

    for (const button of root.querySelectorAll("[data-id=\"resolve-toggle\"]")) button.addEventListener("click", _ => {
        const id = button.getAttribute("data-person");
        state.resolveOpenFor = state.resolveOpenFor == id ? null : id;
        _renderFlagged(root, people);
    });
    if (state.resolveOpenFor) _wireResolveForm(root, people);
}

function _resolveFormHtml(person) {
    return `<div class="tr-card" style="width:100%;margin:4px 0 0 0">
        <div class="row wrap" style="gap:6px">
            <select class="inp" id="id-resolve-status">${EMPLOYMENT_STATUSES.map(s => `<option value="${s}">${s}</option>`).join("")}</select>
            <input class="inp" id="id-resolve-jurisdiction" placeholder="Jurisdiction (e.g. IN)" style="width:140px">
            <input class="inp" id="id-resolve-contract" placeholder="Contract type" style="width:140px">
        </div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp" id="id-resolve-start" type="date">
            <input class="inp grow" id="id-resolve-manager" placeholder="Manager's email (optional)">
            <button class="btn pri" data-id="do-resolve" data-person="${states.esc(person.person_id)}">Resolve</button>
        </div>
    </div>`;
}

function _wireResolveForm(root, people) {
    root.querySelector("[data-id=\"do-resolve\"]")?.addEventListener("click", async _ => {
        const person_id = state.resolveOpenFor;
        const employment_status = root.querySelector("#id-resolve-status").value;
        const jurisdiction = root.querySelector("#id-resolve-jurisdiction").value.trim();
        const contract_type = root.querySelector("#id-resolve-contract").value.trim();
        const start_date = root.querySelector("#id-resolve-start").value;
        const manager = root.querySelector("#id-resolve-manager").value.trim() || undefined;
        if (!jurisdiction || !contract_type || !start_date) {
            states.toast({message: "Jurisdiction, contract type and start date are all required."}); return;}
        const result = await _rest("resolve_flagged", {person_id, employment_status, jurisdiction, contract_type, start_date, manager});
        if (result) {states.toast({message: "Resolved."}); state.resolveOpenFor = null; await _flagged(root);}
    });
}

// ---------------------------------------------------------------------------
// Movement — joiners, movers, leavers
// ---------------------------------------------------------------------------

async function _movement(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const result = await _rest("movement");
    if (!result) return;
    _renderMovement(root, result);
}

function _renderMovement(root, {joiners, movers, leavers}) {
    root.innerHTML = `
        <div class="tr-card">
            <div class="up t3">Joiners — dormant until their start date</div>
            ${joiners.length ? joiners.map(j => `<div class="tr-track-row">
                <span class="grow">${states.esc(j.display_name || j.email)}</span>
                <span class="sm t3">starts ${states.esc(j.valid_from)} · ${states.esc(j.jurisdiction)}</span>
            </div>`).join("") : `<div class="tr-empty">No pending joiners.</div>`}
        </div>
        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Movers — last 90 days</div>
            ${movers.length ? movers.map(m => `<div class="tr-track-row" style="align-items:flex-start">
                <span class="grow"><b>${states.esc(m.display_name || m.email)}</b> · effective ${states.esc(m.effective_from)}
                    <br><span class="sm t3">${m.changes.map(c => `${states.esc(c.field)}: ${states.esc(c.from ?? "—")} → ${states.esc(c.to ?? "—")}`).join(" · ") || "start date renewed"}</span></span>
            </div>`).join("") : `<div class="tr-empty">No moves in the window.</div>`}
        </div>
        <div class="tr-card" style="margin-top:10px;border-color:var(--ember)">
            <div class="up t3" style="color:var(--ember)">Leavers — notice, suspended or ended</div>
            ${leavers.length ? leavers.map(l => `<div class="tr-track-row">
                <span class="grow">${states.esc(l.display_name || l.email)}</span>
                <span class="sm t3">${states.esc(l.status)} since ${states.esc(l.valid_from)}</span>
            </div>`).join("") : `<div class="tr-empty">Nobody currently in notice, suspended or ended.</div>`}
            <div class="sm t3" style="margin-top:6px">Session revocation and the H3 offboarding chain are L4's job, not yet built — ending employment here closes the period, it doesn't touch a live sign-in.</div>
        </div>`;
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
