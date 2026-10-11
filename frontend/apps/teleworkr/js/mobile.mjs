/**
 * A11 — mobile, designed. Three cards, each one decision, usable one-handed,
 * outdoors, in eight seconds — A5's principle, finally drawn. A standalone
 * page outside the desktop shell (see mobile.html), not a responsive
 * breakpoint on top of it: "no nav, no tabs" means this isn't shell.mjs's
 * header shrunk down, it's a different composition of the same component
 * layer (tokens/states/training.css), same as K9's portal.html precedent.
 *
 * Every read and write below already exists and is already tested —
 * dayboard.boardAsync (the clock + bound task), clock.js's in/out/switch/
 * break ops, and the exact pending-timesheet/pending-leave + approve/decline
 * ops approvals.mjs already uses. The one new mechanism is the offline
 * buffer: time.js:syncEventsAsync ("the A11 reconnect path") and
 * apis/clock.js's `sync` op were fully wired and had zero frontend callers
 * until this file.
 *
 * Narrowed, deliberately:
 *  - "Next" (upcoming meeting) has no data to stand on — no meeting/
 *    calendar-event entity exists anywhere (dayboard.js's own desktop card
 *    already reports the identical honest "not_tracked" zero). Named, not
 *    silently dropped, same as the wireframe's own excluded-features card.
 *  - Push notifications: no delivery mechanism exists anywhere (no service
 *    worker, no manifest, no push-subscription table) — nothing to
 *    "reserve for 3 categories," so not built.
 *  - Web, not native: no lock-screen widget, no watch complication, no
 *    background timing.
 *  - A flagged (reconstructed) timesheet row's "Open" shows the same
 *    excluded-feature treatment as "timesheet close" — explicitly named
 *    in the wireframe's own Not-on-mobile list — rather than a compact
 *    detail view. The "over target" flag (a second, per-row calendar call
 *    on desktop) is skipped here to keep this screen to one network call;
 *    only the reconstructed-count flag gates clean vs. flagged.
 *  - Offline buffering covers clock-in/out only. The wireframe's hard
 *    guarantee is specifically "clock-in must work with no network at
 *    all" — switch and break check navigator.onLine first and refuse
 *    locally with a plain message when offline, rather than reimplementing
 *    every clock transition as a local state machine.
 *  - A sync conflict is named in a plain banner pointing at C5 to
 *    reconcile, not a "keep mine/theirs" resolver — syncEventsAsync
 *    reports a conflict but exposes no resolution op for this path.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apiman} from "./apiclient.mjs";
import {session} from "/framework/js/session.mjs";
import {states} from "./states.mjs";
import {taskPicker} from "../components/task-picker/task-picker.mjs";

const API_SHELL = "shell", API_DAYBOARD = "dayboard", API_CLOCK = "clock",
    API_TASKS = "tasks", API_TIME = "time", API_LEAVE = "leave", API_CALENDAR = "calendar";
const QUEUE_KEY = "tw_mobile_clock_queue";

const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});
const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);
const _hm = seconds => `${Math.floor(seconds/3600)}h ${String(Math.floor((seconds%3600)/60)).padStart(2, "0")}m`;
const _hms = total => {
    const h = Math.floor(total/3600), m = Math.floor((total%3600)/60), s = Math.floor(total%60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const _nameOf = person_id => (state.roster||[]).find(p => p.person_id == person_id)?.display_name || person_id;

let state = null, tickTimer = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    state = {root, tab: "clock", board: null, capabilities: [], roster: [],
        timesheetQueue: [], leaveQueue: [], decliningLeaveId: null, queue: _loadQueue()};
    _view();
    window.addEventListener("online", async _ => {
        await _flushQueue();
        if (state.tab == "clock") await _loadClock();
    });
    await _bootstrap();
}

async function _bootstrap() {
    try {
        const proj = await _call(API_SHELL, "bootstrap", {});
        state.capabilities = proj?.capabilities || [];
    } catch (err) {/* degrades to no capabilities — Who-needs-me just stays empty-gated */}
    if (state.queue.queued.length || state.queue.running) await _flushQueue();
    await _loadClock();
}

