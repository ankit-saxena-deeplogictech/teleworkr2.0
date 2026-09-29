/**
 * K9 — the candidate portal. Reached by a magic link; no sign-in, no
 * employee identity. Same `.tr-*`/tokens.css component classes every
 * other screen uses, since this page sits outside the login-gated shell
 * entirely and loads them standalone (see portal.html).
 *
 * Sign-out and containment aside, this is the one other place in the app
 * where "the record it left" is the whole story — reschedule/withdraw/
 * availability/consent here are recorded, never dispatched anywhere;
 * this app sends no email, so the recruiter still copies and sends the
 * link, and a rejection message is read here, never emailed out.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {states} from "./states.mjs";

const API = "portal";
const token = new URL(window.location.href).searchParams.get("token");

let state = null;

/** Renders the portal. @param {HTMLElement} root */
export async function render(root) {
    state = {root};
    if (!token) {
        root.innerHTML = states.error({title: "This link is incomplete", what: "No token was found in the URL.",
            safe: "Check the link you were sent, or ask your recruiter for a new one.", actions: []});
        return;
    }
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = states.loading({rows: 4});
    const result = await _rest("status");
    if (!result) return;
    _render(root, result);
}

function _render(root, status) {
    const {candidate, requisition, pipeline, next_round, terminal, consent_retain} = status;
    root.innerHTML = `
        <div class="portal-hero">
            <h1>${states.esc(requisition?.title || "Your application")}</h1>
            <p class="sm t3">Hi ${states.esc(candidate.full_name)} — here's where things stand. The whole process, up
                front, no waiting to hear back.</p>
        </div>

        <div class="tr-card">
            <div class="up t3">Status</div>
            <div class="row wrap" style="gap:5px">
                ${pipeline.map(round => {
                    const color = round.status == "passed" ? "var(--mint)" : round.status == "rejected" ? "var(--ember)" :
                        round.status == "held" ? "var(--dawn)" : "var(--t3)";
                    return `<span class="mono sm" style="padding:3px 8px;border-radius:6px;background:var(--raise);color:${color}">
                        ${states.esc(round.title)}</span>`;
                }).join("<span class=\"sm t3\">→</span>")}
            </div>
        </div>

        ${terminal ? _terminalHtml(terminal, consent_retain) : ""}
        ${!terminal && next_round ? _nextRoundHtml(next_round) : ""}
        ${!terminal ? _availabilityHtml(candidate) : ""}
        ${!terminal ? `<div class="tr-card">
            <div class="up t3">Withdraw</div>
            <p class="sm t3">One click. No justification needed.</p>
            <button class="btn danger sm" data-pt="withdraw">Withdraw my application</button>
        </div>` : ""}
        <p class="sm t3" style="margin-top:10px">This link is yours alone — don't forward it. Your recruiter can
            revoke it at any time.</p>`;
    _wire(root, status);
}

function _terminalHtml(terminal, consent_retain) {
    if (terminal.kind == "completed") return `<div class="tr-card">
        <div class="up t3" style="color:var(--mint)">Completed</div>
        <p class="sm">You've completed every stage of this process. Your recruiter will be in touch about next steps.</p>
    </div>`;
    if (terminal.kind == "withdrawn") return `<div class="tr-card">
        <div class="up t3">Withdrawn</div>
        <p class="sm">You withdrew this application${terminal.reason ? ` — ${states.esc(terminal.reason)}` : ""}.</p>
    </div>`;
    return `<div class="tr-card" style="border-color:var(--ember)">
        <div class="up t3" style="color:var(--ember)">Not moving forward this time</div>
        <p class="sm">${states.esc(terminal.reason || "")}</p>
        <p class="sm t3">This isn't a judgement about your ability generally — we'd genuinely welcome an application
            for a different role.</p>
        <label class="sm" style="display:flex;gap:6px;align-items:flex-start;margin-top:6px">
            <input type="checkbox" id="pt-consent" ${consent_retain ? "checked" : ""}>
            <span>Keep my details for future roles — we'll delete everything otherwise, per our retention policy.</span>
        </label>
        <button class="btn sm" data-pt="save-consent" style="margin-top:6px">Save</button>
    </div>`;
}

