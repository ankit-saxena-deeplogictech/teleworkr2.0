/**
 * E5 — office days, narrowed to status only. No desk/office entity exists
 * anywhere in this app, so desk booking, capacity, proximity and
 * auto-release aren't here — just home/office/elsewhere, per day, for you
 * and your cohort, and the co-location note when it's worth knowing.
 *
 * Structurally mirrors two existing screens rather than inventing a third
 * layout: calendar.mjs's week-grid/_mondayOf/±7-day paging for the date
 * axis, and team.mjs's per-person-row/status-chip idiom for the people
 * axis — neither alone is the person × day grid this needs, so it's a
 * composite of both, not a new pattern either leaves out.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "officedays";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

const STATUS_LABELS = {home: "Home", office: "Office", elsewhere: "Elsewhere"};

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, weekStart: _mondayOf(new Date().toISOString().substring(0, 10)), editingDate: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page od">${states.loading({rows: 5})}</div>`;
    const data = await _rest("week_status", {week_start: state.weekStart});
    if (!data) return;
    _render(root, data);
}

function _render(root, data) {
    root.innerHTML = `<div class="page od">
        <div class="od-head">
            <button class="btn sm" data-od="prev">‹</button>
            <div class="grow od-week">
                <div class="up t3">Office days</div>
                <div class="sm t2">${_dateRange(state.weekStart)}</div>
            </div>
            <button class="btn sm" data-od="next">›</button>
        </div>

        <div class="tr-card">
            <div class="od-grid od-header">
                <span></span>
                ${data.days.map(d => `<span class="t3 xs up">${_shortDate(d)}</span>`).join("")}
            </div>
            ${data.people.map(p => _personRowHtml(p, data.days)).join("")}
        </div>

        ${state.editingDate ? _editPanelHtml(data) : ""}

        ${data.co_location.length ? `<div class="tr-panel" style="margin-top:10px">
            ${data.co_location.map(c => `<p class="sm">You and ${states.esc(c.with.join(", "))} are both in the
                office on ${states.esc(_shortDate(c.date))}.</p>`).join("")}
        </div>` : ""}
    </div>`;
    _wire(root, data);
}

function _personRowHtml(person, days) {
    return `<div class="od-grid od-row">
        <span class="sm od-name">${states.esc(person.display_name)}${person.is_self ? " (you)" : ""}</span>
        ${days.map(d => _cellHtml(person, d)).join("")}
    </div>`;
}

function _cellHtml(person, date) {
    const entry = person.statuses[date];
    const chip = entry ? `<span class="od-chip ${entry.status}">${STATUS_LABELS[entry.status]}${
        entry.location ? ` · ${states.esc(entry.location)}` : ""}</span>` : `<span class="t3 xs">—</span>`;
    if (!person.is_self) return `<span class="od-cell">${chip}</span>`;
    return `<button class="od-cell od-cell-self" data-od="cell" data-date="${states.esc(date)}">${chip}</button>`;
}

function _editPanelHtml(data) {
    const entry = data.people[0].statuses[state.editingDate];
    return `<div class="tr-panel" style="margin-top:10px">
        <div class="up t3">${states.esc(_shortDate(state.editingDate))}</div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <select class="inp" id="od-status">
                ${["home", "office", "elsewhere"].map(s => `<option value="${s}"${entry?.status == s ? " selected" : ""}>${STATUS_LABELS[s]}</option>`).join("")}
            </select>
            <input class="inp grow" id="od-location" placeholder="Where, optional — e.g. SF, LDN" value="${states.esc(entry?.location || "")}">
            <button class="btn sm pri" data-od="save">Save</button>
            <button class="btn sm" data-od="cancel-edit">Cancel</button>
        </div>
    </div>`;
}

function _wire(root, data) {
    root.querySelector("[data-od=\"prev\"]").addEventListener("click", _ => _shift(-7));
    root.querySelector("[data-od=\"next\"]").addEventListener("click", _ => _shift(7));
    for (const cell of root.querySelectorAll("[data-od=\"cell\"]")) cell.addEventListener("click", _ => {
        state.editingDate = cell.getAttribute("data-date"); _render(root, data);
    });
    root.querySelector("[data-od=\"cancel-edit\"]")?.addEventListener("click", _ => {
        state.editingDate = null; _render(root, data);
    });
    root.querySelector("[data-od=\"save\"]")?.addEventListener("click", async _ => {
        const status = root.querySelector("#od-status").value;
        const location = root.querySelector("#od-location").value.trim() || undefined;
        const result = await _rest("set_status", {status_date: state.editingDate, status, location});
        if (result) {states.toast({message: "Saved."}); state.editingDate = null; await _view();}
    });
}

function _shift(days) {
    const d = new Date(`${state.weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    state.weekStart = d.toISOString().substring(0, 10);
    state.editingDate = null;
    _view();
}

const _mondayOf = iso => {
    const d = new Date(`${iso}T00:00:00Z`);
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - day + 1);
    return d.toISOString().substring(0, 10);
};
const _dateFor = (weekStart, i) => {
    const d = new Date(`${weekStart}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().substring(0, 10);
};
const _dateRange = weekStart => {
    const fmt = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {day: "numeric", month: "short"});
    return `${fmt(weekStart)} – ${fmt(_dateFor(weekStart, 4))}`;
};
const _shortDate = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {weekday: "short", day: "numeric"});

async function _rest(op, extra = {}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET", {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Office days op ${op} failed: ${err}`);}
    if (!response?.result) {
        states.toast({message: response?.reason || "The office-days service did not respond.", ms: 8000});
        return null;
    }
    return response;
}