// ---------------------------------------------------------------------------
// shell: the tab strip
// ---------------------------------------------------------------------------

function _view() {
    const root = state.root;
    root.innerHTML = `<div id="mob-card">${states.loading({rows: 4})}</div>
        <nav class="mob-tabs">
            <button data-tab="clock" class="on"><span>⏱</span><span>Clock</span></button>
            <button data-tab="next"><span>📅</span><span>Next</span></button>
            <button data-tab="who"><span>✅</span><span>Who needs me</span></button>
        </nav>`;
    for (const button of root.querySelectorAll("[data-tab]"))
        button.addEventListener("click", _ => _switchTab(button.getAttribute("data-tab")));
}

async function _switchTab(tab) {
    if (state.tab == tab) return;
    state.tab = tab;
    for (const button of state.root.querySelectorAll("[data-tab]"))
        button.classList.toggle("on", button.getAttribute("data-tab") == tab);
    if (tickTimer) {clearInterval(tickTimer); tickTimer = null;}

    if (tab == "clock") await _loadClock();
    else if (tab == "next") _renderNext();
    else if (tab == "who") await _loadWho();
}

// ---------------------------------------------------------------------------
// Card 1 — Clock
// ---------------------------------------------------------------------------

async function _loadClock() {
    let board = null;
    try {
        const response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_DAYBOARD}`, "GET",
            {op: "board", ..._me()}, true);
        if (response?.result) board = response;
    } catch (err) {/* unreachable — fall through to local state, same as A8 degrades */}
    state.board = board;

    if (!board && !state.queue.running) {
        const card = state.root.querySelector("#mob-card");
        card.innerHTML = `<div class="tr-card">${states.error({title: "Clock unavailable",
            what: "Could not reach the server.", safe: "Nothing was recorded.",
            actions: [{id: "retry", label: "Retry", primary: true}]})}</div>`;
        states.bind(card, {retry: _ => _loadClock()});
        return;
    }
    _renderClock();
    _restartTicker();
}

function _renderClock() {
    const card = state.root.querySelector("#mob-card");
    const localRunning = state.queue.running;
    const serverState = state.board?.clock?.state || "not_clocked_in";
    const clockState = localRunning ? "running" : serverState;
    const workingOn = localRunning ? {task_ref: localRunning.task_ref} : state.board?.working_on;
    const todayTotal = state.board?.clock?.today_total_seconds || 0;
    const queuedSeconds = state.queue.queued.reduce((sum, e) => sum + (e.duration_seconds||0), 0);

    let body;
    if (clockState == "not_clocked_in") {
        body = `<div class="up t3">Not clocked in</div>
            <div class="mono" style="font-size:34px;margin:10px 0">00:00:00</div>
            <button class="btn pri" data-mb="in" style="width:100%;min-height:44px">Clock in</button>`;
    } else if (clockState == "break") {
        body = `<div class="up t3">On a break</div>
            <div class="sm" style="margin:10px 0">${states.esc(_hm(todayTotal))} logged today</div>
            <button class="btn pri" data-mb="resume" style="width:100%;min-height:44px">Resume</button>`;
    } else {
        body = `<div class="up t3">${workingOn?.task_ref ? "Working on" : "Running"}</div>
            <div class="sm t3">${workingOn?.task_ref ? states.esc(`${workingOn.task_ref}${workingOn.project?` · ${workingOn.project}`:""}`) : "No task bound"}</div>
            <div class="mono" id="mb-elapsed" style="font-size:34px;margin:10px 0">00:00:00</div>
            <div class="row" style="gap:8px">
                <button class="btn" data-mb="pause" style="flex:1;min-height:44px">Pause</button>
                <button class="btn" data-mb="switch" style="flex:1;min-height:44px">Switch</button>
            </div>
            <button class="btn" data-mb="out" style="width:100%;min-height:44px;margin-top:8px">Clock out</button>`;
    }

    const showOffline = !navigator.onLine || queuedSeconds > 0 || localRunning;
    card.innerHTML = `<div class="tr-card">
        ${body}
        ${showOffline ? states.offline({buffered: queuedSeconds ? _hm(queuedSeconds) : (localRunning ? "0m" : null)}) : ""}
        ${(state.queue.conflicts||[]).length ? `<div class="tr-empty" style="color:var(--ember);margin-top:8px">
            ${state.queue.conflicts.length} buffered entr${state.queue.conflicts.length==1?"y":"ies"} didn't match
            the server — review in Timesheet &amp; Friday close on the full site.</div>` : ""}
    </div>`;

    card.querySelector('[data-mb="in"]')?.addEventListener("click", _ => _clockIn());
    card.querySelector('[data-mb="out"]')?.addEventListener("click", _ => _clockOut());
    card.querySelector('[data-mb="pause"]')?.addEventListener("click", _ => _pause());
    card.querySelector('[data-mb="resume"]')?.addEventListener("click", _ => _resume());
    card.querySelector('[data-mb="switch"]')?.addEventListener("click", _ => _switchTask());
}

function _restartTicker() {
    if (tickTimer) {clearInterval(tickTimer); tickTimer = null;}
    const localRunning = state.queue.running;
    const serverRunning = state.board?.clock?.running;
    const startedAt = localRunning ? localRunning.started_at : serverRunning?.started_at;
    if (!startedAt) return;

    const base = localRunning ?
        state.queue.queued.reduce((sum, e) => sum + (e.duration_seconds||0), 0) + (state.board?.clock?.today_total_seconds || 0) :
        (state.board.clock.today_total_seconds || 0) - (serverRunning.elapsed_seconds || 0);

    tickTimer = setInterval(_ => {
        const node = state.root.querySelector("#mb-elapsed");
        if (!node) return;
        node.textContent = _hms(base + Math.max(0, _now() - startedAt));
    }, 1000);
}

async function _clockIn() {
    if (navigator.onLine) {
        let response; try {
            response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_CLOCK}`, "GET", {op: "in", ..._me()}, true);
        } catch (err) {response = null;}
        if (response?.result) {states.toast({message: "Clocked in."}); await _loadClock(); return;}
        if (response?.reason) {   // a real refusal, not a network failure — don't buffer a duplicate
            states.toast({message: response.reason, ms: 8000}); return;
        }
        // no response at all — unreachable, fall through to buffering
    }
    state.queue.running = {started_at: _now(), task_ref: null, client_event_id: crypto.randomUUID()};
    _saveQueue();
    await _loadClock();
    states.toast({message: "Clocked in, offline. It'll sync when you're back online."});
}

