/**
 * omni-bar — A3's global command bar, replacing v1's four separate search
 * boxes with one entry point that acts as well as finds.
 *
 * Verbs first (clock in [on a task], log a duration to a task, submit the
 * timesheet, who's free at a time), objects second (tasks/people/wiki pages,
 * fuzzy-matched and scoped by whatever the existing list/search ops already
 * gate server-side), and unparsed text never dead-ends — it offers a task
 * draft instead. "Block focus time" from the wireframe's own example is not
 * here: there is no calendar-event entity anywhere in this app to block time
 * on (the same gap E2/F1-F5 hit), and it is one of five verbs, not the
 * premise. Opening a found object navigates to its surface rather than
 * deep-linking to the exact row — this app has no mechanism to deep-link
 * into a screen anywhere yet, so that would be a bigger feature than this one.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "../../js/states.mjs";

const API_TASKS = "tasks", API_TIME = "time", API_CLOCK = "clock", API_CALENDAR = "calendar",
    API_WIKI = "wiki", API_WINDOWS = "windows";
const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

const MRU_KEY = "teleworkr.omni.recents", MRU_MAX = 6;
const HINT = `Try: clock in on 1042 · who's free at 3 · log 30m to 1038 · submit timesheet`;
const TYPE_PILL = {task: "Task", person: "Person", file: "File"};

/**
 * Opens the bar. Resolves when it closes, whether or not anything ran.
 * @param {object} options {myPersonId, managerId} — needed for "who's free" cohort resolution
 * @returns {Promise<void>}
 */
function open(options={}) {
    return new Promise(resolve => {
        const back = document.createElement("div");
        back.className = "confirm-back";
        back.innerHTML = `<div class="omnibar" role="dialog" aria-modal="true">
            <input class="inp omni-input" placeholder="clock in on 1042…" autocomplete="off">
            <div class="omni-free" style="display:none"></div>
            <div class="omni-results"></div>
            <div class="omni-hint t3 xs">${states.esc(HINT)}</div>
        </div>`;

        const ctx = {back, cache: {tasks: null, roster: null, pages: null}, rows: [], active: -1,
            freeTimer: null, myPersonId: options.myPersonId, managerId: options.managerId, done: null};
        ctx.done = _ => {
            if (ctx.freeTimer) clearTimeout(ctx.freeTimer);
            back.remove(); document.removeEventListener("keydown", onKey); resolve();
        };
        const onKey = event => {if (event.key == "Escape") ctx.done();};
        back.addEventListener("click", event => {if (event.target == back) ctx.done();});
        document.addEventListener("keydown", onKey);
        document.body.appendChild(back);

        _call(API_TASKS, "list", {filters: {}, page_size: 200}).then(r => {ctx.cache.tasks = r?.rows || []; _render(ctx);});
        _call(API_CALENDAR, "roster", {date: _todayISO()}).then(r => {ctx.cache.roster = r?.roster || []; _render(ctx);});
        _call(API_WIKI, "search", {}).then(r => {ctx.cache.pages = r?.pages || []; _render(ctx);});

        const input = back.querySelector(".omni-input");
        input.addEventListener("input", _ => _render(ctx));
        input.addEventListener("keydown", event => _onInputKey(event, ctx));
        back.querySelector(".omni-results").addEventListener("click", event => {
            const i = event.target.closest?.("[data-i]")?.getAttribute("data-i");
            if (i !== null && i !== undefined) _runRow(ctx, Number(i), false);
        });
        _render(ctx);
        input.focus();
    });
}

