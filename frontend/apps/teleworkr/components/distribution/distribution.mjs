/**
 * distribution — the Q4 results renderer, aggregate by construction.
 *
 * Counts, never an average: a mean of 3.2 hides a team split between two
 * people who are fine and two who aren't — the split IS the finding. Below
 * the cohort floor the panel does not render; the refusal names the floor
 * and why, rather than showing an empty chart that looks like a bug.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {states} from "../../js/states.mjs";

const _esc = states.esc;

/**
 * Renders the floor refusal panel (Q4: refused, with the reason).
 * @param {object} options {responded, floor, message}
 */
function refusal(options={}) {
    return `<div class="dist-refused" role="status">
        <div class="up t3">Refused</div>
        <p style="margin-top:6px">${_esc(options.message ||
            `Cohort ${options.responded} — below the floor of ${options.floor}.`)}</p>
        <p class="t3 xs" style="margin-top:4px">Below five, a distribution is a list of
            individuals wearing a chart.</p>
    </div>`;
}

/**
 * Renders one question's distribution as counts.
 * @param {object} dist {question_id, text, counts:[{value, label, count}], responded}
 */
function question(dist) {
    const max = Math.max(1, ...dist.counts.map(c => c.count));
    return `<div class="dist">
        <div class="dist-q">${_esc(dist.text)}</div>
        <div class="dist-bars">${dist.counts.map(c => `
            <div class="dist-bar-row">
                <span class="dist-label">${_esc(c.label)}</span>
                <span class="dist-track"><span class="dist-fill" style="width:${Math.round(c.count/max*100)}%"></span></span>
                <span class="dist-count mono">${c.count}</span>
            </div>`).join("")}</div>
        <div class="dist-responded xs t3">${dist.responded} answered · counts, not an average</div>
    </div>`;
}

/**
 * Renders the response-rate strip — the module's health metric (Q4 item 5).
 * A falling rate across runs means the last results led to nothing visible:
 * a defect, not a preference.
 */
function responseRate(rate) {
    if (rate.invited === null) return `<div class="rate">
        <span class="rate-n mono">${rate.responded}</span><span class="t2"> responded — anonymous, no invitation list exists</span></div>`;
    return `<div class="rate">
        <span class="rate-n mono">${rate.responded} of ${rate.invited}</span><span class="t2"> responded · ${
            rate.rate}%</span></div>`;
}

export const distribution = {refusal, question, responseRate};