async function _clockOut() {
    const localRunning = state.queue.running;

    if (localRunning && !navigator.onLine) {
        state.queue.queued.push({client_event_id: localRunning.client_event_id, entry_date: _today(),
            task_ref: localRunning.task_ref, started_at: localRunning.started_at, ended_at: _now(),
            duration_seconds: Math.max(0, _now() - localRunning.started_at), source: "timer"});
        state.queue.running = null;
        _saveQueue();
        await _loadClock();
        states.toast({message: "Clocked out, offline. It'll sync when you're back online."});
        return;
    }
    if (localRunning && navigator.onLine) {
        await _flushQueue();   // register the open session for real first
        if (state.queue.running) {   // the flush itself failed — still not registered server-side
            state.queue.queued.push({client_event_id: state.queue.running.client_event_id, entry_date: _today(),
                task_ref: state.queue.running.task_ref, started_at: state.queue.running.started_at,
                ended_at: _now(), duration_seconds: Math.max(0, _now() - state.queue.running.started_at), source: "timer"});
            state.queue.running = null;
            _saveQueue();
            await _loadClock();
            states.toast({message: "Clocked out, offline. It'll sync when you're back online."});
            return;
        }
    }

    const preview = await _call(API_CLOCK, "out_preview", {});
    if (!preview) return;
    const confirmed = await states.confirmAction({title: "Clock out?",
        body: `${_hm(preview.session_seconds)} will be recorded, bringing today to ${_hm(preview.today_total_seconds)}.`,
        collateral: (preview.warnings||[]).map(w => w.message), confirmLabel: "Clock out"});
    if (!confirmed) return;

    const stopped = await _call(API_CLOCK, "out", {});
    if (!stopped) return;
    states.toast({message: `Clocked out. ${_hm(stopped.recorded_seconds)} recorded.`});
    await _loadClock();
}

