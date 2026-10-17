/**
 * Activity & logs — the admin day-level viewer (activity.read_daily). Three
 * tabs: the org-wide login log, one person's days, and the per-app log.
 *
 * Day-level on purpose: minute-level activity and screen contents are in the
 * product's CEILING and are never collected, so there are no screenshots here
 * and no per-launch or clock-in/out times. Every view is itself recorded in
 * the audit log, and the screen says so.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apiman} from "../apiclient.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "activity", API_CALENDAR = "calendar";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
const _daysAgo = n => new Date(Date.now() - n*86400000).toISOString().substring(0, 10);
const _when = ts => ts ? new Date(ts*1000).toLocaleString() : "—";
const _hm = seconds => `${Math.floor((seconds||0)/3600)}h ${String(Math.floor(((seconds||0)%3600)/60)).padStart(2, "0")}m`;

const SIGNAL_LABELS = {new_device: "new device", outside_declared_window: "outside declared working window"};
const TIER_COLOR = {review: "var(--warn, #b45309)", quiet: "var(--t3, #6b7280)"};
const NOTE = "Day-level only. Minute-level activity and screen contents are never collected, so there are no screenshots. Every view on this screen is recorded in the audit log.";

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, tab: "logins", from: _daysAgo(13), to: _today(), person_id: "", flagged_only: false,
        app_id: "", roster: null};
    await _view();
}

async function _view() {
    const root = state.root;
    const tab = (id, label) => `<button class="tr-tab${state.tab == id ? " on" : ""}" data-ac="tab" data-tab="${id}">${label}</button>`;
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">${tab("logins", "Login log")}${tab("people", "People")}${tab("apps", "Apps")}</div>
        <div class="sm t3" style="margin:6px 0 10px">${states.esc(NOTE)}</div>
        <div class="tr-card"><div class="row wrap" style="gap:6px;align-items:center">
            <input class="inp" id="ac-from" type="date" value="${states.esc(state.from)}">
            <input class="inp" id="ac-to" type="date" value="${states.esc(state.to)}">
            <span id="ac-filters" class="row wrap" style="gap:6px;align-items:center"></span>
            <button class="btn" id="ac-apply">Apply</button>
            <button class="btn" id="ac-export">Export CSV</button>
        </div></div>
        <div class="tr-view" id="ac-view" style="margin-top:10px"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-ac=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    if (!state.roster) state.roster = (await _call(API_CALENDAR, "roster", {date: _today()}))?.roster || [];
    _renderFilters(root.querySelector("#ac-filters"));
    root.querySelector("#ac-apply").addEventListener("click", _ => {
        state.from = root.querySelector("#ac-from").value; state.to = root.querySelector("#ac-to").value;
        state.person_id = root.querySelector("#ac-person")?.value || "";
        state.flagged_only = Boolean(root.querySelector("#ac-flagged")?.checked);
        _load();
    });
    root.querySelector("#ac-export").addEventListener("click", _ => _exportCsv());
    await _load();
}

function _renderFilters(host) {
    const personSelect = (required) => `<select class="inp" id="ac-person" style="width:200px">
        ${required ? `<option value="">Choose a person…</option>` : `<option value="">Everyone</option>`}
        ${state.roster.map(p => `<option value="${states.esc(p.person_id)}"${p.person_id == state.person_id ? " selected" : ""}>${states.esc(p.display_name)}</option>`).join("")}</select>`;
    if (state.tab == "logins") host.innerHTML = `${personSelect(false)}
        <label class="sm"><input type="checkbox" id="ac-flagged"${state.flagged_only ? " checked" : ""}> needs review only</label>`;
    else if (state.tab == "people") host.innerHTML = personSelect(true);
    else host.innerHTML = "";
}

const _nameOf = person_id => state.roster.find(p => p.person_id == person_id)?.display_name || person_id;

async function _load() {
    const view = state.root.querySelector("#ac-view");
    state.rows = null;
    if (state.tab == "people" && !state.person_id) {
        view.innerHTML = `<div class="tr-empty">Choose a person to see their days.</div>`; return;
    }
    view.innerHTML = `<div class="tr-band">${states.loading({rows: 4})}</div>`;
    const result = state.tab == "logins" ?
        await _rest("login_log", {from: state.from, to: state.to, person_id: state.person_id || undefined, flagged_only: state.flagged_only || undefined}) :
        state.tab == "people" ? await _rest("person_days", {from: state.from, to: state.to, person_id: state.person_id}) :
        await _rest("app_log", {from: state.from, to: state.to});
    if (!result) {
        view.innerHTML = states.error({title: "Couldn't load activity", what: "The request was refused or failed.",
            safe: "Nothing was changed.", reference: `L5-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _load()});
        return;
    }
    if (state.tab == "logins") _renderLogins(view, result);
    else if (state.tab == "people") _renderPeople(view, result);
    else _renderApps(view, result);
}

function _renderLogins(view, result) {
    state.rows = result.sessions.map(s => ({person: s.display_name || s.email, email: s.email, signed_in: _when(s.signed_in_at),
        device: s.device_label, ip: s.ip || "", signals: s.signals.join(" "), tier: s.tier,
        signed_out: s.revoked_at ? _when(s.revoked_at) : ""}));
    view.innerHTML = `<div class="tr-card"><div class="up t3">Sign-ins — ${states.esc(result.from)} to ${states.esc(result.to)}</div>
        ${result.sessions.length ? result.sessions.map(s => `<div class="tr-track-row">
            <span class="grow"><b>${states.esc(s.display_name || s.email)}</b> — ${states.esc(s.device_label)} · ${states.esc(s.ip || "unknown address")}
                <br><span class="sm t3">${_when(s.signed_in_at)}${s.revoked_at ? ` · signed out ${_when(s.revoked_at)}` : ""} ·
                    ${states.esc(s.signals.length ? s.signals.map(x => SIGNAL_LABELS[x] || x).join(", ") : "no signals")}</span></span>
            <span class="sm" style="color:${TIER_COLOR[s.tier]}">${states.esc(s.tier)}</span>
        </div>`).join("") : `<div class="tr-empty">No sign-ins in this range.</div>`}
        ${result.truncated ? `<div class="sm t3">Showing the newest 1000. Narrow the range or pick a person.</div>` : ""}</div>`;
}

function _renderPeople(view, result) {
    state.rows = result.days.map(d => ({date: d.date, sign_ins: d.sign_ins, devices: d.devices.join(" | "),
        flagged_sign_ins: d.flagged_sign_ins, worked: _hm(d.worked_seconds), billable: _hm(d.billable_seconds),
        reconstructed_entries: d.reconstructed_entries, breaks: d.breaks,
        app_launches: Object.entries(d.app_launches).map(([n, c]) => `${n} x${c}`).join(" | "),
        timesheet: d.timesheet_status || ""}));
    view.innerHTML = `<div class="tr-card"><div class="up t3">${states.esc(_nameOf(state.person_id))} — ${states.esc(result.from)} to ${states.esc(result.to)}</div>
        ${result.days.map(d => {
            const apps = Object.entries(d.app_launches);
            const quiet = !d.sign_ins && !d.worked_seconds && !apps.length && !d.breaks;
            return `<div class="tr-track-row">
                <span style="width:90px"><b>${states.esc(d.date)}</b></span>
                <span class="grow">${quiet ? `<span class="t3">No activity recorded</span>` : `
                    ${_hm(d.worked_seconds)} worked${d.billable_seconds ? ` (${_hm(d.billable_seconds)} billable)` : ""}
                    · ${d.sign_ins} sign-in${d.sign_ins == 1 ? "" : "s"}${d.flagged_sign_ins ? ` (${d.flagged_sign_ins} to review)` : ""}
                    · ${d.breaks} break${d.breaks == 1 ? "" : "s"}${d.reconstructed_entries ? ` · ${d.reconstructed_entries} reconstructed` : ""}
                    ${apps.length ? `<br><span class="sm t3">Apps: ${apps.map(([n, c]) => `${states.esc(n)} ×${c}`).join(", ")}</span>` : ""}`}</span>
                <span class="sm t3">${states.esc(d.timesheet_status || "")}</span>
            </div>`;}).join("")}</div>`;
}

function _renderApps(view, result) {
    state.rows = result.days.map(d => ({date: d.date, app: d.name, launches: d.launches, distinct_users: d.distinct_users}));
    view.innerHTML = `<div class="tr-card"><div class="up t3">App launches — ${states.esc(result.from)} to ${states.esc(result.to)}</div>
        ${result.days.length ? result.days.map(d => `<div class="tr-track-row">
            <span style="width:90px"><b>${states.esc(d.date)}</b></span>
            <span class="grow">${states.esc(d.name)}</span>
            <span class="sm">${d.launches} launch${d.launches == 1 ? "" : "es"} · ${d.distinct_users} ${d.distinct_users == 1 ? "person" : "people"}</span>
        </div>`).join("") : `<div class="tr-empty">No app launches in this range.</div>`}</div>`;
}

/** No server-side export pipeline exists — a client-side download of the loaded rows, same precedent as audit.mjs. */
function _exportCsv() {
    if (!state.rows?.length) {states.toast({message: "Nothing loaded to export."}); return;}
    const cols = Object.keys(state.rows[0]);
    const cell = value => `"${String(value ?? "").replace(/"/g, "\"\"")}"`;
    const csv = [cols.join(","), ...state.rows.map(row => cols.map(c => cell(row[c])).join(","))].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], {type: "text/csv"}));
    link.download = `activity-${state.tab}-${state.from}-to-${state.to}.csv`; link.click();
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
