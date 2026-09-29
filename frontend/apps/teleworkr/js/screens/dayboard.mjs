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
import {taskPicker} from "../../components/task-picker/task-picker.mjs";

const API_DAYBOARD = "dayboard", API_CLOCK = "clock", API_TASKS = "tasks", API_WINDOWS = "windows";

const BUCKET_ORDER = ["blocks_you", "needs_reply", "moved", "decided"];
const BUCKET_LABELS = {blocks_you: "Blocks you", needs_reply: "Needs a reply", moved: "Moved", decided: "Decided"};

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

    const briefHtml = await _briefSectionHtml(board);

    root.innerHTML = `<div class="page day-board">
        ${briefHtml}
        ${_workingOn(board)}
        ${_todayStrip(board)}
        <div class="db-grid">
            ${_needsYou(board)}
            ${_presence(board)}
        </div>
        ${_weekFooter(board)}
    </div>`;

    _wire(root, board);
    _wireBrief(root, board);
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

// ---------------------------------------------------------------------------
// B4 — the full daily brief card. A one-shot arrival card, not a screen: the
// same backlog "Needs you" already shows capped to five, here in full, once
// per day, dismissible, never blocking.
// ---------------------------------------------------------------------------

const _briefDismissKey = board => `teleworkr_brief_dismissed_${board.date}`;

async function _briefSectionHtml(board) {
    if (board.clock.state == "not_clocked_in") return "";

    let dismissed = false;
    try {dismissed = sessionStorage.getItem(_briefDismissKey(board)) == "1";} catch (err) {}
    if (dismissed) return `<div class="row" style="justify-content:flex-end">
        <button class="btn sm" data-b4="reopen">↺ Brief dismissed — reopen</button>
    </div>`;

    const {shell} = await import("../shell.mjs");
    const myName = shell.projection?.person?.display_name;
    const brief = board.brief;

    if (brief.state == "quiet") return `<div class="row" style="justify-content:space-between;align-items:center">
        <span class="t2 sm">Quiet night — nothing came in while you were away.</span>
        <button class="btn sm" data-b4="dismiss">Dismiss</button>
    </div>`;

    if (brief.state == "chronological") return `<div class="db-card">
        <div class="row wrap" style="justify-content:space-between;align-items:flex-start;gap:10px">
            <div>
                <div class="up t3">${states.esc(_greeting(myName))}</div>
                <p class="t2 sm" style="margin-top:4px">${brief.items.length} thing${brief.items.length==1?"":"s"} while you were away, in time order —
                    your working hours aren't declared, so ranking by who's awake isn't available.
                    <a data-b4="declare-window" style="cursor:pointer">Declare them</a>.</p>
            </div>
            <button class="btn sm" data-b4="dismiss">Dismiss</button>
        </div>
        <div class="db-list" style="margin-top:12px">${brief.items.map(_briefRowHtml).join("")}</div>
    </div>`;

    const topSuggestion = brief.suggested_order?.[0];
    const topItem = topSuggestion ? brief.items.find(item => item.task_ref == topSuggestion.task_ref) : null;
    const overlapLine = topItem?.by_person_id ? await _overlapLineFor(board, topItem, shell) : null;

    return `<div class="db-card">
        <div class="row wrap" style="justify-content:space-between;align-items:flex-start;gap:10px">
            <div>
                <div class="up t3">${states.esc(_greeting(myName))}</div>
                <h3 style="margin-top:6px">${brief.items.length} thing${brief.items.length==1?"":"s"} while you were away</h3>
                <p class="t2 sm">clocked in at ${states.esc(_clockTime(board.clock.running?.started_at))}</p>
            </div>
            <div class="row" style="gap:8px">
                <button class="btn sm" data-b4="dismiss">Dismiss</button>
                ${topSuggestion ? `<button class="btn sm pri" data-b4="start" data-task="${states.esc(topSuggestion.task_ref)}">
                    Start on ${states.esc(topSuggestion.task_ref)}</button>` : ""}
            </div>
        </div>
        <div class="db-grid db-grid-brief" style="margin-top:14px">
            <div>${BUCKET_ORDER.map(bucket => _bucketSectionHtml(brief, bucket)).join("")}</div>
            <div>
                <div class="db-card" style="padding:12px">
                    <div class="up t3">Today at a glance</div>
                    <p class="sm" style="margin-top:6px">${states.esc(_glanceLine(board))}</p>
                    ${overlapLine ? `<p class="sm t3" style="margin-top:4px">${states.esc(overlapLine)}</p>` : ""}
                </div>
                ${brief.suggested_order?.length ? `<div class="db-card" style="margin-top:10px;padding:12px">
                    <div class="up t3">Suggested order</div>
                    <ol class="sm" style="margin-top:8px;padding-left:18px">${brief.suggested_order.map((suggestion, index) =>
                        `<li data-b4-suggestion="${index}" style="margin-top:4px">${states.esc(suggestion.action)}
                            <button class="btn sm" data-b4="not-useful" style="margin-left:6px;padding:1px 6px">Not useful</button></li>`).join("")}
                    </ol>
                </div>` : ""}
            </div>
        </div>
    </div>`;
}

