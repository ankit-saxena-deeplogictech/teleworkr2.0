/**
 * E1 — the Calendar screen: the week as the working-window projection asks
 * for it, per day, with approved leave days excluded and labelled. The same
 * projection E3 and C5 use, so the three screens can never disagree about
 * what a day was worth.
 *
 * E2 (event composer & meeting cost) is now built on top of the minimal
 * meeting entity — reusing E3's own overlap machinery (`windows.js`'s
 * `team_overlap` op) entirely, no new backend. The composer shows team-hour
 * cost (with a recurring-weekly *projection*, not an actual recurring
 * series — this entity has no recurrence concept), each checked attendee's
 * local time and whether the proposed start falls outside their declared
 * hours, and up to 3 suggested times ranked by how many of them are free.
 * Deliberately not built: the async-alternative/"decision thread" offer
 * (D6 doesn't exist — wiki.js's own header names it as deferred, so a
 * button with nothing behind it would be dishonest), and the post-meeting
 * writeback to tasks/notes/recording (needs a task link this entity
 * deliberately doesn't have, plus recording/notes that don't exist either
 * — F1/F5's job, not this screen's). Day facts stay as they were: leave is
 * labelled, and the public holiday field stays null until an org holiday
 * calendar exists.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apiman} from "../apiclient.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";
import {locale} from "../locale.mjs";

const API = "calendar", API_MEETINGS = "meetings", API_WINDOWS = "windows";
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
                <button class="btn sm" data-meet="join" data-id="${states.esc(m.meeting_id)}">Join call</button>
                ${m.is_owner ? `<button class="btn sm" data-meet="cancel" data-id="${states.esc(m.meeting_id)}">Cancel</button>` : ""}
            </div>`).join("") : `<div class="sm t3">No meetings scheduled.</div>`}
        <div class="up t3">New meeting</div>
        <div class="row wrap">
            <input class="inp" id="meet-title" placeholder="Title" style="width:200px">
            <input class="inp" id="meet-start" type="time" style="width:110px" value="10:00">
            <select class="inp" id="meet-duration" style="width:100px">
                <option value="15">15 min</option>
                <option value="30">30 min</option>
                <option value="45">45 min</option>
                <option value="60" selected>60 min</option>
                <option value="90">90 min</option>
                <option value="120">120 min</option>
            </select>
            <label class="build-check"><input type="checkbox" id="meet-recurring"> Recurring weekly</label>
        </div>
        <div class="row wrap">${state.roster.map(p => `<label class="build-check">
            <input type="checkbox" data-meet-person="${states.esc(p.person_id)}"> ${states.esc(p.display_name || p.person_id)}</label>`).join("") ||
            `<span class="sm t3">No one else is in this org yet.</span>`}</div>
        <div class="row wrap">
            <button class="btn sm pri" data-meet="create">Create</button>
            <button class="btn sm" data-meet="cut30">Cut to 30 min</button>
            <button class="btn sm" data-meet="suggest">Suggest times</button>
        </div>
        <div id="meet-suggest"></div>
        <div id="meet-preview"></div>`;

    panel.querySelector("[data-meet=\"create\"]").addEventListener("click", _ => _createMeeting(root));
    for (const button of panel.querySelectorAll("[data-meet=\"cancel\"]"))
        button.addEventListener("click", _ => _cancelMeeting(root, button.getAttribute("data-id")));
    for (const button of panel.querySelectorAll("[data-meet=\"join\"]"))
        button.addEventListener("click", _ => _joinCall(button.getAttribute("data-id")));
    panel.querySelector("[data-meet=\"cut30\"]").addEventListener("click", _ => {
        panel.querySelector("#meet-duration").value = "30"; _refreshPreview(root);});
    panel.querySelector("[data-meet=\"suggest\"]").addEventListener("click", _ => _suggestTimes(root));
    panel.querySelector("#meet-start").addEventListener("change", _ => _refreshPreview(root));
    panel.querySelector("#meet-duration").addEventListener("change", _ => _refreshPreview(root));
    panel.querySelector("#meet-recurring").addEventListener("change", _ => _refreshPreview(root));
    for (const box of panel.querySelectorAll("[data-meet-person]"))
        box.addEventListener("change", _ => _refreshPreview(root));
    await _refreshPreview(root);
}

async function _createMeeting(root) {
    const panel = root.querySelector("#cal-day");
    const title = panel.querySelector("#meet-title").value.trim();
    const startTime = panel.querySelector("#meet-start").value;
    const duration = Number(panel.querySelector("#meet-duration").value);
    if (!title || !startTime) {states.toast({message: "A meeting needs a title and a start time.", ms: 6000}); return;}
    const attendee_person_ids = Array.from(panel.querySelectorAll("[data-meet-person]:checked"))
        .map(box => box.getAttribute("data-meet-person"));

    // No trailing Z: the viewer typed their own local wall-clock time, and locale.formatTime
    // converts back to local for display — both ends must agree on that, unlike this file's
    // other date math (week-grid dates), which is deliberately UTC-anchored throughout.
    const starts_at = Math.floor(new Date(`${state.selected}T${startTime}:00`).getTime()/1000);
    const ends_at = starts_at + duration*60;
    const response = await _restMeetings("create", {title, starts_at, ends_at, attendee_person_ids});
    if (response) await _paintDay(root);
}

/** The cost + per-attendee preview — its own container so it never clobbers the form's own inputs. */
async function _refreshPreview(root) {
    const panel = root.querySelector("#cal-day");
    const preview = panel?.querySelector("#meet-preview");
    if (!preview) return;
    const startTime = panel.querySelector("#meet-start").value;
    const duration = Number(panel.querySelector("#meet-duration").value);
    const recurring = panel.querySelector("#meet-recurring").checked;
    const attendeeIds = Array.from(panel.querySelectorAll("[data-meet-person]:checked"))
        .map(box => box.getAttribute("data-meet-person"));

    const costHtml = _costLines(attendeeIds.length, duration, recurring);
    if (!attendeeIds.length || !startTime) {preview.innerHTML = costHtml; return;}

    const starts_at = Math.floor(new Date(`${state.selected}T${startTime}:00`).getTime()/1000);
    const overlap = await _restWindows("team_overlap", {person_ids: attendeeIds, date: state.selected});
    if (!overlap) {preview.innerHTML = costHtml; return;}

    const names = Object.fromEntries(state.roster.map(p => [p.person_id, p.display_name || p.person_id]));
    const byPerson = new Map(overlap.per_person.map(p => [p.person_id, p]));
    const rowsHtml = attendeeIds.map(id => {
        const row = byPerson.get(id);
        if (!row?.workday) return `<div class="sm">${states.esc(names[id] || id)} · <span class="t3">${
            row?.reason == "off_day" ? "off that day" : "no declared hours"}</span></div>`;
        const inWindow = starts_at >= row.span.from*60 && starts_at < row.span.to*60;
        return `<div class="sm">${states.esc(names[id] || id)} · ${_attendeeLocalTime(starts_at, row.timezone)}${
            inWindow ? "" : ` <span class="t3 xs">· outside their hours</span>`}</div>`;
    }).join("");
    preview.innerHTML = costHtml + rowsHtml;
}

