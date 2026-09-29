/**
 * H4 — the audit log. My activity (audit.read_own — every built-in role
 * including guest) is the default tab; the fuller org-wide/compliance log
 * only appears when the viewer also holds audit.read_all/audit.read_policy
 * — same per-capability internal tabbing wellbeing.mjs/security.mjs
 * already established, not a role fork.
 *
 * Entries render as sentences built from each row's own detail fields for
 * a handful of common, real actions; anything not templated gets an
 * honest generic line rather than invented prose — audit_event.detail is
 * deliberately shapes-and-counts, never content a person typed.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "audit";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _when = ts => ts ? new Date(ts*1000).toLocaleString() : "—";
const _hm = seconds => seconds == null ? "—" : `${Math.floor(seconds/3600)}h ${Math.floor((seconds%3600)/60)}m`;

/** A handful of common, real actions get a real sentence; everything else falls back honestly. */
const TEMPLATES = {
    "time_entry.edited": row => row.detail.to ?
        `Changed a time entry on ${states.esc(row.detail.to.task_ref || "a task")} from ${_hm(row.detail.from?.duration_seconds)} to ${_hm(row.detail.to.duration_seconds)}` :
        `Edited ${states.esc((row.detail.changed||[]).join(", ") || "a field")} on a time entry`,
    "timesheet.approved": row => `Approved the ${states.esc(row.detail.week_start)} timesheet — ${_hm(row.detail.total_seconds)} (${_hm(row.detail.billable_seconds)} billable)`,
    "timesheet.returned": row => `Returned the ${states.esc(row.detail.week_start || "")} timesheet for changes`,
    "role.assigned": row => `Assigned the ${states.esc(row.detail.role)} role`,
    "capability.granted": row => `Granted ${states.esc(row.detail.capability)} at ${states.esc(row.detail.scope_type)}${row.detail.scope_ref ? `:${states.esc(row.detail.scope_ref)}` : ""}`,
    "capability.revoked": row => `Revoked ${states.esc(row.detail.capability || "a capability")}`,
    "task.deleted": row => `Deleted task ${states.esc(row.detail.task_ref || row.object_ref)}`,
    "session.revoked": row => `Revoked sessions for ${row.detail.target?.person_id ? "one person" :
        row.detail.target?.role_name ? `everyone holding ${states.esc(row.detail.target.role_name)}` : "the whole org"}`,
    "leave_policy.published": row => `Published a leave policy for ${states.esc(row.object_ref)} — effective ${states.esc(row.detail.effective_from)}`,
    "person.erased": row => `Executed an erasure${row.reason ? ` — ${states.esc(row.reason)}` : ""}`,
    "user.impersonated": row => `Impersonated a user${row.reason ? ` — ${states.esc(row.reason)}` : ""}`
};

function _sentence(row) {
    const template = TEMPLATES[row.action];
    if (template) try {return template(row);} catch (err) {/* fall through to the generic line */}
    return `${states.esc(row.action)} on ${states.esc(row.object_type)}${row.object_ref ? ` ${states.esc(row.object_ref)}` : ""}`;
}

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    const caps = (await import("../shell.mjs")).shell.projection?.capabilities || [];
    state = {root, tab: "mine",
        canReadAll: caps.includes("audit.read_all"), canReadPolicy: caps.includes("audit.read_policy"),
        coverage: null, category: "", fromDate: "", toDate: "", searchText: "", entries: []};
    await _view();
}

