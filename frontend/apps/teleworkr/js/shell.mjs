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
import {render as renderTeam} from "./screens/team.mjs";
import {render as renderCalendar} from "./screens/calendar.mjs";
import {render as renderLeave} from "./screens/leave.mjs";
import {render as renderPeople} from "./screens/people.mjs";
import {render as renderDisclosure} from "./screens/disclosure.mjs";
import {render as renderRecruitment} from "./screens/recruitment.mjs";
import {render as renderWellbeing} from "./screens/wellbeing.mjs";
import {render as renderWiki} from "./screens/wiki.mjs";
import {render as renderAccess} from "./screens/access.mjs";
import {render as renderData} from "./screens/data.mjs";
import {render as renderIdentity} from "./screens/identity.mjs";
import {render as renderSecurity} from "./screens/security.mjs";
import {render as renderAudit} from "./screens/audit.mjs";
import {render as renderWindows} from "./screens/windows.mjs";
import {render as renderApprovals} from "./screens/approvals.mjs";
import {render as renderWorkload} from "./screens/workload.mjs";
import {render as renderReports} from "./screens/reports.mjs";

const API_SHELL = "shell", API_CLOCK = "clock", API_NOTIF = "notifications";

/**
 * Screens land one increment at a time. A surface with no entry here still shows
 * — the catalogue and the person's access to it are already decided by A7 — but
 * renders the "not built yet" placeholder instead of a page. Adding a screen is
 * one line here, not a branch in setSurface.
 */
const SCREENS = {day: renderDayBoard, training: renderTraining, trainingtrack: renderTraining,
    surveys: renderSurveys, tasks: renderTasks, timesheet: renderTimesheet,
    team: renderTeam, calendar: renderCalendar, leave: renderLeave, people: renderPeople,
    me: renderDisclosure, recruitment: renderRecruitment, wellbeing: renderWellbeing, wiki: renderWiki,
    permissions: renderAccess, data: renderData, identity: renderIdentity, security: renderSecurity,
    audit: renderAudit, windows: renderWindows, approvals: renderApprovals,
    workload: renderWorkload, reports: renderReports};
const CLOCK_POLL_MS = 30000;        // the server is the record; the local tick is only the seconds between polls
const NOTIF_POLL_MS = 60000;
const THEME_KEY = "__teleworkr_theme";

/** A9: category label and whether the person may change its volume — mirrors lib/notifications.js's own CATALOGUE. */
const CATEGORY_META = {
    security_incident: {label: "Security incident affecting you", mutable: false},
    account_deprovisioned: {label: "Your account was deprovisioned", mutable: false},
    approval_sla: {label: "Approval waiting past SLA", mutable: true},
    became_blocker: {label: "You became the blocker", mutable: true},
    leave_decision: {label: "Leave decision on your request", mutable: false},
    meeting_starting: {label: "Meeting starting, you're the owner", mutable: true},
    page_past_review: {label: "Page you own is past review", mutable: true},
    wellbeing_signal: {label: "Wellbeing signal lit", mutable: true},
    task_assigned: {label: "Task assigned to you", mutable: true},
    timesheet_reminder: {label: "Your timesheet needs submitting", mutable: true},
    comment_mention: {label: "Comment, mention, wiki change", mutable: true}
};

let projection = null, currentSurface = null, clockState = null, clockTimer = null, pollTimer = null;
let notifTimer = null, notifTab = "feed";
let wizardStep = 1, wizardSkipped = false, wizardTimezone = null, wizardRoster = null;

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

    // B2: first sign-in, no working window declared yet. Skippable — the
    // ongoing nag lives in the banner projectAsync now populates, not in
    // anything this wizard itself persists.
    if (projection.window_declared === false && !wizardSkipped) {_renderFirstRunWizard(); return;}

    await _enterShell();
}