function _bucketSectionHtml(brief, bucket) {
    const items = brief.items.filter(item => item.bucket == bucket);
    if (!items.length) return "";
    return `<div style="margin-bottom:14px">
        <div class="up t3">${states.esc(BUCKET_LABELS[bucket])}</div>
        <div class="db-list">${items.map(_briefRowHtml).join("")}</div>
    </div>`;
}

function _briefRowHtml(item) {
    return `<div class="db-row">
        <span class="db-dot ${item.other_availability?.online_now?"awake":""}"></span>
        <div class="grow">
            <div class="sm">${states.esc(item.why)}</div>
            <div class="xs t3">${states.esc(item.by_name)}${item.task_ref?` · ${states.esc(item.task_ref)}`:""} · ${states.esc(_ago(item.at))}</div>
        </div>
    </div>`;
}

function _glanceLine(board) {
    const summary = board.brief.summary;
    const parts = [board.meetings.reason=="not_tracked" ? "Meetings not tracked yet" : `${board.meetings.count} meetings`];
    if (summary.blocked_tasks) parts.push(`${summary.blocked_tasks} of your tasks blocked`);
    parts.push(`${summary.due_today} due today`);
    if (summary.overdue) parts.push(`${summary.overdue} overdue`);
    return parts.join(" · ");
}

/** A real, computed fact or nothing — never a fabricated meeting/overlap guess. */
async function _overlapLineFor(board, topItem, shell) {
    const myId = shell.projection?.person?.person_id;
    if (!myId) return null;
    let response; try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_WINDOWS}`, "GET",
            {op: "team_overlap", person_ids: [myId, topItem.by_person_id], date: board.date, ..._me()}, true);
    } catch (err) {response = null;}
    if (!response?.result || !response.span) return null;
    return `Your overlap with ${topItem.by_name} closes at ${_minutesToClock(response.span.to)}.`;
}

function _greeting(name) {
    const hour = new Date().getHours();
    const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
    return `Good ${part}${name ? `, ${name}` : ""}`;
}

const _clockTime = epochSeconds => epochSeconds ?
    new Date(epochSeconds*1000).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"}) : "—";
const _minutesToClock = epochMinutes =>
    new Date(epochMinutes*60000).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"});

function _wireBrief(root, board) {
    root.querySelector('[data-b4="dismiss"]')?.addEventListener("click", _ => {
        try {sessionStorage.setItem(_briefDismissKey(board), "1");} catch (err) {}
        render(root);
    });
    root.querySelector('[data-b4="reopen"]')?.addEventListener("click", _ => {
        try {sessionStorage.removeItem(_briefDismissKey(board));} catch (err) {}
        render(root);
    });
    root.querySelector('[data-b4="declare-window"]')?.addEventListener("click", async _ => {
        const {shell} = await import("../shell.mjs"); shell.setSurface("windows");
    });
    root.querySelector('[data-b4="start"]')?.addEventListener("click", async _ => {
        const taskRef = root.querySelector('[data-b4="start"]').getAttribute("data-task");
        const switched = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_CLOCK}`, "GET",
            {op: "switch", task_ref: taskRef, ..._me()}, true);
        if (!switched?.result) {states.toast({message: switched?.reason || "Could not switch the clock."}); return;}
        states.toast({message: `Clock moved to ${taskRef}.`});
        render(root);
    });
    for (const button of root.querySelectorAll('[data-b4="not-useful"]'))
        button.addEventListener("click", _ => button.closest("li")?.remove());
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
    root.querySelector('[data-db="switch"]')?.addEventListener("click", _ => _switchTask(root));
    root.querySelector('[data-db="complete"]')?.addEventListener("click", _ => _markComplete(root, board));
    root.querySelector('[data-db="timesheet"]')?.addEventListener("click", async _ => {
        const {shell} = await import("../shell.mjs");
        shell.setSurface("timesheet");
    });
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

/** C1: the clock is bound to a task through the shared picker — one overlay,
 *  used by the Day board and the Tasks screen alike. */
async function _switchTask(root) {
    let response;
    try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_TASKS}`, "GET",
            {op: "list", filters: {}, page_size: 200, ..._me()}, true);
    } catch (err) {response = null;}
    if (!response?.result) {states.toast({message: response?.reason || "Could not load tasks."}); return;}
    const open = (response.rows || []).filter(task => task.status != "done" && task.status != "blocked");
    if (!open.length) {states.toast({message: "No open tasks to switch to. Create one in Tasks."}); return;}

    const taskRef = await taskPicker.pick({title: "Switch the clock to", tasks: open});
    if (!taskRef) return;
    const switched = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_CLOCK}`, "GET",
        {op: "switch", task_ref: taskRef, ..._me()}, true);
    if (!switched?.result) {states.toast({message: switched?.reason || "Could not switch the clock."}); return;}
    states.toast({message: `Clock moved to ${taskRef}.`});
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
