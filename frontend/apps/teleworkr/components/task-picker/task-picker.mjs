/**
 * task-picker — the small overlay that binds the clock to a task.
 *
 * The Day board's "Switch task" and the Tasks screen's "Start timer" both need
 * the same thing: name the task the running clock is bound to. One overlay,
 * used by both, so the two can never disagree about how a task gets picked.
 * The task list comes from the caller — this component only renders and
 * returns a choice, the same split dialog-box uses in neuranet.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {states} from "../../js/states.mjs";

const _esc = states.esc;

/**
 * Opens the picker and resolves with the chosen task_ref, or null.
 * @param {object} options {title, tasks: [{task_ref, title, status}]}
 * @returns {Promise<string|null>}
 */
function pick(options={}) {
    return new Promise(resolve => {
        const tasks = options.tasks || [];
        const back = document.createElement("div");
        back.className = "confirm-back";
        back.innerHTML = `<div class="picker" role="dialog" aria-modal="true">
            <h3>${_esc(options.title || "Pick a task")}</h3>
            <input class="inp picker-q" placeholder="Filter by title or TASK-id">
            <div class="picker-list">${_rows(tasks)}</div>
            <div class="actions">
                <button class="btn" data-x="cancel">Cancel</button>
            </div>
        </div>`;

        const done = answer => {back.remove(); document.removeEventListener("keydown", onKey); resolve(answer);};
        const onKey = event => {if (event.key == "Escape") done(null);};
        back.addEventListener("click", event => {
            const ref = event.target.closest?.("[data-pick]")?.getAttribute("data-pick");
            if (ref) done(ref);
            else if (event.target == back || event.target.getAttribute?.("data-x") == "cancel") done(null);
        });
        const filter = back.querySelector(".picker-q");
        filter.addEventListener("input", _ => {
            const q = filter.value.toLowerCase();
            back.querySelector(".picker-list").innerHTML = _rows(tasks.filter(task =>
                (task.task_ref + " " + task.title).toLowerCase().includes(q)));
        });
        document.addEventListener("keydown", onKey);
        document.body.appendChild(back);
        filter.focus();
    });
}

const _rows = tasks => tasks.length ?
    tasks.map(task => `<button class="picker-row" data-pick="${_esc(task.task_ref)}">
        <span class="mono">${_esc(task.task_ref)}</span><span class="grow">${_esc(task.title)}</span></button>`).join("") :
    `<div class="picker-empty">No tasks match.</div>`;

export const taskPicker = {pick};