/** The normal shell's own boot tail — shared by initShell and the wizard's Skip/Finish paths. */
async function _enterShell() {
    _renderIdentity(); _renderTabs(); _renderMeMenu(); _renderBanners();
    await _refreshClock();
    pollTimer = setInterval(_refreshClock, CLOCK_POLL_MS);
    await _refreshNotifBadge();
    notifTimer = setInterval(_refreshNotifBadge, NOTIF_POLL_MS);

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
        // First-run: the org named by the IdP does not exist yet. Phase 0's
        // gate is "create an org, sign in via IdP" — this is the create half,
        // and it is the one failure the shell answers with a form instead of
        // an error.
        const loginResponse = session.get(APP_CONSTANTS.LOGIN_RESPONSE);
        if (loginResponse?.provisioning_status == "no_org") {
            _renderOrgBootstrap(loginResponse);
            document.querySelector("#tabs").innerHTML = "";
            return false;
        }

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
    if (projection.org_missing) {
        // First-run, decided by the server: the org the IdP named does not
        // exist. Render the creation form regardless of what the login result
        // carried, so a stale login response can never blank the screen.
        const loginResponse = session.get(APP_CONSTANTS.LOGIN_RESPONSE);
        _renderOrgBootstrap({suborg: loginResponse?.suborg || loginResponse?.org || null,
            org: projection.org_id});
        document.querySelector("#tabs").innerHTML = "";
        return false;
    }
    return true;
}

/**
 * The first-run screen: the IdP verified this person and named an org that
 * does not exist here yet. Creating it makes them its first admin — the Phase
 * 0 gate, rendered as a form rather than an error.
 *
 * @param {object} loginResponse The stored login result (org/suborg claims)
 */
