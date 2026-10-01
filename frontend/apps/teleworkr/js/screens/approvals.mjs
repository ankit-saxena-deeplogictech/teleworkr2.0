/**
 * C7 — the approvals queue. Bulk-approve the unremarkable, open the flagged
 * ones, and name the reason on a return. Its two sections are independently
 * capability-gated — timesheet.approve and leave.approve are held by
 * different roles at different scopes, so a lead sees both, HR may see only
 * leave, and neither section assumes the other is present.
 *
 * Bulk-select is restricted to unflagged weeks (the wireframe's own rule):
 * anything reconstructed or over target must be opened and returned with a
 * named reason, one at a time. "Nudge" writes a real, durable notification
 * row via the existing generic notify op — there is no bell/feed UI reading
 * it yet, so this is recorded evidence, not a live push.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API_TIME = "time", API_LEAVE = "leave", API_CALENDAR = "calendar", API_NOTIF = "notifications";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
const _hm = seconds => `${Math.floor(seconds/3600)}:${String(Math.floor((seconds%3600)/60)).padStart(2, "0")}`;
const _daysBetween = (fromISO, toISO) =>
    Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86400000);
const _weekDates = weekStart => {
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(`${weekStart}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
        dates.push(d.toISOString().substring(0, 10));
    }
    return dates;
};

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    const caps = (await import("../shell.mjs")).shell.projection?.capabilities || [];
    state = {root, canApproveTimesheets: caps.includes("timesheet.approve"),
        canApproveLeave: caps.includes("leave.approve"), selected: new Set(),
        openRow: null, openDetail: null, openLeave: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 5})}</div>`;
    try {
        state.roster = (await _call(API_CALENDAR, "roster", {date: _today()}))?.roster || [];

        if (state.canApproveTimesheets) {
            const [pending, missing] = await Promise.all([
                _rest("pending", {}), _rest("missing", {})]);
            state.queue = pending?.queue || [];
            state.missing = missing?.missing || [];
            await Promise.all(state.queue.map(async row => {
                const target = await _call(API_CALENDAR, "week_target",
                    {person_id: row.person_id, week_start: row.week_start});
                row.target_seconds = target?.target_seconds ?? null;
            }));
        } else {state.queue = []; state.missing = [];}

        state.leaveQueue = state.canApproveLeave ?
            (await _call(API_LEAVE, "pending", {}))?.queue || [] : [];

        _render(root);
    } catch (err) {
        root.innerHTML = states.error({title: "Couldn't load the approvals queue", what: err.message,
            safe: "Nothing was changed.", reference: `C7-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(root, {retry: _ => _view()});
    }
}

/** Reloads only the timesheet-derived state (queue/missing/target enrichment) after a write. */
async function _reloadTimesheets(root) {
    const [pending, missing] = await Promise.all([
        _rest("pending", {}), _rest("missing", {})]);
    if (!pending || !missing) return;
    state.queue = pending.queue || []; state.missing = missing.missing || [];
    await Promise.all(state.queue.map(async row => {
        const target = await _call(API_CALENDAR, "week_target", {person_id: row.person_id, week_start: row.week_start});
        row.target_seconds = target?.target_seconds ?? null;
    }));
    state.openRow = null; state.openDetail = null;
    _render(root);
}

async function _reloadLeave(root) {
    state.leaveQueue = (await _call(API_LEAVE, "pending", {}))?.queue || [];
    state.openLeave = null;
    _render(root);
}

const _nameOf = person_id => state.roster.find(p => p.person_id == person_id)?.display_name || person_id;

function _render(root) {
    root.innerHTML = `<div class="page tr">
        ${state.canApproveTimesheets ? _timesheetSectionHtml() + _missingSectionHtml() : ""}
        ${state.canApproveLeave ? _leaveSectionHtml() : ""}
        ${(!state.canApproveTimesheets && !state.canApproveLeave) ? states.empty({title: "Nothing to approve here",
            body: "You don't currently hold an approval capability."}) : ""}
    </div>`;
    _wire(root);
}

// ---------------------------------------------------------------------------
// Timesheets awaiting approval
// ---------------------------------------------------------------------------

