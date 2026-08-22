/**
 * C5 — the Timesheet screen: the week, by day, and the submit that pins it.
 *
 * The week is a projection over the append-only ledger — the screen never
 * computes what the server will submit, it renders what the server returned,
 * including the totals as they will be pinned. A returned week shows its
 * reason and its unlocked dates; only those dates offer an edit. Approvals
 * live on the Approvals surface (C7), not here.
 *
 * The submit confirms the three things the wireframe says to check before
 * submitting: the total, the reconstructed entries (entries rebuilt from
 * signals deserve a look), and the billable split. Submitting pins the entry
 * events as they stood — the screen says so, because a later edit cannot
 * silently change a submitted week.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API_TIME = "time", API_CALENDAR = "calendar";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATUS_LABELS = {open: "Open", submitted: "Submitted", returned: "Returned",
    approved: "Approved", locked: "Locked"};

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, weekStart: _mondayOf(new Date().toISOString().substring(0, 10)), editing: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page ts">${states.loading({rows: 6})}</div>`;

    const [week, target] = await Promise.all([
        _rest(API_TIME, "week", {week_start: state.weekStart}),
        _rest(API_CALENDAR, "week_target", {week_start: state.weekStart})]);
    if (!week) return;

    const sheet = week.timesheet;
    const events = _currentEvents(week.events || []);
    const totals = week.totals || {total_seconds: 0, billable_seconds: 0, reconstructed_count: 0, by_task: []};
    const status = sheet?.status || "open";
    const unlocked = status == "returned" ? JSON.parse(sheet.unlocked_dates || "[]") : null;
    const editable = date => !sheet || status == "open" ||
        (status == "returned" && unlocked.includes(date));

    root.innerHTML = `<div class="page ts">
        <div class="ts-head">
            <button class="btn sm" data-ts="prev">‹</button>
            <div class="grow ts-week">
                <div class="up t3">${_weekLabel(state.weekStart)}</div>
                <div class="sm t2">${_dateRange(state.weekStart)}</div>
            </div>
            <span class="ts-status s-${status}">${STATUS_LABELS[status] || status}</span>
            <button class="btn sm" data-ts="next">›</button>
            ${(status == "open" || status == "returned") ?
                `<button class="btn pri sm" data-ts="submit">Submit week</button>` : ""}
        </div>

        <div class="ts-totals">
            <span><span class="mono">${_hm(totals.total_seconds)}</span> logged</span>
            <span class="dot"></span>
            <span><span class="mono">${target ? _hm(target.target_seconds) : "—"}</span> target${
                target?.working_days ? ` · ${target.working_days} working days` : ""}</span>
            <span class="dot"></span>
            <span><span class="mono">${_hm(totals.billable_seconds)}</span> billable</span>
            ${totals.reconstructed_count ? `<span class="dot"></span>
                <span class="ts-recon">${totals.reconstructed_count} reconstructed — check these</span>` : ""}
        </div>

        ${status == "returned" ? `<div class="ts-returned">
            <b>Returned by your manager.</b> ${states.esc(sheet.return_reason || "")}
            <span class="t2 sm">Only these dates are unlocked: ${
                unlocked.length ? unlocked.join(", ") : "none"}.</span></div>` : ""}
        ${status == "submitted" ? `<div class="ts-submitted">Submitted — the entry events are pinned as they stood.
            A later edit cannot silently change this week; a manager returns it first.</div>` : ""}
        ${status == "approved" ? `<div class="ts-approved">Approved. The snapshot this week was built from is the record.</div>` : ""}

        ${WEEKDAYS.map((label, i) => _daySection(label, _dateFor(state.weekStart, i),
            events, editable)).join("")}

        <div class="ts-card">
            <div class="up t3">By task</div>
            ${totals.by_task.length ? totals.by_task.map(row => `
                <div class="row sm"><span class="mono grow">${states.esc(row.task_ref || "(no task)")}</span>
                <span class="t2">${_hm(row.seconds)}</span>
                ${row.billable_seconds != row.seconds ? `<span class="t3 xs">${_hm(row.seconds - row.billable_seconds)} non-billable</span>` : ""}</div>`).join("") :
                `<p class="t3 sm">No time recorded this week yet.</p>`}
        </div>
    </div>`;

    root.querySelector("[data-ts=\"prev\"]").addEventListener("click", _ => _shift(-7));
    root.querySelector("[data-ts=\"next\"]").addEventListener("click", _ => _shift(7));
    root.querySelector("[data-ts=\"submit\"]")?.addEventListener("click", _ => _submit(root));
    _wireEdits(root, events);
}

function _daySection(label, date, events, editable) {
    const dayEvents = events.filter(event => event.entry_date == date);
    return `<div class="ts-day">
        <div class="ts-day-head">
            <span class="up t3">${label}</span>
            <span class="t3 xs">${states.esc(date)}</span>
            <span class="push"></span>
            <span class="mono sm">${_hm(dayEvents.reduce((sum, e) => sum + _liveSeconds(e), 0))}</span>
        </div>
        ${dayEvents.length ? dayEvents.map(event => _entryRow(event, editable(date))).join("") :
            `<div class="t3 xs ts-noentries">—</div>`}
    </div>`;
}

function _entryRow(event, canEdit) {
    const running = !event.ended_at && event.started_at;
    return `<div class="ts-entry" data-entry="${states.esc(event.entry_event_id)}">
        <span class="ts-entry-time mono">${_span(event)}</span>
        <span class="grow sm">${states.esc(event.note || event.task_ref || event.source)}${
            event.task_ref ? ` · ${states.esc(event.task_ref)}` : ""}</span>
        ${event.category ? `<span class="ts-chip">${states.esc(event.category)}</span>` : ""}
        ${event.reconstructed ? `<span class="ts-chip recon">reconstructed</span>` : ""}
        ${running ? `<span class="ts-chip live">running</span>` : ""}
        <span class="mono sm">${_hm(_liveSeconds(event))}</span>
        ${canEdit && !running ? `<button class="btn sm" data-ts="edit" data-entry="${states.esc(event.entry_event_id)}">Edit</button>` : ""}
    </div>`;
}

function _wireEdits(root, events) {
    for (const button of root.querySelectorAll("[data-ts=\"edit\"]"))
        button.addEventListener("click", _ => _editEntry(root, events.find(
            event => event.entry_event_id == button.getAttribute("data-entry"))));
}

async function _editEntry(root, event) {
    if (!event) return;
    const hours = Math.floor((event.duration_seconds || 0)/3600);
    const minutes = Math.floor(((event.duration_seconds || 0)%3600)/60);
    const row = root.querySelector(`[data-entry="${event.entry_event_id}"]`);
    row.outerHTML = `<div class="ts-edit">
        <input class="inp" type="number" min="0" id="ts-e-h" value="${hours}" style="width:70px"> h
        <input class="inp" type="number" min="0" max="59" id="ts-e-m" value="${minutes}" style="width:70px"> m
        <input class="inp grow" id="ts-e-note" placeholder="note" value="${states.esc(event.note || "")}">
        <input class="inp grow" id="ts-e-reason" placeholder="reason — required, shown on the edit trail">
        <button class="btn pri sm" data-ts="edit-save" data-entry="${states.esc(event.entry_event_id)}">Save</button>
        <button class="btn sm" data-ts="edit-cancel">Cancel</button>
    </div>`;
    const edit = root.querySelector(`[data-ts="edit-save"]`);
    edit.addEventListener("click", async _ => {
        const reason = root.querySelector("#ts-e-reason").value.trim();
        if (!reason) {states.toast({message: "An edit needs a reason — the edit trail shows it forever (C5)."}); return;}
        const h = parseInt(root.querySelector("#ts-e-h").value || "0", 10);
        const m = parseInt(root.querySelector("#ts-e-m").value || "0", 10);
        const saved = await _rest(API_TIME, "edit", {entry_event_id: event.entry_event_id, reason,
            changes: {duration_seconds: h*3600 + m*60, note: root.querySelector("#ts-e-note").value.trim() || null}});
        if (saved) {states.toast({message: "Entry edited. The original survives on the edit trail."}); await _view();}
    });
    root.querySelector("[data-ts=\"edit-cancel\"]").addEventListener("click", _ => _view());
}

async function _submit(root) {
    const week = await _rest(API_TIME, "week", {week_start: state.weekStart});
    if (!week) return;
    const totals = week.totals || {};
    const checks = [
        `Total this week: ${_hm(totals.total_seconds || 0)}`,
        ...(totals.reconstructed_count ?
            [`${totals.reconstructed_count} entry${totals.reconstructed_count == 1 ? " was" : "s were"} reconstructed from signals — worth a look.`] : []),
        `Billable: ${_hm(totals.billable_seconds || 0)} of ${_hm(totals.total_seconds || 0)}`];
    const confirmed = await states.confirmAction({
        title: "Submit this week?",
        body: "Submitting pins the entry events as they stood. A later edit cannot silently change a submitted week — your manager returns it first.",
        collateral: checks, confirmLabel: "Submit week"});
    if (!confirmed) return;
    const submitted = await _rest(API_TIME, "submit", {week_start: state.weekStart});
    if (!submitted) return;
    states.toast({message: "Week submitted. Your manager sees the mirror, not the ledger."});
    await _view();
}

function _shift(days) {
    const d = new Date(`${state.weekStart}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    state.weekStart = d.toISOString().substring(0, 10);
    _view();
}

// ---------------------------------------------------------------------------

async function _rest(api, op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${api}`, "GET",
            {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`${api} op ${op} failed: ${err}`);}
    if (!response?.result) {states.toast({message: response?.reason || "The service did not respond.", ms: 8000}); return null;}
    return response;
}

/** The latest state of each entry — superseded originals stay in the trail, not in the view. */
const _currentEvents = events => {
    const superseded = new Set(events.filter(event => event.supersedes_entry_event_id)
        .map(event => event.supersedes_entry_event_id));
    return events.filter(event => !superseded.has(event.entry_event_id));
};

const _liveSeconds = event => {
    if (!event.ended_at && event.started_at) return Math.max(0, Math.floor(Date.now()/1000) - event.started_at);
    return event.duration_seconds || 0;
};

const _span = event => {
    if (!event.started_at) return "";
    const start = new Date(event.started_at*1000).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"});
    const end = event.ended_at ? new Date(event.ended_at*1000).toLocaleTimeString(undefined,
        {hour: "2-digit", minute: "2-digit"}) : "now";
    return `${start}–${end}`;
};

const _mondayOf = isoDate => {
    const d = new Date(`${isoDate}T00:00:00Z`);
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
    const week = Math.ceil((((d - yearStart)/86400000) + yearStart.getUTCDay() + 1) / 7);
    return `Week ${week}`;
};

const _dateRange = weekStart => {
    const fmt = iso => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {day: "numeric", month: "short"});
    return `${fmt(weekStart)} – ${fmt(_dateFor(weekStart, 6))}`;
};

const _hm = total => `${Math.floor(total/3600)}h ${String(Math.floor((total%3600)/60)).padStart(2,"0")}m`;
