/**
 * P — the training screen: catalogue (P2), course detail (P3), the player
 * (P4), certificates (P5), and the assign & track board (P6, for the
 * capability's holders).
 *
 * The screen owns the flow; the components own the UI. The player keeps the
 * chrome — the shell clock keeps running and re-categorises rather than
 * stopping, because a person part-way through a course is still at work (P4).
 *
 * Failure policy is stated before the first question, not in a help article.
 * Feedback after a failed attempt names the topic, never which question was
 * wrong — the same rule the backend enforces for what a lead can see (P6).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";
import {courseCard} from "../../components/course-card/course-card.mjs";
import {certificateRow} from "../../components/certificate-row/certificate-row.mjs";
import {questionCard} from "../../components/question-card/question-card.mjs";

const API_TRAINING = "training", API_VERIFY = "certverify";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

// the screen's own navigation state — one screen, several views
let state = null;

/**
 * Renders the screen. The hash decides the entry view, so the shell's
 * `#trainingtrack` surface lands on the tracking board directly.
 * @param {HTMLElement} root
 */
export async function render(root) {
    const caps = (await import("../shell.mjs")).shell.projection?.capabilities || [];
    state = {root, tab: window.location.hash == "#trainingtrack" ? "track" : "catalogue",
        canTrack: caps.includes("training.track"), course: null, player: null, ticker: null};
    await _view();
}