const _costLines = (attendeeCount, durationMinutes, recurring) => {
    if (!attendeeCount) return `<div class="sm t3">Check someone to see the cost.</div>`;
    const hoursNow = attendeeCount * durationMinutes / 60;
    const recurringLine = recurring ? `<div class="sm t3">Recurring weekly, projected — not an actual series ·
        ${(hoursNow*4.345).toFixed(1)}h per month · ${Math.round(hoursNow*52)}h per year</div>` : "";
    return `<div class="sm"><b>${hoursNow.toFixed(2)}h</b> of team time · ${attendeeCount}
        ${attendeeCount == 1 ? "person" : "people"} × ${durationMinutes} min</div>${recurringLine}`;
}

/** Up to 3 slots this week ranked by how many of the currently-checked attendees are free. */
async function _suggestTimes(root) {
    const panel = root.querySelector("#cal-day");
    const attendeeIds = Array.from(panel.querySelectorAll("[data-meet-person]:checked"))
        .map(box => box.getAttribute("data-meet-person"));
    const duration = Number(panel.querySelector("#meet-duration").value);
    const suggestBox = panel.querySelector("#meet-suggest");
    if (!attendeeIds.length) {states.toast({message: "Check at least one person first.", ms: 5000}); return;}

    suggestBox.innerHTML = states.loading({rows: 1});
    const candidates = [];
    for (let i = 0; i < 7; i++) {
        const date = _dateFor(state.weekStart, i);
        const overlap = await _restWindows("team_overlap", {person_ids: attendeeIds, date});
        const available = overlap?.per_person.filter(p => p.workday) || [];
        if (!available.length) continue;

        const from = Math.min(...available.map(p => p.span.from)), to = Math.max(...available.map(p => p.span.to));
        let best = null;
        for (let slot = from; slot + duration <= to; slot += 30) {
            const count = available.filter(p => slot >= p.span.from && slot + duration <= p.span.to).length;
            if (count > 0 && (!best || count > best.count)) best = {slot, count};
        }
        if (best) candidates.push({date, epochMinutes: best.slot, count: best.count});
    }
    candidates.sort((a, b) => b.count - a.count || a.epochMinutes - b.epochMinutes);
    const top = candidates.slice(0, 3);

    suggestBox.innerHTML = top.length ?
        `<div class="row wrap">${top.map(c => `<button class="btn sm" data-meet="pick"
            data-date="${states.esc(c.date)}" data-minutes="${c.epochMinutes}">${_weekdayShort(c.epochMinutes)}
            ${locale.formatTime(c.epochMinutes*60)} · ${c.count} of ${attendeeIds.length}</button>`).join("")}</div>` :
        `<div class="sm t3">No shared time found this week for who's checked.</div>`;

    for (const button of suggestBox.querySelectorAll("[data-meet=\"pick\"]"))
        button.addEventListener("click", _ => _pickSuggestion(root,
            button.getAttribute("data-date"), Number(button.getAttribute("data-minutes"))));
}

