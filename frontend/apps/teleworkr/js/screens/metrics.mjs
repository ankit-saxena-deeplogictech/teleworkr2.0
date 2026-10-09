/**
 * A10 — metrics. The smallest screen in the set, and the one that decides
 * whether the build can ever tell if it worked: I3's eight numbers, seven of
 * them built. The eighth — weekly active use of the overlap board — needs
 * screen.viewed, which A10's own "Open" note leaves as an unresolved
 * disclosure question; it's named here, not quietly dropped.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "metrics";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _isoDaysAgo = (isoDate, days) => {
    const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().substring(0, 10);
}
const _today = _ => new Date().toISOString().substring(0, 10);
const _pct = rate => rate == null ? "—" : `${Math.round(rate*1000)/10}%`;
const _secs = seconds => seconds == null ? "—" :
    seconds < 3600 ? `${Math.round(seconds/60)}m` : `${Math.round(seconds/3600*10)/10}h`;

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, fromDate: _isoDaysAgo(_today(), 29), toDate: _today(), summary: null, retentionPreview: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tr">
        <div class="row wrap" style="gap:6px">
            <input class="inp" id="mt-from" type="date" value="${states.esc(state.fromDate)}">
            <span class="sm t3">to</span>
            <input class="inp" id="mt-to" type="date" value="${states.esc(state.toDate)}">
            <button class="btn" data-mt="rollup">Retention rollup…</button>
        </div>
        <div id="mt-view"></div>
    </div>`;
    root.querySelector("#mt-from").addEventListener("change", async event => {state.fromDate = event.target.value; await _load();});
    root.querySelector("#mt-to").addEventListener("change", async event => {state.toDate = event.target.value; await _load();});
    root.querySelector("[data-mt=\"rollup\"]").addEventListener("click", _ => _rollup());
    await _load();
}

async function _load() {
    const view = state.root.querySelector("#mt-view");
    view.innerHTML = `<div class="tr-band">${states.loading({rows: 4})}</div>`;
    try {
        const result = await _rest("summary", {from_date: state.fromDate, to_date: state.toDate});
        if (!result) return;
        state.summary = result;
        _renderSummary(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load metrics", what: err.message,
            safe: "Nothing was changed.", reference: `A10-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _load()});
    }
}

function _renderSummary(view) {
    const s = state.summary;
    const card = (title, body) => `<div class="tr-panel"><div class="up t3">${states.esc(title)}</div>${body}</div>`;

    view.innerHTML = `<div class="tr-panels">
        ${card("Time to first clock-in", s.time_to_first_clockin.sample_size ?
            `<div class="sm">Median ${_secs(s.time_to_first_clockin.median_seconds)} · ${s.time_to_first_clockin.sample_size} activation(s)</div>` :
            `<div class="tr-empty">No activations in range.</div>`)}

        ${card("Timer vs. reconstructed", s.timer_vs_reconstructed.total ?
            Object.entries(s.timer_vs_reconstructed.by_source).map(([source, count]) =>
                `<div class="sm">${states.esc(source)} — ${count} (${_pct(count/s.timer_vs_reconstructed.total)})</div>`).join("") :
            `<div class="tr-empty">No time entries in range.</div>`)}

        ${card("Timesheet edits after submission", s.post_submit_edit_rate.sample_size ?
            `<div class="sm">${_pct(s.post_submit_edit_rate.rate)} of ${s.post_submit_edit_rate.sample_size} edit(s)</div>` :
            `<div class="tr-empty">No edits in range.</div>`)}

        ${card("Median approval latency", s.median_approval_latency_seconds.sample_size ?
            `<div class="sm">${_secs(s.median_approval_latency_seconds.median_seconds)} · ${s.median_approval_latency_seconds.sample_size} decision(s)</div>` :
            `<div class="tr-empty">No decisions in range.</div>`)}

        ${card("Median blocked duration", s.median_blocked_duration_seconds.sample_size ?
            `<div class="sm">${_secs(s.median_blocked_duration_seconds.median_seconds)} · ${s.median_blocked_duration_seconds.sample_size} unblock(s)</div>` :
            `<div class="tr-empty">No unblocks in range.</div>`)}

        ${card("Wellbeing mute rate", s.wellbeing_mute_rate.shown ?
            `<div class="sm">${_pct(s.wellbeing_mute_rate.rate)} of ${s.wellbeing_mute_rate.shown} shown</div>` :
            `<div class="tr-empty">No signals shown in range.</div>`)}

        ${card("Pages inside their review window", s.pages_in_review_window.total_published ?
            `<div class="sm">${_pct(s.pages_in_review_window.rate)} — ${s.pages_in_review_window.in_window} of ${s.pages_in_review_window.total_published} published page(s)</div>` :
            `<div class="tr-empty">No published pages.</div>`)}

        ${card("Weekly active use of the overlap board", `<div class="tr-empty">${states.esc(s.weekly_overlap_board_use.note)}</div>`)}
    </div>
    <div id="mt-rollup" class="sm t3" style="margin-top:10px"></div>`;
}

async function _rollup() {
    const result = await _rest("preview_retention_run", {});
    if (!result) return;
    state.retentionPreview = result;
    const box = state.root.querySelector("#mt-rollup");
    box.innerHTML = `${result.rows_to_aggregate} raw row(s) older than ${states.esc(result.cutoff_date)} would be rolled up and dropped.
        ${result.rows_to_aggregate ? `<button class="btn" data-mt="execute">Run it</button>` : ""}`;
    box.querySelector("[data-mt=\"execute\"]")?.addEventListener("click", async _ => {
        const executed = await _rest("execute_retention_run", {});
        if (!executed) return;
        box.innerHTML = `Rolled up ${executed.rows_aggregated} row(s).`;
    });
}

// ---------------------------------------------------------------------------

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