async function _pause() {
    if (!navigator.onLine) {states.toast({message: "Pause needs a connection. Try again once you're back online."}); return;}
    const response = await _call(API_CLOCK, "break_start", {});
    if (!response) return;
    states.toast({message: "On a break. The clock stopped."});
    await _loadClock();
}

async function _resume() {
    if (!navigator.onLine) {states.toast({message: "Resume needs a connection. Try again once you're back online."}); return;}
    const resumeTask = state.board?.working_on?.task_ref || null;
    const response = await _call(API_CLOCK, "break_end", {resume_task_ref: resumeTask});
    if (!response) return;
    states.toast({message: "Back to work."});
    await _loadClock();
}

/** The clock is bound to a task through the same shared picker the Day board uses. */
async function _switchTask() {
    if (!navigator.onLine) {states.toast({message: "Switch needs a connection. Try again once you're back online."}); return;}
    let response; try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_TASKS}`, "GET",
            {op: "list", filters: {}, page_size: 50, ..._me()}, true);
    } catch (err) {response = null;}
    if (!response?.result) {states.toast({message: response?.reason || "Could not load tasks."}); return;}
    const open = (response.rows || []).filter(task => task.status != "done" && task.status != "blocked");
    if (!open.length) {states.toast({message: "No open tasks to switch to."}); return;}

    const taskRef = await taskPicker.pick({title: "Switch the clock to", tasks: open});
    if (!taskRef) return;

    const prefs = await _call(API_CLOCK, "preferences", {});
    if (prefs?.confirm_before_switch !== false) {
        const confirmed = await states.confirmAction({title: `Switch the clock to ${taskRef}?`, confirmLabel: "Switch"});
        if (!confirmed) return;
    }

    const switched = await _call(API_CLOCK, "switch", {task_ref: taskRef});
    if (!switched) return;
    states.toast({message: `Clock moved to ${taskRef}.`});
    await _loadClock();
}

// ---------------------------------------------------------------------------
// the offline queue — clock-in/out only (see module header)
// ---------------------------------------------------------------------------

function _loadQueue() {
    try {
        const raw = localStorage.getItem(QUEUE_KEY);
        return raw ? JSON.parse(raw) : {running: null, queued: [], conflicts: []};
    } catch (err) {return {running: null, queued: [], conflicts: []};}
}

function _saveQueue() {
    try {localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue));}
    catch (err) {/* storage unavailable — degrades to no buffering, never a crash */}
}

/** Replays whatever is buffered via the A11 reconnect path (apis/clock.js op "sync"). */
async function _flushQueue() {
    const toSend = [...state.queue.queued];
    if (state.queue.running) toSend.push({client_event_id: state.queue.running.client_event_id,
        entry_date: _today(), task_ref: state.queue.running.task_ref,
        started_at: state.queue.running.started_at, source: "timer"});
    if (!toSend.length) return;

    let response; try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_CLOCK}`, "GET",
            {op: "sync", events: toSend, ..._me()}, true);
    } catch (err) {response = null;}
    if (!response?.result) return;   // still queued — retried on the next online event

    for (const result of response.results || []) {
        if (result.result == "stored" || result.result == "already_stored") {
            state.queue.queued = state.queue.queued.filter(e => e.client_event_id != result.client_event_id);
            if (state.queue.running?.client_event_id == result.client_event_id) state.queue.running = null;
        } else if (result.result == "conflict") {
            state.queue.conflicts = state.queue.conflicts || [];
            if (!state.queue.conflicts.includes(result.client_event_id)) state.queue.conflicts.push(result.client_event_id);
            state.queue.queued = state.queue.queued.filter(e => e.client_event_id != result.client_event_id);
            if (state.queue.running?.client_event_id == result.client_event_id) state.queue.running = null;
        } else if (result.result == "invalid") {
            states.toast({message: result.reason || "A buffered entry could not be saved."});
            state.queue.queued = state.queue.queued.filter(e => e.client_event_id != result.client_event_id);
            if (state.queue.running?.client_event_id == result.client_event_id) state.queue.running = null;
        }
    }
    _saveQueue();
}