/** Picking a suggestion can switch the selected day, so the in-progress composer fields are preserved across the repaint. */
async function _pickSuggestion(root, date, epochMinutes) {
    const draft = _captureDraft(root.querySelector("#cal-day"));
    state.selected = date;
    for (const card of root.querySelectorAll("[data-cal=\"day\"]"))
        card.classList.toggle("on", card.getAttribute("data-date") == date);
    await _paintDay(root);
    const panel = root.querySelector("#cal-day");
    _applyDraft(panel, draft);
    const d = new Date(epochMinutes*60*1000);
    panel.querySelector("#meet-start").value = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    await _refreshPreview(root);
}

const _captureDraft = panel => ({title: panel.querySelector("#meet-title").value,
    duration: panel.querySelector("#meet-duration").value, recurring: panel.querySelector("#meet-recurring").checked,
    attendeeIds: Array.from(panel.querySelectorAll("[data-meet-person]:checked")).map(box => box.getAttribute("data-meet-person"))});

function _applyDraft(panel, draft) {
    panel.querySelector("#meet-title").value = draft.title;
    panel.querySelector("#meet-duration").value = draft.duration;
    panel.querySelector("#meet-recurring").checked = draft.recurring;
    for (const box of panel.querySelectorAll("[data-meet-person]"))
        if (draft.attendeeIds.includes(box.getAttribute("data-meet-person"))) box.checked = true;
}

const _weekdayShort = epochMinutes => new Date(epochMinutes*60*1000).toLocaleDateString(undefined, {weekday: "short"});
const _attendeeLocalTime = (epochSeconds, timezone) => new Date(epochSeconds*1000)
    .toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit", timeZone: timezone});

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

/** Opens (or reuses) the Telemeet room for a meeting and hands it to the Telemeet screen. */
async function _joinCall(meeting_id) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/telemeet`, "GET", {op: "create_room", ..._me(), meeting_id}, true);
    } catch (err) {response = null; LOG.error(`Telemeet create_room failed: ${err}`);}
    if (!response?.result) {states.toast({message: response?.reason || "The call could not be opened.", ms: 8000}); return;}
    window.__tw_join_room = response.room.room_id;
    (await import("../shell.mjs")).shell.setSurface("telemeet");
}

/** Silent on failure — this is the composer's background enrichment, not the save path (same idiom shell.mjs's own notif poll uses). */
async function _restWindows(op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_WINDOWS}`, "GET",
            {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Windows op ${op} failed: ${err}`);}
    return response?.result ? response : null;
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
