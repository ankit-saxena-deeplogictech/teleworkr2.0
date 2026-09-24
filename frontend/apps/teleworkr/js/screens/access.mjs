/**
 * L2 — permissions: capabilities, scope & elevation. Admin-facing
 * throughout (role.assign or capability.grant, matching the surface's own
 * gate in shell.js) — this isn't a per-employee screen.
 *
 * The matrix and roles/elevations lists render exactly what
 * `permissions.js`/`capabilities.js` already enforce — nothing here
 * re-derives a rule, it only displays the engine's own data
 * (`access.catalogueAsync` passes the catalogue through unchanged, same
 * principle `audit.coverage()` already uses for its own published list).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "access", API_CALENDAR = "calendar";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, tab: "matrix", roster: null, newRoleOpen: false, newRoleCaps: [], grantOpen: false, whoCanCapability: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">
            <button class="tr-tab${state.tab == "matrix" ? " on" : ""}" data-ac="tab" data-tab="matrix">Matrix</button>
            <button class="tr-tab${state.tab == "roles" ? " on" : ""}" data-ac="tab" data-tab="roles">Roles</button>
            <button class="tr-tab${state.tab == "elevations" ? " on" : ""}" data-ac="tab" data-tab="elevations">Elevations</button>
            <button class="tr-tab${state.tab == "whocan" ? " on" : ""}" data-ac="tab" data-tab="whocan">Who can…</button>
        </div>
        <div class="tr-view" id="ac-view"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-ac=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#ac-view");
    try {
        if (!state.roster) state.roster = (await _call(API_CALENDAR, "roster", {date: _today()}))?.roster || [];
        if (state.tab == "roles") return await _roles(view);
        if (state.tab == "elevations") return await _elevations(view);
        if (state.tab == "whocan") return await _whoCan(view);
        return await _matrix(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load permissions", what: err.message,
            safe: "Nothing was changed.", reference: `L2-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// Matrix — capability x built-in role, the ceiling, and SOD rules
// ---------------------------------------------------------------------------

async function _matrix(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const data = await _rest("catalogue");
    if (!data) return;
    state.catalogue = data;
    _renderMatrix(root, data);
}

function _renderMatrix(root, data) {
    const roleNames = Object.keys(data.builtin_roles);
    const capNames = Object.keys(data.catalogue);
    root.innerHTML = `
        <div class="tr-card">
            <div class="up t3">Permission matrix</div>
            <div class="tr-track-row" style="font-weight:600">
                <span class="grow" style="flex:2">Capability</span>
                ${roleNames.map(r => `<span class="sm" style="width:60px;text-align:center">${states.esc(data.builtin_roles[r].label)}</span>`).join("")}
                <span class="sm t3" style="flex:1.2">Scope</span>
            </div>
            ${capNames.map(cap => {
                const scopes = new Set();
                const cells = roleNames.map(r => {
                    const entry = data.builtin_roles[r].capabilities.find(c => c[0] == cap);
                    if (entry) scopes.add(entry[1]);
                    return `<span class="sm" style="width:60px;text-align:center;color:${entry ? "var(--mint)" : "var(--t3)"}">${entry ? "●" : "○"}</span>`;
                }).join("");
                return `<div class="tr-track-row">
                    <span class="grow" style="flex:2">${states.esc(data.catalogue[cap].label)}<br><span class="sm t3">${states.esc(cap)}</span></span>
                    ${cells}
                    <span class="sm t3" style="flex:1.2">${[...scopes].map(s => states.esc(s)).join(", ") || "—"}</span>
                </div>`;
            }).join("")}
        </div>

        <div class="tr-card" style="margin-top:10px;border-color:var(--ember)">
            <div class="up t3" style="color:var(--ember)">The ceiling — structurally impossible</div>
            ${Object.entries(data.ceiling).map(([cap, reason]) => `<div class="tr-track-row">
                <span class="grow">${states.esc(cap)}</span>
                <span class="sm t3">${states.esc(reason)}</span></div>`).join("")}
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Separation of duties</div>
            ${Object.entries(data.sod_rules).map(([id, rule]) => `<div class="tr-track-row">
                <span class="grow"><b>${states.esc(rule.label)}</b><br><span class="sm t3">${states.esc(rule.explain)} — ${states.esc(rule.who_can)}</span></span>
            </div>`).join("")}
        </div>`;
}

// ---------------------------------------------------------------------------
// Roles — built-in and custom, holder counts, compose a new one
// ---------------------------------------------------------------------------

async function _roles(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const [roles, catalogue] = await Promise.all([_rest("roles"), state.catalogue ? Promise.resolve(state.catalogue) : _rest("catalogue")]);
    if (!roles || !catalogue) return;
    state.catalogue = catalogue;
    _renderRoles(root, roles.roles, catalogue);
}

function _renderRoles(root, roles, catalogue) {
    root.innerHTML = `
        <div class="row wrap"><span class="push"></span>
            <button class="btn pri" data-ac="new-role">${state.newRoleOpen ? "Close" : "+ New role"}</button>
        </div>
        ${state.newRoleOpen ? _newRoleHtml(catalogue) : ""}

        <div class="tr-card" style="margin-top:10px">
            ${roles.map(role => `<div class="tr-track-row" style="align-items:flex-start">
                <span class="grow"><b>${states.esc(role.name)}</b>${role.is_builtin ? "" : " · custom"}
                    <br><span class="sm t3">${role.capabilities.length} capabilit${role.capabilities.length == 1 ? "y" : "ies"} · ${role.holder_count} holder${role.holder_count == 1 ? "" : "s"}</span></span>
                <select class="inp" data-ac="assign-person" data-role="${states.esc(role.name)}" style="width:160px">
                    <option value="">Assign to…</option>
                    ${state.roster.map(p => `<option value="${states.esc(p.person_id)}">${states.esc(p.display_name)}</option>`).join("")}
                </select>
            </div>`).join("")}
        </div>`;

    root.querySelector("[data-ac=\"new-role\"]").addEventListener("click", _ => {
        state.newRoleOpen = !state.newRoleOpen; state.newRoleCaps = []; _renderRoles(root, roles, catalogue);});
    if (state.newRoleOpen) _wireNewRole(root, roles, catalogue);
    for (const select of root.querySelectorAll("[data-ac=\"assign-person\"]")) select.addEventListener("change", async event => {
        const person_id = event.target.value; if (!person_id) return;
        const validTo = prompt("Expiry date (YYYY-MM-DD), or leave blank for an ongoing role:");
        const result = await _rest("assign_role", {person_id, role_name: select.getAttribute("data-role"),
            valid_to: validTo || undefined});
        if (result) {states.toast({message: "Role assigned."}); event.target.value = ""; await _roles(root);}
    });
}

function _newRoleHtml(catalogue) {
    const capNames = Object.keys(catalogue.catalogue);
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">New role</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp" id="ac-role-name" placeholder="Name">
            <input class="inp grow" id="ac-role-desc" placeholder="Description">
        </div>
        <div style="margin-top:8px;max-height:220px;overflow-y:auto">
            ${capNames.map(cap => `<div class="row" style="gap:6px;padding:2px 0">
                <label class="sm grow"><input type="checkbox" data-ac="cap-check" value="${states.esc(cap)}"> ${states.esc(catalogue.catalogue[cap].label)}</label>
                <select class="inp" data-ac="cap-scope" data-cap="${states.esc(cap)}" style="width:140px">
                    ${catalogue.catalogue[cap].scopes.map(s => `<option value="${states.esc(s)}">${states.esc(s)}</option>`).join("")}
                </select>
            </div>`).join("")}
        </div>
        <button class="btn pri" data-ac="do-new-role" style="margin-top:8px">Create role</button>
        <div class="sm t3" id="ac-role-warning" style="margin-top:6px"></div>
    </div>`;
}

function _wireNewRole(root, roles, catalogue) {
    root.querySelector("[data-ac=\"do-new-role\"]").addEventListener("click", async _ => {
        const name = root.querySelector("#ac-role-name").value.trim();
        const description = root.querySelector("#ac-role-desc").value.trim();
        const checked = [...root.querySelectorAll("[data-ac=\"cap-check\"]:checked")].map(c => c.value);
        if (!name || !checked.length) return;
        const capabilities = checked.map(cap => {
            const scopeSelect = root.querySelector(`[data-ac="cap-scope"][data-cap="${cap}"]`);
            return [cap, scopeSelect.value];
        });
        const result = await _rest("create_role", {name, description, capabilities});
        if (result) {
            states.toast({message: `Role "${result.role.name}" created.`});
            if (result.warnings?.length) root.querySelector("#ac-role-warning").textContent = result.warnings.join(" ");
            state.newRoleOpen = false; await _roles(root);
        }
    });
}

// ---------------------------------------------------------------------------
// Elevations — the access review, plus granting one
// ---------------------------------------------------------------------------

async function _elevations(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const [review, catalogue] = await Promise.all([_rest("access_review"), state.catalogue ? Promise.resolve(state.catalogue) : _rest("catalogue")]);
    if (!review || !catalogue) return;
    state.catalogue = catalogue;
    _renderElevations(root, review.grants, catalogue);
}

function _renderElevations(root, grants, catalogue) {
    root.innerHTML = `
        <div class="row wrap"><span class="push"></span>
            <button class="btn pri" data-ac="grant">${state.grantOpen ? "Close" : "+ Grant elevation"}</button>
        </div>
        ${state.grantOpen ? _grantHtml(catalogue) : ""}

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Active elevations & the quarterly review</div>
            ${grants.length ? grants.map(g => `<div class="tr-track-row" style="align-items:flex-start">
                <span class="grow"><b>${states.esc(g.person_name)}</b> — ${states.esc(g.capability)} @ ${states.esc(g.scope_type)}${g.scope_ref ? `:${states.esc(g.scope_ref)}` : ""}
                    <br><span class="sm t3">by ${states.esc(g.granted_by_name || "—")} · ${states.esc(g.reason || "no reason on file")} · expires ${states.esc(g.valid_to || "—")}
                    ${g.propose_removal ? ` · <span style="color:var(--ember)">propose removal — ${states.esc(g.why)}</span>` : ""}</span></span>
                <button class="btn" data-ac="revoke" data-id="${states.esc(g.grant_id)}" style="padding:3px 7px">Revoke</button>
            </div>`).join("") : `<div class="tr-empty">No elevations outside the built-in roles.</div>`}
        </div>`;

    root.querySelector("[data-ac=\"grant\"]").addEventListener("click", _ => {state.grantOpen = !state.grantOpen; _renderElevations(root, grants, catalogue);});
    if (state.grantOpen) _wireGrant(root, grants, catalogue);
    for (const button of root.querySelectorAll("[data-ac=\"revoke\"]")) button.addEventListener("click", async _ => {
        const result = await _rest("revoke_grant", {grant_id: button.getAttribute("data-id")});
        if (result) {states.toast({message: "Revoked."}); await _elevations(root);}
    });
}

function _grantHtml(catalogue) {
    const capNames = Object.keys(catalogue.catalogue);
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">Grant a time-boxed elevation</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <select class="inp" id="ac-grant-person">${state.roster.map(p => `<option value="${states.esc(p.person_id)}">${states.esc(p.display_name)}</option>`).join("")}</select>
            <select class="inp" id="ac-grant-capability">${capNames.map(c => `<option value="${states.esc(c)}">${states.esc(catalogue.catalogue[c].label)}</option>`).join("")}</select>
            <select class="inp" id="ac-grant-scope" style="width:140px"></select>
            <input class="inp" id="ac-grant-scope-ref" placeholder="scope_ref" style="width:120px;display:none">
        </div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp" id="ac-grant-valid-to" type="date" placeholder="Expires">
            <input class="inp grow" id="ac-grant-reason" placeholder="Reason (required)">
            <button class="btn pri" data-ac="do-grant">Grant</button>
        </div>
    </div>`;
}

function _wireGrant(root, grants, catalogue) {
    const capSelect = root.querySelector("#ac-grant-capability");
    const scopeSelect = root.querySelector("#ac-grant-scope");
    const scopeRefInput = root.querySelector("#ac-grant-scope-ref");
    const needsRef = new Set(["team", "project", "location", "jurisdiction"]);
    const refreshScopes = _ => {
        const scopes = catalogue.catalogue[capSelect.value].scopes;
        scopeSelect.innerHTML = scopes.map(s => `<option value="${states.esc(s)}">${states.esc(s)}</option>`).join("");
        scopeRefInput.style.display = needsRef.has(scopeSelect.value) ? "" : "none";
    };
    capSelect.addEventListener("change", refreshScopes);
    scopeSelect.addEventListener("change", _ => {scopeRefInput.style.display = needsRef.has(scopeSelect.value) ? "" : "none";});
    refreshScopes();

    root.querySelector("[data-ac=\"do-grant\"]").addEventListener("click", async _ => {
        const person_id = root.querySelector("#ac-grant-person").value;
        const capability = capSelect.value, scope_type = scopeSelect.value;
        const scope_ref = needsRef.has(scope_type) ? scopeRefInput.value.trim() : undefined;
        const valid_to = root.querySelector("#ac-grant-valid-to").value;
        const reason = root.querySelector("#ac-grant-reason").value.trim();
        if (!person_id || !valid_to || !reason) {states.toast({message: "Person, expiry and reason are all required."}); return;}
        const result = await _rest("grant_elevation", {person_id, capability, scope_type, scope_ref, valid_to, reason});
        if (result) {states.toast({message: "Granted."}); state.grantOpen = false; await _elevations(root);}
    });
}

// ---------------------------------------------------------------------------
// Who can… — the reverse lookup
// ---------------------------------------------------------------------------

async function _whoCan(root) {
    const catalogue = state.catalogue || await _rest("catalogue");
    if (!catalogue) return;
    state.catalogue = catalogue;
    if (!state.whoCanCapability) state.whoCanCapability = Object.keys(catalogue.catalogue)[0];
    root.innerHTML = `
        <div class="row wrap">
            <select class="inp" id="ac-whocan-capability">
                ${Object.keys(catalogue.catalogue).map(c => `<option value="${states.esc(c)}"${
                    c == state.whoCanCapability ? " selected" : ""}>${states.esc(catalogue.catalogue[c].label)}</option>`).join("")}
            </select>
        </div>
        <div class="tr-card" style="margin-top:10px" id="ac-whocan-results">${states.loading({rows: 2})}</div>`;
    root.querySelector("#ac-whocan-capability").addEventListener("change", async event => {
        state.whoCanCapability = event.target.value; await _paintWhoCan(root);});
    await _paintWhoCan(root);
}

async function _paintWhoCan(root) {
    const result = await _rest("who_can", {capability: state.whoCanCapability});
    const container = root.querySelector("#ac-whocan-results");
    if (!result) return;
    container.innerHTML = `<div class="up t3">Who can — ${states.esc(state.catalogue.catalogue[state.whoCanCapability].label)}</div>
        ${result.holders.length ? result.holders.map(h => `<div class="tr-track-row">
            <span class="grow">${states.esc(h.name)}</span>
            <span class="sm t3">${states.esc(h.through.source_role ? `via ${h.through.source_role}` : "direct grant")} @ ${states.esc(h.through.scope_type)}</span>
        </div>`).join("") : `<div class="tr-empty">Nobody currently holds this.</div>`}`;
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