function _render(ctx) {
    const input = ctx.back.querySelector(".omni-input");
    const query = input.value.trim();
    const freeDiv = ctx.back.querySelector(".omni-free");

    const freeMatch = query.match(/^who'?s?\s+free\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (freeMatch) {
        freeDiv.style.display = "";
        ctx.rows = [];
        _renderFree(ctx, freeMatch);
    } else {
        freeDiv.style.display = "none"; freeDiv.innerHTML = "";
        if (ctx.freeTimer) {clearTimeout(ctx.freeTimer); ctx.freeTimer = null;}
        ctx.rows = _computeRows(ctx, query);
    }
    ctx.active = ctx.rows.length ? 0 : -1;
    ctx.back.querySelector(".omni-results").innerHTML = _rowsHtml(ctx, Boolean(query));
}

function _computeRows(ctx, query) {
    const rows = [];
    const clockMatch = query.match(/^clock\s*in(?:\s+(?:on|for)\s+(.+))?$/i);
    const logMatch = query.match(/^log\s+(\d+(?:\.\d+)?)\s*(m|min|minutes|h|hr|hrs|hours)\s+to\s+(.+)$/i);
    const submitMatch = /^submit\s+timesheet$/i.test(query);
    const matchedVerb = Boolean(clockMatch || logMatch || submitMatch);
    // A verb's own object fragment ("1042" in "clock in on 1042") is what FIND
    // matches against — the whole sentence is only used for FIND when nothing
    // parsed as a verb at all, otherwise every find would just be "no matches".
    let findQuery = matchedVerb ? "" : query;

    if (clockMatch) {
        const frag = clockMatch[1]?.trim();
        if (frag) {
            findQuery = frag;
            const task = _findTask(ctx, frag);
            if (task) rows.push({type: "do", kind: "clockin", section: "DO", task,
                label: "Clock in", sub: `start the timer on ${task.task_ref} · ${task.title}`,
                run: _ => _doClockIn(task.task_ref)});
        } else rows.push({type: "do", kind: "clockin", section: "DO", task: null,
            label: "Clock in", sub: "start the timer, unbound to a task",
            run: _ => _doClockIn(null)});
    }

    if (logMatch) {
        const frag = logMatch[3].trim();
        findQuery = frag;
        const task = _findTask(ctx, frag);
        if (task) {
            const isHours = /^h/i.test(logMatch[2]);
            const seconds = Math.round(parseFloat(logMatch[1]) * (isHours ? 3600 : 60));
            rows.push({type: "do", kind: "log", section: "DO", task,
                label: `Log ${logMatch[1]}${isHours ? "h" : "m"}`, sub: `to ${task.task_ref} · ${task.title}`,
                run: _ => _doLog(task.task_ref, seconds)});
        }
    }

    if (submitMatch) rows.push({type: "do", kind: "submit", section: "DO", task: null,
        label: "Submit timesheet", sub: `for the week of ${_mondayOf(_todayISO())}`,
        run: _ => _doSubmit()});

    if (findQuery) rows.push(..._findRows(ctx, findQuery));

    if (!matchedVerb && query) rows.push({type: "draft", kind: "draft", section: null, task: null,
        label: `Create task: "${query}"`, sub: "Unparsed text becomes a task draft",
        run: _ => _doCreateDraft(query)});

    return rows.length ? rows : _recentRows();
}

function _recentRows() {
    let recents = []; try {recents = JSON.parse(localStorage.getItem(MRU_KEY) || "[]");} catch (_e) {recents = [];}
    return recents.map(r => ({type: r.type, kind: r.kind, section: "RECENT", label: r.label, sub: r.sub,
        task: r.taskRef ? {task_ref: r.taskRef} : null, surface: r.surface,
        run: _ => r.kind == "clockin" ? _doClockIn(r.taskRef) :
            r.kind == "submit" ? _doSubmit() : _goto(r.surface)}));
}

