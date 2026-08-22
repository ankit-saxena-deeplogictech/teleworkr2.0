/**
 * C1 — the Day board. Now/next before what exists: rendered from a single call
 * to the dayboard API, which already assembled the clock, what it is bound to,
 * what is due, who needs you, presence, and the week.
 *
 * The header's clock (shell.mjs) is the one instrument — clocking in and out
 * happens there. This screen's own Pause and Mark complete buttons call the same
 * backend directly rather than duplicating clock state locally, so the two can
 * never disagree about whether the timer is running.
 *
 * States this screen designs, per C1's spec panel: not clocked in, running,
 * break, no meetings today, nothing needs you (said warmly, nothing invented),
 * offline.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../states.mjs";

const API_DAYBOARD = "dayboard", API_CLOCK = "clock", API_TASKS = "tasks";

const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

/**
 * Renders the Day board into the given element.
 * @param {HTMLElement} root
 */
export async function render(root) {
    root.innerHTML = `<div class="page day-board">${states.loading({rows: 5})}</div>`;

    let board; try {
        const response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_DAYBOARD}`, "GET",
            {op: "board", ..._me()}, true);
        if (!response?.result) throw new Error(response?.reason || "The server did not respond.");
        board = response;
    } catch (err) {
        root.innerHTML = `<div class="page">${states.error({title: "Couldn't load your day",
            what: err.message, safe: "Nothing you have recorded is affected.",
            reference: `C1-${Date.now().toString(36).toUpperCase().slice(-4)}`})}</div>`;
        states.bind(root, {retry: _ => render(root)});
        return;
    }

    root.innerHTML = `<div class="page day-board">
        ${_workingOn(board)}
        ${_todayStrip(board)}
        <div class="db-grid">
            ${_needsYou(board)}
            ${_presence(board)}
        </div>
        ${_weekFooter(board)}
    </div>`;

    _wire(root, board);
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

function _workingOn(board) {
    const clock = board.clock;
    if (clock.state == "not_clocked_in") return `<div class="db-card db-clockcard">
        <div class="up t3">Not clocked in</div>
        <h3 style="margin-top:6px">Ready when you are</h3>
        <p class="t2 sm">Use the clock in the header to start the day.</p>
    </div>`;

    if (clock.state == "break") return `<div class="db-card db-clockcard on-break">
        <div class="up t3">On a break</div>
        <h3 style="margin-top:6px">${states.esc(_hm(clock.today_total_seconds))} logged so far today</h3>
        <button class="btn pri" data-db="resume">Resume working</button>
    </div>`;

    const working = board.working_on;
    if (!working) return `<div class="db-card db-clockcard">
        <div class="up t3">Working — no task bound</div>
        <h3 style="margin-top:6px">${states.esc(_hms(clock.today_total_seconds))} today</h3>
        <p class="t2 sm">Bind the timer to a task from Tasks so it lands in the right place.</p>
        <div class="row" style="gap:8px;margin-top:10px">
            <button class="btn" data-db="pause">☕ Break</button>
        </div>
    </div>`;

    return `<div class="db-card db-clockcard">
        <div class="up t3">Working on</div>
        <h3 style="margin-top:6px">${states.esc(working.title || working.task_ref)}</h3>
        <p class="t2 sm">${states.esc(working.task_ref)}${working.project?` · ${states.esc(working.project)}`:""}${
            working.due_date?` · due ${states.esc(working.due_date)}`:""}</p>
        <p class="sm" style="margin-top:6px">Timer running · ${states.esc(_hm(working.session_seconds))} this session
            ${working.estimate_minutes ? ` · ${states.esc(_hm(working.logged_seconds))} / ${
                states.esc(_hm(working.estimate_minutes*60))} est` : ""}</p>
        <div class="row" style="gap:8px;margin-top:10px">
            <button class="btn" data-db="pause">☕ Break</button>
            <button class="btn" data-db="switch">Switch task</button>
            <button class="btn pri" data-db="complete">Mark complete</button>
        </div>
    </div>`;
}

function _todayStrip(board) {
    const dueLabel = board.due_today.count == 0 ? "no tasks due" :
        `${board.due_today.count} task${board.due_today.count==1?"":"s"} due`;
    // meetings and focus report their stated absence rather than a number the
    // product cannot back — there is no calendar-event entity yet (see C1 module note)
    return `<div class="db-card db-strip">
        <span>${states.esc(board.meetings.reason=="not_tracked" ? "Meetings not tracked yet" : `${board.meetings.count} meetings`)}</span>
        <span class="dot"></span>
        <span>${states.esc(board.focus.reason=="not_tracked" ? "Focus time not tracked yet" : `${board.focus.minutes}m focus`)}</span>
        <span class="dot"></span>
        <span>${states.esc(dueLabel)}${board.due_today.overdue_count ?
            ` <span class="t3">(${board.due_today.overdue_count} overdue)</span>` : ""}</span>
    </div>`;
}

function _needsYou(board) {
    const items = board.needs_you.items;
    if (!items.length) return `<div class="db-card">
        <div class="up t3">Needs you</div>
        <p class="t2 sm" style="margin-top:8px">Nothing needs you right now. Enjoy the quiet.</p>
    </div>`;

    return `<div class="db-card">
        <div class="up t3">Needs you</div>
        <div class="db-list">${items.map(item => `<div class="db-row">
            <span class="db-dot ${item.other_availability?.online_now?"awake":""}"></span>
            <div class="grow">
                <div class="sm">${states.esc(item.action || item.bucket)}${item.task_ref?` · ${states.esc(item.task_ref)}`:""}</div>
                <div class="xs t3">${states.esc(item.by_name)} · ${states.esc(_ago(item.at))}</div>
            </div>
        </div>`).join("")}</div>
    </div>`;
}

function _presence(board) {
    const p = board.presence;
    return `<div class="db-card">
        <div class="up t3">Around now</div>
        <p style="margin-top:8px"><span class="mono" style="font-size:18px">${p.online}</span>
            <span class="t2"> of ${p.total} online</span></p>
        <div class="row wrap" style="gap:6px;margin-top:8px">
            ${p.sample.map(person => `<span class="chip">${states.esc(person.display_name||"someone")}</span>`).join("")}
            ${p.total > p.sample.length ? `<span class="chip">+${p.total - p.sample.length}</span>` : ""}
        </div>
    </div>`;
}

function _weekFooter(board) {
    const week = board.week;
    return `<div class="db-card db-week">
        <span>Week · ${states.esc(_hm(week.logged_seconds))} / ${states.esc(_hm(week.target_seconds))}</span>
        <button class="btn push" data-db="timesheet">Open timesheet →</button>
    </div>`;
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

function _wire(root, board) {
    root.querySelector('[data-db="pause"]')?.addEventListener("click", _ => _pause(root));
    root.querySelector('[data-db="resume"]')?.addEventListener("click", _ => _resume(root, board));
    root.querySelector('[data-db="switch"]')?.addEventListener("click", _ =>
        states.toast({message: "Choosing a task to switch to needs a task picker — not built yet."}));
    root.querySelector('[data-db="complete"]')?.addEventListener("click", _ => _markComplete(root, board));
    root.querySelector('[data-db="timesheet"]')?.addEventListener("click", _ =>
        states.toast({message: "The timesheet (C5) is not built yet."}));
}

async function _pause(root) {
    const response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_CLOCK}`, "GET",
        {op: "break_start", ..._me()}, true);
    if (!response?.result) {states.toast({message: response?.reason || "Could not start a break."}); return;}
    states.toast({message: "On a break. The clock stopped."});
    render(root);
}

