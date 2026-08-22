/**
 * A2 — the shell, and A7 — the projection that fills it.
 *
 * The nav is not built here. It is fetched, already decided, from the server: a
 * client that computes its own menu from a role name is a role fork waiting to
 * happen, and it also tells the person what exists that they cannot have. What
 * arrives is a list of surfaces this person can reach, and this module draws it.
 *
 * Hiding is a courtesy. Every action behind every surface is still refused by the
 * permission engine on its own terms.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

import {session} from "/framework/js/session.mjs";
import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {states} from "./states.mjs";
import {render as renderDayBoard} from "./screens/dayboard.mjs";
import {render as renderTraining} from "./screens/training.mjs";
import {render as renderSurveys} from "./screens/surveys.mjs";
import {render as renderTasks} from "./screens/tasks.mjs";
import {render as renderTimesheet} from "./screens/timesheet.mjs";

const API_SHELL = "shell", API_CLOCK = "clock";

/**
 * Screens land one increment at a time. A surface with no entry here still shows
 * — the catalogue and the person's access to it are already decided by A7 — but
 * renders the "not built yet" placeholder instead of a page. Adding a screen is
 * one line here, not a branch in setSurface.
 */
const SCREENS = {day: renderDayBoard, training: renderTraining, trainingtrack: renderTraining,
    surveys: renderSurveys, tasks: renderTasks, timesheet: renderTimesheet};
const CLOCK_POLL_MS = 30000;        // the server is the record; the local tick is only the seconds between polls
const THEME_KEY = "__teleworkr_theme";

let projection = null, currentSurface = null, clockState = null, clockTimer = null, pollTimer = null;

const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

/**
 * Boots the shell into the page. Called once, from main.html.
 */
async function initShell() {
    _applyTheme(session.get(THEME_KEY)?.toString());
    _wireChrome();

    document.querySelector("#surface").innerHTML = states.loading({rows: 4});
    _paintWhen();
    setInterval(_paintWhen, 30000);

    if (!await refreshProjection()) return;

    _renderIdentity(); _renderTabs(); _renderMeMenu(); _renderBanners();
    await _refreshClock();
    pollTimer = setInterval(_refreshClock, CLOCK_POLL_MS);

    const wanted = (new URL(window.location.href).hash||"").replace("#", "");
    setSurface(_canReach(wanted) ? wanted : projection.home);
}

/**
 * Re-reads the projection. Called on boot and whenever a grant may have changed —
 * an expired elevation should take its tab away without a sign-out.
 * @returns true if a projection was obtained
 */
async function refreshProjection() {
    const me = _me();
    let response; try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_SHELL}`, "GET", {op: "bootstrap", ...me}, true);
    } catch (err) {response = null; LOG.error(`Shell bootstrap failed: ${err}`);}

    if (!response || !response.result) {
        // The shell itself could not load. This is the one error that cannot be
        // rendered inside the shell, so it replaces it.
        const root = document.querySelector("#surface");
        root.innerHTML = states.error({title: "TeleWorkr could not start",
            what: response?.reason || "The server did not respond.",
            safe: "Nothing you have recorded is affected.",
            reference: `SHELL-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(root, {retry: _ => window.location.reload()});
        document.querySelector("#tabs").innerHTML = "";
        return false;
    }

    projection = response;
    return true;
}

/**
 * Switches the visible surface. Refuses to open one the projection does not
 * contain, rather than rendering a screen whose every call would be refused.
 * @param {string} surfaceId The surface to show
 */
function setSurface(surfaceId) {
    if (!projection) return;
    if (!_canReach(surfaceId)) {
        const root = document.querySelector("#surface");
        root.innerHTML = states.denied({title: "That surface is not part of your product",
            who_can: "Your administrator can grant the capability it needs."});
        states.bind(root, {request: _ => states.toast({message: "Access requests are not built yet."})});
        return;
    }

    currentSurface = surfaceId;
    window.history.replaceState(null, "", `#${surfaceId}`);
    document.querySelector("#memenu").classList.remove("on");
    for (const link of document.querySelectorAll("[data-surface]"))
        link.classList.toggle("on", link.getAttribute("data-surface") == surfaceId);

    const surface = _surface(surfaceId);
    const root = document.querySelector("#surface");

    const screen = SCREENS[surfaceId];
    if (screen) {screen(root); return;}

    // No screen registered yet. Say so plainly rather than rendering an empty
    // page that looks like a bug — access to the surface is already decided,
    // only the screen itself is still pending.
    root.innerHTML = `<div class="page">
        <h2 class="disp" style="font-size:19px">${states.esc(surface.label)}</h2>
        <p class="t2 sm" style="margin-top:4px">Wireframe ${states.esc(surface.screen)} · ${states.esc(surface.classification)} surface</p>
        <div style="margin-top:22px">${states.empty({
            title: "This screen is not built yet",
            body: "The surface is in the catalogue and your access to it is already decided. The screen itself lands in a later increment."})}</div>
    </div>`;
}