function _pushRecent(row) {
    if (!["clockin", "submit", "task", "person", "file"].includes(row.type == "do" ? row.kind : row.type)) return;
    const entry = row.type == "do" ?
        {kind: row.kind, type: "do", label: row.label, sub: row.sub, taskRef: row.task?.task_ref || null, surface: null} :
        {kind: "goto", type: row.type, label: row.label, sub: row.sub, taskRef: null,
            surface: row.type == "task" ? "tasks" : row.type == "person" ? "team" : "wiki"};
    let recents = []; try {recents = JSON.parse(localStorage.getItem(MRU_KEY) || "[]");} catch (_e) {recents = [];}
    recents = recents.filter(r => !(r.kind == entry.kind && r.taskRef == entry.taskRef && r.surface == entry.surface));
    recents.unshift(entry);
    try {localStorage.setItem(MRU_KEY, JSON.stringify(recents.slice(0, MRU_MAX)));} catch (_e) {/* best-effort only */}
}

function _findTask(ctx, frag) {
    const tasks = ctx.cache.tasks || [];
    const q = frag.toLowerCase().replace(/^task-/, "");
    return tasks.find(t => t.task_ref.toLowerCase().replace(/^task-/, "").includes(q) ||
        t.title.toLowerCase().includes(q)) || null;
}

function _findRows(ctx, query) {
    const q = query.toLowerCase();
    const rows = [];
    let n = 0;
    for (const t of (ctx.cache.tasks || [])) {
        if (n >= 5) break;
        if ((t.task_ref + " " + t.title).toLowerCase().includes(q)) {
            rows.push({type: "task", kind: "task", section: "FIND", task: t, surface: "tasks",
                label: t.title, sub: t.task_ref, run: _ => _goto("tasks")}); n++;
        }
    }
    n = 0;
    for (const p of (ctx.cache.roster || [])) {
        if (n >= 5) break;
        if ((p.display_name || "").toLowerCase().includes(q)) {
            rows.push({type: "person", kind: "person", section: "FIND", task: null, surface: "team",
                label: p.display_name, sub: "Person", run: _ => _goto("team")}); n++;
        }
    }
    n = 0;
    for (const page of (ctx.cache.pages || [])) {
        if (n >= 5) break;
        if ((page.title || "").toLowerCase().includes(q)) {
            rows.push({type: "file", kind: "file", section: "FIND", task: null, surface: "wiki",
                label: page.title, sub: "Wiki page", run: _ => _goto("wiki")}); n++;
        }
    }
    return rows;
}

function _rowsHtml(ctx, hasQuery) {
    if (!ctx.rows.length) return `<div class="t3 sm" style="padding:10px 2px">${
        hasQuery ? "No matches." : "No recent activity yet."}</div>`;
    let html = "", lastSection;
    ctx.rows.forEach((row, i) => {
        if (row.section !== lastSection) {
            if (row.section) html += `<div class="omni-sec t3 xs">${states.esc(row.section)}</div>`;
            lastSection = row.section;
        }
        html += `<div class="omni-row row${i == ctx.active ? " on" : ""}" data-i="${i}">
            <span class="grow"><span>${states.esc(row.label)}</span>${
                row.sub ? `<span class="t3 xs" style="display:block">${states.esc(row.sub)}</span>` : ""}</span>
            ${TYPE_PILL[row.type] ? `<span class="t3 xs push">${TYPE_PILL[row.type]}</span>` : ""}
        </div>`;
    });
    return html;
}

function _onInputKey(event, ctx) {
    if (event.key == "ArrowDown") {event.preventDefault(); _move(ctx, 1);}
    else if (event.key == "ArrowUp") {event.preventDefault(); _move(ctx, -1);}
    else if (event.key == "Enter") {
        event.preventDefault();
        if (ctx.active >= 0) _runRow(ctx, ctx.active, event.metaKey || event.ctrlKey);
    }
}

function _move(ctx, delta) {
    if (!ctx.rows.length) return;
    ctx.active = (ctx.active + delta + ctx.rows.length) % ctx.rows.length;
    ctx.back.querySelectorAll(".omni-row").forEach((el, i) => el.classList.toggle("on", i == ctx.active));
}