function _renderOrgBootstrap(loginResponse) {
    const root = document.querySelector("#surface");
    const today = new Date().toISOString().substring(0, 10);
    const orgName = loginResponse.suborg || loginResponse.org || "";
    root.innerHTML = `<div class="page">
        <div class="orgboot">
            <div class="up t3">TeleWorkr · first sign-in</div>
            <h2>Set up your organisation</h2>
            <p class="t2 sm">Your identity is verified. <b>${states.esc(orgName)}</b> does not exist
                here yet — creating it makes you its first admin.</p>
            <div class="orgboot-form">
                <label class="col sm t3">Organisation name
                    <input class="inp" id="ob-name" value="${states.esc(orgName)}"></label>
                <label class="col sm t3">Home jurisdiction
                    <input class="inp" id="ob-home" placeholder="e.g. IN"></label>
                <label class="col sm t3">Your jurisdiction
                    <input class="inp" id="ob-jur" placeholder="e.g. IN"></label>
                <label class="col sm t3">Start date
                    <input class="inp" id="ob-start" type="date" value="${today}"></label>
                <label class="col sm t3">Employment status
                    <select class="inp" id="ob-status">
                        <option value="active">active</option><option value="on_probation">on probation</option>
                        <option value="terminated">terminated</option><option value="retired">retired</option>
                    </select></label>
                <label class="col sm t3">Contract type
                    <select class="inp" id="ob-contract">
                        <option value="employee">employee</option><option value="contractor">contractor</option>
                    </select></label>
                <button class="btn pri" id="ob-create">Create organisation</button>
            </div>
            <div id="ob-error" class="t3 sm"></div>
        </div>
    </div>`;

    root.querySelector("#ob-create").addEventListener("click", async _ => {
        const button = root.querySelector("#ob-create");
        button.disabled = true;
        const response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/org`, "GET",
            {op: "create", ..._me(),
                name: root.querySelector("#ob-name").value.trim(),
                home_jurisdiction: root.querySelector("#ob-home").value.trim(),
                jurisdiction: root.querySelector("#ob-jur").value.trim(),
                start_date: root.querySelector("#ob-start").value,
                employment_status: root.querySelector("#ob-status").value,
                contract_type: root.querySelector("#ob-contract").value}, true);
        if (!response?.result) {
            button.disabled = false;
            root.querySelector("#ob-error").textContent =
                response?.reason || "The organisation could not be created.";
            return;
        }
        states.toast({message: "Organisation created — you are its first admin."});
        window.location.reload();
    });
}

/**
 * B2 — first sign-in, no working window declared yet. Two screens, matching
 * the wireframe's own layout: identity/timezone confirmation, then the
 * window form and the tracking disclosure shown together (one grid, not
 * sequential pages). Skippable from either — the ongoing reminder lives in
 * the banner projectAsync already populates when no window exists, so
 * skipping here loses nothing permanent.
 */
function _renderFirstRunWizard() {
    if (wizardStep == 1) return _renderWizardStep1();
    return _renderWizardStep2();
}

function _renderWizardStep1() {
    const root = document.querySelector("#surface");
    document.querySelector("#tabs").innerHTML = "";
    const person = projection.person || {};
    if (!wizardTimezone) wizardTimezone = person.home_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

    root.innerHTML = `<div class="page">
        <div class="orgboot">
            <div class="up t3">TeleWorkr · first sign-in</div>
            <h2>Welcome, ${states.esc(person.display_name || person.email || "")}</h2>
            <p class="t2 sm">${states.esc(person.email || "")}</p>
            <div class="orgboot-form">
                <label class="col sm t3" style="grid-column:1/-1">Timezone
                    <input class="inp" id="wz-tz" value="${states.esc(wizardTimezone)}"></label>
                <button class="btn pri" id="wz-continue">Continue</button>
                <button class="btn" id="wz-skip">Skip — you can finish later</button>
            </div>
        </div>
    </div>`;

    root.querySelector("#wz-continue").addEventListener("click", _ => {
        wizardTimezone = root.querySelector("#wz-tz").value.trim() || wizardTimezone;
        wizardStep = 2; _renderFirstRunWizard();
    });
    root.querySelector("#wz-skip").addEventListener("click", _ => {wizardSkipped = true; _enterShell();});
}

async function _renderWizardStep2() {
    const root = document.querySelector("#surface");
    root.innerHTML = `<div class="page">${states.loading({rows: 4})}</div>`;
    if (!wizardRoster) {
        const response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/calendar`, "GET",
            {op: "roster", date: new Date().toISOString().substring(0,10), ..._me()}, true);
        wizardRoster = response?.roster || [];
    }

    root.innerHTML = `<div class="page">
        <div class="up t3">TeleWorkr · first sign-in</div>
        <h2 style="margin-top:4px">Your working window</h2>
        <p class="t2 sm">Declaring it is what makes the overlap board, send-later and your own capacity view work.</p>
        <div class="row wrap" style="gap:14px;margin-top:14px;align-items:flex-start">
            <div class="tr-card" style="flex:1;min-width:280px">
                <div class="up t3">Hours</div>
                <div class="row wrap" style="gap:8px;margin-top:8px">
                    <input class="inp" id="wz-start" type="time" value="09:00" style="width:110px">
                    <span class="sm t3">to</span>
                    <input class="inp" id="wz-end" type="time" value="17:30" style="width:110px">
                </div>
                <div class="sm t3" style="margin-top:6px">Timezone</div>
                <input class="inp" id="wz-window-tz" value="${states.esc(wizardTimezone)}" style="margin-top:4px;width:100%">
                <div class="sm t3" style="margin-top:8px">Days</div>
                <div class="row wrap" style="gap:4px;margin-top:4px">
                    ${[1,2,3,4,5,6,7].map(d => `<label class="sm"><input type="checkbox" data-wz-day="${d}"${d<=5?" checked":""}> ${["M","T","W","T","F","S","S"][d-1]}</label>`).join("")}
                </div>
                <div class="sm t3" style="margin-top:8px" id="wz-target"></div>
                <button class="btn sm" id="wz-preview" style="margin-top:10px">Preview against the team</button>
                <div class="sm" id="wz-preview-result" style="margin-top:6px"></div>
            </div>
            <div class="tr-card" style="flex:1;min-width:280px">
                <div class="up t3">What TeleWorkr records</div>
                <div class="sm" style="margin-top:8px">
                    <div class="row" style="gap:8px"><span class="chip">Yes</span><span class="grow">Clock in and out times, and which task the timer is on</span></div>
                    <div class="row" style="gap:8px;margin-top:6px"><span class="chip">Yes</span><span class="grow">Which apps you launch from TeleWorkr, and when</span></div>
                    <div class="row" style="gap:8px;margin-top:6px"><span class="chip">Yes</span><span class="grow">Idle periods over 10 minutes — you always get to keep or discard them</span></div>
                    <div class="row" style="gap:8px;margin-top:6px"><span class="chip warn">No</span><span class="grow">Screenshots, keystrokes, your screen, or anything outside TeleWorkr</span></div>
                    <div class="row" style="gap:8px;margin-top:6px"><span class="chip warn">No</span><span class="grow">Your location beyond the timezone you set above</span></div>
                </div>
                <div class="sm t3" style="margin-top:10px">Your manager sees weekly totals and task time — not minute-by-minute activity.</div>
            </div>
        </div>
        <div class="row wrap" style="gap:8px;margin-top:14px">
            <button class="btn" id="wz-back">Back</button>
            <button class="btn pri" id="wz-finish">I understand — finish setup</button>
            <button class="btn" id="wz-skip">Skip — you can finish later</button>
        </div>
    </div>`;

    const paintTarget = _ => {
        const start = _wzMinutes(root.querySelector("#wz-start").value), end = _wzMinutes(root.querySelector("#wz-end").value);
        const span = end > start ? end - start : (1440 - start) + end;
        root.querySelector("#wz-target").textContent = `Daily target: ${Math.floor(span/60)}h ${String(span%60).padStart(2,"0")}m`;
    };
    root.querySelector("#wz-start").addEventListener("input", paintTarget);
    root.querySelector("#wz-end").addEventListener("input", paintTarget);
    paintTarget();

    root.querySelector("#wz-back").addEventListener("click", _ => {wizardStep = 1; _renderFirstRunWizard();});
    root.querySelector("#wz-skip").addEventListener("click", _ => {wizardSkipped = true; _enterShell();});

    root.querySelector("#wz-preview").addEventListener("click", async _ => {
        const myId = projection.person?.person_id, managerId = projection.employment?.manager_person_id;
        const siblings = wizardRoster.filter(p => p.manager_person_id == managerId && p.person_id != myId);
        const cohort = (siblings.length ? siblings : wizardRoster.filter(p => p.person_id != myId)).slice(0, 3);
        const result = root.querySelector("#wz-preview-result");
        if (!cohort.length) {result.textContent = "No colleagues to compare against yet."; return;}
        result.textContent = "Checking…";

        // Reads colleagues' own already-declared hours rather than simulating the
        // form's unsaved values — team_overlap only ever reads from the database,
        // and there is nothing to preview against for someone who hasn't saved yet.
        const response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/windows`, "GET",
            {op: "team_overlap", person_ids: cohort.map(p => p.person_id),
                date: new Date().toISOString().substring(0,10), ..._me()}, true);
        if (!response?.result) {result.textContent = "Couldn't check right now."; return;}

        const declared = response.per_person.filter(p => p.workday && p.span);
        if (!declared.length) {
            result.textContent = `${cohort.length} nearby colleague${cohort.length==1?"":"s"}, none with hours declared yet.`;
            return;
        }
        result.innerHTML = declared.map(p => {
            const name = cohort.find(c => c.person_id == p.person_id)?.display_name || p.person_id;
            return `${states.esc(name)}: ${_wzClock(p.span.from)}–${_wzClock(p.span.to)} ${states.esc(p.timezone)}`;
        }).join("<br>");
    });

    root.querySelector("#wz-finish").addEventListener("click", async _ => {
        const days = [...root.querySelectorAll("[data-wz-day]:checked")].map(b => Number(b.getAttribute("data-wz-day")));
        if (!days.length) {states.toast({message: "Pick at least one working day."}); return;}
        const timezone = root.querySelector("#wz-window-tz").value.trim();
        const button = root.querySelector("#wz-finish");
        button.disabled = true;
        const response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/windows`, "GET",
            {op: "set", timezone, start_minute: _wzMinutes(root.querySelector("#wz-start").value),
                end_minute: _wzMinutes(root.querySelector("#wz-end").value), days,
                valid_from: new Date().toISOString().substring(0,10), ..._me()}, true);
        if (!response?.result) {
            button.disabled = false;
            states.toast({message: response?.reason || "Could not save your working window."});
            return;
        }
        states.toast({message: "Working window set."});
        await refreshProjection();
        await _enterShell();
    });
}

