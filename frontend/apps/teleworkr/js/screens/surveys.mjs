/**
 * Q — the surveys screen: the list with the brief (Q2), the questionnaire
 * (Q3), the results (Q4), and — for holders of survey.publish — build &
 * publish (Q5).
 *
 * The anonymity contract is the screen's spine. The mode is stated in the
 * list, restated in the footer of every questionnaire page, and its
 * consequences are not softened: in anonymous mode nobody can remind you and
 * you cannot withdraw an answer; in confidential mode there is no link back
 * to your response, which is the whole guarantee. Q5 keeps that contract
 * structural on the authoring side too: mode copy is read off the API
 * (mode_contracts), never hardcoded here, and the mode radio is disabled
 * nowhere near a live survey — it simply cannot be resent after publish.
 *
 * Save-as-you-go: each answer posts immediately under a deterministic
 * client_event_id, so a dropped connection retries idempotently and a
 * failed submission never re-asks a question already answered.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";
import {questionCard} from "../../components/question-card/question-card.mjs";
import {distribution} from "../../components/distribution/distribution.mjs";

const API = "surveys";
const TOKEN_REGISTRY = "__tw_survey_tokens";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _today = _ => new Date().toISOString().substring(0, 10);

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    const caps = (await import("../shell.mjs")).shell.projection?.capabilities || [];
    state = {root, tab: "surveys", view: "list", code: null, token: null,
        canManage: caps.includes("survey.publish"), composerOpen: false, previewOpen: false, draft: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page sv">
        ${state.canManage ? `<div class="tr-tabs">
            <button class="tr-tab${state.tab == "surveys" ? " on" : ""}" data-sv="tab" data-tab="surveys">Surveys</button>
            <button class="tr-tab${state.tab == "manage" ? " on" : ""}" data-sv="tab" data-tab="manage">Build &amp; publish</button>
        </div>` : ""}
        <div id="sv-view"></div>
    </div>`;
    if (state.canManage) for (const button of root.querySelectorAll("[data-sv=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab");
            state.view = "list"; state.code = null; _view();});

    const view = root.querySelector("#sv-view");
    try {
        if (state.tab == "manage") return await _manage(view);
        if (state.view == "take") return await _questionnaire(view);
        if (state.view == "results") return await _results(view);
        return await _list(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load surveys",
            what: err.message, safe: "Your answers are saved as you go.",
            reference: `Q-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// Q2 — the list, and the brief
// ---------------------------------------------------------------------------

async function _list(root) {
    root.innerHTML = `<div class="sv-band">${states.loading({rows: 4})}</div>`;
    const response = await _rest("list", {tokens: _tokens()});
    if (!response) return;

    root.innerHTML = `
        <div class="sv-note">Surveys sit beside training under one Assigned group —
            from your side both are the same thing: something the organisation has
            asked of you, with a deadline.</div>
        <div class="sv-band">
            <div class="tr-band-title"><span class="code">Open to you</span></div>
            ${response.open.length ? response.open.map(_openCard).join("") :
                `<div class="tr-empty">Nothing open right now.</div>`}
        </div>
        <div class="sv-band">
            <div class="tr-band-title"><span class="code">Closed</span></div>
            ${response.closed.length ? response.closed.map(_closedCard).join("") :
                `<div class="tr-empty">No past surveys yet.</div>`}
        </div>`;

    for (const button of root.querySelectorAll("[data-sv=\"take\"]"))
        button.addEventListener("click", _ => _open(button.getAttribute("data-code")));
    for (const button of root.querySelectorAll("[data-sv=\"results\"]"))
        button.addEventListener("click", _ => {state.view = "results";
            state.code = button.getAttribute("data-code"); state.token = null; _view();});
}

const _openCard = survey => `
    <div class="sv-card">
        <div class="sv-card-top">
            <span class="sv-mode m-${survey.mode}">${states.esc(survey.mode_contract.label)}</span>
            <span class="t2 sm">${survey.questions} questions · ~${survey.minutes} min</span>
            <span class="push"></span>
            <span class="t2 sm">Closes ${states.esc(survey.closes_on)}</span>
        </div>
        <h3>${states.esc(survey.title)}</h3>
        <div class="sv-brief">
            <p class="sm"><b>Who sees it</b> — ${states.esc(survey.brief.who_sees)}</p>
            <p class="sm"><b>How long</b> — about ${survey.brief.minutes} minutes. Save and come back; your place is kept.</p>
            <p class="sm"><b>Is it optional</b> — ${states.esc(survey.brief.optional)}</p>
            <p class="sm"><b>What happens next</b> — ${states.esc(survey.brief.what_happens_next)}</p>
            <p class="sm"><b>Reminders</b> — ${states.esc(survey.brief.reminders)}</p>
        </div>
        <div class="row">
            ${survey.progress.answered_count ?
                `<span class="t2 sm">${survey.progress.answered_count} of ${survey.progress.question_total} answered</span>` : ""}
            <button class="btn pri push" data-sv="take" data-code="${states.esc(survey.survey_code)}">${
                survey.progress.answered_count ? "Resume" : "Start"}</button>
        </div>
    </div>`;

const _closedCard = survey => `
    <div class="sv-card closed">
        <div class="sv-card-top">
            <span class="sv-mode m-${survey.mode}">${states.esc(survey.mode_contract.label)}</span>
            <span class="t2 sm">Closed ${states.esc(survey.closes_on)}</span>
            <span class="push"></span>
            <span class="t2 sm">${survey.progress.submitted ? "you responded" : "you didn't respond"}</span>
        </div>
        <h3>${states.esc(survey.title)}</h3>
        <div class="row">
            ${survey.status == "results_published" || survey.status == "closed" ?
                `<span class="t2 sm">Results are visible to everyone who was asked.</span>` : ""}
            ${survey.status == "results_published" || survey.status == "closed" ?
                `<button class="btn push" data-sv="results" data-code="${states.esc(survey.survey_code)}">See results</button>` :
                `<span class="t3 sm push">results not published</span>`}
        </div>
    </div>`;

// ---------------------------------------------------------------------------
// Q3 — the questionnaire: save as you go, skip is deliberate
// ---------------------------------------------------------------------------

async function _open(code) {
    state.view = "take"; state.code = code; state.token = _token(code);
    await _view();
}

async function _questionnaire(root) {
    const code = state.code, token = state.token;
    root.innerHTML = `<div class="sv-band">${states.loading({rows: 4})}</div>`;
    const response = await _rest("survey", {survey_code: code, token});
    if (!response) return;

    const answered = new Set(response.progress.answered);
    const skipped = new Set(response.progress.skipped);
    let questionIndex = 0;

    root.innerHTML = `
        <button class="tr-back" data-sv="exit">← Surveys</button>
        <div class="sv-take">
            <div class="sv-take-head">
                <div class="grow"><h2>${states.esc(response.survey.title)}</h2>
                    <span class="sv-mode m-${response.survey.mode}">${states.esc(
                        response.footer.split(".")[0].split("—")[0] || "Survey")}</span></div>
                <span class="t2 sm">Closes ${states.esc(response.survey.closes_on)}</span>
            </div>
            <div class="tr-bar"><span id="sv-bar-fill"></span></div>
            ${response.sections.map(section => `
                <div class="sv-section">
                    <div class="up t3">${states.esc(section.title)}</div>
                    ${section.questions.map(question => {
                        const qIndex = ++questionIndex;
                        return `<div style="margin:12px 0">${questionCard.render(question, {
                            index: qIndex, answered: answered.has(question.id),
                            skipped: skipped.has(question.id), skipAllowed: !question.required,
                            freeTextWarning: response.free_text_warning})}
                            ${answered.has(question.id) && !skipped.has(question.id) ?
                                `<div class="sv-saved">Saved</div>` : ""}</div>`;
                    }).join("")}
                </div>`).join("")}
            <div class="sv-footer">
                <p class="sm">${states.esc(response.footer)}</p>
                ${response.note ? `<p class="sm t3">${states.esc(response.note)}</p>` : ""}
            </div>
            <div class="sv-submit">
                ${response.required_remaining ?
                    `<span class="t2 sm">${response.required_remaining} required question${
                        response.required_remaining == 1 ? "" : "s"} unanswered</span>` : ""}
                <button class="btn pri" data-sv="submit" ${response.required_remaining ? "disabled" : ""}>Submit</button>
            </div>
        </div>`;

    root.querySelector("[data-sv=\"exit\"]").addEventListener("click", _ => {state.view = "list"; state.code = null; _view();});
    const bar = root.querySelector("#sv-bar-fill");
    const total = response.progress.question_total;
    const counted = new Set(answered);
    const paintBar = _ => {bar.style.width = `${Math.min(100, Math.round(counted.size/total*100))}%`;};
    paintBar();

    // save as you go: deterministic client ids, so a retry replays the same
    // event and never duplicates — answer and skip use different ids so a
    // person can change their mind without tripping the idempotency key
    const save = async payload => {try {await _rest("save_answer", payload);} catch {}};
    const markSaved = holder => {
        if (!holder.querySelector(".sv-saved")) {
            const chip = document.createElement("div");
            chip.className = "sv-saved"; chip.textContent = "Saved";
            holder.appendChild(chip);
        }
    };

    for (const card of root.querySelectorAll("[data-question]")) {
        questionCard.wire(card, changed => {
            const questionId = card.getAttribute("data-question");
            if (changed?.skipped) {
                counted.add(questionId); paintBar();
                save({survey_code: code, token, question_id: questionId, skipped: true,
                    client_event_id: `${token}-${questionId}-skip`});
            } else if (changed?.value !== undefined) {
                counted.add(questionId); paintBar(); markSaved(card.parentElement);
                save({survey_code: code, token, question_id: questionId, value: changed.value,
                    client_event_id: `${token}-${questionId}`});
            } else if (changed?.cleared) {
                counted.delete(questionId); paintBar();
            }
        });
    }

    root.querySelector("[data-sv=\"submit\"]").addEventListener("click", async _ => {
        const hasFreeText = response.sections.some(section => section.questions.some(q => q.type == "text"));
        const confirmed = await states.confirmAction({
            title: "Submit the survey?",
            body: response.survey.mode == "attributed" ?
                "Your name is attached to your answers, and you can change them until close." :
                "You cannot change or withdraw your answers afterwards — there is no link back to your response, which is the whole guarantee.",
            collateral: hasFreeText ? [response.free_text_warning] : [],
            confirmLabel: "Submit"});
        if (!confirmed) return;
        const submitted = await _rest("submit", {survey_code: code, token});
        if (!submitted) return;
        states.toast({message: submitted.results_publish_on ?
            `Submitted. Results will be published by ${submitted.results_publish_on}.` : "Submitted."});
        state.view = "list"; state.code = null;
        await _view();
    });
}

// ---------------------------------------------------------------------------
// Q4 — results, aggregate by construction
// ---------------------------------------------------------------------------

async function _results(root) {
    const code = state.code;
    root.innerHTML = `<div class="sv-band">${states.loading({rows: 4})}</div>`;
    let response;
    try {response = await _rest("results", {survey_code: code});}
    catch (err) {response = {reason: err.message};}
    if (!response || !response.floor_met) {
        root.innerHTML = `
            <button class="tr-back" data-sv="exit">← Surveys</button>
            ${distribution.refusal({message: response?.reason || "Results are not available."})}`;
        root.querySelector("[data-sv=\"exit\"]").addEventListener("click", _ => {state.view = "list"; _view();});
        return;
    }

    root.innerHTML = `
        <button class="tr-back" data-sv="exit">← Surveys</button>
        <div class="sv-card">
            <div class="sv-card-top">
                <span class="sv-mode m-${response.survey.mode}">${states.esc(
                    response.survey.mode)}</span>
                <span class="t2 sm">Closed ${states.esc(response.survey.closes_on)}</span>
                <span class="push"></span>
                ${distribution.responseRate(response.response_rate)}
            </div>
            <h2 style="margin-top:8px">${states.esc(response.survey.title)}</h2>
            ${response.owner_response ? `
                <div class="sv-owner">
                    <div class="up t3">What we're doing about it</div>
                    <p class="sm" style="margin-top:6px">${states.esc(response.owner_response)}</p>
                </div>` : response.owner_response_missing ? `
                <div class="sv-owner missing">
                    <p class="sm">Results were published without an owner response — flagged,
                        because it is the most reliable way to reduce the next response rate.</p>
                </div>` : ""}
        </div>
        <div class="sv-band">
            <div class="tr-band-title"><span class="code">Distribution, never a list</span>
                <span class="t2 sm">counts, not an average — the split is the finding${
                    response.runs < 3 ? ` · no trend line until three runs exist (this is run ${response.runs})` : ""}</span></div>
            ${response.distributions.length ? response.distributions.map(distribution.question).join("") :
                `<div class="tr-empty">Zero responses say so — this panel does not render an empty chart.</div>`}
        </div>
        ${response.free_text ? `
        <div class="sv-band">
            <div class="tr-band-title"><span class="code">Free text — the careful part</span>
                <span class="t2 sm">readable by the named owner only · every read is logged · never quoted by the product</span></div>
            ${response.free_text.map(item => `<div class="sv-freetext sm">${states.esc(item.value)}</div>`).join("")}
        </div>` : ""}`;
    root.querySelector("[data-sv=\"exit\"]").addEventListener("click", _ => {state.view = "list"; _view();});
}

// ---------------------------------------------------------------------------
// Q5 — build & publish: the owner's tools, gated on survey.publish
// ---------------------------------------------------------------------------

async function _manage(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 3})}</div>`;
    const board = await _rest("manage_list");
    if (!board) return;
    if (!state.draft) state.draft = _blankDraft();
    _renderManage(root, board);
}

function _renderManage(root, board) {
    root.innerHTML = `
        <div class="row"><span class="tr-band-title"><span class="code">Surveys you manage</span></span>
            <button class="btn pri push" data-sv="new">${state.composerOpen ? "Close" : "+ New survey"}</button></div>
        <div class="tr-card" style="padding:0">
            ${board.surveys.length ? board.surveys.map(_manageRow).join("") :
                `<div class="tr-empty">No surveys published yet.</div>`}
        </div>
        ${state.composerOpen ? _composerHtml(state.draft, board.mode_contracts) : ""}
        ${state.composerOpen && state.previewOpen ? _previewHtml(state.draft) : ""}`;

    root.querySelector("[data-sv=\"new\"]").addEventListener("click", _ => {
        state.composerOpen = !state.composerOpen; state.previewOpen = false; _renderManage(root, board);});

    for (const row of root.querySelectorAll("[data-manage-row]")) {
        const code = row.getAttribute("data-manage-row");
        row.querySelector("[data-sv=\"extend\"]")?.addEventListener("click", async _ => {
            const value = row.querySelector("[data-sv-extend]").value;
            if (!value) {states.toast({message: "Pick a new close date."}); return;}
            try {await _rest("extend_close", {survey_code: code, new_closes_on: value});} catch {return;}
            states.toast({message: "Close date extended."}); await _manage(root);
        });
        row.querySelector("[data-sv=\"results\"]")?.addEventListener("click", _ => {
            state.tab = "surveys"; state.view = "results"; state.code = code; _view();});
        row.querySelector("[data-sv=\"publish-results\"]")?.addEventListener("click", async _ => {
            const ownerResponse = row.querySelector("[data-sv-response]").value;
            try {await _rest("publish_results", {survey_code: code, owner_response: ownerResponse});} catch {return;}
            states.toast({message: "Results published."}); await _manage(root);
        });
        row.querySelector("[data-sv=\"withdraw\"]")?.addEventListener("click", async _ => {
            const reason = row.querySelector("[data-sv-reason]").value.trim();
            if (!reason) {states.toast({message: "A withdrawal needs a reason — it's announced, not silent."}); return;}
            const confirmed = await states.confirmDestructive({title: "Withdraw this survey?",
                body: "Responses are destroyed immediately and this cannot be undone.", confirmLabel: "Withdraw"});
            if (!confirmed) return;
            try {await _rest("withdraw", {survey_code: code, reason});} catch {return;}
            states.toast({message: "Withdrawn."}); await _manage(root);
        });
    }

    if (state.composerOpen) _wireComposer(root, board);
}

const _manageRow = survey => `
    <div class="tr-track-row sv-manage-row" data-manage-row="${states.esc(survey.survey_code)}">
        <span class="grow"><b>${states.esc(survey.title)}</b> ·
            <span class="sv-mode m-${survey.mode}">${states.esc(survey.mode)}</span> ·
            <span class="sm t3">${states.esc(survey.status.replace(/_/g, " "))}</span></span>
        <span class="sm t3">${survey.responded}${survey.invited != null ? ` of ${survey.invited}` : ""} responded ·
            closes ${states.esc(survey.closes_on)}${survey.withdrawn_reason ?
                ` · withdrawn: ${states.esc(survey.withdrawn_reason)}` : ""}</span>
        <span class="sv-manage-actions">
            ${survey.status == "published" ? `
                <input class="inp" type="date" data-sv-extend style="width:145px">
                <button class="btn sm" data-sv="extend">Extend</button>` : ""}
            ${(survey.status == "closed" || survey.status == "results_published") ?
                `<button class="btn sm" data-sv="results">Results</button>` : ""}
            ${survey.status == "closed" ? `
                <input class="inp" data-sv-response placeholder="What we're doing about it">
                <button class="btn sm pri" data-sv="publish-results">Publish results</button>` : ""}
            ${survey.status != "withdrawn" ? `
                <input class="inp" data-sv-reason placeholder="reason" style="width:110px">
                <button class="btn sm danger" data-sv="withdraw">Withdraw</button>` : ""}
        </span>
    </div>`;

// -- the composer: a fresh survey, in memory until Publish --

function _blankDraft() {
    return {title: "", code: "", mode: "confidential", opens_on: _today(), closes_on: "",
        jurisdictions: "", roles: {employee: false, lead: false, hr: false, admin: false},
        include_contractors: false, sections: [_blankSection()]};
}
const _blankSection = _ => ({title: "", questions: [_blankQuestion()]});
const _blankQuestion = _ => ({type: "scale", text: "", required: false,
    low: "1 disagree", high: "5 agree", choices: ["", ""]});

function _composerHtml(draft, modeContracts) {
    return `<div class="tr-card">
        <div class="tr-card-top">
            <div class="grow"><h2 style="font-size:16px">New survey</h2>
                <p class="sm t2">Title, a code, a mode fixed for good, an audience, and at least one question.</p></div>
            <button class="btn" data-sv="composer-close">Close</button>
        </div>

        <div class="row wrap">
            <input class="inp grow" id="sv-b-title" placeholder="Title" value="${states.esc(draft.title)}">
            <input class="inp" id="sv-b-code" placeholder="survey-code" style="width:180px" value="${states.esc(draft.code)}">
            <input class="inp" type="date" id="sv-b-opens" style="width:150px" value="${draft.opens_on}">
            <input class="inp" type="date" id="sv-b-closes" style="width:150px" value="${draft.closes_on}">
        </div>

        <div class="up t3">Mode — fixed at publish, cannot change afterwards</div>
        <div class="sv-mode-pick">
            ${Object.entries(modeContracts).map(([key, contract]) => `
                <label class="sv-mode-opt${draft.mode == key ? " on" : ""}">
                    <input type="radio" name="sv-b-mode" value="${key}"${draft.mode == key ? " checked" : ""}>
                    <span><b>${states.esc(contract.label)}</b><br><span class="sm t3">${states.esc(contract.promise)}</span></span>
                </label>`).join("")}
        </div>

        <div class="up t3">Audience</div>
        <input class="inp grow" id="sv-b-juris" placeholder="Jurisdictions, comma-separated — blank means everyone" value="${states.esc(draft.jurisdictions)}">
        <div class="row wrap">
            ${Object.keys(draft.roles).map(role => `<label class="build-check">
                <input type="checkbox" id="sv-b-role-${role}"${draft.roles[role] ? " checked" : ""}> ${role}</label>`).join("")}
            <label class="build-check"><input type="checkbox" id="sv-b-contractors"${draft.include_contractors ? " checked" : ""}> include contractors</label>
        </div>
        <span class="sm t3">Contractors are excluded by default.</span>

        <div class="up t3">Questions</div>
        ${draft.sections.map((section, si) => _sectionHtml(section, si)).join("")}
        <button class="btn sm" data-sv="add-section">+ Section</button>

        <div class="row">
            <button class="btn" data-sv="preview">Preview as respondent</button>
            <button class="btn pri push" data-sv="publish">Publish…</button>
        </div>
    </div>`;
}

function _sectionHtml(section, si) {
    return `<div class="build-section" data-section="${si}">
        <div class="row">
            <input class="inp grow" placeholder="Section title" data-sec-title value="${states.esc(section.title)}">
            <button class="btn sm" data-sv="remove-section">Remove section</button>
        </div>
        ${section.questions.map((q, qi) => _questionHtml(q, qi)).join("")}
        <button class="btn sm" data-sv="add-question">+ Question</button>
    </div>`;
}

function _questionHtml(q, qi) {
    return `<div class="build-q" data-qi="${qi}">
        <div class="row wrap">
            <input class="inp grow" placeholder="Question text" data-q-text value="${states.esc(q.text)}">
            <select class="inp" data-q-type>
                <option value="scale"${q.type == "scale" ? " selected" : ""}>Scale 1–5</option>
                <option value="choice"${q.type == "choice" ? " selected" : ""}>Choice</option>
                <option value="text"${q.type == "text" ? " selected" : ""}>Free text</option>
            </select>
            <label class="build-check"><input type="checkbox" data-q-required${q.required ? " checked" : ""}> required</label>
            <button class="btn sm" data-sv="remove-question">Remove</button>
        </div>
        ${q.type == "scale" ? `<div class="row">
            <input class="inp grow" placeholder="Low label — e.g. 1 disagree" data-q-low value="${states.esc(q.low)}">
            <input class="inp grow" placeholder="High label — e.g. 5 agree" data-q-high value="${states.esc(q.high)}">
        </div>` : ""}
        ${q.type == "choice" ? `<div class="build-opts">
            ${q.choices.map((choice, ci) => `<div class="row" data-oi="${ci}">
                <input class="inp grow" placeholder="Option ${String.fromCharCode(97 + ci)}" data-q-opt value="${states.esc(choice)}">
                ${q.choices.length > 2 ? `<button class="btn sm" data-sv="remove-option">×</button>` : ""}
            </div>`).join("")}
            <button class="btn sm" data-sv="add-option">+ Option</button>
        </div>` : ""}
        ${q.type == "text" ? `<span class="sm t3">Free-text answers show the respondent a warning before submission.</span>` : ""}
    </div>`;
}

function _previewHtml(draft) {
    let index = 0;
    return `<div class="tr-card">
        <div class="up t3">Preview — as a respondent would see it</div>
        <span class="sv-mode m-${draft.mode}">${states.esc(draft.mode)}</span>
        ${draft.sections.map(section => `<div class="sv-section">
            <div class="up t3">${states.esc(section.title || "Untitled section")}</div>
            ${section.questions.map(q => questionCard.render({
                id: `preview-${++index}`, text: q.text || "(question text)", type: q.type,
                required: q.required, free_text: q.type == "text",
                options: q.type == "scale" ? [1, 2, 3, 4, 5].map(v => ({value: v,
                        label: v == 1 ? (q.low || "1") : v == 5 ? (q.high || "5") : String(v)})) :
                    q.type == "choice" ? q.choices.filter(c => c.trim()).map((c, ci) =>
                        ({code: String.fromCharCode(97 + ci), text: c})) : []
            }, {index, skipAllowed: false})).join("")}
        </div>`).join("")}
    </div>`;
}

function _wireComposer(root, board) {
    root.querySelector("[data-sv=\"composer-close\"]").addEventListener("click", _ => {
        state.composerOpen = false; state.previewOpen = false; _renderManage(root, board);});

    for (const input of root.querySelectorAll("input[name=\"sv-b-mode\"]"))
        input.addEventListener("change", _ => {_syncDraft(root); _renderManage(root, board);});
    for (const select of root.querySelectorAll("[data-q-type]"))
        select.addEventListener("change", _ => {_syncDraft(root); _renderManage(root, board);});

    root.querySelector("[data-sv=\"add-section\"]")?.addEventListener("click", _ => {
        _syncDraft(root); state.draft.sections.push(_blankSection()); _renderManage(root, board);});
    for (const button of root.querySelectorAll("[data-sv=\"remove-section\"]"))
        button.addEventListener("click", _ => {
            const si = Number(button.closest(".build-section").getAttribute("data-section"));
            _syncDraft(root); state.draft.sections.splice(si, 1); _renderManage(root, board);});
    for (const button of root.querySelectorAll("[data-sv=\"add-question\"]"))
        button.addEventListener("click", _ => {
            const si = Number(button.closest(".build-section").getAttribute("data-section"));
            _syncDraft(root); state.draft.sections[si].questions.push(_blankQuestion()); _renderManage(root, board);});
    for (const button of root.querySelectorAll("[data-sv=\"remove-question\"]"))
        button.addEventListener("click", _ => {
            const si = Number(button.closest(".build-section").getAttribute("data-section"));
            const qi = Number(button.closest(".build-q").getAttribute("data-qi"));
            _syncDraft(root); state.draft.sections[si].questions.splice(qi, 1); _renderManage(root, board);});
    for (const button of root.querySelectorAll("[data-sv=\"add-option\"]"))
        button.addEventListener("click", _ => {
            const si = Number(button.closest(".build-section").getAttribute("data-section"));
            const qi = Number(button.closest(".build-q").getAttribute("data-qi"));
            _syncDraft(root); state.draft.sections[si].questions[qi].choices.push(""); _renderManage(root, board);});
    for (const button of root.querySelectorAll("[data-sv=\"remove-option\"]"))
        button.addEventListener("click", _ => {
            const si = Number(button.closest(".build-section").getAttribute("data-section"));
            const qi = Number(button.closest(".build-q").getAttribute("data-qi"));
            const ci = Number(button.closest("[data-oi]").getAttribute("data-oi"));
            _syncDraft(root); state.draft.sections[si].questions[qi].choices.splice(ci, 1); _renderManage(root, board);});

    root.querySelector("[data-sv=\"preview\"]")?.addEventListener("click", _ => {
        _syncDraft(root); state.previewOpen = !state.previewOpen; _renderManage(root, board);});
    root.querySelector("[data-sv=\"publish\"]")?.addEventListener("click", _ => _doPublish(root, board));
}

// reads the composer's plain DOM inputs back into state.draft — the same
// read-on-demand shape P6's assign form uses, just for a nested structure
function _syncDraft(root) {
    const d = state.draft;
    const field = id => root.querySelector(`#${id}`);
    if (field("sv-b-title")) d.title = field("sv-b-title").value;
    if (field("sv-b-code")) d.code = field("sv-b-code").value.trim().toLowerCase();
    if (field("sv-b-opens")) d.opens_on = field("sv-b-opens").value;
    if (field("sv-b-closes")) d.closes_on = field("sv-b-closes").value;
    if (field("sv-b-juris")) d.jurisdictions = field("sv-b-juris").value;
    const modeInput = root.querySelector("input[name=\"sv-b-mode\"]:checked");
    if (modeInput) d.mode = modeInput.value;
    for (const role of Object.keys(d.roles)) if (field(`sv-b-role-${role}`)) d.roles[role] = field(`sv-b-role-${role}`).checked;
    if (field("sv-b-contractors")) d.include_contractors = field("sv-b-contractors").checked;

    for (const secEl of root.querySelectorAll(".build-section")) {
        const section = d.sections[Number(secEl.getAttribute("data-section"))];
        if (!section) continue;
        const title = secEl.querySelector("[data-sec-title]");
        if (title) section.title = title.value;
        for (const qEl of secEl.querySelectorAll(".build-q")) {
            const q = section.questions[Number(qEl.getAttribute("data-qi"))];
            if (!q) continue;
            q.text = qEl.querySelector("[data-q-text]")?.value ?? q.text;
            q.type = qEl.querySelector("[data-q-type]")?.value ?? q.type;
            q.required = qEl.querySelector("[data-q-required]")?.checked ?? q.required;
            const low = qEl.querySelector("[data-q-low]"); if (low) q.low = low.value;
            const high = qEl.querySelector("[data-q-high]"); if (high) q.high = high.value;
            for (const optEl of qEl.querySelectorAll("[data-oi]")) {
                const opt = optEl.querySelector("[data-q-opt]");
                if (opt) q.choices[Number(optEl.getAttribute("data-oi"))] = opt.value;
            }
        }
    }
}

async function _doPublish(root, board) {
    _syncDraft(root);
    const d = state.draft;
    if (!d.title.trim()) {states.toast({message: "A survey needs a title."}); return;}
    if (!/^[a-z0-9-]{2,64}$/.test(d.code)) {
        states.toast({message: "The code must be lowercase letters, digits and dashes (2-64)."}); return;}
    if (!d.opens_on || !d.closes_on) {states.toast({message: "Set both the open and close dates."}); return;}

    const sections = d.sections.map((section, si) => ({
        id: `s${si + 1}`, title: section.title.trim() || `Section ${si + 1}`,
        questions: section.questions.map((q, qi) => {
            const question = {id: `s${si + 1}q${qi + 1}`, text: q.text.trim(), type: q.type, required: Boolean(q.required)};
            if (q.type == "scale") question.options = [1, 2, 3, 4, 5].map(v => ({value: v,
                label: v == 1 ? (q.low.trim() || "1") : v == 5 ? (q.high.trim() || "5") : String(v)}));
            else if (q.type == "choice") question.options = q.choices.filter(c => c.trim())
                .map((c, ci) => ({code: String.fromCharCode(97 + ci), text: c.trim()}));
            return question;
        })}));

    const audience = {include_contractors: d.include_contractors};
    const jurisdictions = d.jurisdictions.split(",").map(j => j.trim()).filter(Boolean);
    if (jurisdictions.length) audience.jurisdictions = jurisdictions;
    const roles = Object.entries(d.roles).filter(([, on]) => on).map(([role]) => role);
    if (roles.length) audience.roles = roles;

    let response;
    try {response = await _rest("publish", {survey_code: d.code, title: d.title.trim(), mode: d.mode,
        sections, audience, opens_on: d.opens_on, closes_on: d.closes_on});}
    catch {return;}
    states.toast({message: `Published — ${response.invited} invited.${response.warnings?.length ?
        ` ${response.warnings.map(w => w.message).join(" ")}` : ""}`, ms: 9000});
    state.draft = _blankDraft(); state.composerOpen = false; state.previewOpen = false;
    await _manage(root);
}

// ---------------------------------------------------------------------------
// tokens: the client-held resume keys, kept out of the server's hands
// ---------------------------------------------------------------------------

const _tokens = _ => {try {return JSON.parse(localStorage.getItem(TOKEN_REGISTRY) || "{}");}
    catch {return {};}};

function _token(code) {
    const registry = _tokens();
    if (!registry[code]) {
        registry[code] = crypto.randomUUID();
        localStorage.setItem(TOKEN_REGISTRY, JSON.stringify(registry));
    }
    return registry[code];
}

async function _rest(op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API}`, "GET",
            {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Survey op ${op} failed: ${err}`);}
    if (!response?.result) {
        const error = new Error(response?.reason || "The survey service did not respond.");
        error.handled = true;
        states.toast({message: error.message, ms: 8000});
        throw error;
    }
    return response;
}