function _flagsFor(row) {
    const flags = [];
    if (row.reconstructed_count > 0) flags.push(`${row.reconstructed_count} reconstructed`);
    if (row.target_seconds != null && row.total_seconds > row.target_seconds)
        flags.push(`over by ${_hm(row.total_seconds - row.target_seconds)}`);
    return flags;
}

function _timesheetSectionHtml() {
    const cleanSelected = [...state.selected].some(key => state.queue.some(row =>
        `${row.person_id}|${row.week_start}` == key));
    return `<div class="tr-card">
        <div class="up t3">Timesheets awaiting approval</div>
        ${state.queue.length ? state.queue.map(row => _timesheetRowHtml(row)).join("") :
            `<div class="tr-empty">Nothing waiting.</div>`}
        ${cleanSelected ? _bulkBarHtml() : ""}
    </div>`;
}

function _timesheetRowHtml(row) {
    const flags = _flagsFor(row);
    const clean = flags.length == 0;
    const key = `${row.person_id}|${row.week_start}`;
    const open = state.openRow == key;
    return `<div class="tr-track-row" data-c7-row="${states.esc(key)}">
        ${clean ? `<input type="checkbox" data-c7="select" data-key="${states.esc(key)}"${state.selected.has(key) ? " checked" : ""}>` :
            `<span style="display:inline-block;width:16px"></span>`}
        <span class="grow"><b>${states.esc(_nameOf(row.person_id))}</b> · ${states.esc(row.week_start)} – ${states.esc(row.week_end)}
            <br><span class="sm t3">${_hm(row.total_seconds)}${flags.length ?
                " · " + flags.map(f => `<span class="chip warn">${states.esc(f)}</span>`).join(" ") :
                ` · <span class="chip">Clean</span>`}</span></span>
        ${clean ? `<button class="btn sm pri" data-c7="approve" data-key="${states.esc(key)}">Approve</button>` :
            `<button class="btn sm" data-c7="open" data-key="${states.esc(key)}">${open ? "Close" : "Open"}</button>`}
    </div>
    ${open ? _returnFormHtml(row) : ""}`;
}

function _returnFormHtml(row) {
    const detail = state.openDetail;
    const byTask = detail?.totals?.by_task || [];
    const days = _weekDates(row.week_start);
    return `<div class="tr-panel" style="margin-top:4px">
        ${byTask.length ? `<div class="up t3">Per-task totals</div>` +
            byTask.map(t => `<div class="sm">${states.esc(t.task_ref || "(no task)")} — ${_hm(t.seconds)}${
                t.reconstructed ? ` · <span class="chip warn">reconstructed</span>` : ""}</div>`).join("") : ""}
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <input class="inp grow" id="c7-return-reason" placeholder="Reason, shown to them">
        </div>
        <div class="row wrap" style="gap:4px;margin-top:6px">
            <label class="sm"><input type="checkbox" id="c7-return-all"> Unlock the whole week</label>
            ${days.map(d => `<label class="sm"><input type="checkbox" data-c7-unlock="${d}"> ${d.slice(5)}</label>`).join("")}
        </div>
        <div class="sm t3" style="margin-top:4px">Only the unlocked dates become editable again — select the whole week, or just the ones that need fixing.</div>
        <button class="btn sm danger" data-c7="do-return" data-person="${states.esc(row.person_id)}"
            data-week="${states.esc(row.week_start)}" style="margin-top:6px">Return</button>
    </div>`;
}

