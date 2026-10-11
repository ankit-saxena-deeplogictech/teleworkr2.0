/**
 * E1 — the Calendar screen: the week as the working-window projection asks
 * for it, per day, with approved leave days excluded and labelled. The same
 * projection E3 and C5 use, so the three screens can never disagree about
 * what a day was worth.
 *
 * The minimal meeting/calendar-event entity now exists (the foundation
 * E2/F1-F5 build on, not those features themselves — no cost calculator,
 * no Telemeet/WebRTC room, no async video notes, no handoff notes). A
 * selected day shows that day's real meetings and a bare create form: title,
 * start/end time, and who from the org roster. Day facts stay as they were:
 * leave is labelled, and the public holiday field stays null until an org
 * holiday calendar exists.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";
import {locale} from "../locale.mjs";

const API = "calendar", API_MEETINGS = "meetings";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, weekStart: _mondayOf(new Date().toISOString().substring(0, 10)), selected: null, roster: null};
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
                <div class="sm t2">${_dateRange(state.weekStart)} · target ${locale.formatDuration(target.target_seconds)}</div>
            </div>
            <button class="btn sm" data-cal="next">›</button>
        </div>

        <div class="cal-grid">
            ${target.per_day.map(day => _dayCard(day)).join("")}
        </div>

        ${state.selected ? `<div class="cal-card" id="cal-day">${states.loading({rows: 2})}</div>` :
            `<div class="cal-note">Pick a day to see its meetings, or schedule a new one.</div>`}
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
            locale.formatDuration(day.target_seconds)}</div>
        ${excluded?.reason == "leave" ? `<div class="t3 xs">${states.esc(excluded.leave_type || "")}</div>` : ""}
    </div>`;
}

async function _paintDay(root) {
    const panel = root.querySelector("#cal-day");
    if (!panel) return;
    if (!state.roster) state.roster = (await _rest("roster", {date: state.selected}))?.roster || [];
    const [facts, meetingsResp] = await Promise.all([
        _rest("day_facts", {date: state.selected}),
        _restMeetings("for_range", {from_date: state.selected, to_date: state.selected})]);
    if (!facts) return;
    const meetings = meetingsResp?.meetings || [];

    panel.innerHTML = `
        <div class="up t3">${_longDate(state.selected)}</div>
        ${facts.leave ? `<p class="sm"><span class="tm-chip leave">on leave</span>
            ${states.esc(facts.leave[0].leave_type)} · ${states.esc(facts.leave[0].from_date)}–${
                states.esc(facts.leave[0].to_date)}</p>` :
            `<p class="t2 sm">A working day, per your declared window.</p>`}
        ${facts.public_holiday === null ? `<p class="t3 xs">Public holiday: none — no org holiday calendar exists yet.</p>` :
            `<p class="sm">Public holiday: ${states.esc(facts.public_holiday)}</p>`}
        <div class="up t3">Meetings</div>
        ${meetings.length ? meetings.map(m => `
            <div class="cal-meet-row">
                <div class="sm"><b>${states.esc(m.title)}</b> · ${locale.formatTime(m.starts_at)}–${locale.formatTime(m.ends_at)}
                    · ${m.attendees.length} ${m.attendees.length == 1 ? "person" : "people"}</div>
                ${m.is_owner ? `<button class="btn sm" data-meet="cancel" data-id="${states.esc(m.meeting_id)}">Cancel</button>` : ""}
            </div>`).join("") : `<div class="sm t3">No meetings scheduled.</div>`}
        <div class="up t3">New meeting</div>
        <div class="row wrap">
            <input class="inp" id="meet-title" placeholder="Title" style="width:200px">
            <input class="inp" id="meet-start" type="time" style="width:110px" value="10:00">
            <input class="inp" id="meet-end" type="time" style="width:110px" value="10:30">
        </div>
        <div class="row wrap">${state.roster.map(p => `<label class="build-check">
            <input type="checkbox" data-meet-person="${states.esc(p.person_id)}"> ${states.esc(p.display_name || p.person_id)}</label>`).join("") ||
            `<span class="sm t3">No one else is in this org yet.</span>`}</div>
        <button class="btn sm pri" data-meet="create">Create</button>`;

    panel.querySelector("[data-meet=\"create\"]").addEventListener("click", _ => _createMeeting(root));
    for (const button of panel.querySelectorAll("[data-meet=\"cancel\"]"))
        button.addEventListener("click", _ => _cancelMeeting(root, button.getAttribute("data-id")));
}

async function _createMeeting(root) {
    const panel = root.querySelector("#cal-day");
    const title = panel.querySelector("#meet-title").value.trim();
    const startTime = panel.querySelector("#meet-start").value, endTime = panel.querySelector("#meet-end").value;
    if (!title || !startTime || !endTime) {states.toast({message: "A meeting needs a title, start and end time.", ms: 6000}); return;}
    const attendee_person_ids = Array.from(panel.querySelectorAll("[data-meet-person]:checked"))
        .map(box => box.getAttribute("data-meet-person"));

    // No trailing Z: the viewer typed their own local wall-clock time, and locale.formatTime
    // converts back to local for display — both ends must agree on that, unlike this file's
    // other date math (week-grid dates), which is deliberately UTC-anchored throughout.
    const starts_at = Math.floor(new Date(`${state.selected}T${startTime}:00`).getTime()/1000);
    const ends_at = Math.floor(new Date(`${state.selected}T${endTime}:00`).getTime()/1000);
    const response = await _restMeetings("create", {title, starts_at, ends_at, attendee_person_ids});
    if (response) await _paintDay(root);
}

async function _cancelMeeting(root, meeting_id) {
    const response = await _restMeetings("cancel", {meeting_id});
    if (response) await _paintDay(root);
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

async function _restMeetings(op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_MEETINGS}`, "GET",
            {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Meetings op ${op} failed: ${err}`);}
    if (!response?.result) {states.toast({message: response?.reason || "The meeting did not save.", ms: 8000}); return null;}
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