const _canReach = surfaceId => Boolean(surfaceId) && Boolean(_surface(surfaceId));
const _reachable = _ => [...(projection?.tabs||[]),
    ...(projection?.consoles||[]).flatMap(group => group.surfaces)];
const _surface = surfaceId => _reachable().find(surface => surface.id == surfaceId);

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** The five tabs A1 fixes, minus any whose screen this person cannot reach. */
function _renderTabs() {
    const region = document.querySelector("#tabs");
    region.innerHTML = (projection.tabs||[]).map(surface =>
        `<a data-surface="${states.esc(surface.id)}"><span class="code">${states.esc(surface.screen)}</span>${
            states.esc(surface.label)}</a>`).join("");
    for (const link of region.querySelectorAll("a"))
        link.addEventListener("click", _ => setSurface(link.getAttribute("data-surface")));
}

/** Everything in the IA that is reachable but is not a tab, plus theme and sign out. */
function _renderMeMenu() {
    const menu = document.querySelector("#memenu");
    menu.innerHTML = (projection.consoles||[]).map(group => `
        <div class="mh">${states.esc(group.console)}</div>
        ${group.surfaces.map(surface => `<a data-surface="${states.esc(surface.id)}">
            <span class="code">${states.esc(surface.screen)}</span>${states.esc(surface.label)}</a>`).join("")}`).join("")
        + `<div class="sep"></div>
        <button data-me="theme">Switch theme</button>
        <button data-me="signout">Sign out</button>
        <div class="foot">${projection.coverage.visible} of ${projection.coverage.total} surfaces</div>`;

    for (const link of menu.querySelectorAll("[data-surface]"))
        link.addEventListener("click", _ => setSurface(link.getAttribute("data-surface")));
    menu.querySelector('[data-me="theme"]').addEventListener("click", _ => {
        const next = document.documentElement.getAttribute("data-theme") == "day" ? "night" : "day";
        _applyTheme(next); session.set(THEME_KEY, next); menu.classList.remove("on");
    });
    menu.querySelector('[data-me="signout"]').addEventListener("click", _ =>
        window.monkshu_env.apps[APP_CONSTANTS.APP_NAME].main.logoutClicked());
}

function _renderIdentity() {
    const person = projection.person||{}, employment = projection.employment;
    const name = person.display_name || person.email || "";
    const avatar = document.querySelector("#avatar");
    avatar.textContent = (name.trim()[0]||"?").toUpperCase();
    avatar.title = employment ? `${name} · ${employment.jurisdiction} · ${employment.status}` : name;
}

/** A2's system banner slot. An empty list means nothing is degraded — never that nothing was checked. */
function _renderBanners() {
    const region = document.querySelector("#banners");
    const banners = projection.banners||[];
    region.innerHTML = banners.map(banner => {
        const level = {blocked: "block", degraded: "warn", read_only: "warn",
            local_only: "info", queued: "queued"}[banner.level] || "info";
        return `<div class="banner ${level}" role="status">
            <span>${states.esc(banner.message)}</span>
            ${banner.what_to_do ? `<span class="what">${states.esc(banner.what_to_do)}</span>` : ""}
        </div>`;
    }).join("");
}

// ---------------------------------------------------------------------------
// the clock — persistent, and it states what it is bound to
// ---------------------------------------------------------------------------