async function _runRow(ctx, i, openInstead) {
    const row = ctx.rows[i];
    if (!row) return;
    if (openInstead && row.type == "do" && row.task) {await _goto("tasks"); ctx.done(); return;}
    const ok = await row.run();
    if (ok) {_pushRecent(row); ctx.done();}
}

async function _renderFree(ctx, match) {
    const freeDiv = ctx.back.querySelector(".omni-free");
    freeDiv.innerHTML = `<div class="t3 sm">Checking…</div>`;
    if (ctx.freeTimer) clearTimeout(ctx.freeTimer);
    ctx.freeTimer = setTimeout(async _ => {
        let hour = parseInt(match[1], 10);
        const minute = match[2] ? parseInt(match[2], 10) : 0;
        const meridiem = match[3]?.toLowerCase();
        if (meridiem == "pm" && hour < 12) hour += 12;
        if (meridiem == "am" && hour == 12) hour = 0;
        if (!meridiem && hour >= 1 && hour <= 7) hour += 12;   // bare "3" during the day reads as 3pm

        const target = new Date(); target.setHours(hour, minute, 0, 0);
        const targetMinutes = target.getUTCHours()*60 + target.getUTCMinutes();
        const label = target.toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"});

        if (ctx.cache.roster === null) {freeDiv.innerHTML = `<div class="t3 sm">Still loading the roster…</div>`; return;}
        const roster = ctx.cache.roster;
        const siblings = roster.filter(p => p.manager_person_id == ctx.managerId && p.person_id != ctx.myPersonId);
        const cohort = (siblings.length ? siblings : roster.filter(p => p.person_id != ctx.myPersonId)).slice(0, 8);
        if (!cohort.length) {freeDiv.innerHTML = `<div class="t3 sm">No colleagues to check.</div>`; return;}

        const response = await _call(API_WINDOWS, "team_overlap", {person_ids: cohort.map(p => p.person_id), date: _todayISO()});
        if (!response) return;

        const byId = new Map(cohort.map(p => [p.person_id, p.display_name]));
        const free = [];
        for (const p of response.per_person || []) {
            if (p.workday && p.span && _within(targetMinutes, p.span)) free.push(byId.get(p.person_id) || p.person_id);
        }
        freeDiv.innerHTML = free.length ?
            `<div class="t2 sm"><b>Free at ${states.esc(label)}:</b> ${states.esc(free.join(", "))}</div>` :
            `<div class="t3 sm">Nobody nearby is working at ${states.esc(label)}.</div>`;
    }, 300);
}

const _within = (minutes, span) => (minutes >= span.from && minutes <= span.to) ||
    (minutes + 1440 >= span.from && minutes + 1440 <= span.to);

async function _doClockIn(taskRef) {
    const r = await _call(API_CLOCK, "in", taskRef ? {task_ref: taskRef} : {});
    if (r) states.toast({message: taskRef ? `Clocked in on ${taskRef}.` : "Clocked in."});
    return Boolean(r);
}

async function _doLog(taskRef, seconds) {
    const r = await _call(API_TIME, "record", {entry_date: _todayISO(), task_ref: taskRef, duration_seconds: seconds});
    if (r) states.toast({message: `Logged to ${taskRef}.`});
    return Boolean(r);
}

async function _doSubmit() {
    const r = await _call(API_TIME, "submit", {week_start: _mondayOf(_todayISO())});
    if (r) states.toast({message: "Timesheet submitted."});
    return Boolean(r);
}

async function _doCreateDraft(title) {
    const r = await _call(API_TASKS, "create", {title});
    if (r) states.toast({message: `Created ${r.task?.task_ref || "the task"}.`});
    return Boolean(r);
}

async function _goto(surface) {
    const {shell} = await import("../../js/shell.mjs");
    shell.setSurface(surface);
    return true;
}

const _todayISO = _ => new Date().toISOString().substring(0, 10);
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

export const omniBar = {open};
