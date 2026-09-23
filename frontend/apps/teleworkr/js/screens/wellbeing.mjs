/**
 * M — wellbeing & load. My load (M2, everyone with wellbeing.read_own —
 * every built-in role) is the default tab; team load (M3) and signal
 * definitions (M1) only appear when the viewer also holds
 * wellbeing.read_aggregate / wellbeing.publish_signal — same per-capability
 * internal tabbing `recruitment.mjs` already established, not a role fork.
 *
 * The engine, not this screen, decides what's lit and what the escalation
 * step is (`myLoadAsync`'s `ladder_step`) — this file only renders it.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "wellbeing", API_CALENDAR = "calendar";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    const caps = (await import("../shell.mjs")).shell.projection?.capabilities || [];
    state = {root, tab: "my", canReadAggregate: caps.includes("wellbeing.read_aggregate"),
        canPublish: caps.includes("wellbeing.publish_signal"), shareOpen: false, roster: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">
            <button class="tr-tab${state.tab == "my" ? " on" : ""}" data-wc="tab" data-tab="my">My load</button>
            ${state.canReadAggregate ? `<button class="tr-tab${state.tab == "team" ? " on" : ""}" data-wc="tab" data-tab="team">Team load</button>` : ""}
            ${state.canPublish ? `<button class="tr-tab${state.tab == "signals" ? " on" : ""}" data-wc="tab" data-tab="signals">Signal definitions</button>` : ""}
        </div>
        <div class="tr-view" id="wc-view"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-wc=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#wc-view");
    try {
        if (state.tab == "team" && state.canReadAggregate) return await _team(view);
        if (state.tab == "signals" && state.canPublish) return await _signals(view);
        return await _myLoad(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load wellbeing", what: err.message,
            safe: "Nothing you have recorded is affected.", reference: `M-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// M2 — my load, private by default
// ---------------------------------------------------------------------------

async function _myLoad(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const load = await _rest("my_load");
    if (!load) return;
    _renderMyLoad(root, load);
}

function _renderMyLoad(root, load) {
    if (!load.enough_history) {
        root.innerHTML = `<div class="tr-empty">Not enough history yet — this needs at least 4 weeks of employment before it shows anything.</div>`;
        return;
    }
    const maxHours = Math.max(1, ...load.weeks.map(w => w.hours));
    root.innerHTML = `
        <div class="row wrap">
            <div><div class="up t3">Your last four weeks</div><span class="sm t3">Only you can see this page.</span></div>
            <div class="push row wrap" style="gap:6px">
                <button class="btn" data-wc="share">${state.shareOpen ? "Close" : "Share a summary…"}</button>
                <button class="btn" data-wc="mute-all">Mute for 2 weeks</button>
            </div>
        </div>
        ${state.shareOpen ? _shareComposerHtml() : ""}

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Signals lit</div>
            ${load.signals.length ? load.signals.map(signal => `
                <div class="tr-track-row">
                    <span style="width:10px;height:10px;border-radius:50%;flex:none;background:${
                        signal.ladder_step == "offer" ? "var(--ember)" : "var(--dawn)"}"></span>
                    <span class="grow"><b>${states.esc(signal.label)}</b><br>
                        <span class="sm t3">${states.esc(_signalSentence(signal))}</span></span>
                    ${signal.action ? `<button class="btn" data-wc="action" data-screen="${
                        states.esc(signal.action.screen)}" style="padding:3px 7px">${states.esc(signal.action.label)}</button>` : ""}
                    <button class="btn" data-wc="mute-one" data-signal="${states.esc(signal.signal_code)}" style="padding:3px 7px">Mute</button>
                </div>
                ${signal.ladder_step == "offer" ? `<div class="sm t3" style="padding:0 0 6px 20px">Lit for ${
                    signal.days_lit} days. <span data-wc="hr-link" style="cursor:pointer;text-decoration:underline">Talk to HR</span></div>` : ""}`
                ).join("") : `<div class="tr-empty">No signals lit right now.</div>`}
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Hours, four weeks</div>
            <div class="row" style="gap:0;height:42px;align-items:flex-end">
                ${load.weeks.map(w => `<div class="tr-bar" style="flex:1;margin-right:4px;height:${
                    Math.max(4, Math.round((w.hours/maxHours)*100))}%"><span style="width:100%;height:100%"></span></div>`).join("")}
            </div>
            <div class="row" style="gap:0">${load.weeks.map(w => `<span class="sm t3" style="flex:1">${
                states.esc(w.week_start)} · ${w.hours}h</span>`).join("")}</div>
            <div class="sm t3" style="margin-top:6px">Compared with your own history, never your team. There is no ranking on this page.</div>
        </div>

        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Where the time went</div>
            <div class="tr-track-row"><span class="grow">Outside your working window</span><span class="sm t3">${_hm(load.out_of_window_seconds)}</span></div>
            <div class="tr-track-row"><span class="grow">Blocked, waiting on others</span><span class="sm t3">${_hm(load.blocked.blocked_seconds)}${
                load.blocked.ratio != null ? ` · ${Math.round(load.blocked.ratio*100)}% of your open work` : ""}</span></div>
        </div>

        ${load.shares_received.length ? `<div class="tr-card" style="margin-top:10px">
            <div class="up t3">Shared with you</div>
            ${load.shares_received.map(share => `<div class="tr-track-row">
                <span class="grow"><b>${states.esc(share.sharer_name)}</b> shared ${states.esc(share.period_from)} – ${states.esc(share.period_to)}<br>
                    <span class="sm t3">${share.summary.total_hours}h total · ${_hm(share.summary.blocked_seconds)} blocked</span></span>
            </div>`).join("")}
            <div class="sm t3" style="margin-top:6px">They shared this so you'd have the context. A conversation is the response — not a note in their file.</div>
        </div>` : ""}`;

    root.querySelector("[data-wc=\"share\"]").addEventListener("click", async _ => {
        if (!state.roster) state.roster = (await _call(API_CALENDAR, "roster", {date: _today()}))?.roster || [];
        state.shareOpen = !state.shareOpen; _renderMyLoad(root, load);
    });
    root.querySelector("[data-wc=\"mute-all\"]").addEventListener("click", _ => _doMute(root, load, null));
    for (const button of root.querySelectorAll("[data-wc=\"mute-one\"]"))
        button.addEventListener("click", _ => _doMute(root, load, button.getAttribute("data-signal")));
    for (const button of root.querySelectorAll("[data-wc=\"action\"]"))
        button.addEventListener("click", async _ => (await import("../shell.mjs")).shell.setSurface(button.getAttribute("data-screen")));
    for (const link of root.querySelectorAll("[data-wc=\"hr-link\"]")) link.addEventListener("click", async _ => {
        const result = await _rest("hr_contacts");
        states.toast({message: result?.contacts?.length ?
            `HR: ${result.contacts.map(c => c.name).join(", ")}` : "No HR contact is currently assigned."});
    });
    if (state.shareOpen) _wireShareComposer(root, load);
}

async function _doMute(root, load, signal_code) {
    const muted_until = _isoAddDays(_today(), 14);
    const result = await _rest("mute", {signal_code, muted_until});
    if (result) {states.toast({message: `Muted until ${muted_until}.`}); await _myLoad(root);}
}

function _signalSentence(signal) {
    const i = signal.inputs;
    switch (signal.signal_code) {
        case "sustained_load": return `${i.avg_weekly_hours}h/week average, against ${i.contracted_hours_per_week}h contracted.`;
        case "no_recovery": return `${i.streak_days} consecutive days with logged time.`;
        case "out_of_window": return `${i.out_of_window_days} of the last ${i.window_days} days had time logged outside your window.`;
        case "leave_not_taken": return `${i.available} of ${i.annual_days} day(s) still available — ${i.unused_percent}% unused.`;
        case "blocked_drag": return `${i.percent}% of your open work is currently blocked.`;
        default: return "";
    }
}

const _shareComposerHtml = _ => `<div class="tr-card" style="margin-top:10px">
    <div class="up t3">Share a summary</div>
    <div class="row wrap" style="gap:6px;margin-top:6px">
        <select class="inp" id="wc-share-recipient">
            ${(state.roster || []).map(p => `<option value="${states.esc(p.person_id)}">${states.esc(p.display_name)}</option>`).join("")}
        </select>
        <span class="sm t3">Last 14 days · expires in 14 days · revocable</span>
        <button class="btn pri push" data-wc="do-share">Share</button>
    </div>
    <div class="sm t3" style="margin-top:6px">Hours, meeting load and blocked time only — no signal names, no thresholds, no history.</div>
</div>`;

function _wireShareComposer(root, load) {
    root.querySelector("[data-wc=\"do-share\"]")?.addEventListener("click", async _ => {
        const recipient = root.querySelector("#wc-share-recipient")?.value;
        if (!recipient) return;
        const period_to = _today(), period_from = _isoAddDays(period_to, -14);
        const result = await _rest("share_summary", {recipient_person_id: recipient, period_from, period_to, expires_in_days: 14});
        if (result) {states.toast({message: "Shared."}); state.shareOpen = false; await _myLoad(root);}
    });
}

// ---------------------------------------------------------------------------
// M3 — team load: aggregate only, by construction
// ---------------------------------------------------------------------------

async function _team(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    let response;
    try {response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET", {op: "team_load", ..._me()}, true);}
    catch (err) {response = null; LOG.error(`wellbeing team_load failed: ${err}`);}
    if (!response?.result) {
        root.innerHTML = `<div class="tr-card"><div class="up t3" style="color:var(--ember)">Cohort too small</div>
            <div class="sm t3" style="margin-top:6px">${states.esc(response?.reason ||
                "Team load could not be read.")}</div></div>`;
        return;
    }
    _renderTeam(root, response);
}

function _renderTeam(root, result) {
    const maxCount = Math.max(1, ...result.bins.map(b => b.count));
    root.innerHTML = `
        <div class="row wrap"><div class="up t3">Your cohort · ${result.cohort_size} people · last 4 weeks</div></div>
        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Distribution, not a list</div>
            <div class="row" style="gap:0;height:46px;align-items:flex-end">
                ${result.bins.map(b => `<div class="tr-bar" style="flex:1;margin-right:6px;height:${
                    Math.max(4, Math.round((b.count/maxCount)*100))}%"><span style="width:100%;height:100%"></span></div>`).join("")}
            </div>
            <div class="row" style="gap:0">${result.bins.map(b => `<span class="sm t3" style="flex:1">${
                b.min == null ? `<${b.max}h` : b.max == null ? `${b.min}h+` : `${b.min}–${b.max}h`}</span>`).join("")}</div>
            <div class="sm t3" style="margin-top:6px">No names anywhere on this screen, and no interaction that reveals who is in which band.</div>
        </div>
        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Causes you control</div>
            ${result.causes.leave ? `<div class="tr-track-row"><span class="grow">Leave utilisation</span>
                <span class="sm t3">${result.causes.leave.under_a_third_used} of ${result.causes.leave.evaluable} have used under a third of entitlement, ${
                    Math.round(result.causes.leave.day_of_year/365*100)}% of the year gone</span></div>` : ""}
            ${result.causes.blocked ? `<div class="tr-track-row"><span class="grow">Blocked time</span>
                <span class="sm t3">${result.causes.blocked.percent}% of the team's open work is currently blocked</span></div>` : ""}
            ${!result.causes.leave && !result.causes.blocked ? `<div class="tr-empty">Nothing to report this window.</div>` : ""}
            <div class="sm t3" style="margin-top:6px">No comparison between teams, ever.</div>
        </div>`;
}

// ---------------------------------------------------------------------------
// M1 — signal definitions: HR's catalogue, publish, the never-measured list
// ---------------------------------------------------------------------------

async function _signals(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const result = await _rest("signal_definitions");
    if (!result) return;
    _renderSignals(root, result);
}

function _renderSignals(root, result) {
    root.innerHTML = `
        <div class="tr-card">
            <div class="up t3">Signal definitions</div>
            ${result.signals.map(s => `<div class="tr-track-row">
                <span class="grow"><b>${states.esc(s.label)}</b><br>
                    <span class="sm t3">${states.esc(JSON.stringify(s.threshold))} · offer step after ${
                        s.ladder.offer_after_days} day(s) lit</span></span>
                <span class="sm t3">${s.version ? `v${s.version}` : "unpublished, using default"}</span>
                <button class="btn" data-wc="edit-signal" data-signal="${states.esc(s.signal_code)}" style="padding:3px 7px">Publish new version</button>
            </div>`).join("")}
        </div>
        <div class="tr-card" style="margin-top:10px;border-color:var(--ember)">
            <div class="up t3" style="color:var(--ember)">Never measured, never inferred</div>
            <div class="sm t3" style="margin-top:6px">${result.never_measured.map(x => states.esc(x)).join(" · ")}</div>
        </div>
        <div class="tr-card" style="margin-top:10px">
            <div class="up t3">Run tonight's evaluation</div>
            <div class="row wrap" style="gap:6px;margin-top:6px">
                <button class="btn" data-wc="preview-run">Preview</button>
                <button class="btn pri" data-wc="execute-run">Run now</button>
            </div>
            <div class="sm t3" id="wc-run-result" style="margin-top:6px"></div>
        </div>
        <div id="wc-signal-editor"></div>`;

    root.querySelector("[data-wc=\"preview-run\"]").addEventListener("click", async _ => {
        const preview = await _rest("preview_evaluation");
        if (preview) root.querySelector("#wc-run-result").textContent =
            `Preview: ${preview.people} people, ${preview.lit_count} signal(s) lit, ${preview.new_lit_count} newly lit.`;
    });
    root.querySelector("[data-wc=\"execute-run\"]").addEventListener("click", async _ => {
        const executed = await _rest("evaluate");
        if (executed) {
            states.toast({message: `Evaluated ${executed.people} people.`});
            root.querySelector("#wc-run-result").textContent =
                `Ran: ${executed.people} people, ${executed.lit_count} lit, ${executed.new_lit_count} newly lit.`;
        }
    });
    for (const button of root.querySelectorAll("[data-wc=\"edit-signal\"]"))
        button.addEventListener("click", _ => _openSignalEditor(root, result, button.getAttribute("data-signal")));
}

function _openSignalEditor(root, result, signal_code) {
    const current = result.signals.find(s => s.signal_code == signal_code);
    const keys = Object.keys(current.threshold);
    const editor = root.querySelector("#wc-signal-editor");
    editor.innerHTML = `<div class="tr-card" style="margin-top:10px">
        <div class="up t3">Publish — ${states.esc(current.label)}</div>
        ${keys.map(key => `<div class="row" style="margin-top:6px">
            <span class="sm t3" style="width:180px">${states.esc(key)}</span>
            <input class="inp" type="number" id="wc-th-${states.esc(key)}" value="${current.threshold[key]}" style="width:100px"></div>`).join("")}
        <div class="row" style="margin-top:6px"><span class="sm t3" style="width:180px">offer_after_days</span>
            <input class="inp" type="number" id="wc-ladder-offer" value="${current.ladder.offer_after_days}" style="width:100px"></div>
        <button class="btn pri" data-wc="publish-signal" style="margin-top:8px">Publish</button>
    </div>`;
    editor.querySelector("[data-wc=\"publish-signal\"]").addEventListener("click", async _ => {
        const threshold = {};
        for (const key of keys) threshold[key] = Number(editor.querySelector(`#wc-th-${key}`).value);
        const ladder = {offer_after_days: Number(editor.querySelector("#wc-ladder-offer").value)};
        const published = await _rest("publish_signal", {signal_code, threshold, ladder});
        if (published) {states.toast({message: `Published v${published.version}.`}); await _signals(root);}
    });
}

// ---------------------------------------------------------------------------

const _hm = seconds => `${Math.floor(seconds/3600)}h ${String(Math.floor(seconds%3600/60)).padStart(2, "0")}m`;
const _today = _ => new Date().toISOString().substring(0, 10);
function _isoAddDays(iso, days) {
    const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().substring(0, 10);
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
