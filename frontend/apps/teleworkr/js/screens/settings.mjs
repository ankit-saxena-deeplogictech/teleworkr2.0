/**
 * I1 — Settings & notifications. Grouped by what a person controls, not by
 * how the system is built.
 *
 * A top tab bar, not the wireframe's literal left sidebar — no sidebar-layout
 * CSS exists anywhere in this app, and the existing .tr-tabs convention
 * already solves "several named panels in one screen" (audit.mjs/
 * wellbeing.mjs/security.mjs). Same composition-over-invention call this
 * session already made elsewhere.
 *
 * The notification matrix here is a single live/digest/off dial per
 * category, not independent push/email/digest checkboxes — push and email
 * have no delivery mechanism anywhere in this app, and the catalogue's own
 * `channels` field is a fixed backend property per category, not a
 * per-person choice. Shown honestly for every catalogue category even
 * though only 2 of 11 are ever actually raised anywhere yet — same
 * transparency A10's event catalogue already established.
 *
 * Working hours / Privacy & your data / Connected apps are pure links to
 * screens that already exist (E4/H5/G1) — nothing rebuilt here. Accessibility
 * (I2 slice 1) and Language & region preferences (I2 slice 2a) are both now
 * built; applying those formats across every screen's own rendering, and RTL
 * layout, are separate, larger, later pieces — named as such in their own
 * tabs rather than silently implied as finished.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {apiman} from "../apiclient.mjs";
import {session} from "/framework/js/session.mjs";
import {i18n} from "/framework/js/i18n.mjs";
import {language} from "../language.mjs";
import {locale} from "../locale.mjs";
import {states} from "../states.mjs";

const API_NOTIF = "notifications", API_CLOCK = "clock", API_SETTINGS = "settings";
const LANGUAGES = {en: "English", hi: "हिंदी", ja: "日本語"};   // the only 3 bundles that actually exist — i18n/i18n_en|hi|ja.mjs

const _me = _ => ({id: session.get(APP_CONSTANTS.USERID)?.toString(),
    org: session.get(APP_CONSTANTS.USERORG)?.toString()});

/** Same labels shell.mjs's own bell-panel settings tab already uses — duplicated,
 *  not imported, this app's established per-module convention. */
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

let state = null;

/** Renders the screen. @param {HTMLElement} root */
export async function render(root) {
    const {shell} = await import("../shell.mjs");
    state = {root, tab: "notifications", person: shell.projection?.person || {}};
    await _view();
}

async function _view() {
    const root = state.root;
    root.innerHTML = `<div class="page tr">
        <div class="tr-tabs">
            <button class="tr-tab${state.tab=="notifications"?" on":""}" data-st="tab" data-tab="notifications">Notifications</button>
            <button class="tr-tab${state.tab=="profile"?" on":""}" data-st="tab" data-tab="profile">Profile</button>
            <button class="tr-tab${state.tab=="clock"?" on":""}" data-st="tab" data-tab="clock">Clock &amp; timer</button>
            <button class="tr-tab${state.tab=="accessibility"?" on":""}" data-st="tab" data-tab="accessibility">Accessibility</button>
            <button class="tr-tab${state.tab=="locale"?" on":""}" data-st="tab" data-tab="locale">Language &amp; region</button>
            <button class="tr-tab${state.tab=="more"?" on":""}" data-st="tab" data-tab="more">More</button>
        </div>
        <div class="tr-view" id="st-view"></div>
    </div>`;
    for (const button of root.querySelectorAll("[data-st=\"tab\"]"))
        button.addEventListener("click", _ => {state.tab = button.getAttribute("data-tab"); _view();});

    const view = root.querySelector("#st-view");
    try {
        if (state.tab == "notifications") await _notifications(view);
        else if (state.tab == "profile") _profile(view);
        else if (state.tab == "clock") await _clockPrefs(view);
        else if (state.tab == "accessibility") await _accessibility(view);
        else if (state.tab == "locale") _locale(view);
        else _more(view);
    } catch (err) {
        view.innerHTML = states.error({title: "Couldn't load settings", what: err.message,
            safe: "Nothing was changed.", reference: `I1-${Date.now().toString(36).toUpperCase().slice(-4)}`});
        states.bind(view, {retry: _ => _view()});
    }
}