const _wzMinutes = hhmm => {const [h, m] = (hhmm||"0:0").split(":").map(Number); return h*60 + (m||0);};
const _wzClock = epochMinutes =>
    new Date(epochMinutes*60000).toLocaleTimeString(undefined, {hour: "2-digit", minute: "2-digit"});

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
    document.querySelector("#notifpanel").classList.remove("on");
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
// A9 — the notification bell: opens a panel, never a page
// ---------------------------------------------------------------------------

/** Silent on failure, same as the clock's own poll — the header degrades, the page does not. */
async function _refreshNotifBadge() {
    const feed = await _notifOp("feed", {}, true);
    if (feed) _updateNotifBadge(feed.unread_count);
}

function _updateNotifBadge(count) {
    const badge = document.querySelector("#notifbadge");
    badge.hidden = count <= 0;
    badge.textContent = count > 99 ? "99+" : String(count);
}

async function _renderNotifPanel() {
    const panel = document.querySelector("#notifpanel");
    panel.innerHTML = `<div class="tr-tabs">
        <button class="tr-tab${notifTab == "feed" ? " on" : ""}" data-notif="tab" data-tab="feed">Feed</button>
        <button class="tr-tab${notifTab == "settings" ? " on" : ""}" data-notif="tab" data-tab="settings">Settings</button>
    </div><div id="notifbody"></div>`;
    for (const button of panel.querySelectorAll("[data-notif=\"tab\"]"))
        button.addEventListener("click", _ => {notifTab = button.getAttribute("data-tab"); _renderNotifPanel();});

    const body = panel.querySelector("#notifbody");
    if (notifTab == "settings") await _renderNotifSettings(body);
    else await _renderNotifFeed(body);
}