function _bulkBarHtml() {
    const n = state.selected.size;
    if (!n) return "";
    return `<div class="tr-panel" style="margin-top:6px">
        <span class="sm">${n} selected</span>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <button class="btn sm pri" data-c7="bulk-approve">Approve selected</button>
            <input class="inp grow" id="c7-bulk-reason" placeholder="Reason for a bulk return">
            <button class="btn sm danger" data-c7="bulk-return">Return selected with a note</button>
        </div>
        <div class="sm t3" style="margin-top:4px">Approving is a signature — each lands in the audit log with your name and the totals as they stood. A bulk return reopens each selected week whole.</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Not yet submitted
// ---------------------------------------------------------------------------

function _missingSectionHtml() {
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">Not yet submitted</div>
        ${state.missing.length ? `<div class="row wrap"><span class="push"></span>
            <button class="btn sm" data-c7="remind-all">Remind all missing</button></div>
            ${state.missing.map(m => _missingRowHtml(m)).join("")}` :
            `<div class="tr-empty">Everyone's caught up.</div>`}
    </div>`;
}

function _missingRowHtml(missing) {
    const today = _today(), late = missing.week_end < today;
    const daysLate = late ? _daysBetween(missing.week_end, today) : null;
    return `<div class="tr-track-row">
        <span class="grow"><b>${states.esc(_nameOf(missing.person_id))}</b> · ${states.esc(missing.week_start)} – ${states.esc(missing.week_end)}
            <br><span class="sm t3">${late ? `<span class="chip warn">${daysLate} day${daysLate == 1 ? "" : "s"} late</span>` : "not yet due"}</span></span>
        <button class="btn sm" data-c7="nudge" data-person="${states.esc(missing.person_id)}"
            data-week="${states.esc(missing.week_start)}">Nudge</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// Leave requests awaiting approval
// ---------------------------------------------------------------------------

function _leaveSectionHtml() {
    return `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">Leave requests awaiting approval</div>
        ${state.leaveQueue.length ? state.leaveQueue.map(r => _leaveRowHtml(r)).join("") :
            `<div class="tr-empty">Nothing waiting.</div>`}
    </div>`;
}

function _leaveRowHtml(request) {
    const key = request.leave_request_id, open = state.openLeave == key;
    const waitingDays = request.submitted_at ? Math.floor((Date.now()/1000 - request.submitted_at) / 86400) : null;
    return `<div class="tr-track-row">
        <span class="grow"><b>${states.esc(_nameOf(request.person_id))}</b> · ${states.esc(request.leave_type)} ·
            ${states.esc(request.from_date)} – ${states.esc(request.to_date)} (${request.days_deducted}d)
            <br><span class="sm t3">step ${states.esc(request.step)}${
                request.short_notice ? ` · <span class="chip warn">short notice</span>` : ""}${
                request.proof_provided ? ` · <span class="chip">proof provided</span>` : ""}${
                waitingDays != null ? ` · waiting ${waitingDays}d` : ""}</span></span>
        <button class="btn sm pri" data-c7="leave-approve" data-id="${states.esc(key)}"${
            request.short_notice ? ` data-exception="1"` : ""}>${request.short_notice ? "Approve as exception" : "Approve"}</button>
        <button class="btn sm" data-c7="leave-open" data-id="${states.esc(key)}">${open ? "Close" : "Decline"}</button>
    </div>
    ${open ? _leaveDeclineFormHtml(key) : ""}`;
}

function _leaveDeclineFormHtml(leaveRequestId) {
    return `<div class="tr-panel" style="margin-top:4px">
        <div class="row wrap" style="gap:6px">
            <input class="inp grow" id="c7-decline-reason" placeholder="Reason, required">
            <button class="btn sm danger" data-c7="do-decline" data-id="${states.esc(leaveRequestId)}">Decline</button>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------

function _wire(root) {
    for (const box of root.querySelectorAll("[data-c7=\"select\"]")) box.addEventListener("change", _ => {
        const key = box.getAttribute("data-key");
        if (box.checked) state.selected.add(key); else state.selected.delete(key);
        _render(root);
    });

    for (const button of root.querySelectorAll("[data-c7=\"approve\"]")) button.addEventListener("click", async _ => {
        const [subject_person_id, week_start] = button.getAttribute("data-key").split("|");
        const result = await _rest("approve", {subject_person_id, week_start});
        if (result) {states.toast({message: "Approved."}); state.selected.delete(button.getAttribute("data-key"));
            await _reloadTimesheets(root);}
    });

    for (const button of root.querySelectorAll("[data-c7=\"open\"]")) button.addEventListener("click", async _ => {
        const key = button.getAttribute("data-key");
        if (state.openRow == key) {state.openRow = null; state.openDetail = null; _render(root); return;}
        const [subject_person_id, week_start] = key.split("|");
        const detail = await _rest("read_other", {subject_person_id, week_start});
        if (!detail) return;
        state.openRow = key; state.openDetail = detail; _render(root);
    });

    root.querySelector("[data-c7=\"do-return\"]")?.addEventListener("click", async _ => {
        const button = root.querySelector("[data-c7=\"do-return\"]");
        const subject_person_id = button.getAttribute("data-person"), week_start = button.getAttribute("data-week");
        const reason = root.querySelector("#c7-return-reason").value.trim();
        if (!reason) {states.toast({message: "A reason is required."}); return;}
        const whole = root.querySelector("#c7-return-all")?.checked;
        const picked = [...root.querySelectorAll("[data-c7-unlock]:checked")].map(box => box.getAttribute("data-c7-unlock"));
        const unlock_dates = whole ? _weekDates(week_start) : picked;
        if (!unlock_dates.length) {states.toast({message: "Select at least one date to unlock, or the whole week."}); return;}
        const result = await _rest("return", {subject_person_id, week_start, reason, unlock_dates});
        if (result) {states.toast({message: "Returned."}); await _reloadTimesheets(root);}
    });

    root.querySelector("[data-c7=\"bulk-approve\"]")?.addEventListener("click", async _ => {
        const items = [...state.selected].map(key => {
            const [subject_person_id, week_start] = key.split("|"); return {subject_person_id, week_start};});
        const confirmed = await states.confirmAction({title: `Approve ${items.length} timesheet(s)?`,
            body: "Each approval is its own signature in the audit log with the totals as they stood.",
            confirmLabel: "Approve"});
        if (!confirmed) return;
        const result = await _rest("approve_many", {items});
        if (!result) return;
        states.toast({message: `Approved ${result.succeeded.length}.${result.failed.length ? ` ${result.failed.length} failed.` : ""}`});
        state.selected.clear(); await _reloadTimesheets(root);
    });

    root.querySelector("[data-c7=\"bulk-return\"]")?.addEventListener("click", async _ => {
        const reason = root.querySelector("#c7-bulk-reason").value.trim();
        if (!reason) {states.toast({message: "A reason is required."}); return;}
        const items = [...state.selected].map(key => {
            const [subject_person_id, week_start] = key.split("|"); return {subject_person_id, week_start};});
        const result = await _rest("return_many", {items, reason});
        if (!result) return;
        states.toast({message: `Returned ${result.succeeded.length}.${result.failed.length ? ` ${result.failed.length} failed.` : ""}`});
        state.selected.clear(); await _reloadTimesheets(root);
    });

    root.querySelector("[data-c7=\"remind-all\"]")?.addEventListener("click", async _ => {
        for (const missing of state.missing) await _call(API_NOTIF, "notify", {category: "timesheet_reminder",
            recipient_person_id: missing.person_id, payload: {week_start: missing.week_start}, object_ref: missing.week_start});
        states.toast({message: "Recorded."});
    });
    for (const button of root.querySelectorAll("[data-c7=\"nudge\"]")) button.addEventListener("click", async _ => {
        const result = await _call(API_NOTIF, "notify", {category: "timesheet_reminder",
            recipient_person_id: button.getAttribute("data-person"),
            payload: {week_start: button.getAttribute("data-week")}, object_ref: button.getAttribute("data-week")});
        if (result) states.toast({message: "Recorded."});
    });

    for (const button of root.querySelectorAll("[data-c7=\"leave-approve\"]")) button.addEventListener("click", async _ => {
        const result = await _call(API_LEAVE, "approve", {leave_request_id: button.getAttribute("data-id"),
            approve_as_exception: button.getAttribute("data-exception") == "1"});
        if (result) {states.toast({message: "Approved."}); await _reloadLeave(root);}
    });
    for (const button of root.querySelectorAll("[data-c7=\"leave-open\"]")) button.addEventListener("click", _ => {
        state.openLeave = state.openLeave == button.getAttribute("data-id") ? null : button.getAttribute("data-id");
        _render(root);
    });
    root.querySelector("[data-c7=\"do-decline\"]")?.addEventListener("click", async _ => {
        const button = root.querySelector("[data-c7=\"do-decline\"]");
        const reason = root.querySelector("#c7-decline-reason").value.trim();
        if (!reason) {states.toast({message: "A reason is required."}); return;}
        const result = await _call(API_LEAVE, "decline", {leave_request_id: button.getAttribute("data-id"), reason});
        if (result) {states.toast({message: "Declined."}); await _reloadLeave(root);}
    });
}

const _rest = (op, extra = {}) => _call(API_TIME, op, extra);

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
