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
    state = {root, editingRecord: false, requestingDeletion: false, diversityOpen: false};
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
    const [status, myRecord, accessLog, diversityData] = await Promise.all(
        [_rest("status"), _rest("my_record"), _rest("access_log"), _rest("diversity")]);
    if (!status || !myRecord || !accessLog || !diversityData) return;
    _render(root, status, myRecord, accessLog, diversityData);
}

function _render(root, status, myRecord, accessLog, diversityData) {
    const {candidate, requisition, pipeline, next_round, terminal, consent_retain, deletion_status} = status;
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

        ${_myRecordHtml(myRecord)}
        ${_accessLogHtml(accessLog)}
        ${_deletionHtml(deletion_status)}
        ${_diversityHtml(diversityData)}

        <p class="sm t3" style="margin-top:10px">This link is yours alone — don't forward it. Your recruiter can
            revoke it at any time.</p>`;
    _wire(root, status, myRecord, accessLog, diversityData);
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
    if (terminal.kind == "deletion_pending") return `<div class="tr-card">
        <div class="up t3">Deletion requested</div>
        <p class="sm">Your application is paused while your deletion request is reviewed. Nobody can act on it
            until that's decided.</p>
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

/** K12 slice 2: what you submitted — never scorecards or evaluations, those stay with the hiring team. */
function _myRecordHtml(record) {
    if (!state.editingRecord) return `<div class="tr-card">
        <div class="up t3">Your record</div>
        <p class="sm">${states.esc(record.full_name)} · ${states.esc(record.email)}${record.phone ? ` · ${states.esc(record.phone)}` : ""}</p>
        <p class="sm t3">Source: ${states.esc(record.source)}${record.resume_ref ? ` · Résumé: ${states.esc(record.resume_ref)}` : ""}
            · Applied ${new Date(record.applied_at*1000).toLocaleDateString()}</p>
        <button class="btn sm" data-pt="edit-record-open" style="margin-top:6px">Correct this</button>
    </div>`;
    return `<div class="tr-card">
        <div class="up t3">Your record</div>
        <div class="row wrap" style="gap:6px">
            <input class="inp" id="pt-rec-name" placeholder="Full name" value="${states.esc(record.full_name)}">
            <input class="inp" id="pt-rec-email" placeholder="Email" value="${states.esc(record.email)}">
            <input class="inp" id="pt-rec-phone" placeholder="Phone" value="${states.esc(record.phone || "")}">
            <input class="inp grow" id="pt-rec-resume" placeholder="Résumé link" value="${states.esc(record.resume_ref || "")}">
        </div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <button class="btn sm pri" data-pt="save-record">Save</button>
            <button class="btn sm" data-pt="edit-record-cancel">Cancel</button>
        </div>
    </div>`;
}

/** K12 slice 2: "see who viewed it." */
function _accessLogHtml(log) {
    return `<div class="tr-card">
        <div class="up t3">Who's viewed this</div>
        ${log.accesses.length ? log.accesses.map(a => `<div class="sm t3" style="padding:3px 0">
            ${states.esc(a.actor_name)} — ${a.count}× · last ${new Date(a.last_at*1000).toLocaleDateString()}</div>`).join("") :
            `<p class="sm t3">Nobody has viewed your record yet.</p>`}
    </div>`;
}

/** K12 slice 2: pauses the application rather than silently rejecting the candidate. */
function _deletionHtml(status) {
    if (status.pending) return `<div class="tr-card">
        <div class="up t3">Deletion request</div>
        <p class="sm">Pending review since ${new Date(status.requested_at*1000).toLocaleDateString()}.</p>
    </div>`;
    if (status.decision == "declined") return `<div class="tr-card">
        <div class="up t3">Deletion request</div>
        <p class="sm">Declined: ${states.esc(status.decision_reason || "")}</p>
        <button class="btn sm" data-pt="delete-request-open" style="margin-top:6px">Request again</button>
    </div>`;
    if (!state.requestingDeletion) return `<div class="tr-card">
        <div class="up t3">Delete my data</div>
        <p class="sm t3">Pauses this application while HR reviews your request — never a silent rejection.</p>
        <button class="btn danger sm" data-pt="delete-request-open" style="margin-top:6px">Request deletion</button>
    </div>`;
    return `<div class="tr-card">
        <div class="up t3">Delete my data</div>
        <div class="row wrap" style="gap:6px">
            <input class="inp grow" id="pt-delete-reason" placeholder="Reason (optional)">
            <button class="btn sm danger" data-pt="do-delete-request">Send request</button>
            <button class="btn sm" data-pt="delete-request-cancel">Cancel</button>
        </div>
    </div>`;
}

const GENDER_OPTIONS = [["", "— Not answered —"], ["woman", "Woman"], ["man", "Man"],
    ["non_binary", "Non-binary"], ["prefer_not_to_say", "Prefer not to say"]];
const DISABILITY_OPTIONS = [["", "— Not answered —"], ["yes", "Yes"], ["no", "No"], ["prefer_not_to_say", "Prefer not to say"]];

/** K12 slice 3: collected optionally, collapsed by default — not the first thing a candidate sees. */
function _diversityHtml(data) {
    if (!state.diversityOpen) return `<div class="tr-card">
        <div class="up t3">Diversity monitoring (optional)</div>
        <p class="sm t3">Used only in anonymous, aggregate fairness reporting — never seen by anyone making a
            decision about you, and never shown below a minimum group size.</p>
        <button class="btn sm" data-pt="diversity-open" style="margin-top:6px">Tell us about yourself</button>
    </div>`;
    const selectHtml = (id, options, current) => `<select class="inp" id="${id}">
        ${options.map(([value, label]) => `<option value="${states.esc(value)}"${value == (current || "") ? " selected" : ""}>${states.esc(label)}</option>`).join("")}
    </select>`;
    return `<div class="tr-card">
        <div class="up t3">Diversity monitoring (optional)</div>
        <p class="sm t3">Used only in anonymous, aggregate fairness reporting — never seen by anyone making a
            decision about you. Answer as much or as little as you like.</p>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <label class="sm t3">Gender<br>${selectHtml("pt-div-gender", GENDER_OPTIONS, data.gender)}</label>
            <label class="sm t3">Disability status<br>${selectHtml("pt-div-disability", DISABILITY_OPTIONS, data.disability_status)}</label>
            <label class="sm t3">Ethnicity<br><input class="inp" id="pt-div-ethnicity" placeholder="Optional, free text" value="${states.esc(data.ethnicity || "")}"></label>
        </div>
        <div class="row wrap" style="gap:6px;margin-top:6px">
            <button class="btn sm pri" data-pt="save-diversity">Save</button>
            <button class="btn sm" data-pt="diversity-cancel">Close</button>
        </div>
    </div>`;
}

function _wire(root, status, myRecord, accessLog, diversityData) {
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

    root.querySelector("[data-pt=\"edit-record-open\"]")?.addEventListener("click", _ => {
        state.editingRecord = true; _render(root, status, myRecord, accessLog, diversityData);
    });
    root.querySelector("[data-pt=\"edit-record-cancel\"]")?.addEventListener("click", _ => {
        state.editingRecord = false; _render(root, status, myRecord, accessLog, diversityData);
    });
    root.querySelector("[data-pt=\"save-record\"]")?.addEventListener("click", async _ => {
        const full_name = root.querySelector("#pt-rec-name").value.trim(), email = root.querySelector("#pt-rec-email").value.trim();
        if (!full_name || !email) {states.toast({message: "A name and an email are both required."}); return;}
        const result = await _rest("update_record", {full_name, email,
            phone: root.querySelector("#pt-rec-phone").value.trim() || undefined,
            resume_ref: root.querySelector("#pt-rec-resume").value.trim() || undefined});
        if (result) {states.toast({message: "Saved."}); state.editingRecord = false; await _view();}
    });

    root.querySelector("[data-pt=\"delete-request-open\"]")?.addEventListener("click", _ => {
        state.requestingDeletion = true; _render(root, status, myRecord, accessLog, diversityData);
    });
    root.querySelector("[data-pt=\"delete-request-cancel\"]")?.addEventListener("click", _ => {
        state.requestingDeletion = false; _render(root, status, myRecord, accessLog, diversityData);
    });
    root.querySelector("[data-pt=\"do-delete-request\"]")?.addEventListener("click", async _ => {
        const confirmed = await states.confirmDestructive({title: "Request deletion of your data?",
            body: "Your application is paused while this is reviewed. This isn't reversible once approved.",
            confirmLabel: "Request deletion"});
        if (!confirmed) return;
        const result = await _rest("request_deletion", {reason: root.querySelector("#pt-delete-reason")?.value.trim() || undefined});
        if (result) {states.toast({message: "Request sent."}); state.requestingDeletion = false; await _view();}
    });

    root.querySelector("[data-pt=\"diversity-open\"]")?.addEventListener("click", _ => {
        state.diversityOpen = true; _render(root, status, myRecord, accessLog, diversityData);
    });
    root.querySelector("[data-pt=\"diversity-cancel\"]")?.addEventListener("click", _ => {
        state.diversityOpen = false; _render(root, status, myRecord, accessLog, diversityData);
    });
    root.querySelector("[data-pt=\"save-diversity\"]")?.addEventListener("click", async _ => {
        const result = await _rest("set_diversity", {
            gender: root.querySelector("#pt-div-gender").value || undefined,
            disability_status: root.querySelector("#pt-div-disability").value || undefined,
            ethnicity: root.querySelector("#pt-div-ethnicity").value.trim() || undefined});
        if (result) {states.toast({message: "Saved. Thank you."}); await _view();}
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
