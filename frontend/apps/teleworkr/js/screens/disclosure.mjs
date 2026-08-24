/**
 * H5 — what your manager sees. A live mirror of your own record, rendered from
 * the same permission checks and reads the rest of the product uses, so the
 * sees/does-not-see lists can never drift from what the API actually returns.
 *
 * The perspective switcher offers only people the engine can actually name —
 * your manager on record, whoever currently holds the HR bundle, whoever
 * currently holds the admin bundle (op "viewers") — never a role with nobody
 * in it. Retention, the access log and the export are about the caller's own
 * record regardless of which perspective is selected, so switching perspective
 * only ever re-fetches the mirror.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "disclosure";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

const VIEW_LABELS = {weekly_totals: "Weekly total, per-task totals and the billable split",
    task_status_and_due_dates: "Task status and due dates", leave_dates: "Leave dates"};
const ROLE_LABELS = {self: "Your full record", manager: name => `As ${name} sees it`,
    hr: "As HR sees it", admin: "As admin sees it"};
const DOW = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ANCHOR_LABELS = {occurred_at: "from when it happened", employment_ended: "from when employment ends",
    requisition_closed: "from when the role closes", period_closed: "from when the period closes",
    signal_evaluated: "from when it was evaluated"};
const ACTION_LABELS = {"timesheet.approved": "weekly approvals", "time_entry.edited": "corrections",
    "leave.approved": "leave approvals", "leave.declined": "leave declines"};

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, viewers: [], viewerId: null, mirror: null, accessLog: null, retention: null};
    root.innerHTML = `<div class="page ds">${states.loading({rows: 6})}</div>`;

    const [viewersResp, accessLogResp, retentionResp] = await Promise.all([
        _rest("viewers", {}), _rest("access_log", {days: 90}), _rest("retention", {})]);
    if (!viewersResp || !accessLogResp || !retentionResp) return;

    state.viewers = viewersResp.viewers;
    state.viewerId = state.viewers[0]?.person_id;
    state.accessLog = accessLogResp;
    state.retention = retentionResp.entities;

    await _loadMirror();
}

async function _loadMirror() {
    const mirror = await _rest("mirror", {viewer_person_id: state.viewerId});
    if (!mirror) return;
    state.mirror = mirror;
    _view();
}

function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page ds">
        <div class="ds-head">
            <div><div class="up t3">Your record</div>
                <div class="sm t2" style="margin-top:2px">Exactly what each role can see about you, rendered live from your real data.</div></div>
            <div class="ds-switcher" id="ds-switcher">${state.viewers.map(viewer => {
                const label = typeof ROLE_LABELS[viewer.role] == "function" ?
                    ROLE_LABELS[viewer.role](viewer.display_name) : (ROLE_LABELS[viewer.role] || viewer.display_name);
                return `<button class="ds-persp${viewer.person_id == state.viewerId ? " on" : ""}"
                    data-viewer="${states.esc(viewer.person_id)}" title="${states.esc(viewer.display_name)}">${states.esc(label)}</button>`;
            }).join("")}</div>
        </div>

        <div class="ds-grid">
            <div class="ds-card ds-sees">
                <div class="up t3">What this view shows</div>
                ${_seesRowsHTML()}
            </div>
            <div class="col" style="gap:12px">
                <div class="ds-card">
                    <div class="up t3">Never shown, on any view</div>
                    <div class="ds-chips">${state.mirror.does_not_see.map(item =>
                        `<span class="ds-chip" title="${states.esc(item.why)}">${states.esc(item.item)}</span>`).join("")}</div>
                    <div class="sm t3 mt2">This list is generated from the same permission rules the API enforces —
                        it cannot drift from reality.</div>
                </div>
                <div class="ds-card">
                    <div class="up t3">Your data</div>
                    <div class="row" style="gap:8px;margin-top:2px">
                        <button class="btn sm pri" data-ds="export">Download everything</button>
                    </div>
                    <div class="sm t2 mt2">${_accessLogSummary()}</div>
                </div>
                <div class="ds-card">
                    <div class="up t3">Retention, in concrete numbers</div>
                    <div class="ds-retention">${state.retention
                        .filter(entity => entity.keep)
                        .map(entity => `<div class="ds-ret-row">
                            <span class="grow">${states.esc(_pretty(entity.entity))}</span>
                            <span class="mono xs t2">${states.esc(entity.keep)}${
                                entity.anchor ? ` · ${states.esc(ANCHOR_LABELS[entity.anchor] || entity.anchor)}` : ""}</span>
                        </div>`).join("")}</div>
                </div>
            </div>
        </div>

        <div class="ds-note">If something here is surprising, the product has a problem — better to find that out here.</div>
    </div>`;

    for (const button of root.querySelectorAll("[data-viewer]"))
        button.addEventListener("click", async _ => {
            state.viewerId = button.getAttribute("data-viewer");
            root.querySelector(".ds-sees").innerHTML = `<div class="up t3">What this view shows</div>${states.loading({rows: 4})}`;
            await _loadMirror();
        });
    root.querySelector('[data-ds="export"]').addEventListener("click", _exportData);
}

function _seesRowsHTML() {
    const sees = state.mirror.sees;
    const rows = [];

    if (sees.weekly_totals) {
        const totals = sees.weekly_totals;
        const nonBillable = Math.max(0, totals.total_seconds - totals.billable_seconds);
        rows.push(["Weekly total", _hm(totals.total_seconds)]);
        rows.push(["Per-task totals", `${totals.by_task.length} task${totals.by_task.length == 1 ? "" : "s"}`]);
        rows.push(["Billable split", totals.total_seconds ?
            `${_hm(totals.billable_seconds)} billable / ${_hm(nonBillable)} other` : "No time logged yet"]);
        rows.push(["Entries you reconstructed", totals.reconstructed_count ?
            `${totals.reconstructed_count} flagged` : "None"]);
    } else rows.push(["Weekly total, per-task totals & billable split", _notVisible("weekly_totals")]);

    if (sees.task_status_and_due_dates) {
        const list = sees.task_status_and_due_dates;
        rows.push(["Task status and due dates", list.length ? `${list.length} task${list.length == 1 ? "" : "s"}` : "No tasks yet"]);
    } else rows.push(["Task status and due dates", _notVisible("task_status_and_due_dates")]);

    if (sees.leave_dates) rows.push(["Your leave dates",
        sees.leave_dates.length ? sees.leave_dates.join(", ") : "None yet"]);
    else rows.push(["Your leave dates", _notVisible("leave_dates")]);

    if (sees.working_window) {
        const window = sees.working_window;
        rows.push(["Your declared working window",
            `${window.days.map(d => DOW[d]).join(", ")} · ${_hhmm(window.start_minute)}–${_hhmm(window.end_minute)} ${window.timezone}`]);
    } else rows.push(["Your declared working window", "Not visible to this viewer"]);

    return rows.map(([label, value]) => `<div class="ds-row">
        <span class="grow">${states.esc(label)}</span><span class="t2 sm">${states.esc(value)}</span></div>`).join("");
}

const _notVisible = key => {
    const entry = state.mirror.does_not_see.find(item => item.item == VIEW_LABELS[key]);
    return entry ? `Not visible to this viewer — ${entry.why}` : "Not visible to this viewer";
};

function _accessLogSummary() {
    const log = state.accessLog;
    const total = log.accesses.reduce((sum, entry) => sum + entry.count, 0) + log.self_count;
    if (!total) return `Nobody has accessed your record in the last ${log.days} days.`;
    const parts = log.accesses.map(entry =>
        `${states.esc(entry.display_name || entry.actor_kind)} (${states.esc(ACTION_LABELS[entry.action] || entry.action.replace(".", " "))} ×${entry.count})`);
    if (log.self_count) parts.push(`you (×${log.self_count})`);
    return `${total} access${total == 1 ? "" : "es"} in the last ${log.days} days: ${parts.join(", ")}.`;
}

async function _exportData() {
    const bundle = await _rest("export", {});
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {type: "application/json"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `teleworkr-my-data-${new Date().toISOString().substring(0, 10)}.json`;
    link.click(); URL.revokeObjectURL(link.href);
    states.toast({message: "Your record was exported — it leaves with you, which is the point."});
}

const _pretty = key => {const s = key.replace(/_/g, " "); return s.charAt(0).toUpperCase() + s.slice(1);};
const _hhmm = minute => `${String(Math.floor(minute/60)).padStart(2, "0")}:${String(minute%60).padStart(2, "0")}`;
const _hm = totalSeconds => `${Math.floor(totalSeconds/3600)}h ${String(Math.floor((totalSeconds%3600)/60)).padStart(2, "0")}m`;

async function _rest(op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET", {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Disclosure op ${op} failed: ${err}`);}
    if (!response?.result) {states.toast({message: response?.reason || "The disclosure service did not respond.", ms: 8000}); return null;}
    return response;
}
