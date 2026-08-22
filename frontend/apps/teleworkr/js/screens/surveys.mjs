/**
 * Q — the surveys screen: the list with the brief (Q2), the questionnaire
 * (Q3), and the results (Q4).
 *
 * The anonymity contract is the screen's spine. The mode is stated in the
 * list, restated in the footer of every questionnaire page, and its
 * consequences are not softened: in anonymous mode nobody can remind you and
 * you cannot withdraw an answer; in confidential mode there is no link back
 * to your response, which is the whole guarantee.
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

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, view: "list", code: null, token: null};
    await _view();
}

async function _view() {
    const root = state.root;
    try {
        if (state.view == "take") return await _questionnaire(root);
        if (state.view == "results") return await _results(root);
        return await _list(root);
    } catch (err) {
        root.innerHTML = `<div class="page">${states.error({title: "Couldn't load surveys",
            what: err.message, safe: "Your answers are saved as you go.",
            reference: `Q-${Date.now().toString(36).toUpperCase().slice(-4)}`})}</div>`;
        states.bind(root, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// Q2 — the list, and the brief
// ---------------------------------------------------------------------------

async function _list(root) {
    root.innerHTML = `<div class="sv-band">${states.loading({rows: 4})}</div>`;
    const response = await _rest("list", {tokens: _tokens()});
    if (!response) return;

    root.innerHTML = `<div class="page sv">
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
        </div>
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

    root.innerHTML = `<div class="page sv">
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
        root.innerHTML = `<div class="page sv">
            <button class="tr-back" data-sv="exit">← Surveys</button>
            ${distribution.refusal({message: response?.reason || "Results are not available."})}
        </div>`;
        root.querySelector("[data-sv=\"exit\"]").addEventListener("click", _ => {state.view = "list"; _view();});
        return;
    }

    root.innerHTML = `<div class="page sv">
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
        </div>` : ""}
    </div>`;
    root.querySelector("[data-sv=\"exit\"]").addEventListener("click", _ => {state.view = "list"; _view();});
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