async function _view() {
    const root = state.root;
    const tabs = [["catalogue", "Training"], ["certificates", "My certificates"],
        ...(state.canTrack ? [["track", "Assign & track"]] : [])];
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">${tabs.map(([id, label]) =>
            `<button class="tr-tab${state.tab == id ? " on" : ""}" data-tr="tab" data-tab="${id}">${label}</button>`).join("")}
        </div>
        <div class="tr-view" id="tr-view"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-tr=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab");
            state.course = null; state.player = null; _view();});

    const view = root.querySelector("#tr-view");
    try {
        if (state.course && state.player) return await _player(view);
        if (state.course) return await _courseDetail(view, state.course);
        if (state.tab == "certificates") return await _certificates(view);
        if (state.tab == "track") return await _track(view);
        return await _catalogue(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load training",
            what: err.message, safe: "Nothing you have recorded is affected.",
            reference: `P-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// P2 — the catalogue: what you must do, then what you could
// ---------------------------------------------------------------------------

async function _catalogue(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 4})}</div>`;
    const response = await _rest("catalogue");
    if (!response) return;

    root.innerHTML = `
        <div class="tr-note">This is paid working time. The clock keeps running while you learn,
            and the entry lands on your timesheet under <span class="mono">training</span>.</div>
        <div class="tr-band">
            <div class="tr-band-title"><span class="code">Required</span>
                <span class="t2 sm">every requirement names the rule behind it</span></div>
            ${response.required.length ? response.required.map(courseCard.required).join("") :
                `<div class="tr-empty">Nothing is required of you right now.</div>`}
        </div>
        <div class="tr-band">
            <div class="tr-band-title"><span class="code">Recommended</span>
                <span class="t2 sm">by role and jurisdiction only — never by wellbeing signals, never by performance</span></div>
            ${response.recommended.length ? response.recommended.map(courseCard.recommended).join("") :
                `<div class="tr-empty">Nothing is suggested for you right now.</div>`}
        </div>`;
    courseCard.wire(root, code => {state.course = code; state.player = null; _view();});
}

// ---------------------------------------------------------------------------
// P3 — course detail: the commitment, before it begins
// ---------------------------------------------------------------------------

async function _courseDetail(root, code) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 4})}</div>`;
    const response = await _rest("course", {course_code: code});
    if (!response) return;
    const course = response.course, policy = response.policy;
    const startedSomething = response.modules.some(module => module.state != "not_started");

    root.innerHTML = `
        <button class="tr-back" data-tr="back">← Training</button>
        <div class="tr-card">
            <div class="tr-card-top">
                <div class="grow"><h2>${states.esc(course.title)}</h2>
                    <p class="t2 sm">v${course.version} · ${course.modules.length} modules · ~${course.minutes}m${
                        course.validity_years ? ` · certificate valid ${course.validity_years}y` : ""}</p></div>
                <button class="btn pri" data-tr="begin">${startedSomething ? "Resume" : "Start"}</button>
            </div>
            <div class="tr-panels">
                <div class="tr-panel">
                    <div class="up t3">Modules</div>
                    ${response.modules.map(module => `<div class="tr-module s-${module.state}">
                        <span class="tr-module-dot"></span>
                        <span class="grow">${states.esc(module.title)}</span>
                        <span class="sm t3">${module.questions?.length ? `${module.questions.length} questions · ` : ""}~${module.minutes}m</span>
                    </div>`).join("")}
                </div>
                <div class="tr-panel">
                    <div class="up t3">Before you begin</div>
                    <p class="t2 sm">${states.esc(response.time_policy)}</p>
                    ${policy.pass_mark ? `<p class="sm"><b>Pass mark ${states.esc(policy.pass_mark)}%.</b> ${states.esc(policy.attempts)}</p>` :
                        `<p class="sm">Read-and-acknowledge — completing each module is the pass.</p>`}
                    ${policy.failure ? `<p class="sm" style="margin-top:6px">${states.esc(policy.failure)}</p>` : ""}
                </div>
                <div class="tr-panel">
                    <div class="up t3">What your lead sees</div>
                    ${response.lead_sees.map(item => `<p class="sm" style="margin-top:4px">✓ ${states.esc(item)}</p>`).join("")}
                    ${response.lead_never_sees.map(item => `<p class="sm t3" style="margin-top:4px">✕ ${states.esc(item)}</p>`).join("")}
                </div>
            </div>
        </div>`;
    root.querySelector("[data-tr=\"back\"]").addEventListener("click", _ => {state.course = null; state.player = null; _view();});
    root.querySelector("[data-tr=\"begin\"]").addEventListener("click", _ => _begin(code));
}

// ---------------------------------------------------------------------------
// P4 — the player: the portal does not disappear
// ---------------------------------------------------------------------------

async function _begin(code) {
    const detail = await _rest("course", {course_code: code});
    if (!detail) return;
    const next = detail.modules.find(module => !["passed", "completed"].includes(module.state))
        || detail.modules[0];
    const started = await _rest("start_module", {course_code: code, module_id: next.id});
    if (!started) return;
    state.course = code;
    state.player = {module_id: next.id, started_at: performance.now()};
    await _view();
}

async function _player(root) {
    const code = state.course, moduleId = state.player.module_id;
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const detail = await _rest("course", {course_code: code});
    if (!detail) return;
    const course = detail.course;
    const modules = detail.modules;
    const currentIndex = modules.findIndex(module => module.id == moduleId);
    const current = modules[currentIndex];
    const questions = current.questions || [];

    root.innerHTML = `
        <div class="tr-player">
            <div class="tr-player-head">
                <button class="tr-back" data-tr="exit">Save & exit</button>
                <div class="grow"><div class="up t3">${states.esc(course.title)}</div>
                    <div class="sm">Module ${currentIndex+1} of ${modules.length} · ${states.esc(current.title)}</div></div>
                <span class="mono" data-tr="elapsed">00:00</span>
            </div>
            <div class="tr-bar"><span id="tr-bar-fill"></span></div>
            <div class="tr-play-body">
                ${questions.length ? questions.map((question, i) =>
                    `<div style="margin-bottom:14px">${questionCard.render({id: question.id, text: question.text,
                        type: question.type, options: question.options, required: false, free_text: false},
                        {index: i+1, skipAllowed: false})}</div>`).join("")
                    : `<div class="tr-empty">This module has no questions — reading it completes it.</div>`}
                ${questions.length ? `<button class="btn pri" data-tr="check">Check answers</button>` :
                    `<button class="btn pri" data-tr="complete-module">Complete module & log time</button>`}
                <div class="tr-feedback" id="tr-feedback"></div>
            </div>
        </div>`;

    root.querySelector("[data-tr=\"exit\"]").addEventListener("click", _ => {state.player = null; _view();});
    const elapsed = root.querySelector("[data-tr=\"elapsed\"]");
    if (state.ticker) clearInterval(state.ticker);
    state.ticker = setInterval(_ => {
        elapsed.textContent = _ms(Math.floor((performance.now() - state.player.started_at)/1000));
    }, 1000);

    if (questions.length) {
        for (const card of root.querySelectorAll("[data-question]"))
            questionCard.wire(card, _ => {});
        root.querySelector("[data-tr=\"check\"]").addEventListener("click", async _ => {
            const answers = {};
            for (const card of root.querySelectorAll("[data-question]")) {
                const collected = questionCard.collect(card);
                if (collected?.value !== undefined) answers[card.getAttribute("data-question")] = collected.value;
            }
            const feedback = root.querySelector("#tr-feedback");
            const elapsedSeconds = Math.max(1, Math.floor((performance.now() - state.player.started_at)/1000));
            const attempt = await _rest("save_attempt", {course_code: code, module_id: moduleId,
                answers, elapsed_seconds: elapsedSeconds, client_event_id: crypto.randomUUID()});
            if (!attempt) return;
            if (attempt.passed) {
                feedback.innerHTML = `<div class="tr-pass">Passed — ${attempt.score}%.
                    Complete the module to log the time on your timesheet.</div>
                    <button class="btn pri" data-tr="complete-module">Complete module & log time</button>`;
                feedback.querySelector("[data-tr=\"complete-module\"]").addEventListener("click",
                    _ => _completeModule(code, moduleId));
            } else feedback.innerHTML = `<div class="tr-fail">Not passed.
                <b>Revisit the topic — ${states.esc(current.title)}.</b> Retry as often as you like;
                only your passing attempt is recorded.</div>`;
        });
    } else root.querySelector("[data-tr=\"complete-module\"]").addEventListener("click",
        _ => _completeModule(code, moduleId));
}

async function _completeModule(code, moduleId) {
    const elapsedSeconds = Math.max(1, Math.floor((performance.now() - state.player.started_at)/1000));
    const done = await _rest("complete_module", {course_code: code, module_id: moduleId,
        elapsed_seconds: elapsedSeconds, client_event_id: crypto.randomUUID()});
    if (!done) return;
    states.toast({message: `Module complete — ${_ms(elapsedSeconds)} logged under training.`});

    const detail = await _rest("course", {course_code: code});
    if (detail) {
        const next = detail.modules.find(module => !["passed", "completed"].includes(module.state));
        if (next) {
            const started = await _rest("start_module", {course_code: code, module_id: next.id});
            if (!started) return;
            state.player = {module_id: next.id, started_at: performance.now()};
            return await _view();
        }
        // every module done — the pass is one call away
        const certificate = await _rest("pass_course", {course_code: code});
        if (!certificate) return;
        state.player = null;
        states.toast({message: `Passed — certificate ${certificate.verification_code} issued.`});
        return await _view();
    }
    state.player = null; await _view();
}

// ---------------------------------------------------------------------------
// P5 — certificates: records with countdowns, portable and provable
// ---------------------------------------------------------------------------

async function _certificates(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 4})}</div>`;
    const response = await _rest("certificates");
    if (!response) return;
    const rows = response.certificates || [];

    root.innerHTML = `
        <div class="tr-card">
            <div class="tr-card-top">
                <div class="grow"><div class="up t3">Certificates</div>
                    <p class="sm">A certificate is a record — the PDF is rendered from it on demand.
                    Expiry is warned at 90, 30 and 7 days; expired records stay in history.</p></div>
                <button class="btn" data-tr="export">Export my record</button>
            </div>
            ${rows.length ? rows.map(certificateRow.render).join("") :
                `<div class="tr-empty">No certificates yet. Passing a course issues the first one.</div>`}
        </div>`;
    certificateRow.wire(root, {
        view: id => _printCertificate(rows.find(row => row.certificate_id == id)),
        verify: id => _verify(rows.find(row => row.certificate_id == id))});
    root.querySelector("[data-tr=\"export\"]").addEventListener("click", _ => _export());
}

