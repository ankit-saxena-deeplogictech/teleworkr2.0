/**
 * gap-filler — C3's day-reconstruction tool, narrowed to the one real signal
 * this app has: the timer ledger against the person's own declared working
 * window. Opens from the Day board and the Timesheet alike — one overlay,
 * so the two can never disagree about what a gap is or how filling one
 * works.
 *
 * The wireframe's full C3 draws the day from four signal lanes (Timer,
 * Calendar, Apps, Rooms) with one-click suggestions ("Figma was open on
 * apibot-hero-v3"). Three of those four don't exist in this app — no
 * calendar-event entity, no app-launch tracking, no meeting-room
 * integration — so there is no suggestion here, only a real gap and a real
 * choice: log it to a task, mark it a break, or mark it not work. Every fill
 * is honestly labelled reconstructed, keeping the signal it actually came
 * from (a self-assigned gap, never a fabricated calendar/app provenance).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../../js/states.mjs";
import {taskPicker} from "../task-picker/task-picker.mjs";

const API_TIME = "time", API_TASKS = "tasks";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

/**
 * Opens the gap-filler for one date.
 * @param {object} options {date}
 * @returns {Promise<boolean>} true if anything was filled
 */
function open(options={}) {
    return new Promise(resolve => {
        const date = options.date;
        let changed = false;
        const back = document.createElement("div");
        back.className = "confirm-back";
        back.innerHTML = `<div class="confirm gap-filler" role="dialog" aria-modal="true">
            <h3>Reconstruct ${states.esc(date)}</h3>
            <div class="gap-filler-body">${states.loading({rows: 3})}</div>
            <div class="actions"><button class="btn" data-x="close">Close</button></div>
        </div>`;

        const done = _ => {back.remove(); document.removeEventListener("keydown", onKey); resolve(changed);};
        const onKey = event => {if (event.key == "Escape") done();};
        back.addEventListener("click", event => {
            if (event.target == back || event.target.getAttribute?.("data-x") == "close") done();
        });
        document.addEventListener("keydown", onKey);
        document.body.appendChild(back);

        _load(back.querySelector(".gap-filler-body"), date, _ => {changed = true;});
    });
}

async function _load(body, date, onChange) {
    body.innerHTML = states.loading({rows: 3});

    const week = await _call(API_TIME, "week", {week_start: _mondayOf(date)});
    if (!week) {body.innerHTML = `<p class="t2 sm">Couldn't load this week.</p>`; return;}
    const status = week.timesheet?.status || "open";
    if (["submitted", "approved", "locked"].includes(status)) {
        body.innerHTML = `<p class="t2 sm">This week is already ${states.esc(status)} — read-only.
            Reconstructed entries can't be added to it.</p>`;
        return;
    }

    const result = await _call(API_TIME, "gaps", {entry_date: date});
    if (!result) {body.innerHTML = `<p class="t2 sm">Couldn't load the day's gaps.</p>`; return;}

    if (!result.window) {
        body.innerHTML = `<p class="t2 sm">Your working hours aren't declared for this date, so there's
            nothing to measure the timer against. <a data-gf="declare" style="cursor:pointer">Declare them</a>.</p>`;
        body.querySelector('[data-gf="declare"]').addEventListener("click", async _ => {
            const {shell} = await import("../../js/shell.mjs"); shell.setSurface("windows");
        });
        return;
    }

    if (!result.gaps.length) {
        body.innerHTML = `<p class="t2 sm">Nothing missing — the timer covers the window.</p>`;
        return;
    }

    body.innerHTML = `<div class="gap-filler-list">${result.gaps.map((gap, index) => _gapRowHtml(gap, index)).join("")}</div>
        <p class="t3 xs" style="margin-top:10px">Every entry logged here is marked reconstructed and keeps
            this signal — shown in the timesheet and in exports.</p>`;

    for (const row of body.querySelectorAll("[data-gap]")) {
        const gap = result.gaps[Number(row.getAttribute("data-gap"))];
        row.querySelector('[data-gf="task"]').addEventListener("click", async _ => {
            const tasksResponse = await _call(API_TASKS, "list", {filters: {}, page_size: 200});
            const openTasks = (tasksResponse?.rows || []).filter(task => task.status != "done" && task.status != "blocked");
            if (!openTasks.length) {states.toast({message: "No open tasks. Create one in Tasks."}); return;}
            const taskRef = await taskPicker.pick({title: "Log this gap to", tasks: openTasks});
            if (!taskRef) return;
            await _fill(body, date, gap, {task_ref: taskRef}, onChange);
        });
        row.querySelector('[data-gf="break"]').addEventListener("click", _ =>
            _fill(body, date, gap, {category: "break"}, onChange));
        row.querySelector('[data-gf="notwork"]').addEventListener("click", _ =>
            _fill(body, date, gap, {category: "other"}, onChange));
    }
}

async function _fill(body, date, gap, extra, onChange) {
    const result = await _call(API_TIME, "fill_gap",
        {entry_date: date, started_at: gap.start_epoch, ended_at: gap.end_epoch, ...extra});
    if (!result) return;
    states.toast({message: "Logged — marked reconstructed."});
    onChange();
    await _load(body, date, onChange);
}

function _gapRowHtml(gap, index) {
    return `<div class="gap-filler-row" data-gap="${index}">
        <span class="mono sm">${_clock(gap.start_epoch)}–${_clock(gap.end_epoch)}</span>
        <span class="t3 xs">${states.esc(_hm(gap.end_epoch - gap.start_epoch))}</span>
        <span class="push"></span>
        <button class="btn sm" data-gf="task">Log to a task</button>
        <button class="btn sm" data-gf="break">Break</button>
        <button class="btn sm" data-gf="notwork">Not work</button>
    </div>`;
}

const _clock = epochSeconds =>
    new Date(epochSeconds*1000).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"});
const _hm = seconds => `${Math.floor(seconds/3600)}h ${String(Math.floor((seconds%3600)/60)).padStart(2, "0")}m`;
const _mondayOf = isoDate => {
    const d = new Date(`${isoDate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay()+6)%7));
    return d.toISOString().substring(0, 10);
};

async function _call(api, op, extra={}) {
    let response; try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${api}`, "GET", {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`${api} op ${op} failed: ${err}`);}
    if (!response?.result) {
        states.toast({message: response?.reason || "The service did not respond.", ms: 8000});
        return null;
    }
    return response;
}

export const gapFiller = {open};
