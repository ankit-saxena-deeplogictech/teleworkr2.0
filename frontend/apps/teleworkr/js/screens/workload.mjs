/**
 * H1 — the lead's team board & workload. A named per-person capacity view
 * (declared hours minus leave, vs. their open tasks' estimated hours) over a
 * date range — the cohort is always the caller's own direct reports, the
 * same limitation M3's team-load screen already works around (SCOPES.TEAM
 * needs scope_ref plumbing that doesn't exist yet).
 *
 * The wireframe's fuller version also wants a meetings time-split, a
 * "Sprint 12 ▾ / Group ▾" team selector, and an onboarding panel — no
 * meeting/calendar-event system, no sprint/project entity and no onboarding
 * (B3) module exist anywhere in this app, so none of those are here. What's
 * shown is real: capacity, commitment, leave, ramping new hires, and the
 * team's own blocked-time figure.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "workload", API_CALENDAR = "calendar";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
const _addDays = (iso, days) => {
    const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().substring(0, 10);
};

const FLAG_LABELS = {over_capacity: "Over capacity", room_for_more: "Room for more", nothing_scheduled: "Nothing scheduled"};

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, from: _today(), to: _addDays(_today(), 13)};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 4})}</div>`;
    try {
        const [board, roster] = await Promise.all([
            _rest("board", {from_date: state.from, to_date: state.to}),
            _call(API_CALENDAR, "roster", {date: _today()})]);
        if (!board) return;
        state.board = board;
        state.roster = roster?.roster || [];
        _render(root);
    } catch (err) {
        root.innerHTML = states.error({title: "Couldn't load the team board", what: err.message,
            safe: "Nothing was changed.", reference: `H1-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(root, {retry: _ => _view()});
    }
}

const _nameOf = person_id => state.roster.find(p => p.person_id == person_id)?.display_name || person_id;
const _hm = seconds => seconds == null ? null : `${Math.round(seconds/3600)}h`;

function _render(root) {
    const board = state.board;
    root.innerHTML = `<div class="page tr">
        <div class="row wrap" style="gap:8px;align-items:center">
            <span class="up t3">Team board · next window</span>
            <span class="push"></span>
            <input class="inp" type="date" id="wl-from" value="${state.from}" style="width:150px">
            <span class="sm t3">to</span>
            <input class="inp" type="date" id="wl-to" value="${state.to}" style="width:150px">
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="sm">${board.people.length} people · ${board.over_capacity_count} over capacity ·
                ${board.nothing_scheduled_count} with nothing scheduled</div>
            ${board.people.length ? board.people.map(_personRowHtml).join("") :
                `<div class="tr-empty">No direct reports.</div>`}
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Where things stand</div>
            <p class="sm" style="margin-top:6px">${board.blocked_percent === null ?
                "No open work to measure." :
                `${board.blocked_percent}% of the team's open work is currently blocked — the number to act on.`}</p>
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Not shown here</div>
            <p class="sm t3" style="margin-top:6px">Clock-in times · idle minutes · app sessions · focus-block
                completion · hours worked outside declared windows.</p>
            <p class="sm t3" style="margin-top:4px">Deliberate. A lead needs capacity and blockers; minute-level
                activity turns a planning tool into a monitoring one.</p>
        </div>
    </div>`;

    root.querySelector("#wl-from").addEventListener("change", event => {state.from = event.target.value; _view();});
    root.querySelector("#wl-to").addEventListener("change", event => {state.to = event.target.value; _view();});
}

function _personRowHtml(person) {
    const flag = person.flag ? `<span class="chip warn">${states.esc(FLAG_LABELS[person.flag])}</span>` : "";
    const ramping = person.ramping ? `<span class="chip">Ramping — excluded from flags</span>` : "";
    const leave = person.leave_days ? `<span class="sm t3">${person.leave_days} day${person.leave_days==1?"":"s"} leave</span>` : "";

    let hours;
    if (person.capacity_seconds == null) hours = `<span class="sm t3">Hours not declared</span>`;
    else if (person.no_estimates) hours = `<span class="sm t3">No estimates set</span>`;
    else hours = `<span class="mono sm">${_hm(person.committed_seconds)} / ${_hm(person.capacity_seconds)}</span>`;

    return `<div class="tr-track-row">
        <span class="grow"><b>${states.esc(_nameOf(person.person_id))}</b></span>
        ${hours}
        ${leave}
        ${flag}${ramping}
    </div>`;
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