async function _verify(row) {
    if (!row) return;
    let response;
    try {response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_VERIFY}`, "GET",
        {op: "verify", code: row.verification_code}, true);}
    catch {response = null;}
    states.toast({message: response?.result && response.exists ?
        `Code verifies: ${row.title} v${row.version}, ${response.state}.` :
        "That code does not verify.", ms: 8000});
}

function _printCertificate(row) {
    if (!row) return;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`<!doctype html><html><head><title>Certificate — ${row.title}</title>
        <style>body{font-family:Georgia,serif;max-width:720px;margin:40px auto;padding:0 20px;color:#111}
        h1{font-size:26px}.rule{border-top:1px solid #ccc;margin:24px 0}.mono{font-family:monospace}
        .muted{color:#555}</style></head><body>
        <h1>TeleWorkr — Certificate</h1>
        <p class="muted">This certificate is rendered from the training record, not stored as a file.</p>
        <div class="rule"></div>
        <p><b>Course:</b> ${row.title} (v${row.version})</p>
        <p><b>Issued:</b> ${new Date(row.issued_at*1000).toLocaleDateString(undefined,
            {year:"numeric", month:"long", day:"numeric"})}</p>
        <p><b>Expires:</b> ${row.expires_on || "does not expire"}</p>
        <div class="rule"></div>
        <p class="mono">Verification code: ${row.verification_code}</p>
        <script>window.print()</script></body></html>`);
    win.document.close();
}

async function _export() {
    const record = await _rest("export_record");
    if (!record) return;
    const blob = new Blob([JSON.stringify(record, null, 2)], {type: "application/json"});
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `teleworkr-training-record-${new Date().toISOString().substring(0, 10)}.json`;
    link.click(); URL.revokeObjectURL(link.href);
    states.toast({message: "Training record exported — it leaves with you, which is the point."});
}

// ---------------------------------------------------------------------------
// P6 — assign & track: completion status only, by name, and only that
// ---------------------------------------------------------------------------

async function _track(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 4})}</div>`;
    const board = await _rest("track");
    if (!board) return;

    root.innerHTML = `
        <div class="tr-summary">
            <span class="chip">${board.summary.assigned} assigned</span>
            <span class="chip">${board.summary.complete} complete</span>
            <span class="chip warn">${board.summary.overdue} overdue</span>
            <span class="chip">${board.summary.certificates_expiring} certificates expiring</span>
        </div>
        <div class="tr-card">
            <div class="up t3">Overdue — by name, and only this</div>
            ${board.overdue.length ? board.overdue.map(row => `
                <div class="tr-track-row">
                    <span class="grow"><b>${states.esc(row.name)}</b> · ${states.esc(row.course_code)}</span>
                    <span class="sm t3">${states.esc(row.reason)}${row.source_rule ? ` · ${states.esc(row.source_rule)}` : ""}</span>
                    <span class="sm ${row.state == "overdue" ? "late" : ""}">due ${states.esc(row.effective_due)}${
                        row.leave_days ? ` · ${row.leave_days}d leave` : ""}</span>
                </div>`).join("") :
                `<div class="tr-empty">Fully compliant. Said plainly, not as an empty table.</div>`}
        </div>
        <div class="tr-card">
            <div class="up t3">Certificates expiring</div>
            ${board.expiring.length ? board.expiring.map(row => `
                <div class="tr-track-row"><span class="grow"><b>${states.esc(row.name)}</b> · ${states.esc(row.course_code)}</span>
                    <span class="sm warn">in ${row.days_left} days</span></div>`).join("") :
                `<div class="tr-empty">Nothing expiring soon.</div>`}
        </div>
        <div class="tr-card">
            <div class="up t3">Assign — the exception, not the rule</div>
            <p class="sm t2">Rule-based assignment lands with the day-one checklist. A manual
                assignment carries a reason the person can see.</p>
            <div class="row wrap" style="margin-top:10px">
                <input class="inp" id="tr-assign-course" placeholder="course code" style="width:130px">
                <input class="inp" id="tr-assign-person" placeholder="person id" style="width:200px">
                <input class="inp" id="tr-assign-due" type="date" style="width:150px">
                <input class="inp grow" id="tr-assign-reason" placeholder="reason — shown to the person" style="min-width:220px">
                <button class="btn pri" data-tr="assign">Assign</button>
            </div>
        </div>`;

    root.querySelector("[data-tr=\"assign\"]").addEventListener("click", async _ => {
        const due = root.querySelector("#tr-assign-due").value;
        const reason = root.querySelector("#tr-assign-reason").value.trim();
        if (!due || !reason) {states.toast({message: "A due date and a visible reason are required."}); return;}
        const assigned = await _rest("assign", {course_code: root.querySelector("#tr-assign-course").value.trim(),
            subject_person_id: root.querySelector("#tr-assign-person").value.trim(),
            due_date: due, reason});
        if (assigned) {states.toast({message: "Assigned. The reason is visible to the person."}); _track(root);}
    });
}

// ---------------------------------------------------------------------------

async function _rest(op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_TRAINING}`, "GET",
            {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Training op ${op} failed: ${err}`);}
    if (!response?.result) {states.toast({message: response?.reason || "The training service did not respond.", ms: 8000}); return null;}
    return response;
}

const _ms = total => `${String(Math.floor(total/60)).padStart(2,"0")}:${String(total%60).padStart(2,"0")}`;
