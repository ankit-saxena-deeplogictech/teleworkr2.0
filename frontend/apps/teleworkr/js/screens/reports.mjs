/**
 * H2 — Reports. Three aggregate, never-per-person reports built from the
 * same team the workload board reads: blocked time, estimate accuracy, and
 * utilisation. No meeting-cost report (no meeting/calendar-event system
 * exists) and no working-time compliance report (no guardrails exist — the
 * same C6 absence this app has documented since early this session) — H2
 * carries three reports, not five. No "Schedule monthly" either (no email/
 * scheduling infrastructure exists anywhere in this app).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "workload";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);
const _addDays = (iso, days) => {
    const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().substring(0, 10);
};
const _hm = seconds => `${Math.floor(seconds/3600)}h ${String(Math.floor((seconds%3600)/60)).padStart(2, "0")}m`;

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, from: _addDays(_today(), -30), to: _today()};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const reports = await _rest("reports", {from_date: state.from, to_date: state.to});
    if (!reports) return;
    state.reports = reports;
    _render(root);
}

function _render(root) {
    const r = state.reports;
    root.innerHTML = `<div class="page tr">
        <div class="row wrap" style="gap:8px;align-items:center">
            <span class="up t3">Reports · aggregates only</span>
            <span class="push"></span>
            <input class="inp" type="date" id="rp-from" value="${state.from}" style="width:150px">
            <span class="sm t3">to</span>
            <input class="inp" type="date" id="rp-to" value="${state.to}" style="width:150px">
            <button class="btn sm" data-rp="export">Export CSV</button>
        </div>
        <p class="sm t3" style="margin-top:6px">Nothing here is ranked by person. A leaderboard of hours is the
            fastest way to make this product hated.</p>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Blocked time</div>
            <p class="sm" style="margin-top:6px">${r.blocked.percent === null ? "No open work in this range." :
                `${r.blocked.percent}% of the team's currently open work is blocked (${_hm(r.blocked.blocked_seconds)}
                    of ${_hm(r.blocked.open_seconds)}).`}</p>
            <p class="sm t3" style="margin-top:4px">A current snapshot, not a historical total — this app doesn't
                track how long a block lasted once resolved.</p>
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Estimate accuracy</div>
            <p class="sm" style="margin-top:6px">${r.estimate_accuracy.ratio === null ?
                "No tasks with both an estimate and logged time yet." :
                `The team ships at ${r.estimate_accuracy.ratio.toFixed(1)}× estimate on average, across
                    ${r.estimate_accuracy.tasks_counted} task${r.estimate_accuracy.tasks_counted==1?"":"s"}.`}</p>
            <p class="sm t3" style="margin-top:4px">A team-level planning input, never per person — individual
                ratios are visible to the individual only.</p>
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Utilisation</div>
            <p class="sm" style="margin-top:6px">Billable ${_hm(r.utilisation.billable_seconds)} ·
                non-billable ${_hm(r.utilisation.total_seconds - r.utilisation.billable_seconds)} ·
                unaccounted ${_hm(r.utilisation.unaccounted_seconds)}.</p>
            <p class="sm t3" style="margin-top:4px">Unaccounted is reported honestly. A tool that shows 100%
                accounted time is a tool people have learned to feed.</p>
        </div>
    </div>`;

    root.querySelector("#rp-from").addEventListener("change", event => {state.from = event.target.value; _view();});
    root.querySelector("#rp-to").addEventListener("change", event => {state.to = event.target.value; _view();});
    root.querySelector('[data-rp="export"]').addEventListener("click", _ => _exportCsv(r));
}

/** No server-side export pipeline exists — a client-side download, same precedent as H4's audit log. */
function _exportCsv(r) {
    const rows = [
        ["report", "metric", "value"],
        ["blocked_time", "percent", r.blocked.percent ?? ""],
        ["blocked_time", "blocked_seconds", r.blocked.blocked_seconds],
        ["blocked_time", "open_seconds", r.blocked.open_seconds],
        ["estimate_accuracy", "ratio", r.estimate_accuracy.ratio ?? ""],
        ["estimate_accuracy", "tasks_counted", r.estimate_accuracy.tasks_counted],
        ["utilisation", "billable_seconds", r.utilisation.billable_seconds],
        ["utilisation", "total_seconds", r.utilisation.total_seconds],
        ["utilisation", "unaccounted_seconds", r.utilisation.unaccounted_seconds]];
    const csv = rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], {type: "text/csv"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = `teleworkr-reports-${state.from}-to-${state.to}.csv`; link.click();
    URL.revokeObjectURL(link.href);
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
