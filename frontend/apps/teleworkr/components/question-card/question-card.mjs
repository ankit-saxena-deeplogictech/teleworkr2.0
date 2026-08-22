/**
 * question-card — the one component both P and Q render a question with.
 *
 * Built once because training modules and survey questionnaires ask questions
 * the same way, and Q3's accessibility rule applies to both: scale questions
 * are radio groups with real labels, never unlabelled dots (I2). A 1–5 scale
 * must be usable with a screen reader and without colour.
 *
 * The card renders:
 *   - scale  — one radio per scale point, labels like "1 disagree — 5 agree"
 *   - choice — one radio per option
 *   - text   — a textarea, with the free-text warning BESIDE the field (Q3),
 *              never buried in a footer
 *   - skip   — a first-class answer, recorded distinctly from not reaching
 *   - required — named, because a forced answer that hides its own forcing
 *              produces the middle option, which is worse than no data
 *
 * This module renders and collects; the screen owns the data and the calls.
 * That is the same split neuranet's dialog-box uses: the component knows the
 * UI, the caller knows the truth.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {states} from "../../js/states.mjs";

const _esc = states.esc;

/**
 * Renders one question.
 * @param {object} question {id, text, type, options, required, free_text}
 * @param {object} context {index, total, answer, skipped, skipAllowed,
 *      freeTextWarning}
 * @returns {string} HTML
 */
function render(question, context={}) {
    const answer = context.answer;
    const options = question.options || [];
    let control = "";
    if (question.type == "text") {
        control = `<textarea class="q-text" data-q="text" rows="3"
            placeholder="Type your answer">${_esc(answer ?? "")}</textarea>
            ${question.free_text !== false ? `<div class="q-warn">${_esc(context.freeTextWarning ||
                "Details that identify you can't be removed after you send this.")}</div>` : ""}`;
    } else {
        const optionKey = option => option.code ?? String(option.value);
        const optionLabel = option => option.label || option.text || String(option.value ?? option.code);
        control = `<div class="q-options" role="radiogroup" aria-label="${_esc(question.text)}">${
            options.map((option, i) => {
                const key = optionKey(option);
                return `<label class="q-opt${answer == key ? " on" : ""}">
                    <input type="radio" name="q-${_esc(question.id)}" value="${_esc(key)}"${answer == key ? " checked" : ""}>
                    <span class="q-radio"></span>
                    <span>${_esc(optionLabel(option))}</span>
                </label>`;
            }).join("")}</div>`;
    }

    return `<div class="q-card" data-question="${_esc(question.id)}">
        <div class="q-head">
            <span class="q-num">${context.index ?? 1}</span>
            <div class="grow">
                <div class="q-text-label">${_esc(question.text)}</div>
                ${question.required ? `<span class="q-req">required</span>` : ""}
            </div>
        </div>
        ${control}
        ${context.skipAllowed !== false ? `<button class="q-skip" data-q="skip">${
            context.skipped ? "Skipped — tap to answer" : "Skip this question"}</button>` : ""}
        <div class="q-foot sm t3">${context.skipped ? "Skipped is recorded as your answer." :
            question.type == "text" ? "Answers save as you go." : ""}</div>
    </div>`;
}

/**
 * Collects the current answer state from a rendered question card.
 * @param {HTMLElement} root The card element (or its container)
 * @returns {object|null} {value, skipped} or null when unanswered
 */
function collect(root) {
    const card = root.matches?.("[data-question]") ? root : root.querySelector("[data-question]");
    if (!card) return null;
    if (card.querySelector("[data-q=\"skip\"]")?.classList.contains("on")) return {skipped: true};
    const radio = card.querySelector("input[type=radio]:checked");
    if (radio) return {value: radio.value};
    const text = card.querySelector("textarea[data-q=\"text\"]");
    if (text && text.value.trim()) return {value: text.value.trim()};
    return null;
}

/**
 * Wires a rendered question card: radio highlight, skip toggle, input events.
 * @param {HTMLElement} root The container with one card
 * @param {object} handlers {change: (state) => void}
 */
function wire(root, handlers={}) {
    const card = root.matches?.("[data-question]") ? root : root.querySelector("[data-question]");
    if (!card) return;
    const onChange = _ => {
        for (const label of card.querySelectorAll(".q-opt"))
            label.classList.toggle("on", Boolean(label.querySelector("input:checked")));
        handlers.change?.(collect(card));
    };
    for (const input of card.querySelectorAll("input[type=radio]")) input.addEventListener("change", onChange);
    const text = card.querySelector("textarea");
    if (text) text.addEventListener("input", _ => handlers.change?.({value: text.value.trim() || null}));

    const skip = card.querySelector("[data-q=\"skip\"]");
    if (skip) skip.addEventListener("click", _ => {
        card.classList.toggle("skipped");
        const state = collect(card);
        if (state?.skipped) handlers.change?.({skipped: true});
        else handlers.change?.(collect(card) || {cleared: true});
    });
}

/** Marks the skip button visually. */
function setSkipped(card, skipped) {
    card?.classList.toggle("skipped", Boolean(skipped));
}

export const questionCard = {render, collect, wire, setSkipped};
