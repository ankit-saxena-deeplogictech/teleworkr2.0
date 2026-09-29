/**
 * E4 — working windows, travel, and the drift/DST nudges. The missing
 * "declare your own availability" half of a model the already-built E3
 * team overlap board has been reading live all along — until this
 * screen, the only way a window existed was a direct DB write.
 *
 * No capability gates this screen (matching day/calendar/team's own
 * shared-surface precedent) — it's the caller's own availability, not a
 * permission-gated view of anyone else's. Public holidays are left out
 * entirely: lib/calendar.js's own comment says no org holiday calendar
 * exists yet, "a deliberate, honest absence." "Tell my team" on travel is
 * narrowed to what's real — the team board already reads windows live,
 * so a change is visible the next time anyone opens it; there's no push
 * notification wiring for this specific event to send instead.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "windows", API_LEAVE = "leave", API_CALENDAR = "calendar";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
const _inDays = days => new Date(Date.now() + days*86400000).toISOString().substring(0, 10);
const _midDate = (fromISO, toISO) => new Date(
    (Date.parse(`${fromISO}T00:00:00Z`) + Date.parse(`${toISO}T00:00:00Z`)) / 2).toISOString().substring(0, 10);

const DAY_LABELS = {1: "M", 2: "T", 3: "W", 4: "T", 5: "F", 6: "S", 7: "S"};
const _hhmm = minutes => minutes == null ? "" :
    `${String(Math.floor(minutes/60)).padStart(2, "0")}:${String(minutes%60).padStart(2, "0")}`;
const _minutesFromHHMM = value => {const [h, m] = (value||"0:0").split(":").map(Number); return h*60 + (m||0);};
const _hm = minutes => `${Math.floor(minutes/60)}h ${minutes%60}m`;

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    const projection = (await import("../shell.mjs")).shell.projection;
    state = {root, myPersonId: projection?.person?.person_id, managerPersonId: projection?.employment?.manager_person_id,
        editOpen: false, travelOpen: false, driftDismissed: false, travelPreview: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 5})}</div>`;
    try {
        const [asOf, drift, dst, leaveResp, history, roster] = await Promise.all([
            _rest("asof", {as_of: _today()}), _rest("drift", {}), _rest("dst", {}),
            _call(API_LEAVE, "requests", {}), _rest("history", {}),
            _call(API_CALENDAR, "roster", {date: _today()})]);
        if (!asOf) return;
        state.window = asOf.window;
        state.drift = drift;
        state.dstFlag = dst?.flags?.[0] || null;
        state.leaveRequests = (leaveResp?.requests || []).filter(r =>
            ["pending", "approved"].includes(r.status) && r.to_date >= _today())
            .sort((a, b) => a.from_date.localeCompare(b.from_date));
        state.history = (history?.history || []).slice().reverse();
        state.roster = roster?.roster || [];
        _render(root);
    } catch (err) {
        root.innerHTML = states.error({title: "Couldn't load your working hours", what: err.message,
            safe: "Nothing was changed.", reference: `E4-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(root, {retry: _ => _view()});
    }
}

function _render(root) {
    root.innerHTML = `<div class="page tr">
        ${_windowCardHtml()}
        ${_travelCardHtml()}
        ${_leaveCardHtml()}
        ${_historyCardHtml()}
        ${_dstCardHtml()}
    </div>`;
    _wire(root);
}

// ---------------------------------------------------------------------------
// Your working window, and the drift nudge
// ---------------------------------------------------------------------------

function _windowCardHtml() {
    const w = state.window;
    return `<div class="tr-card">
        <div class="up t3">Your working window</div>
        ${w ? `<div class="sm">${_hhmm(w.start_minute)} – ${_hhmm(w.end_minute)} · ${states.esc(w.timezone)}</div>
            <div class="row wrap" style="gap:4px;margin-top:4px">${[1,2,3,4,5,6,7].map(d => {
                const on = JSON.parse(w.days).includes(d);
                return `<span class="sm" style="padding:2px 7px;border-radius:6px;background:${on ? "var(--dawn-w)" : "var(--raise)"};color:${on ? "var(--dawn)" : "var(--t3)"}">${DAY_LABELS[d]}</span>`;
            }).join("")}</div>` :
            `<div class="tr-empty">No window declared — the team overlap board reads you as undeclared.</div>`}
        <button class="btn sm" data-wd="edit-toggle" style="margin-top:6px">${state.editOpen ? "Close" : w ? "Edit" : "Declare a window"}</button>
        ${state.editOpen ? _editFormHtml() : ""}
        ${_driftHtml()}
    </div>`;
}

function _editFormHtml() {
    const w = state.window;
    const days = w ? JSON.parse(w.days) : [1,2,3,4,5];
    return `<div class="tr-panel" style="margin-top:6px">
        <div class="row wrap" style="gap:6px">
            <input class="inp" id="wd-start" type="time" value="${w ? _hhmm(w.start_minute) : "09:00"}" style="width:110px">
            <span class="sm t3">to</span>
            <input class="inp" id="wd-end" type="time" value="${w ? _hhmm(w.end_minute) : "17:30"}" style="width:110px">
            <input class="inp grow" id="wd-tz" placeholder="IANA timezone, e.g. Asia/Kolkata" value="${states.esc(w?.timezone || "")}">
        </div>
        <div class="row wrap" style="gap:4px;margin-top:6px">
            ${[1,2,3,4,5,6,7].map(d => `<label class="sm"><input type="checkbox" data-wd-day="${d}"${days.includes(d) ? " checked" : ""}> ${DAY_LABELS[d]}</label>`).join("")}
        </div>
        <button class="btn pri sm" data-wd="save-window" style="margin-top:6px">Save</button>
    </div>`;
}

function _driftHtml() {
    const d = state.drift, w = state.window;
    if (state.driftDismissed || !d?.window || !d.early_days || !w) return "";
    return `<div class="tr-panel" style="margin-top:6px;border-color:var(--dawn)">
        <span class="sm">You clocked in before ${_hhmm(w.start_minute)} on ${d.early_days} of the last ${d.days_with_events}
            day${d.days_with_events == 1 ? "" : "s"} you recorded time. Update your window to ${_hhmm(d.suggested_start_minute)}
            so the team's overlap board is accurate?</span>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <button class="btn sm pri" data-wd="drift-update">Update</button>
            <button class="btn sm" data-wd="drift-dismiss">Keep as is</button>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Travel mode
// ---------------------------------------------------------------------------

function _travelCardHtml() {
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">Travel mode</div>
        <button class="btn sm" data-wd="travel-toggle">${state.travelOpen ? "Close" : "Declare travel"}</button>
        ${state.travelOpen ? _travelFormHtml() : ""}
        ${state.travelPreview ? _travelPreviewHtml() : ""}
    </div>`;
}

function _travelFormHtml() {
    const w = state.window;
    return `<div class="tr-panel" style="margin-top:6px">
        <div class="row wrap" style="gap:6px">
            <input class="inp" id="wd-travel-from" type="date" value="${_inDays(1)}">
            <span class="sm t3">to</span>
            <input class="inp" id="wd-travel-to" type="date" value="${_inDays(8)}">
        </div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp grow" id="wd-travel-tz" placeholder="Timezone while travelling">
            <input class="inp" id="wd-travel-start" type="time" value="${w ? _hhmm(w.start_minute) : ""}" style="width:110px">
            <span class="sm t3">to</span>
            <input class="inp" id="wd-travel-end" type="time" value="${w ? _hhmm(w.end_minute) : ""}" style="width:110px">
        </div>
        <div class="sm t3" style="margin-top:4px">Hours default to your usual window — change them if travel shifts when you work.
            The team overlap board reads this the moment it's saved; there's no separate "tell my team" step.</div>
        <button class="btn pri sm" data-wd="save-travel" style="margin-top:6px">Save</button>
    </div>`;
}

function _travelPreviewHtml() {
    const rows = state.travelPreview;
    if (!rows.length) return "";
    return `<div class="tr-panel" style="margin-top:6px">
        <div class="up t3">Overlap while you're away</div>
        ${rows.map(r => `<div class="sm">With ${states.esc(r.name)}: ${_hm(r.before)} → ${_hm(r.after)}</div>`).join("")}
    </div>`;
}

// ---------------------------------------------------------------------------
// Leave (a cross-reference — the full balance and management stays on J3)
// ---------------------------------------------------------------------------

function _leaveCardHtml() {
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">Leave — upcoming</div>
        ${state.leaveRequests.length ? state.leaveRequests.map(r => `<div class="tr-track-row">
            <span class="grow">${states.esc(r.leave_type)} · ${states.esc(r.from_date)} – ${states.esc(r.to_date)}</span>
            <span class="sm" style="color:${r.status == "approved" ? "var(--mint)" : "var(--dawn)"}">${states.esc(r.status)}</span>
        </div>`).join("") : `<div class="tr-empty">Nothing upcoming.</div>`}
        <div class="sm t3" style="margin-top:6px">Balance and requesting leave live on My leave.</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Window history — every effective-dated period, declared and travel alike
// ---------------------------------------------------------------------------

function _historyCardHtml() {
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">History</div>
        ${state.history.length ? state.history.map(row => `<div class="tr-track-row">
            <span class="grow">${row.kind == "travel" ? "Travel" : "Declared"} — ${_hhmm(row.start_minute)}–${_hhmm(row.end_minute)}
                · ${states.esc(row.timezone)}${row.note ? ` — ${states.esc(row.note)}` : ""}</span>
            <span class="sm t3">${states.esc(row.valid_from)} → ${row.valid_to ? states.esc(row.valid_to) : "now"}</span>
        </div>`).join("") : `<div class="tr-empty">Nothing recorded yet.</div>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// Daylight saving
// ---------------------------------------------------------------------------

function _dstCardHtml() {
    const flag = state.dstFlag;
    if (!flag) return "";
    const delta = flag.offset_in_a_week - flag.offset_minutes;
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">Daylight saving</div>
        <div class="sm">${states.esc(flag.timezone)} changes offset within the next week — your overlap with others
            shifts by ${Math.abs(delta)} minute${Math.abs(delta) == 1 ? "" : "s"}.</div>
    </div>`;
}

// ---------------------------------------------------------------------------

function _wire(root) {
    root.querySelector("[data-wd=\"edit-toggle\"]").addEventListener("click", _ => {
        state.editOpen = !state.editOpen; _render(root);});
    root.querySelector("[data-wd=\"save-window\"]")?.addEventListener("click", async _ => {
        const days = [...root.querySelectorAll("[data-wd-day]:checked")].map(b => Number(b.getAttribute("data-wd-day")));
        if (!days.length) {states.toast({message: "Pick at least one working day."}); return;}
        const result = await _rest("set", {timezone: root.querySelector("#wd-tz").value.trim(),
            start_minute: _minutesFromHHMM(root.querySelector("#wd-start").value),
            end_minute: _minutesFromHHMM(root.querySelector("#wd-end").value),
            days, valid_from: _today()});
        if (result) {states.toast({message: "Saved."}); state.editOpen = false; await _view();}
    });
    root.querySelector("[data-wd=\"drift-update\"]")?.addEventListener("click", async _ => {
        const w = state.window;
        const result = await _rest("set", {timezone: w.timezone, start_minute: state.drift.suggested_start_minute,
            end_minute: w.end_minute, days: JSON.parse(w.days), valid_from: _today()});
        if (result) {states.toast({message: "Window updated."}); await _view();}
    });
    root.querySelector("[data-wd=\"drift-dismiss\"]")?.addEventListener("click", _ => {
        state.driftDismissed = true; _render(root);});

    root.querySelector("[data-wd=\"travel-toggle\"]").addEventListener("click", _ => {
        state.travelOpen = !state.travelOpen; state.travelPreview = null; _render(root);});
    root.querySelector("[data-wd=\"save-travel\"]")?.addEventListener("click", async _ => {
        const from_date = root.querySelector("#wd-travel-from").value, to_date = root.querySelector("#wd-travel-to").value;
        const timezone = root.querySelector("#wd-travel-tz").value.trim();
        if (!from_date || !to_date || !timezone) {states.toast({message: "From, to and a timezone are all required."}); return;}
        const result = await _rest("travel", {timezone, valid_from: from_date, valid_to: to_date,
            start_minute: _minutesFromHHMM(root.querySelector("#wd-travel-start").value),
            end_minute: _minutesFromHHMM(root.querySelector("#wd-travel-end").value)});
        if (!result) return;
        states.toast({message: "Travel saved."});
        const preview = await _computeTravelPreview(from_date, to_date);
        state.travelOpen = false;
        await _view();
        state.travelPreview = preview;
        _render(root);
    });
}

/**
 * A before/after read, not a pre-commit simulation — travel isn't
 * irreversible, and there's no dry-run op to preview against. Compares
 * today's shared minutes with the manager and up to one direct report
 * against a date inside the trip; omitted gracefully when neither exists.
 */
async function _computeTravelPreview(from_date, to_date) {
    if (!state.myPersonId) return [];
    const colleagues = [];
    if (state.managerPersonId) colleagues.push(state.managerPersonId);
    for (const person of state.roster)
        if (person.manager_person_id == state.myPersonId && !colleagues.includes(person.person_id) && colleagues.length < 2)
            colleagues.push(person.person_id);
    if (!colleagues.length) return [];

    const midTrip = _midDate(from_date, to_date);
    const rows = [];
    for (const colleague of colleagues) {
        const name = state.roster.find(p => p.person_id == colleague)?.display_name || colleague;
        const before = await _rest("team_overlap", {person_ids: [state.myPersonId, colleague], date: _today()});
        const after = await _rest("team_overlap", {person_ids: [state.myPersonId, colleague], date: midTrip});
        if (before && after) rows.push({name, before: before.shared_minutes, after: after.shared_minutes});
    }
    return rows;
}

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