async function _view() {
    const root = state.root;
    const canFull = state.canReadAll || state.canReadPolicy;
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">
            <button class="tr-tab${state.tab == "mine" ? " on" : ""}" data-au="tab" data-tab="mine">My activity</button>
            ${canFull ? `<button class="tr-tab${state.tab == "full" ? " on" : ""}" data-au="tab" data-tab="full">Full log</button>` : ""}
        </div>
        <div class="tr-view" id="au-view"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-au=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#au-view");
    try {
        if (state.tab == "full" && canFull) return await _full(view);
        return await _mine(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load the audit log", what: err.message,
            safe: "Nothing was changed.", reference: `H4-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// My activity — everyone, own entries only (queryAsync's own "own" level)
// ---------------------------------------------------------------------------

async function _mine(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 4})}</div>`;
    const result = await _rest("query", {});
    if (!result) return;
    root.innerHTML = `<div class="tr-card">
        <div class="up t3">Entries about you, and your own actions</div>
        ${result.entries.length ? result.entries.map(row => _rowHtml(row)).join("") :
            `<div class="tr-empty">Nothing recorded yet.</div>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// Full log — audit.read_all / audit.read_policy
// ---------------------------------------------------------------------------

async function _full(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 4})}</div>`;
    if (!state.coverage) state.coverage = await _rest("coverage", {});
    const result = await _rest("query", {category: state.category || undefined,
        from: state.fromDate ? Math.floor(Date.parse(`${state.fromDate}T00:00:00Z`)/1000) : undefined,
        to: state.toDate ? Math.floor(Date.parse(`${state.toDate}T23:59:59Z`)/1000) : undefined, limit: 200});
    if (!result || !state.coverage) return;
    state.entries = result.entries;
    _renderFull(root);
}

function _renderFull(root) {
    const filtered = state.searchText ? state.entries.filter(row =>
        `${row.action} ${row.object_type} ${row.object_ref||""} ${row.actor_person_id||""} ${_sentence(row)}`
            .toLowerCase().includes(state.searchText.toLowerCase())) : state.entries;

    root.innerHTML = `
        <div class="row wrap" style="gap:6px">
            <input class="inp grow" id="au-search" placeholder="Search actor, object or id" value="${states.esc(state.searchText)}">
            <select class="inp" id="au-category" style="width:160px">
                <option value="">All types</option>
                ${state.coverage.categories.map(c => `<option value="${states.esc(c.name)}"${c.name == state.category ? " selected" : ""}>${states.esc(c.label)}</option>`).join("")}
            </select>
            <input class="inp" id="au-from" type="date" value="${states.esc(state.fromDate)}">
            <input class="inp" id="au-to" type="date" value="${states.esc(state.toDate)}">
            <button class="btn" data-au="export">Export</button>
            ${state.canReadAll ? `<button class="btn" data-au="verify">Integrity check</button>` : ""}
        </div>
        <div id="au-integrity" class="sm t3" style="margin-top:6px"></div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Immutable · retained 7 years · ${filtered.length} of ${state.entries.length} shown</div>
            ${filtered.length ? filtered.map(row => _rowHtml(row)).join("") : `<div class="tr-empty">No entries match.</div>`}
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">What's always logged</div>
            ${state.coverage.always_audited.map(c => `<div class="sm t3">${states.esc(c.label)}</div>`).join("")}
            ${state.coverage.fixed_events.map(name => `<div class="sm t3">${states.esc(name)}</div>`).join("")}
        </div>`;

    root.querySelector("#au-search").addEventListener("input", event => {state.searchText = event.target.value; _renderFull(root);});
    root.querySelector("#au-category").addEventListener("change", async event => {state.category = event.target.value; await _full(root);});
    root.querySelector("#au-from").addEventListener("change", async event => {state.fromDate = event.target.value; await _full(root);});
    root.querySelector("#au-to").addEventListener("change", async event => {state.toDate = event.target.value; await _full(root);});
    root.querySelector("[data-au=\"export\"]").addEventListener("click", _ => _exportEntries(filtered));
    root.querySelector("[data-au=\"verify\"]")?.addEventListener("click", async _ => {
        const result = await _rest("verify_integrity", {});
        if (!result) return;
        root.querySelector("#au-integrity").innerHTML = result.ok ?
            `<span style="color:var(--mint)">Chain verified — ${result.count} entries, no tampering detected.</span>` :
            `<span style="color:var(--ember)">Broken at ${states.esc(result.broken_at)} — ${states.esc(result.why)}</span>`;
    });
}

function _rowHtml(row) {
    const escalated = row.action == "role.assigned" || row.action == "capability.granted" || row.action.startsWith("capability.");
    return `<div class="tr-track-row"${escalated ? ` style="background:var(--dawn-w)"` : ""}>
        <span class="sm t3" style="width:150px;flex-shrink:0">${states.esc(_when(row.occurred_at))}</span>
        <span class="grow">${_sentence(row)}${row.reason && !TEMPLATES[row.action] ? `<br><span class="sm t3">Reason: ${states.esc(row.reason)}</span>` : ""}</span>
    </div>`;
}

/** No server-side export pipeline exists — a client-side download of the loaded, filtered rows, same precedent as K9's own .ics. */
function _exportEntries(rows) {
    const blob = new Blob([JSON.stringify(rows, null, 2)], {type: "application/json"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = "audit-log.json"; link.click();
    URL.revokeObjectURL(link.href);
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