async function _refreshClock() {
    let response; try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_CLOCK}`, "GET", {op: "status", ..._me()}, true);
    } catch (err) {response = null;}

    if (!response || !response.result) {   // the header degrades, the page does not
        document.querySelector("#clock").classList.add("idle");
        document.querySelector("#clock-task").textContent = "clock unavailable";
        return;
    }
    clockState = response; _paintClock();

    if (clockTimer) clearInterval(clockTimer);
    if (clockState.running) clockTimer = setInterval(_paintClock, 1000);
}

function _paintClock() {
    if (!clockState) return;
    const element = document.querySelector("#clock");
    const running = clockState.running;

    let seconds = clockState.today_total_seconds || 0;
    if (running?.started_at) {  // count the seconds between polls locally
        const elapsedNow = Math.max(0, Math.floor(Date.now()/1000) - running.started_at);
        seconds = (clockState.today_total_seconds - (running.elapsed_seconds||0)) + elapsedNow;
    }

    element.classList.toggle("idle", !running);
    document.querySelector("#clock-val").textContent = _hms(seconds);
    document.querySelector("#clock-task").textContent = running ?
        (running.task_ref ? `on ${running.task_ref}` : "no task bound") : "not clocked in";
    document.querySelector("#clock-act").textContent = running ? "Clock out" : "Clock in";
    document.querySelector("#clock-act").classList.toggle("stop", Boolean(running));

    // A2 asks for the week total here. Only today's is a read the server currently
    // offers, so this states today rather than presenting a week figure it cannot back.
    document.querySelector("#hdr-logged").textContent = `Today · ${_hm(seconds)} logged`;

    const status = document.querySelector("#statusctl");
    status.setAttribute("data-status", running ? "working" : "offline");
    document.querySelector("#status-label").textContent = running ? "Working" :
        (clockState.workday === false ? "Not a working day" : "Off the clock");
}

/** A2 carries the date and what is logged beside the instrument that produces it. */
function _paintWhen() {
    const now = new Date();
    const date = now.toLocaleDateString(undefined, {weekday: "short", day: "numeric", month: "short"});
    const time = now.toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"});
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    document.querySelector("#hdr-date").textContent = `${date} · ${time} ${zone}`;
}

const _hms = total => {
    const h = Math.floor(total/3600), m = Math.floor((total%3600)/60), s = Math.floor(total%60);
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
};

const _hm = total => `${Math.floor(total/3600)}h ${String(Math.floor((total%3600)/60)).padStart(2,"0")}m`;

/**
 * C2's one button, driven by state. Clocking in is immediate — hesitating in front
 * of a dialog is how the first ten minutes of a day go unrecorded. Clocking out
 * confirms, because it states a total that is about to become the record.
 */
async function toggleClock() {
    const button = document.querySelector("#clock-act");
    if (button.disabled) return;
    button.disabled = true;

    try {
        if (!clockState?.running) {
            const started = await _clockOp("in");
            if (started) states.toast({message: `Clocked in at ${_time(started.entry?.started_at)}.`});
            return;
        }

        const preview = await _clockOp("out_preview");
        if (!preview) return;

        const confirmed = await states.confirmAction({
            title: `Clock out at ${_time(preview.at)}?`,
            body: `${_hm(preview.session_seconds)} will be recorded for today, bringing the day to ${
                _hm(preview.today_total_seconds)}.`,
            collateral: preview.warnings.map(warning => warning.message),
            confirmLabel: "Clock out"});
        if (!confirmed) return;

        const stopped = await _clockOp("out");
        if (stopped) states.toast({message: `Clocked out. ${_hm(stopped.recorded_seconds)} recorded.`});
    } finally {
        button.disabled = false;
        await _refreshClock();
    }
}

/**
 * One place where a clock operation can fail, so the failure is stated once and
 * the same way. A refused clock action says why — the engine already explains
 * itself, and swallowing that into "something went wrong" wastes it.
 */
async function _clockOp(op, extra={}) {
    let response; try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_CLOCK}`, "GET", {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Clock op ${op} failed: ${err}`);}

    if (!response || !response.result) {
        states.toast({message: response?.reason || "The clock could not be reached. Your recorded time is safe.",
            ms: 8000});
        return null;
    }
    return response;
}

const _time = seconds => seconds ?
    new Date(seconds*1000).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"}) : "now";

// ---------------------------------------------------------------------------

function _wireChrome() {
    document.querySelector("#omni").addEventListener("click", _ =>
        states.toast({message: "The command bar (A3) is not built yet."}));

    const menu = document.querySelector("#memenu"), avatar = document.querySelector("#avatar");
    avatar.addEventListener("click", event => {
        event.stopPropagation();
        const open = menu.classList.toggle("on");
        avatar.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", _ => menu.classList.remove("on"));
    menu.addEventListener("click", event => event.stopPropagation());

    document.querySelector("#overlap").addEventListener("click", _ =>
        projection && _canReach("team") ? setSurface("team") :
            states.toast({message: "The overlap board is not part of your product."}));

    document.querySelector("#clock-act").addEventListener("click", _ => toggleClock());

    document.querySelector("#notifbtn").addEventListener("click", _ =>
        states.toast({message: "The notification panel (A9) is not built yet."}));

    document.addEventListener("keydown", event => {      // A2: cmd-K opens the command bar
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() == "k") {
            event.preventDefault(); document.querySelector("#omni").click();
        }
    });

    window.addEventListener("offline", _ => _systemBanner("local_only",
        "You are offline. Time is still recording locally.", "It syncs when you reconnect."));
    window.addEventListener("online", async _ => {
        if (projection) projection.banners = [];
        _renderBanners();
        if (await refreshProjection()) {_renderIdentity(); _renderTabs(); _renderMeMenu(); _renderBanners();}
    });
}

function _systemBanner(level, message, what_to_do) {
    if (!projection) return;
    projection.banners = [...(projection.banners||[]).filter(b => b.level != level), {level, message, what_to_do}];
    _renderBanners();
}

function _applyTheme(theme) {
    if (theme == "day" || theme == "night") document.documentElement.setAttribute("data-theme", theme);
}

/** Stops the timers, so a signed-out shell does not keep polling. */
function stopShell() {
    if (clockTimer) clearInterval(clockTimer);
    if (pollTimer) clearInterval(pollTimer);
    clockTimer = pollTimer = null;
}

export const shell = {initShell, refreshProjection, setSurface, stopShell, toggleClock,
    get projection() {return projection;}};