// ---------------------------------------------------------------------------
// Notifications — the existing live/digest/off dial, given its own screen
// ---------------------------------------------------------------------------

async function _notifications(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 4})}</div>`;
    const response = await _call(API_NOTIF, "settings", {});
    if (!response) return;
    const settings = response.settings || {};

    root.innerHTML = `<div class="tr-card">
        <div class="up t3">How you're interrupted</div>
        ${Object.entries(CATEGORY_META).map(([category, meta]) => {
            const level = settings[category] || "live";
            return `<div class="tr-track-row">
                <span class="grow sm">${states.esc(meta.label)}</span>
                ${meta.mutable ? `<select class="inp" data-st="level" data-category="${states.esc(category)}" style="width:100px">
                    <option value="live"${level=="live"?" selected":""}>Live</option>
                    <option value="digest"${level=="digest"?" selected":""}>Digest</option>
                    <option value="off"${level=="off"?" selected":""}>Off</option>
                </select>` : `<span class="sm t3">Fixed — always on</span>`}
            </div>`;
        }).join("")}
        <div class="sm t3" style="margin-top:10px">Quiet hours follow your declared working window automatically.
            Nothing pushes outside it unless it's marked urgent.</div>
    </div>`;

    for (const select of root.querySelectorAll("[data-st=\"level\"]")) select.addEventListener("change", async _ => {
        const result = await _call(API_NOTIF, "set_volume",
            {category: select.getAttribute("data-category"), level: select.value});
        if (result) states.toast({message: "Saved."});
    });
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

function _profile(root) {
    const person = state.person;
    root.innerHTML = `<div class="tr-card">
        <div class="up t3">Profile</div>
        <div class="sm" style="margin-top:8px">Name</div>
        <input class="inp" id="st-name" style="width:100%" value="${states.esc(person.display_name||"")}">
        <div class="sm" style="margin-top:8px">Email</div>
        <div class="sm t3">${states.esc(person.email||"—")} — managed by your identity provider</div>
        <div class="sm" style="margin-top:8px">Home timezone</div>
        <input class="inp" id="st-tz" style="width:100%" placeholder="IANA timezone, e.g. Asia/Kolkata"
            value="${states.esc(person.home_timezone||"")}">
        <button class="btn pri" data-st="save-profile" style="margin-top:10px">Save</button>
    </div>`;

    root.querySelector('[data-st="save-profile"]').addEventListener("click", async _ => {
        const display_name = root.querySelector("#st-name").value.trim();
        const home_timezone = root.querySelector("#st-tz").value.trim();
        const result = await _call(API_SETTINGS, "update_profile", {display_name, home_timezone});
        if (!result) return;
        state.person = result.person;
        states.toast({message: "Saved."});
    });
}

// ---------------------------------------------------------------------------
// Clock & timer
// ---------------------------------------------------------------------------

async function _clockPrefs(root) {
    root.innerHTML = `<div class="tr-band">${states.loading({rows: 2})}</div>`;
    const response = await _call(API_CLOCK, "preferences", {});
    if (!response) return;

    root.innerHTML = `<div class="tr-card">
        <div class="up t3">Clock &amp; timer</div>
        <div class="tr-track-row">
            <span class="grow sm">Ask before switching task</span>
            <input type="checkbox" id="st-confirm-switch" ${response.confirm_before_switch ? "checked" : ""}>
        </div>
        <div class="sm t3" style="margin-top:10px">Idle threshold, auto-pause on away and an end-of-day
            reminder aren't built yet — none of their mechanisms exist in this product (there's no
            automatic idle-detection loop and no scheduled job anywhere in this backend), so there's
            nothing real yet for a setting to control.</div>
    </div>`;

    root.querySelector("#st-confirm-switch").addEventListener("change", async event => {
        const result = await _call(API_CLOCK, "set_preference", {confirm_before_switch: event.target.checked});
        if (result) states.toast({message: "Saved."});
    });
}

// ---------------------------------------------------------------------------
// Accessibility (I2 slice 1) — client-local, same mechanism as the theme
// toggle; applied immediately via shell.mjs, nothing server-side.
// ---------------------------------------------------------------------------

async function _accessibility(root) {
    const {shell} = await import("../shell.mjs");
    const prefs = shell.a11yPrefs();

    root.innerHTML = `<div class="tr-card">
        <div class="up t3">Accessibility — the floor, not the ceiling</div>
        <div class="tr-track-row">
            <span class="grow sm">Reduce motion</span>
            <input type="checkbox" id="st-reduce-motion" ${prefs.reduce_motion ? "checked" : ""}>
        </div>
        <div class="tr-track-row">
            <span class="grow sm">Increase contrast</span>
            <input type="checkbox" id="st-contrast" ${prefs.contrast == "high" ? "checked" : ""}>
        </div>
        <div class="tr-track-row">
            <span class="grow sm">Keyboard-only mode (stronger focus outline)</span>
            <input type="checkbox" id="st-kbd-mode" ${prefs.kbd_mode ? "checked" : ""}>
        </div>
        <div class="sm t3" style="margin-top:10px">Press <span class="mono">?</span> anywhere for the keyboard
            shortcut sheet.</div>
        <div class="sm t3" style="margin-top:6px">Larger text isn't built yet — every font size in this
            product is fixed, not scalable, so a text-size setting would need a CSS rework first, not just
            a toggle. Disabling auto-playing video and captions-by-default have nothing to control yet
            either — no video feature exists in this product.</div>
    </div>`;

    root.querySelector("#st-reduce-motion").addEventListener("change", event =>
        {shell.setA11yPrefs({reduce_motion: event.target.checked}); states.toast({message: "Saved."});});
    root.querySelector("#st-contrast").addEventListener("change", event =>
        {shell.setA11yPrefs({contrast: event.target.checked ? "high" : "normal"}); states.toast({message: "Saved."});});
    root.querySelector("#st-kbd-mode").addEventListener("change", event =>
        {shell.setA11yPrefs({kbd_mode: event.target.checked}); states.toast({message: "Saved."});});
}

// ---------------------------------------------------------------------------
// Language & region (I2 slice 2a) — language is real (the framework's own
// i18n, already wired on login.html, just never reachable once signed in);
// the rest are new, client-local preferences with no rendering consumer yet.
// ---------------------------------------------------------------------------

function _locale(root) {
    const prefs = locale.prefs();
    const lang = i18n.getSessionLang();
    const opt = (value, label, current) => `<option value="${states.esc(value)}"${value==current?" selected":""}>${states.esc(label)}</option>`;

    root.innerHTML = `<div class="tr-card">
        <div class="up t3">Language &amp; region</div>
        <div class="tr-track-row"><span class="grow sm">Language</span>
            <select class="inp" id="st-lang" style="width:140px">
                ${Object.entries(LANGUAGES).map(([code, label]) => opt(code, label, lang)).join("")}
            </select></div>
        <div class="tr-track-row"><span class="grow sm">Region format</span>
            <select class="inp" id="st-region" style="width:140px">
                ${["IN", "US", "GB", "JP"].map(code =>
                    opt(code, {IN: "India", US: "United States", GB: "United Kingdom", JP: "Japan"}[code], prefs.region)).join("")}
            </select></div>
        <div class="tr-track-row"><span class="grow sm">Date</span>
            <select class="inp" id="st-date-format" style="width:140px">
                ${opt("DD/MM/YYYY", "DD/MM/YYYY", prefs.date_format)}
                ${opt("MM/DD/YYYY", "MM/DD/YYYY", prefs.date_format)}
                ${opt("YYYY-MM-DD", "YYYY-MM-DD", prefs.date_format)}
            </select></div>
        <div class="tr-track-row"><span class="grow sm">Time</span>
            <select class="inp" id="st-time-format" style="width:140px">
                ${opt("24h", "24-hour", prefs.time_format)}
                ${opt("12h", "12-hour", prefs.time_format)}
            </select></div>
        <div class="tr-track-row"><span class="grow sm">Week starts</span>
            <select class="inp" id="st-week-start" style="width:140px">
                ${opt("monday", "Monday", prefs.week_start)}
                ${opt("sunday", "Sunday", prefs.week_start)}
            </select></div>
        <div class="tr-track-row"><span class="grow sm">Numbers</span>
            <select class="inp" id="st-number-format" style="width:170px">
                ${opt("indian", "1,23,456.78", prefs.number_format)}
                ${opt("western", "123,456.78", prefs.number_format)}
            </select></div>
        <div class="tr-track-row"><span class="grow sm">Duration format</span>
            <select class="inp" id="st-duration-format" style="width:170px">
                ${opt("hm", "1h 45m", prefs.duration_format)}
                ${opt("decimal", "1.75h (decimal, for payroll)", prefs.duration_format)}
            </select></div>
        <div class="sm t3" style="margin-top:10px">Language and region are independent — plenty of people
            want one language's interface with another region's date and number formats.</div>
        <div class="sm t3" style="margin-top:6px">Time and duration format now affect the header clock, Day
            board, Timesheet and Calendar. Date, region and week-start formats are saved but not read by any
            screen yet — and RTL layout for Arabic and Hebrew is a separate, larger decision, not yet made.
            Translating this product's own screens (today, only a handful of framework-level strings are) is
            further out still.</div>
    </div>`;

    root.querySelector("#st-lang").addEventListener("change", event => language.changeLanguage(event.target.value));
    root.querySelector("#st-region").addEventListener("change", event =>
        {locale.setPrefs({region: event.target.value}); states.toast({message: "Saved."});});
    root.querySelector("#st-date-format").addEventListener("change", event =>
        {locale.setPrefs({date_format: event.target.value}); states.toast({message: "Saved."});});
    root.querySelector("#st-time-format").addEventListener("change", event =>
        {locale.setPrefs({time_format: event.target.value}); states.toast({message: "Saved."});});
    root.querySelector("#st-week-start").addEventListener("change", event =>
        {locale.setPrefs({week_start: event.target.value}); states.toast({message: "Saved."});});
    root.querySelector("#st-number-format").addEventListener("change", event =>
        {locale.setPrefs({number_format: event.target.value}); states.toast({message: "Saved."});});
    root.querySelector("#st-duration-format").addEventListener("change", event =>
        {locale.setPrefs({duration_format: event.target.value}); states.toast({message: "Saved."});});
}

// ---------------------------------------------------------------------------
// More — pure links, and the I2 note
// ---------------------------------------------------------------------------

function _more(root) {
    root.innerHTML = `<div class="tr-card">
        <div class="tr-track-row"><span class="grow sm">Working hours &amp; travel</span>
            <button class="btn" data-st="goto" data-surface="windows">Open</button></div>
        <div class="tr-track-row"><span class="grow sm">Privacy &amp; your data</span>
            <button class="btn" data-st="goto" data-surface="me">Open</button></div>
        <div class="tr-track-row"><span class="grow sm">Connected apps</span>
            <button class="btn" data-st="goto" data-surface="apps">Open</button></div>
    </div>`;

    root.querySelectorAll('[data-st="goto"]').forEach(button => button.addEventListener("click", async _ => {
        const {shell} = await import("../shell.mjs");
        shell.setSurface(button.getAttribute("data-surface"));
    }));
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