function _nextRoundHtml(round) {
    const start = new Date(round.scheduled_start*1000), end = new Date(round.scheduled_end*1000);
    return `<div class="tr-card">
        <div class="up t3">Next — ${states.esc(round.round_title)}</div>
        <p class="sm">${start.toLocaleDateString()} · ${start.toLocaleTimeString()} – ${end.toLocaleTimeString()}
            ${round.timezone_base ? ` (${states.esc(round.timezone_base)})` : ""}</p>
        <p class="sm t3">With ${round.interviewers.map(i => states.esc(i.name)).join(", ") || "the panel"}</p>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <button class="btn sm" data-pt="ics">Add to calendar</button>
            ${round.candidate_reschedule_count < 2 ? `<button class="btn sm" data-pt="reschedule-open">Reschedule</button>` :
                `<span class="sm t3">Already rescheduled twice through this link — contact your recruiter to move it again.</span>`}
        </div>
        <div id="pt-reschedule-form" style="display:none;margin-top:8px" class="row wrap">
            <input class="inp" type="datetime-local" id="pt-resched-start">
            <input class="inp" type="datetime-local" id="pt-resched-end">
            <button class="btn sm pri" data-pt="do-reschedule">Confirm new time</button>
        </div>
    </div>`;
}

function _availabilityHtml(candidate) {
    return `<div class="tr-card">
        <div class="up t3">Your availability</div>
        <div class="row wrap" style="gap:6px">
            <input class="inp" id="pt-tz" placeholder="Timezone, e.g. Asia/Kolkata" value="${states.esc(candidate.timezone || "")}">
            <input class="inp grow" id="pt-avail" placeholder="When you're generally free" value="${states.esc(candidate.availability_notes || "")}">
            <button class="btn sm" data-pt="save-availability">Save</button>
        </div>
    </div>`;
}

function _wire(root, status) {
    root.querySelector("[data-pt=\"save-availability\"]")?.addEventListener("click", async _ => {
        const result = await _rest("update_availability", {timezone: root.querySelector("#pt-tz").value.trim() || undefined,
            availability_notes: root.querySelector("#pt-avail").value.trim() || undefined});
        if (result) {states.toast({message: "Saved."}); await _view();}
    });
    root.querySelector("[data-pt=\"save-consent\"]")?.addEventListener("click", async _ => {
        const result = await _rest("set_consent", {consent_retain: root.querySelector("#pt-consent").checked});
        if (result) states.toast({message: "Saved."});
    });
    root.querySelector("[data-pt=\"withdraw\"]")?.addEventListener("click", async _ => {
        const confirmed = await states.confirmDestructive({title: "Withdraw your application?",
            body: "This can't be undone. No justification is needed.", confirmLabel: "Withdraw"});
        if (!confirmed) return;
        const result = await _rest("withdraw", {});
        if (result) {states.toast({message: "Withdrawn."}); await _view();}
    });
    root.querySelector("[data-pt=\"ics\"]")?.addEventListener("click", _ => _downloadIcs(status.next_round));
    root.querySelector("[data-pt=\"reschedule-open\"]")?.addEventListener("click", _ => {
        root.querySelector("#pt-reschedule-form").style.display = "";
    });
    root.querySelector("[data-pt=\"do-reschedule\"]")?.addEventListener("click", async _ => {
        const startVal = root.querySelector("#pt-resched-start").value, endVal = root.querySelector("#pt-resched-end").value;
        if (!startVal || !endVal) {states.toast({message: "Pick both a start and an end time."}); return;}
        const scheduled_start = Math.floor(new Date(startVal).getTime()/1000), scheduled_end = Math.floor(new Date(endVal).getTime()/1000);
        const result = await _rest("reschedule", {panel_assignment_id: status.next_round.panel_assignment_id, scheduled_start, scheduled_end});
        if (result) {states.toast({message: "Rescheduled."}); await _view();}
    });
}

/** No calendar/meeting integration exists anywhere in this app — a plain client-built .ics is the honest substitute. */
function _downloadIcs(round) {
    const fmt = epochSeconds => new Date(epochSeconds*1000).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TeleWorkr//Candidate Portal//EN", "BEGIN:VEVENT",
        `UID:${round.panel_assignment_id}@teleworkr`, `DTSTAMP:${fmt(Math.floor(Date.now()/1000))}`,
        `DTSTART:${fmt(round.scheduled_start)}`, `DTEND:${fmt(round.scheduled_end)}`,
        `SUMMARY:${round.round_title}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([ics], {type: "text/calendar"}));
    link.download = "interview.ics"; link.click();
    URL.revokeObjectURL(link.href);
}

const _rest = (op, extra = {}) => _call(op, extra);

async function _call(op, extra = {}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET", {op, token, ...extra}, false);
    } catch (err) {response = null; LOG?.error?.(`portal op ${op} failed: ${err}`);}
    if (!response?.result) {
        states.toast({message: response?.reason || "The portal service did not respond.", ms: 8000});
        return null;
    }
    return response;
}