// ---------------------------------------------------------------------------
// Card 2 — Next (narrowed — see module header)
// ---------------------------------------------------------------------------

function _renderNext() {
    const card = state.root.querySelector("#mob-card");
    card.innerHTML = `<div class="tr-card">
        <div class="up t3">Next meeting</div>
        <div class="tr-empty" style="margin-top:8px">Not built yet — no meeting or calendar-event entity
            exists in this product (Telemeet, F5, is still unbuilt). This card will show your next
            meeting and a one-tap Join once that exists.</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Card 3 — Who needs me
// ---------------------------------------------------------------------------

async function _loadWho() {
    const card = state.root.querySelector("#mob-card");
    card.innerHTML = `<div class="tr-card">${states.loading({rows: 3})}</div>`;

    const canApproveTimesheets = state.capabilities.includes("timesheet.approve");
    const canApproveLeave = state.capabilities.includes("leave.approve");
    if (!canApproveTimesheets && !canApproveLeave) {
        card.innerHTML = `<div class="tr-card"><div class="tr-empty">Nothing waiting on you.</div></div>`;
        return;
    }

    try {
        const [roster, timesheetQueue, leaveQueue] = await Promise.all([
            apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_CALENDAR}`, "GET", {op: "roster", date: _today(), ..._me()}, true),
            canApproveTimesheets ? _call(API_TIME, "pending", {}) : null,
            canApproveLeave ? _call(API_LEAVE, "pending", {}) : null
        ]);
        state.roster = roster?.roster || [];
        state.timesheetQueue = timesheetQueue?.queue || [];
        state.leaveQueue = leaveQueue?.queue || [];
    } catch (err) {
        card.innerHTML = states.error({title: "Couldn't load who needs you", what: err.message,
            safe: "Nothing was changed.", reference: `A11-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(card, {retry: _ => _loadWho()});
        return;
    }
    _renderWho();
}

function _renderWho() {
    const card = state.root.querySelector("#mob-card");
    const total = state.timesheetQueue.length + state.leaveQueue.length;
    card.innerHTML = `<div class="tr-card">
        <div class="up t3">${total} waiting</div>
        ${total ? state.timesheetQueue.map(_timesheetRowHtml).join("") + state.leaveQueue.map(_leaveRowHtml).join("") :
            `<div class="tr-empty">Nothing waiting.</div>`}
    </div>`;
    _wireWho(card);
}

function _timesheetRowHtml(row) {
    const flagged = row.reconstructed_count > 0;   // "over target" needs a second per-row call — skipped here
    return `<div class="tr-track-row" style="flex-direction:column;align-items:stretch;gap:6px">
        <div class="sm">${states.esc(_nameOf(row.person_id))}'s timesheet</div>
        <div class="sm t3">${states.esc(row.week_start)} · ${states.esc(_hm(row.total_seconds))}${
            flagged ? ` · ${row.reconstructed_count} reconstructed` : " · clean"}</div>
        <div class="row" style="gap:8px">
            ${flagged ?
                `<button class="btn" data-who="open-ts" style="flex:1;min-height:44px">Open</button>` :
                `<button class="btn pri" data-who="approve-ts" data-person="${states.esc(row.person_id)}"
                    data-week="${states.esc(row.week_start)}" style="flex:1;min-height:44px">Approve</button>`}
        </div>
    </div>`;
}

function _leaveRowHtml(row) {
    const declining = state.decliningLeaveId == row.leave_request_id;
    return `<div class="tr-track-row" style="flex-direction:column;align-items:stretch;gap:6px">
        <div class="sm">${states.esc(_nameOf(row.person_id))} · ${states.esc(row.leave_type)}</div>
        <div class="sm t3">${states.esc(row.from_date)} – ${states.esc(row.to_date)} · ${row.days_deducted} day(s)${
            row.short_notice ? " · short notice" : ""}</div>
        ${declining ? `
            <input class="inp" id="decline-reason-${states.esc(row.leave_request_id)}" placeholder="Reason" style="min-height:44px">
            <div class="row" style="gap:8px">
                <button class="btn" data-who="cancel-decline" style="flex:1;min-height:44px">Cancel</button>
                <button class="btn danger" data-who="confirm-decline" data-id="${states.esc(row.leave_request_id)}"
                    style="flex:1;min-height:44px">Send</button>
            </div>` : `
            <div class="row" style="gap:8px">
                <button class="btn" data-who="decline-leave" data-id="${states.esc(row.leave_request_id)}"
                    style="flex:1;min-height:44px">Decline</button>
                <button class="btn pri" data-who="approve-leave" data-id="${states.esc(row.leave_request_id)}"
                    data-exception="${row.short_notice?1:0}" style="flex:1;min-height:44px">Approve</button>
            </div>`}
    </div>`;
}

function _wireWho(card) {
    card.querySelectorAll('[data-who="approve-ts"]').forEach(btn => btn.addEventListener("click",
        _ => _approveTimesheet(btn.dataset.person, btn.dataset.week)));
    card.querySelectorAll('[data-who="open-ts"]').forEach(btn => btn.addEventListener("click",
        _ => _notOnMobile("Timesheet close")));
    card.querySelectorAll('[data-who="approve-leave"]').forEach(btn => btn.addEventListener("click",
        _ => _approveLeave(btn.dataset.id, btn.dataset.exception == "1")));
    card.querySelectorAll('[data-who="decline-leave"]').forEach(btn => btn.addEventListener("click",
        _ => {state.decliningLeaveId = btn.dataset.id; _renderWho();}));
    card.querySelectorAll('[data-who="cancel-decline"]').forEach(btn => btn.addEventListener("click",
        _ => {state.decliningLeaveId = null; _renderWho();}));
    card.querySelectorAll('[data-who="confirm-decline"]').forEach(btn => btn.addEventListener("click",
        _ => _declineLeave(btn.dataset.id)));
}

async function _approveTimesheet(personId, weekStart) {
    const response = await _call(API_TIME, "approve", {subject_person_id: personId, week_start: weekStart});
    if (!response) return;
    states.toast({message: "Approved."});
    await _loadWho();
}

async function _approveLeave(id, asException) {
    const response = await _call(API_LEAVE, "approve",
        {leave_request_id: id, ...(asException ? {approve_as_exception: true} : {})});
    if (!response) return;
    states.toast({message: "Approved."});
    await _loadWho();
}

async function _declineLeave(id) {
    const input = state.root.querySelector(`#decline-reason-${id}`);
    const reason = input?.value?.trim();
    if (!reason) {states.toast({message: "A reason is needed."}); return;}
    const response = await _call(API_LEAVE, "decline", {leave_request_id: id, reason});
    if (!response) return;
    state.decliningLeaveId = null;
    states.toast({message: "Declined."});
    await _loadWho();
}

/** The wireframe's own treatment for an excluded feature: say what it is and why it needs a bigger screen. */
function _notOnMobile(featureName) {
    const card = state.root.querySelector("#mob-card");
    card.innerHTML = `<div class="tr-card">
        <div class="up t3">${states.esc(featureName)}</div>
        <div class="tr-empty" style="margin-top:8px">This needs a bigger screen.</div>
        <a href="./main.html" class="btn pri" style="display:block;text-align:center;margin-top:10px;min-height:44px;line-height:44px">Open full site</a>
    </div>`;
}

// ---------------------------------------------------------------------------

async function _call(api, op, extra = {}) {
    let response; try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${api}`, "GET", {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`${api} op ${op} failed: ${err}`);}
    if (!response?.result) {
        states.toast({message: response?.reason || `The ${api} service did not respond.`, ms: 8000});
        return null;
    }
    return response;
}