/** Rows raised since the *previous* visit stay visually distinct for this viewing, then the watermark moves. */
async function _renderNotifFeed(body) {
    body.innerHTML = states.loading({rows: 3});
    const feed = await _notifOp("feed", {});
    if (!feed) return;

    body.innerHTML = feed.notifications.length ? feed.notifications.map(row => `
        <div class="notif-item${row.raised_at > feed.read_until ? " unread" : ""}">
            <div class="sm">${states.esc(CATEGORY_META[row.category]?.label || row.category)}</div>
            <div class="sm t3">${_relativeTime(row.raised_at)}</div>
        </div>`).join("") : `<div class="tr-empty">Nothing yet.</div>`;

    if (feed.unread_count > 0) {
        await _notifOp("mark_read", {});
        _updateNotifBadge(0);
    }
}

async function _renderNotifSettings(body) {
    body.innerHTML = states.loading({rows: 3});
    const settingsResponse = await _notifOp("settings", {});
    if (!settingsResponse) return;
    const settings = settingsResponse.settings || {};

    body.innerHTML = Object.entries(CATEGORY_META).map(([category, meta]) => {
        const level = settings[category] || "live";
        return `<div class="tr-track-row">
            <span class="grow sm">${states.esc(meta.label)}</span>
            ${meta.mutable ? `<select class="inp" data-notif="level" data-category="${states.esc(category)}" style="width:90px">
                <option value="live"${level == "live" ? " selected" : ""}>Live</option>
                <option value="digest"${level == "digest" ? " selected" : ""}>Digest</option>
                <option value="off"${level == "off" ? " selected" : ""}>Off</option>
            </select>` : `<span class="sm t3">Live — fixed</span>`}
        </div>`;
    }).join("");

    for (const select of body.querySelectorAll("[data-notif=\"level\"]")) select.addEventListener("change", async _ => {
        const result = await _notifOp("set_volume",
            {category: select.getAttribute("data-category"), level: select.value});
        if (result) states.toast({message: "Saved."});
    });
}

const _relativeTime = epochSeconds => {
    const diff = Math.max(0, Math.floor(Date.now()/1000) - epochSeconds);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
    return `${Math.floor(diff/86400)}d ago`;
}

async function _notifOp(op, extra={}, silent=false) {
    let response; try {
        response = await apiman.rest(`${APP_CONSTANTS.API_PATH}/${API_NOTIF}`, "GET", {op, ..._me(), ...extra}, true);
    } catch (err) {response = null; LOG.error(`Notifications op ${op} failed: ${err}`);}

    if (!response || !response.result) {
        if (!silent) states.toast({message: response?.reason || "The notification service did not respond.", ms: 8000});
        return null;
    }
    return response;
}

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

    const notifPanel = document.querySelector("#notifpanel"), notifBtn = document.querySelector("#notifbtn");
    notifBtn.addEventListener("click", event => {
        event.stopPropagation();
        const open = notifPanel.classList.toggle("on");
        notifBtn.setAttribute("aria-expanded", String(open));
        if (open) _renderNotifPanel();
    });
    document.addEventListener("click", _ => notifPanel.classList.remove("on"));
    notifPanel.addEventListener("click", event => event.stopPropagation());

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
    if (notifTimer) clearInterval(notifTimer);
    clockTimer = pollTimer = notifTimer = null;
}

export const shell = {initShell, refreshProjection, setSurface, stopShell, toggleClock,
    get projection() {return projection;}};
