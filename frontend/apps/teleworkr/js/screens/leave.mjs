/**
 * J3 — My leave: the ledger, the requests, and the request form that shows
 * the engine's working before anything is asked of anyone.
 *
 * The balance is a projection, never a stored number — what the screen shows
 * is what the policy says, as of today, including which units are about to
 * expire. A prospective request is evaluated first and the result shown
 * plainly: the working days it would consume, what the policy ruled, and the
 * warnings. The request itself pins that evaluation, so a republished policy
 * never silently re-judges it (A6).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API = "leave";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

const STATUS_LABELS = {draft: "Draft", pending: "Pending", approved: "Approved",
    declined: "Declined", cancelled: "Cancelled"};

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, tab: "balances", policy: null, form: {leave_type: null,
        from_date: null, to_date: null, reason: ""}, preview: null};
    await _view();
}

async function _view() {
    const root = state.root;
    const tabs = [["balances", "Balances"], ["requests", "Requests"], ["request", "Request leave"]];
    root.innerHTML = `<div class="page lv">
        <div class="tr-tabs">${tabs.map(([id, label]) =>
            `<button class="tr-tab${state.tab == id ? " on" : ""}" data-lv="tab" data-tab="${id}">${label}</button>`).join("")}
        </div>
        <div class="lv-view" id="lv-view">${states.loading({rows: 4})}</div>
    </div>`;
    for (const button of root.querySelectorAll("[data-lv=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#lv-view");
    try {
        if (!state.policy) {
            const policyResponse = await _rest("policy", {});
            if (policyResponse) state.policy = policyResponse.policy;
        }
        if (state.tab == "balances") return await _balances(view);
        if (state.tab == "requests") return await _requests(view);
        return await _requestForm(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load leave",
            what: err.message, safe: "Your requests are unaffected.",
            reference: `J3-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

async function _balances(root) {
    if (!state.policy) {
        root.innerHTML = `<div class="tr-empty">No published leave policy covers you yet.
            Your HR console publishes one; the screen will not invent a number.</div>`;
        return;
    }
    root.innerHTML = `<div class="lv-cards">${states.loading({rows: 3})}</div>`;
    const cards = [];
    for (const type of state.policy.leave_types) {
        const balance = await _rest("balance", {leave_type: type.code});
        if (!balance) return;
        cards.push(`<div class="lv-card">
            <div class="lv-card-top"><span class="lv-code">${states.esc(type.code)}</span>
                <span class="grow">${states.esc(type.label)}</span>
                <span class="mono lv-avail">${balance.available}</span></div>
            <div class="sm t3">+${balance.accrued} accrued · −${balance.deducted} deducted${
                balance.opening ? ` · ${balance.opening} opening` : ""}</div>
            ${balance.expiring?.length ? `<div class="lv-expiring">${
                balance.expiring.map(entry => `${entry.days}d expires ${states.esc(entry.expires_on)}`).join(" · ")}</div>` : ""}
        </div>`);
    }
    root.innerHTML = `<div class="lv-cards">${cards.join("")}</div>`;
    if (!cards.length) root.innerHTML = `<div class="tr-empty">The policy declares no leave types.</div>`;
}

async function _requests(root) {
    const response = await _rest("requests", {});
    if (!response) return;
    const rows = response.requests || response;
    root.innerHTML = rows.length ? rows.map(row => `
        <div class="lv-card">
            <div class="lv-card-top">
                <span class="lv-code">${states.esc(row.leave_type)}</span>
                <span class="grow">${states.esc(row.from_date)} – ${states.esc(row.to_date)}${
                    row.days_deducted ? ` · ${row.days_deducted} day${row.days_deducted == 1 ? "" : "s"}` : ""}</span>
                <span class="lv-status s-${states.esc(row.status)}">${states.esc(STATUS_LABELS[row.status] || row.status)}</span>
            </div>
            ${row.reason ? `<div class="sm t2">${states.esc(row.reason)}</div>` : ""}
            ${row.status == "returned" ? "" : ""}
            ${row.status == "pending" || row.status == "approved" ?
                `<button class="btn sm" data-lv="cancel" data-id="${states.esc(row.leave_request_id)}">Cancel</button>` : ""}
        </div>`).join("") :
        `<div class="tr-empty">No requests yet. Your leave history will appear here.</div>`;

    for (const button of root.querySelectorAll("[data-lv=\"cancel\"]"))
        button.addEventListener("click", async _ => {
            const id = button.getAttribute("data-id");
            const confirmed = await states.confirmDestructive({title: "Cancel this leave request?",
                body: "An approved request is reversed in the ledger — the days return. Neither is ever edited (A6).",
                confirmLabel: "Cancel request"});
            if (!confirmed) return;
            if (await _rest("cancel", {leave_request_id: id})) {
                states.toast({message: "Request cancelled."}); await _requests(root);
            }
        });
}

async function _requestForm(root) {
    const types = state.policy?.leave_types || [];
    root.innerHTML = `<div class="lv-form">
        ${!state.policy ? `<div class="tr-empty">No published leave policy covers you yet —
            the request form cannot invent the rules it would be judged by.</div>` : `
        <div class="lv-card">
            <div class="up t3">Request leave</div>
            <div class="row wrap">
                <select class="inp" id="lv-type">${types.map(type =>
                    `<option value="${states.esc(type.code)}"${state.form.leave_type == type.code ? " selected" : ""}>${
                        states.esc(type.label || type.code)}</option>`).join("")}</select>
                <input class="inp" type="date" id="lv-from" value="${states.esc(state.form.from_date || "")}">
                <input class="inp" type="date" id="lv-to" value="${states.esc(state.form.to_date || "")}">
                <input class="inp grow" id="lv-reason" placeholder="reason (shown to your approver)"
                    value="${states.esc(state.form.reason || "")}" style="min-width:200px">
                <button class="btn pri" data-lv="evaluate">Check</button>
            </div>
            <div id="lv-preview"></div>
        </div>`}
    </div>`;

    root.querySelector("[data-lv=\"evaluate\"]")?.addEventListener("click", async _ => {
        state.form = {leave_type: root.querySelector("#lv-type").value,
            from_date: root.querySelector("#lv-from").value,
            to_date: root.querySelector("#lv-to").value,
            reason: root.querySelector("#lv-reason").value.trim()};
        const preview = await _rest("evaluate", {...state.form});
        if (!preview) return;
        state.preview = preview;
        root.querySelector("#lv-preview").innerHTML = _previewHTML(preview);
        root.querySelector("[data-lv=\"submit\"]")?.addEventListener("click", _ => _submit(root));
    });
}

const _previewHTML = preview => preview.allowed ? `
    <div class="lv-preview ok">
        <div class="up t3">The policy says yes</div>
        <p class="sm">${preview.working_days} working day${preview.working_days == 1 ? "" : "s"} · ${
            preview.days_deducted} day${preview.days_deducted == 1 ? "" : "s"} deducted${
            preview.clubbed_days ? ` · ${preview.clubbed_days} clubbed` : ""}</p>
        ${(preview.warnings || []).map(w => `<p class="t3 xs">⚠ ${states.esc(w.reason || w)}</p>`).join("")}
        <button class="btn pri" data-lv="submit">Request it</button>
    </div>` : `
    <div class="lv-preview no">
        <div class="up t3">Refused — ${states.esc(preview.rule_fired || "the policy")}</div>
        <p class="sm">${states.esc(preview.reason || "The policy does not allow this request.")}</p>
    </div>`;

async function _submit(root) {
    if (!state.preview?.allowed) return;
    const created = await _rest("request", {...state.form});
    if (!created) return;
    states.toast({message: `Requested ${created.request.leave_type} ${created.request.from_date}–${
        created.request.to_date}. Pending approval.`});
    state.tab = "requests"; state.preview = null;
    await _view();
}

async function _rest(op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET",
            {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Leave op ${op} failed: ${err}`);}
    if (!response?.result) {states.toast({message: response?.reason || "The leave service did not respond.", ms: 8000}); return null;}
    return response;
}
