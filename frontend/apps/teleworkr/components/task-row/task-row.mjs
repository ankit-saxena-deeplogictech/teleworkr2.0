/**
 * task-row — one row of the D1 task list.
 *
 * The row states what the wireframe cares about: the ref, the status, who it
 * is with, when it is due, how much time has been logged against it, and — for
 * blocked rows — WHOM it is blocked on, with the reason and how long ago. A
 * blocked row that hides its blocker is a dead end, so the list carries it
 * inline rather than behind a click.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {states} from "../../js/states.mjs";

const _esc = states.esc;
const _hm = total => total ? `${Math.floor(total/3600)}h ${String(Math.floor((total%3600)/60)).padStart(2,"0")}m` : "";

const STATUS_LABELS = {to_do: "To do", in_progress: "In progress", in_review: "In review",
    blocked: "Blocked", done: "Done"};

/**
 * Renders one task row.
 * @param {object} row The task from the list API (with assignee_name)
 * @param {object} context {loggedSeconds}
 */
function render(row, context={}) {
    const logged = context.loggedSeconds?.[row.task_ref] || 0;
    const overdue = row.due_date && row.due_date < new Date().toISOString().substring(0, 10) &&
        !["done", "blocked"].includes(row.status);
    return `<div class="tk-row" data-task="${_esc(row.task_ref)}">
        <span class="tk-status s-${_esc(row.status)}"></span>
        <div class="grow">
            <div class="tk-row-top">
                <span class="mono tk-ref">${_esc(row.task_ref)}</span>
                <span class="tk-status-chip s-${_esc(row.status)}">${_esc(STATUS_LABELS[row.status] || row.status)}</span>
                ${overdue ? `<span class="tk-due late">due ${_esc(row.due_date)}</span>` :
                    row.due_date ? `<span class="tk-due">due ${_esc(row.due_date)}</span>` : ""}
            </div>
            <div class="tk-title">${_esc(row.title)}</div>
            <div class="tk-meta t3 sm">${row.assignee_name ? `${_esc(row.assignee_name)} · ` : ""}${
                logged ? `${_hm(logged)} logged` : "no time logged"}${
                row.project ? ` · ${_esc(row.project)}` : ""}</div>
            ${row.blocked_on?.blocker_task_ref ? `<div class="tk-blocked">
                Blocked on <span class="mono">${_esc(row.blocked_on.blocker_task_ref)}</span> — ${
                    _esc(row.blocked_on.reason || "no reason given")} · ${_esc(_ago(row.blocked_on.since))}</div>` : ""}
        </div>
        <button class="btn sm" data-tk="timer" data-task="${_esc(row.task_ref)}">Start timer</button>
        <button class="btn pri sm" data-tk="open" data-task="${_esc(row.task_ref)}">Open</button>
    </div>`;
}

/** Wires a rendered list. @param {object} handlers {open, timer} */
function wire(root, handlers={}) {
    for (const button of root.querySelectorAll("[data-tk=\"open\"]"))
        button.addEventListener("click", _ => handlers.open?.(button.getAttribute("data-task")));
    for (const button of root.querySelectorAll("[data-tk=\"timer\"]"))
        button.addEventListener("click", _ => handlers.timer?.(button.getAttribute("data-task")));
}

const _ago = epochSeconds => {
    if (!epochSeconds) return "";
    const minutes = Math.max(0, Math.round((Date.now()/1000 - epochSeconds) / 60));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes/60);
    return hours < 24 ? `${hours}h ago` : `${Math.round(hours/24)}d ago`;
};

export const taskRow = {render, wire};
