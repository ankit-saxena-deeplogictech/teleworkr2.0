/**
 * D1/D2 — the Tasks screen: the list with its filters, creation, and the
 * detail drawer.
 *
 * The list answers "what is open, blocked on whom, due when". The drawer is
 * D2's whole point: subtasks, blockers with their reasons, watchers, comments,
 * the activity trail and the time log projected from the ledger — never
 * duplicated, always carrying each entry's source.
 *
 * Blocking is never a silent colour: the screen asks for the blocker and the
 * reason, because the backend refuses a blocked status without an active block
 * relation (D1). The drawer's status control therefore cannot paint "blocked"
 * on a task that isn't — it routes through the block action instead.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";
import {taskRow} from "../../components/task-row/task-row.mjs";
import {taskPicker} from "../../components/task-picker/task-picker.mjs";

const API_TASKS = "tasks", API_CLOCK = "clock";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

const STATUSES = ["all", "to_do", "in_progress", "in_review", "blocked", "done"];
const STATUS_LABELS = {all: "All", to_do: "To do", in_progress: "In progress",
    in_review: "In review", blocked: "Blocked", done: "Done"};
const NON_TERMINAL = ["to_do", "in_progress", "in_review"];

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, filter: {status: "all", q: ""}, detail: null, detailData: null};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tk">
        <div class="tk-head">
            <input class="inp tk-q grow" id="tk-q" placeholder="Search tasks" value="${states.esc(state.filter.q)}">
            <div class="tk-chips">${STATUSES.map(status =>
                `<button class="tk-chip${state.filter.status == status ? " on" : ""}" data-tk="filter" data-status="${status}">${
                    STATUS_LABELS[status]}</button>`).join("")}</div>
            <button class="btn pri" data-tk="create-toggle">+ New task</button>
        </div>
        <div class="tk-create" id="tk-create" style="display:none">
            <input class="inp grow" id="tk-c-title" placeholder="What needs doing?">
            <input class="inp" id="tk-c-project" placeholder="project (optional)" style="width:160px">
            <input class="inp" id="tk-c-due" type="date" style="width:140px">
            <button class="btn pri" data-tk="create">Create</button>
        </div>
        <div class="tk-grid">
            <div class="tk-col" id="tk-list">${states.loading({rows: 5})}</div>
            <div class="tk-drawer" id="tk-drawer" style="display:none"></div>
        </div>
    </div>`;

    root.querySelector("[data-tk=\"create-toggle\"]").addEventListener("click", _ => {
        const form = root.querySelector("#tk-create");
        form.style.display = form.style.display == "none" ? "flex" : "none";
    });
    for (const chip of root.querySelectorAll("[data-tk=\"filter\"]"))
        chip.addEventListener("click", _ => {state.filter.status = chip.getAttribute("data-status");
            state.filter.q = ""; _view();});
    root.querySelector("#tk-q").addEventListener("keydown", event => {
        if (event.key == "Enter") {state.filter.q = event.target.value.trim(); _loadList(root);}
    });
    root.querySelector("[data-tk=\"create\"]").addEventListener("click", _ => _create(root));

    await _loadList(root);
    if (state.detail) await _openDetail(root, state.detail);
}

async function _loadList(root) {
    const list = root.querySelector("#tk-list");
    const filters = {...(state.filter.status == "all" ? {} : {status: state.filter.status}),
        ...(state.filter.q ? {q: state.filter.q} : {})};
    const response = await _rest("list", {filters});
    if (!response) return;
    state.listData = response;
    list.innerHTML = response.rows.length ?
        response.rows.map(row => taskRow.render(row, {loggedSeconds: response.logged_seconds})).join("") :
        `<div class="tr-empty">${state.filter.q || state.filter.status != "all" ?
            "No tasks match these filters." : "No tasks assigned to you. Work assigned to you shows up here."}</div>`;
    taskRow.wire(list, {
        open: ref => {state.detail = ref; _openDetail(root, ref);},
        timer: ref => _bindTimer(ref)});
}

async function _create(root) {
    const title = root.querySelector("#tk-c-title").value.trim();
    if (!title) {states.toast({message: "A task needs a title."}); return;}
    const created = await _rest("create", {title,
        project: root.querySelector("#tk-c-project").value.trim() || undefined,
        due_date: root.querySelector("#tk-c-due").value || undefined});
    if (!created) return;
    states.toast({message: `${created.task.task_ref} created.`});
    state.filter.status = "all"; state.filter.q = "";
    await _view();
}

async function _openDetail(root, taskRef) {
    const drawer = root.querySelector("#tk-drawer");
    drawer.style.display = "block";
    drawer.innerHTML = states.loading({rows: 4});
    const detail = await _rest("get", {task_ref: taskRef});
    if (!detail) return;
    state.detailData = detail;
    const task = detail.task;

    const watching = (detail.watchers || []).some(watcher =>
        watcher.person_id == session.get(APP_CONSTANTS.USERID)?.toString());
    const activeBlockers = (detail.blockers || []).filter(blocker => !blocker.resolved_at);
    const caps = (await import("../shell.mjs")).shell.projection?.capabilities || [];

    drawer.innerHTML = `
        <div class="tk-drawer-head">
            <div class="grow">
                <div class="mono tk-ref">${states.esc(task.task_ref)}</div>
                <h2>${states.esc(task.title)}</h2>
                <p class="t3 sm">${task.assignee_name ? `with ${states.esc(task.assignee_name)}` : "unassigned"}${
                    task.created_by_name ? ` · created by ${states.esc(task.created_by_name)}` : ""}${
                    task.project ? ` · ${states.esc(task.project)}` : ""}${
                    task.due_date ? ` · due ${states.esc(task.due_date)}` : ""}</p>
            </div>
            <button class="btn sm" data-tk="close">Close</button>
        </div>
        ${task.description ? `<p class="t2 sm">${states.esc(task.description)}</p>` : ""}
        <div class="tk-drawer-actions">
            <select class="inp" data-tk="status">
                ${NON_TERMINAL.map(status => `<option value="${status}"${task.status == status ? " selected" : ""}>${
                    STATUS_LABELS[status]}</option>`).join("")}
                <option value="done"${task.status == "done" ? " selected" : ""}>Done</option>
            </select>
            <button class="btn pri sm" data-tk="timer">Start timer</button>
            <button class="btn sm" data-tk="comment-btn">Comment</button>
            <button class="btn sm" data-tk="watch">${watching ? "Unwatch" : "Watch"}</button>
            <button class="btn sm" data-tk="subtask-toggle">+ Subtask</button>
            ${caps.includes("task.delete") ? `<button class="btn danger sm" data-tk="delete">Delete</button>` : ""}
        </div>

        ${activeBlockers.length ? `<div class="tk-block-panel">
            <div class="up t3">Blocked on</div>
            ${activeBlockers.map(blocker => `<div class="row">
                <span class="mono sm">${states.esc(blocker.task?.task_ref || "")}</span>
                <span class="grow t2 sm">${states.esc(blocker.task?.title || "")} — ${states.esc(blocker.reason || "")}</span>
                <button class="btn sm" data-tk="unblock" data-blocker="${states.esc(blocker.task?.task_ref || "")}">Unblock</button>
            </div>`).join("")}
        </div>` : ""}

        <div class="tk-drawer-section">
            <div class="up t3">Time on this task — <span class="mono">${_hm(detail.logged_seconds)}</span></div>
            ${_timeLog(detail.time_log)}
        </div>

        <div class="tk-drawer-section">
            <div class="up t3">Subtasks</div>
            ${(detail.subtasks || []).length ? detail.subtasks.map(sub => `
                <div class="row"><span class="mono sm">${states.esc(sub.task_ref)}</span>
                <span class="grow sm">${states.esc(sub.title)}</span>
                <span class="tk-status-chip s-${states.esc(sub.status)} sm">${states.esc(STATUS_LABELS[sub.status] || sub.status)}</span></div>`).join("") :
                `<p class="t3 sm">No subtasks yet.</p>`}
            <div class="row" style="margin-top:6px; display:none" id="tk-subtask-form">
                <input class="inp grow" id="tk-subtask-title" placeholder="Subtask title">
                <button class="btn sm" data-tk="subtask-add">Add</button>
            </div>
        </div>

        <div class="tk-drawer-section">
            <div class="up t3">Comments</div>
            ${(detail.comments || []).length ? detail.comments.map(comment => `
                <div class="tk-comment sm">${states.esc(comment.body)}
                    <span class="t3 xs"> · ${states.esc(comment.display_name || "someone")} · ${_ago(comment.created_at)}</span></div>`).join("") :
                `<p class="t3 sm">No comments yet.</p>`}
            <div class="row" style="margin-top:8px">
                <input class="inp grow" id="tk-comment" placeholder="Add a comment">
                <button class="btn sm" data-tk="comment-send">Send</button>
            </div>
        </div>

        <div class="tk-drawer-section">
            <div class="up t3">Watchers</div>
            <p class="sm">${(detail.watchers || []).map(watcher => states.esc(watcher.display_name || watcher.person_id)).join(" · ") || "No watchers."}</p>
        </div>

        <div class="tk-drawer-section">
            <div class="up t3">Activity</div>
            ${(detail.events || []).slice().reverse().slice(0, 8).map(event => `
                <div class="tk-event sm">${states.esc(event.kind.replace("task.", ""))}
                    <span class="t3 xs"> · ${_ago(event.created_at)}</span></div>`).join("")}
        </div>

        <div class="tk-drawer-section">
            <div class="up t3">Block this task on another</div>
            <div class="row" style="margin-top:6px">
                <input class="inp" id="tk-blocker" placeholder="TASK- that blocks this one" style="width:210px">
                <input class="inp grow" id="tk-block-reason" placeholder="reason — required">
                <button class="btn sm" data-tk="block">Block</button>
            </div>
        </div>
    </div>`;   // note: the drawer's own wrapper stays in tk-drawer; content above is its html

    drawer.querySelector("[data-tk=\"close\"]").addEventListener("click", _ => {drawer.style.display = "none"; state.detail = null;});
    drawer.querySelector("[data-tk=\"status\"]").addEventListener("change", event => _updateStatus(event.target.value));
    drawer.querySelector("[data-tk=\"timer\"]").addEventListener("click", _ => _bindTimer(task.task_ref));
    drawer.querySelector("[data-tk=\"comment-btn\"]").addEventListener("click",
        _ => drawer.querySelector("#tk-comment").focus());
    drawer.querySelector("[data-tk=\"comment-send\"]").addEventListener("click", async _ => {
        const body = drawer.querySelector("#tk-comment").value.trim();
        if (!body) return;
        if (await _rest("comment", {task_ref: task.task_ref, body})) _reopenDetail(root, task.task_ref);
    });
    drawer.querySelector("[data-tk=\"watch\"]").addEventListener("click", async _ => {
        if (await _rest("watch", {task_ref: task.task_ref, watch: !watching})) _reopenDetail(root, task.task_ref);
    });
    drawer.querySelector("[data-tk=\"subtask-toggle\"]").addEventListener("click", _ => {
        const form = drawer.querySelector("#tk-subtask-form");
        form.style.display = form.style.display == "none" ? "flex" : "none";
        form.querySelector("input").focus();
    });
    drawer.querySelector("[data-tk=\"subtask-add\"]").addEventListener("click", async _ => {
        const title = drawer.querySelector("#tk-subtask-title").value.trim();
        if (!title) return;
        if (await _rest("subtask", {parent_task_ref: task.task_ref, title})) {
            states.toast({message: "Subtask added."}); _reopenDetail(root, task.task_ref);
        }
    });
    drawer.querySelector("[data-tk=\"delete\"]")?.addEventListener("click", async _ => {
        const confirmed = await states.confirmDestructive({title: `Delete ${task.task_ref}?`,
            body: "The task is archived, its history stays in the record."});
        if (!confirmed) return;
        if (await _rest("delete", {task_ref: task.task_ref})) {drawer.style.display = "none"; state.detail = null; await _loadList(root);}
    });
    for (const button of drawer.querySelectorAll("[data-tk=\"unblock\"]"))
        button.addEventListener("click", async _ => {
            if (await _rest("unblock", {blocker_task_ref: button.getAttribute("data-blocker"),
                blocked_task_ref: task.task_ref})) _reopenDetail(root, task.task_ref);
        });
    drawer.querySelector("[data-tk=\"block\"]").addEventListener("click", async _ => {
        const blocker = drawer.querySelector("#tk-blocker").value.trim().toUpperCase();
        const reason = drawer.querySelector("#tk-block-reason").value.trim();
        if (!blocker || !reason) {states.toast({message: "The blocker's TASK-id and a reason are both required."}); return;}
        if (await _rest("block", {blocker_task_ref: blocker, blocked_task_ref: task.task_ref, reason}))
            _reopenDetail(root, task.task_ref);
    });
}

async function _reopenDetail(root, taskRef) {
    await _loadList(root);
    await _openDetail(root, taskRef);
}

async function _updateStatus(status) {
    const taskRef = state.detailData?.task?.task_ref;
    if (!taskRef) return;
    const updated = await _rest("update", {task_ref: taskRef, changes: {status}});
    if (updated) states.toast({message: `${taskRef} → ${STATUS_LABELS[status]}.`});
    await _loadList(state.root);
}

async function _bindTimer(taskRef) {
    const started = await _clock("in", {task_ref: taskRef});
    if (started) states.toast({message: `Clock started on ${taskRef}.`});
}

function _timeLog(entries) {
    const superseded = new Set((entries || []).filter(e => e.supersedes_entry_event_id)
        .map(e => e.supersedes_entry_event_id));
    const current = (entries || []).filter(e => !superseded.has(e.entry_event_id)).slice().reverse();
    if (!current.length) return `<p class="t3 sm">No time logged on this task yet.</p>`;
    return current.slice(0, 5).map(entry => `<div class="row sm">
        <span class="mono">${_hms(entry.ended_at ? entry.duration_seconds : Math.max(0, Date.now()/1000 - entry.started_at))}</span>
        <span class="grow t2">${states.esc(entry.note || entry.source)}${entry.category ? ` · ${states.esc(entry.category)}` : ""}</span>
        <span class="t3 xs">${entry.started_at ? new Date(entry.started_at*1000).toLocaleString(undefined, {hour:"2-digit", minute:"2-digit"}) : ""}</span>
    </div>`).join("");
}

async function _rest(op, extra={}) {
    return await _call(API_TASKS, op, extra);
}

async function _clock(op, extra={}) {
    return await _call(API_CLOCK, op, extra);
}

async function _call(api, op, extra={}) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${api}`, "GET",
            {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`${api} op ${op} failed: ${err}`);}
    if (!response?.result) {states.toast({message: response?.reason || "The service did not respond.", ms: 8000}); return null;}
    return response;
}

const _hm = total => `${Math.floor(total/3600)}h ${String(Math.floor((total%3600)/60)).padStart(2,"0")}m`;
const _hms = total => {
    const h = Math.floor(total/3600), m = Math.floor((total%3600)/60), s = Math.floor(total%60);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};
const _ago = epochSeconds => {
    if (!epochSeconds) return "";
    const minutes = Math.max(0, Math.round((Date.now()/1000 - epochSeconds) / 60));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes/60);
    return hours < 24 ? `${hours}h ago` : `${Math.round(hours/24)}d ago`;
};
