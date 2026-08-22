/**
 * course-card — one row of the P2 catalogue, and the states it can be in.
 *
 * The catalogue's ordering is the whole design: what you must do first, then
 * what you could. This card renders both bands, but the required band's rows
 * carry what obligation they come from — "statutory, India, refreshed
 * annually" is a reason a person can act on; "because HR said so" is not.
 *
 * States: not_started · in_progress (Resume) · passed · locked (names the
 * prerequisite — not built yet, and it says so rather than showing a dead
 * disabled button).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {states} from "../states.mjs";

const _esc = states.esc;
const _hm = total => `${Math.floor(total/3600)}h ${String(Math.floor((total%3600)/60)).padStart(2,"0")}m`;

/**
 * Renders a required-assignment card.
 * @param {object} row The required row from the catalogue API
 * @returns {string} HTML
 */
function required(row) {
    const overdue = row.due_date && row.effective_due < new Date().toISOString().substring(0, 10);
    return `<div class="cc-card ${overdue ? "overdue" : ""}" data-cc="row">
        <div class="cc-top">
            <span class="cc-kind">${_esc(row.kind || "required")}</span>
            ${row.due_date ? `<span class="cc-due ${overdue ? "late" : ""}">Due ${_esc(row.effective_due)}${row.leave_days ?
                ` · paused ${row.leave_days}d for leave` : ""}</span>` : ""}
            <span class="push"></span>
            <span class="cc-rule">${_esc(row.source_rule || row.reason)}</span>
        </div>
        <div class="cc-body">
            <div class="grow">
                <h3>${_esc(row.title)}</h3>
                <p class="t2 sm">${row.modules_total} module${row.modules_total == 1 ? "" : "s"} · ${
                    row.logged_seconds ? `${_hm(row.logged_seconds)} logged · ` : ""}${
                    _progressLabel(row)}</p>
            </div>
            ${_cta(row)}
        </div>
        ${row.modules_total ? `<div class="cc-bar"><span style="width:${Math.round(
            (row.modules_done||0) / row.modules_total * 100)}%"></span></div>` : ""}
    </div>`;
}

/**
 * Renders a recommended card (no obligation attached).
 * @param {object} row The recommended row from the catalogue API
 * @returns {string} HTML
 */
function recommended(row) {
    return `<div class="cc-card" data-cc="row">
        <div class="cc-body">
            <div class="grow">
                <h3>${_esc(row.title)}</h3>
                <p class="t2 sm">${row.modules} modules · ~${row.minutes}m${row.validity_years ?
                    ` · certificate renews ${row.validity_years}y` : ""}${row.recommended_roles?.length ?
                    ` · suggested for ${_esc(row.recommended_roles.join(", "))}` : ""}</p>
            </div>
            <button class="btn" data-cc="open" data-course="${_esc(row.course_code)}">View</button>
        </div>
    </div>`;
}

const _progressLabel = row => {
    switch (row.state) {
        case "passed": return "Passed — certificate issued";
        case "in_progress": return `In progress · ${row.modules_done} of ${row.modules_total}`;
        default: return "Not started";
    }
};

const _cta = row => {
    if (row.state == "passed") return `<span class="cc-pass">Passed</span>`;
    const label = row.state == "in_progress" ? "Resume" : "Start";
    return `<button class="btn pri" data-cc="open" data-course="${_esc(row.course_code)}">${label}</button>`;
};

/**
 * Wires the buttons a rendered band produced.
 * @param {HTMLElement} root The band container
 * @param {function} open Called with the course_code when Start/Resume/View is clicked
 */
function wire(root, open) {
    for (const button of root.querySelectorAll("[data-cc=\"open\"]"))
        button.addEventListener("click", _ => open(button.getAttribute("data-course")));
}

export const courseCard = {required, recommended, wire};
