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
        canTrack: caps.includes("training.track"), canPublish: caps.includes("training.publish"),
        course: null, player: null, ticker: null, composerOpen: false, draft: null};
    await _view();
}

async function _view() {
    const root = state.root;
    const tabs = [["catalogue", "Training"], ["certificates", "My certificates"],
        ...(state.canTrack ? [["track", "Assign & track"]] : []),
        ...(state.canPublish ? [["courses", "Courses"]] : [])];
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
        if (state.tab == "courses") return await _courses(view);
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
// P1/P6 — courses: publish a course or a new version, gated on training.publish
// ---------------------------------------------------------------------------

async function _courses(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const board = await _rest("manage_list");
    if (!board) return;
    if (!state.draft) state.draft = _blankCourseDraft();
    _renderCourses(root, board);
}

function _renderCourses(root, board) {
    root.innerHTML = `
        <div class="row"><span class="tr-band-title"><span class="code">Courses you manage</span></span>
            <button class="btn pri push" data-tr="new">${state.composerOpen ? "Close" : "+ New course"}</button></div>
        <div class="tr-card" style="padding:0">
            ${board.courses.length ? board.courses.map(_courseRow).join("") :
                `<div class="tr-empty">No courses published yet.</div>`}
        </div>
        ${state.composerOpen ? _courseComposerHtml(state.draft, board) : ""}`;

    root.querySelector("[data-tr=\"new\"]").addEventListener("click", _ => {
        state.composerOpen = !state.composerOpen; _renderCourses(root, board);});

    for (const row of root.querySelectorAll("[data-course-row]"))
        row.querySelector("[data-tr=\"new-version\"]")?.addEventListener("click", _ => {
            const code = row.getAttribute("data-course-row");
            const existing = board.courses.find(c => c.course_code == code);
            state.draft = _blankCourseDraft();
            if (existing) {
                state.draft.code = existing.course_code; state.draft.title = existing.title;
                state.draft.kind = existing.kind; state.draft.validity_years = existing.validity_years || "";
                state.draft.jurisdictions = (existing.jurisdictions || []).join(", ");
                for (const role of existing.recommended_roles || [])
                    if (role in state.draft.roles) state.draft.roles[role] = true;
            }
            state.composerOpen = true; _renderCourses(root, board);
        });

    if (state.composerOpen) _wireCourseComposer(root, board);
}

const _courseRow = course => `
    <div class="tr-track-row sv-manage-row" data-course-row="${states.esc(course.course_code)}">
        <span class="grow"><b>${states.esc(course.title)}</b> ·
            <span class="chip">${states.esc(course.kind)}</span> · v${course.version}</span>
        <span class="sm t3">${states.esc(course.course_code)} · ${course.modules} module${course.modules == 1 ? "" : "s"} ·
            ~${course.minutes}m · ${course.validity_years ? `certificate valid ${course.validity_years}y` : "no certificate expiry"} ·
            ${course.assigned} assigned</span>
        <span class="sv-manage-actions">
            <button class="btn sm" data-tr="new-version">New version</button>
        </span>
    </div>`;

// -- the composer: a fresh course version, in memory until Publish --

function _blankCourseDraft() {
    return {title: "", code: "", kind: "statutory", validity_years: "", pass_mark: 80,
        jurisdictions: "", roles: {employee: false, lead: false, hr: false, admin: false},
        invalidates: "none", reissue_days: 30, modules: [_blankModule()]};
}
const _blankModule = _ => ({title: "", minutes: 10, questions: []});
const _blankCourseQuestion = _ => ({text: "", options: ["", ""], answer: 0});

function _courseComposerHtml(draft, board) {
    const existing = board.courses.find(c => c.course_code == draft.code);
    return `<div class="tr-card">
        <div class="tr-card-top">
            <div class="grow"><h2 style="font-size:16px">${existing ? `New version of ${states.esc(existing.title)}` : "New course"}</h2>
                <p class="sm t2">Title, a code, modules, and — for a course with questions — a pass mark.${
                    existing ? " Modules aren't carried over from the previous version; re-enter them here." : ""}</p></div>
            <button class="btn" data-tr="composer-close">Close</button>
        </div>

        <div class="row wrap">
            <input class="inp grow" id="tc-title" placeholder="Title" value="${states.esc(draft.title)}">
            <input class="inp" id="tc-code" placeholder="course-code" style="width:170px" value="${states.esc(draft.code)}">
            <select class="inp" id="tc-kind">${board.kinds.map(kind =>
                `<option value="${kind}"${draft.kind == kind ? " selected" : ""}>${states.esc(kind)}</option>`).join("")}</select>
            <input class="inp" id="tc-validity" type="number" min="1" placeholder="certificate validity (years)" style="width:180px" value="${states.esc(draft.validity_years)}">
            <input class="inp" id="tc-passmark" type="number" min="1" max="100" placeholder="pass mark %" style="width:120px" value="${draft.pass_mark}">
        </div>
        <span class="sm t3">Pass mark only matters if a module below has questions — a module with none is read-and-acknowledge.</span>

        <div class="up t3">Audience</div>
        <input class="inp grow" id="tc-juris" placeholder="Jurisdictions this course satisfies, comma-separated — blank means all" value="${states.esc(draft.jurisdictions)}">
        <div class="row wrap">
            ${Object.keys(draft.roles).map(role => `<label class="build-check">
                <input type="checkbox" id="tc-role-${role}"${draft.roles[role] ? " checked" : ""}> ${role}</label>`).join("")}
        </div>
        <span class="sm t3">Recommended-for roles — an invitation, not an obligation, unlike a jurisdiction match.</span>

        ${existing ? `
        <div class="up t3">This code is already published — v${existing.version}</div>
        <div class="row wrap">
            <select class="inp" id="tc-invalidates">${board.invalidations.map(inv =>
                `<option value="${inv}"${draft.invalidates == inv ? " selected" : ""}>${states.esc(inv)}</option>`).join("")}</select>
            ${draft.invalidates == "major" ? `<input class="inp" id="tc-reissue" type="number" min="0" placeholder="reissue in (days)" style="width:170px" value="${draft.reissue_days}">` : ""}
        </div>
        <span class="sm t3">${draft.invalidates == "none" ?
            "Typo fix — nobody retakes, certificates stay valid." : draft.invalidates == "minor" ?
            "Existing certificates stay valid to expiry; new enrolments get this version." :
            "Every live assignment is superseded and reissued with a fresh due date — everyone told why."}</span>` : ""}

        <div class="up t3">Modules</div>
        ${draft.modules.map((module, mi) => _courseModuleHtml(module, mi)).join("")}
        <button class="btn sm" data-tr="add-module">+ Module</button>

        <div class="row">
            <button class="btn pri push" data-tr="publish">Publish…</button>
        </div>
    </div>`;
}

function _courseModuleHtml(module, mi) {
    return `<div class="build-section" data-section="${mi}">
        <div class="row wrap">
            <input class="inp grow" placeholder="Module title" data-mod-title value="${states.esc(module.title)}">
            <input class="inp" type="number" min="0" placeholder="minutes" data-mod-minutes value="${module.minutes}" style="width:100px">
            <button class="btn sm" data-tr="remove-module">Remove module</button>
        </div>
        ${module.questions.map((q, qi) => _courseQuestionHtml(q, mi, qi)).join("")}
        <button class="btn sm" data-tr="add-question">+ Question</button>
    </div>`;
}

function _courseQuestionHtml(q, mi, qi) {
    return `<div class="build-q" data-qi="${qi}">
        <div class="row wrap">
            <input class="inp grow" placeholder="Question text" data-q-text value="${states.esc(q.text)}">
            <button class="btn sm" data-tr="remove-question">Remove</button>
        </div>
        <div class="build-opts">
            ${q.options.map((option, oi) => `<div class="row" data-oi="${oi}">
                <label class="build-check"><input type="radio" name="tc-answer-${mi}-${qi}" data-q-answer${q.answer == oi ? " checked" : ""}> correct</label>
                <input class="inp grow" placeholder="Option ${String.fromCharCode(97 + oi)}" data-q-opt value="${states.esc(option)}">
                ${q.options.length > 2 ? `<button class="btn sm" data-tr="remove-option">×</button>` : ""}
            </div>`).join("")}
            <button class="btn sm" data-tr="add-option">+ Option</button>
        </div>
    </div>`;
}

function _wireCourseComposer(root, board) {
    root.querySelector("[data-tr=\"composer-close\"]").addEventListener("click", _ => {
        state.composerOpen = false; _renderCourses(root, board);});
    root.querySelector("#tc-invalidates")?.addEventListener("change", _ => {
        _syncCourseDraft(root); _renderCourses(root, board);});

    root.querySelector("[data-tr=\"add-module\"]")?.addEventListener("click", _ => {
        _syncCourseDraft(root); state.draft.modules.push(_blankModule()); _renderCourses(root, board);});
    for (const button of root.querySelectorAll("[data-tr=\"remove-module\"]"))
        button.addEventListener("click", _ => {
            const mi = Number(button.closest(".build-section").getAttribute("data-section"));
            _syncCourseDraft(root); state.draft.modules.splice(mi, 1); _renderCourses(root, board);});
    for (const button of root.querySelectorAll("[data-tr=\"add-question\"]"))
        button.addEventListener("click", _ => {
            const mi = Number(button.closest(".build-section").getAttribute("data-section"));
            _syncCourseDraft(root); state.draft.modules[mi].questions.push(_blankCourseQuestion()); _renderCourses(root, board);});
    for (const button of root.querySelectorAll("[data-tr=\"remove-question\"]"))
        button.addEventListener("click", _ => {
            const mi = Number(button.closest(".build-section").getAttribute("data-section"));
            const qi = Number(button.closest(".build-q").getAttribute("data-qi"));
            _syncCourseDraft(root); state.draft.modules[mi].questions.splice(qi, 1); _renderCourses(root, board);});
    for (const button of root.querySelectorAll("[data-tr=\"add-option\"]"))
        button.addEventListener("click", _ => {
            const mi = Number(button.closest(".build-section").getAttribute("data-section"));
            const qi = Number(button.closest(".build-q").getAttribute("data-qi"));
            _syncCourseDraft(root); state.draft.modules[mi].questions[qi].options.push(""); _renderCourses(root, board);});
    for (const button of root.querySelectorAll("[data-tr=\"remove-option\"]"))
        button.addEventListener("click", _ => {
            const mi = Number(button.closest(".build-section").getAttribute("data-section"));
            const qi = Number(button.closest(".build-q").getAttribute("data-qi"));
            const oi = Number(button.closest("[data-oi]").getAttribute("data-oi"));
            _syncCourseDraft(root);
            const q = state.draft.modules[mi].questions[qi];
            if (oi === q.answer) q.answer = 0;         // the removed option was correct — fall back
            else if (oi < q.answer) q.answer -= 1;      // options after it shift down by one
            q.options.splice(oi, 1);
            _renderCourses(root, board);});

    root.querySelector("[data-tr=\"publish\"]")?.addEventListener("click", _ => _doCoursePublish(root, board));
}

// reads the composer's plain DOM inputs back into state.draft — same
// read-on-demand shape the assign form above uses, for a nested structure
function _syncCourseDraft(root) {
    const d = state.draft;
    const field = id => root.querySelector(`#${id}`);
    if (field("tc-title")) d.title = field("tc-title").value;
    if (field("tc-code")) d.code = field("tc-code").value.trim().toLowerCase();
    if (field("tc-kind")) d.kind = field("tc-kind").value;
    if (field("tc-validity")) d.validity_years = field("tc-validity").value;
    if (field("tc-passmark")) d.pass_mark = field("tc-passmark").value;
    if (field("tc-juris")) d.jurisdictions = field("tc-juris").value;
    for (const role of Object.keys(d.roles)) if (field(`tc-role-${role}`)) d.roles[role] = field(`tc-role-${role}`).checked;
    if (field("tc-invalidates")) d.invalidates = field("tc-invalidates").value;
    if (field("tc-reissue")) d.reissue_days = field("tc-reissue").value;

    for (const modEl of root.querySelectorAll(".build-section")) {
        const module = d.modules[Number(modEl.getAttribute("data-section"))];
        if (!module) continue;
        const title = modEl.querySelector("[data-mod-title]"); if (title) module.title = title.value;
        const minutes = modEl.querySelector("[data-mod-minutes]"); if (minutes) module.minutes = minutes.value;
        for (const qEl of modEl.querySelectorAll(".build-q")) {
            const q = module.questions[Number(qEl.getAttribute("data-qi"))];
            if (!q) continue;
            q.text = qEl.querySelector("[data-q-text]")?.value ?? q.text;
            for (const optEl of qEl.querySelectorAll("[data-oi]")) {
                const oi = Number(optEl.getAttribute("data-oi"));
                const input = optEl.querySelector("[data-q-opt]");
                if (input) q.options[oi] = input.value;
                if (optEl.querySelector("[data-q-answer]")?.checked) q.answer = oi;
            }
        }
    }
}

async function _doCoursePublish(root, board) {
    _syncCourseDraft(root);
    const d = state.draft;
    if (!d.title.trim()) {states.toast({message: "A course needs a title."}); return;}
    if (!/^[a-z0-9-]{2,64}$/.test(d.code)) {
        states.toast({message: "The code must be lowercase letters, digits and dashes (2-64)."}); return;}
    if (!d.modules.length) {states.toast({message: "A course needs at least one module."}); return;}

    const modules = d.modules.map((module, mi) => {
        const minutes = Number(module.minutes);
        const built = {id: `m${mi + 1}`, title: module.title.trim() || `Module ${mi + 1}`,
            minutes: Number.isInteger(minutes) && minutes >= 0 ? minutes : 0};
        const questions = module.questions.filter(q => q.text.trim());
        if (questions.length) built.questions = questions.map((q, qi) => {
            // resolve the answer's code before filtering blanks out — filtering
            // shifts array indices, so looking answer up by index afterwards
            // would silently point at the wrong option once any earlier option
            // in the list is blank
            const mapped = q.options.map((text, oi) => ({code: String.fromCharCode(97 + oi), text: text.trim()}));
            const answerCode = mapped[q.answer]?.code;
            const options = mapped.filter(option => option.text);
            return {id: `m${mi + 1}q${qi + 1}`, text: q.text.trim(), type: "choice", options,
                answer: options.some(option => option.code == answerCode) ? answerCode : options[0]?.code};
        });
        return built;
    });
    const hasQuestions = modules.some(module => (module.questions || []).length);
    const passMark = Number(d.pass_mark);
    if (hasQuestions && (!Number.isInteger(passMark) || passMark < 1 || passMark > 100)) {
        states.toast({message: "A course with questions needs a pass mark between 1 and 100."}); return;
    }

    const request = {course_code: d.code, title: d.title.trim(), kind: d.kind, modules,
        jurisdictions: d.jurisdictions.split(",").map(j => j.trim()).filter(Boolean),
        recommended_roles: Object.entries(d.roles).filter(([, on]) => on).map(([role]) => role)};
    if (d.validity_years) request.validity_years = Number(d.validity_years);
    if (hasQuestions) request.pass_mark = passMark;
    if (board.courses.some(c => c.course_code == d.code)) {
        request.invalidates = d.invalidates;
        if (d.invalidates == "major") request.reissue_days = Number(d.reissue_days) || 30;
    }

    const response = await _rest("publish", request);
    if (!response) return;
    states.toast({message: `Published — v${response.version}.${response.reassigned ?
        ` ${response.reassigned} live assignment${response.reassigned == 1 ? "" : "s"} reissued.` : ""}`, ms: 9000});
    state.draft = null; state.composerOpen = false;
    await _courses(root);
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
