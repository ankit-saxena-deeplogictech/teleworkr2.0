/**
 * E3 — the Team screen: the overlap board, which is the one fact only this
 * screen produces — who you can actually talk to today.
 *
 * The board is a projection the server already made: the shared window across
 * everyone's declared hours, each person's own span, and — named rather than
 * silently dropped — people on leave, on an off day, or with no declared
 * window. Zero-overlap pairs carry their evidence, because "you two share no
 * common hour" is actionable in a way a bar chart is not.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "calendar";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, date: new Date().toISOString().substring(0, 10)};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tm">${states.loading({rows: 6})}</div>`;

    const [rosterResponse, board] = await Promise.all([
        _rest("roster", {date: state.date}),
        null]);
    if (!rosterResponse) return;
    const roster = rosterResponse.roster || [];
    const names = Object.fromEntries(roster.map(person => [person.person_id,
        person.display_name || person.person_id]));
    const boardResponse = await _rest("board", {person_ids: roster.map(p => p.person_id), date: state.date});
    if (!boardResponse) return;

    const shared = boardResponse.shared_minutes ? _hm(boardResponse.shared_minutes) : null;
    const spanLabel = boardResponse.span ? `${_clock(state.date, boardResponse.span.from)} – ${
        _clock(state.date, boardResponse.span.to)}` : null;

    root.innerHTML = `<div class="page tm">
        <div class="tm-head">
            <button class="btn sm" data-tm="prev">‹</button>
            <div class="grow tm-date">
                <div class="up t3">${_longDate(state.date)}</div>
                <div class="sm t2">${roster.length} people on the roster</div>
            </div>
            <button class="btn sm" data-tm="next">›</button>
        </div>

        <div class="tm-card tm-headline">
            <div class="up t3">Shared window</div>
            ${shared ? `<p class="tm-big"><span class="mono">${shared}</span> shared${spanLabel ?
                ` · <span class="mono">${states.esc(spanLabel)}</span>` : ""}</p>` :
                `<p class="tm-big">No shared window today.</p>`}
            <p class="t2 sm">${boardResponse.per_person.filter(p => p.workday).length} working · ${
                boardResponse.on_leave?.length || 0} on leave · ${
                boardResponse.off_day.length} off · ${boardResponse.undeclared.length} undeclared</p>
        </div>

        <div class="tm-card">
            <div class="up t3">The day, by person</div>
            ${roster.map(person => _personRow(person, boardResponse, names)).join("")}
        </div>

        ${boardResponse.zero_overlap_pairs.length ? `<div class="tm-card">
            <div class="up t3">No overlap — the pairs to work around</div>
            ${boardResponse.zero_overlap_pairs.map(pair => `<div class="tm-zero">
                <span><b>${states.esc(names[pair.a] || pair.a)}</b> · ${_clock(state.date, pair.a_span.from)}–${
                    _clock(state.date, pair.a_span.to)}</span>
                <span class="t3">shares no common hour with</span>
                <span><b>${states.esc(names[pair.b] || pair.b)}</b> · ${_clock(state.date, pair.b_span.from)}–${
                    _clock(state.date, pair.b_span.to)}</span>
            </div>`).join("")}
        </div>` : ""}
    </div>`;

    root.querySelector("[data-tm=\"prev\"]").addEventListener("click", _ => _shift(-1));
    root.querySelector("[data-tm=\"next\"]").addEventListener("click", _ => _shift(1));
}

function _personRow(person, board, names) {
    const stateRow = board.per_person.find(row => row.person_id == person.person_id);
    const onLeave = (board.on_leave || []).find(fact => fact.person_id == person.person_id);
    let chip, detail = "";
    if (onLeave) {chip = `<span class="tm-chip leave">on leave</span>`; detail = `${
        states.esc(onLeave.leave_type)} · ${states.esc(onLeave.from_date)}–${states.esc(onLeave.to_date)}`;}
    else if (stateRow?.workday) {chip = `<span class="tm-chip on">working</span>`; detail = `${
        stateRow.kind == "travel" ? "travelling" : "declared window"} · ${_clock(board_date(), stateRow.span.from)}–${
        _clock(board_date(), stateRow.span.to)}${stateRow.timezone ? ` · ${states.esc(stateRow.timezone)}` : ""}`;}
    else if (stateRow?.reason == "off_day") {chip = `<span class="tm-chip off">off day</span>`; detail = "not a working day for them";}
    else if (stateRow?.reason == "undeclared") {chip = `<span class="tm-chip undeclared">undeclared</span>`; detail = "no window declared — named, not guessed";}
    else {chip = `<span class="tm-chip undeclared">unavailable</span>`; detail = stateRow?.reason || "";}
    return `<div class="tm-row">
        <span class="grow"><b>${states.esc(names[person.person_id] || person.person_id)}</b></span>
        <span class="t2 sm">${detail}</span>
        ${chip}
    </div>`;
}

const board_date = _ => state.date;

function _shift(days) {
    const d = new Date(`${state.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    state.date = d.toISOString().substring(0, 10);
    _view();
}

async function _rest(op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET",
            {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Calendar op ${op} failed: ${err}`);}
    if (!response?.result) {states.toast({message: response?.reason || "The team board did not respond.", ms: 8000}); return null;}
    return response;
}

/** Span values are epoch minutes — subtract the day's UTC midnight for clock time. */
const _clock = (date, epochMinutes) => {
    const midnight = Date.parse(`${date}T00:00:00Z`)/60000;
    const minutes = ((epochMinutes - midnight) % 1440 + 1440) % 1440;
    return `${String(Math.floor(minutes/60)).padStart(2, "0")}:${String(Math.round(minutes%60)).padStart(2, "0")}`;
};
const _hm = minutes => `${Math.floor(minutes/60)}h ${String(Math.round(minutes%60)).padStart(2, "0")}m`;
const _longDate = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined,
    {weekday: "long", day: "numeric", month: "long"});
