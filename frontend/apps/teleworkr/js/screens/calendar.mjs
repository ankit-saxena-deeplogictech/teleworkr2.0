/**
 * E1 — the Calendar screen: the week as the working-window projection asks
 * for it, per day, with approved leave days excluded and labelled. The same
 * projection E3 and C5 use, so the three screens can never disagree about
 * what a day was worth.
 *
 * There is no calendar-event entity yet — meetings and focus blocks are the
 * Day board's stated absence (C1), and this screen says so rather than
 * inventing events. Day facts are honest: leave is labelled, and the public
 * holiday field stays null until an org holiday calendar exists.
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
    state = {root, weekStart: _mondayOf(new Date().toISOString().substring(0, 10)), selected: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page cal">${states.loading({rows: 5})}</div>`;

    const target = await _rest("week_target", {week_start: state.weekStart});
    if (!target) return;

    root.innerHTML = `<div class="page cal">
        <div class="cal-head">
            <button class="btn sm" data-cal="prev">‹</button>
            <div class="grow cal-week">
                <div class="up t3">${_weekLabel(state.weekStart)}</div>
                <div class="sm t2">${_dateRange(state.weekStart)} · target ${_hm(target.target_seconds)}</div>
            </div>
            <button class="btn sm" data-cal="next">›</button>
        </div>

        <div class="cal-grid">
            ${target.per_day.map(day => _dayCard(day)).join("")}
        </div>

        ${state.selected ? `<div class="cal-card" id="cal-day">${states.loading({rows: 2})}</div>` :
            `<div class="cal-note">No event calendar yet — meetings and focus blocks are the Day board's
                stated absence, and this screen will not invent them.</div>`}
    </div>`;

    root.querySelector("[data-cal=\"prev\"]").addEventListener("click", _ => _shift(-7));
    root.querySelector("[data-cal=\"next\"]").addEventListener("click", _ => _shift(7));
    for (const card of root.querySelectorAll("[data-cal=\"day\"]"))
        card.addEventListener("click", _ => {state.selected = card.getAttribute("data-date"); _paintDay(root);});
    if (state.selected) await _paintDay(root);
}

function _dayCard(day) {
    const date = day.date;
    const excluded = day.excluded;
    return `<div class="cal-day ${state.selected == date ? "on" : ""} ${excluded ? "excluded" : ""}"
        data-cal="day" data-date="${states.esc(date)}">
        <div class="up t3">${_shortDate(date)}</div>
        <div class="mono cal-day-target">${excluded ? states.esc(excluded.reason) :
            _hm(day.target_seconds)}</div>
        ${excluded?.reason == "leave" ? `<div class="t3 xs">${states.esc(excluded.leave_type || "")}</div>` : ""}
    </div>`;
}

async function _paintDay(root) {
    const panel = root.querySelector("#cal-day");
    if (!panel) return;
    const facts = await _rest("day_facts", {date: state.selected});
    if (!facts) return;
    panel.innerHTML = `
        <div class="up t3">${_longDate(state.selected)}</div>
        ${facts.leave ? `<p class="sm"><span class="tm-chip leave">on leave</span>
            ${states.esc(facts.leave[0].leave_type)} · ${states.esc(facts.leave[0].from_date)}–${
                states.esc(facts.leave[0].to_date)}</p>` :
            `<p class="t2 sm">A working day, per your declared window.</p>`}
        ${facts.public_holiday === null ? `<p class="t3 xs">Public holiday: none — no org holiday calendar exists yet.</p>` :
            `<p class="sm">Public holiday: ${states.esc(facts.public_holiday)}</p>`}`;
}

function _shift(days) {
    const d = new Date(`${state.weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    state.weekStart = d.toISOString().substring(0, 10);
    state.selected = null;
    _view();
}

async function _rest(op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET",
            {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Calendar op ${op} failed: ${err}`);}
    if (!response?.result) {states.toast({message: response?.reason || "The calendar did not respond.", ms: 8000}); return null;}
    return response;
}

const _mondayOf = iso => {
    const d = new Date(`${iso}T00:00:00Z`);
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - day + 1);
    return d.toISOString().substring(0, 10);
};
const _dateFor = (weekStart, i) => {
    const d = new Date(`${weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().substring(0, 10);
};
const _weekLabel = weekStart => {
    const d = new Date(`${weekStart}T00:00:00Z`);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return `Week ${Math.ceil((((d - yearStart)/86400000) + yearStart.getUTCDay() + 1) / 7)}`;
};
const _dateRange = weekStart => {
    const fmt = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {day: "numeric", month: "short"});
    return `${fmt(weekStart)} – ${fmt(_dateFor(weekStart, 6))}`;
};
const _shortDate = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined,
    {weekday: "short", day: "numeric"});
const _longDate = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined,
    {weekday: "long", day: "numeric", month: "long"});
const _hm = seconds => `${Math.floor(seconds/3600)}h ${String(Math.floor((seconds%3600)/60)).padStart(2, "0")}m`;