async function _resume(root, board) {
    const resumeTask = board.working_on?.task_ref || null;
    const response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_CLOCK}`, "GET",
        {op: "break_end", resume_task_ref: resumeTask, ..._me()}, true);
    if (!response?.result) {states.toast({message: response?.reason || "Could not end the break."}); return;}
    states.toast({message: "Back to work."});
    render(root);
}

async function _markComplete(root, board) {
    const taskRef = board.working_on?.task_ref;
    if (!taskRef) return;
    const response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_TASKS}`, "GET",
        {op: "update", task_ref: taskRef, changes: {status: "done"}, ..._me()}, true);
    if (!response?.result) {states.toast({message: response?.reason || "Could not update the task."}); return;}
    states.toast({message: `${taskRef} marked complete.`});
    render(root);
}

// ---------------------------------------------------------------------------

const _hms = total => {
    const h = Math.floor(total/3600), m = Math.floor((total%3600)/60), s = Math.floor(total%60);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};
const _hm = total => `${Math.floor(total/3600)}h ${String(Math.floor((total%3600)/60)).padStart(2,"0")}m`;
const _ago = epochSeconds => {
    if (!epochSeconds) return "";
    const minutes = Math.max(0, Math.round((Date.now()/1000 - epochSeconds) / 60));
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes/60);
    return hours < 24 ? `${hours}h ago` : `${Math.round(hours/24)}d ago`;
};
