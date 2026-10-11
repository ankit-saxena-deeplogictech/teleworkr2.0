/**
 * I2 slice 2 — the locale preferences, and the two formatters that actually
 * honour them (duration, time). The single source of truth: every screen
 * imports this rather than keeping its own copy — the four private `_hm`
 * duration formatters this replaced were byte-identical copies of each
 * other, exactly the kind of duplication this app's shared frontend modules
 * (`states.mjs`, `shell.mjs`) already exist to avoid (unlike the backend's
 * own lib files, which duplicate small per-module helpers deliberately).
 *
 * Only `duration_format`/`time_format` have a real consumer today —
 * `date_format`/`number_format`/`week_start` are saved here and read by
 * `settings.mjs`'s own Language & region tab, but no screen's rendering
 * honours them yet (see that tab's own note for why, and I2 slice 2b's
 * narrative for exactly which surfaces were checked and found to have no
 * genuine numeric-date/week-start target).
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

import {session} from "/framework/js/session.mjs";

const LOCALE_KEY = "__teleworkr_locale_prefs";
const DEFAULTS = {region: "IN", date_format: "DD/MM/YYYY", time_format: "24h", week_start: "monday",
    number_format: "indian", duration_format: "hm"};

function prefs() {
    try {return {...DEFAULTS, ...JSON.parse(session.get(LOCALE_KEY)||"{}")};}
    catch (err) {return {...DEFAULTS};}
}

function setPrefs(partial) {
    const merged = {...prefs(), ...partial};
    session.set(LOCALE_KEY, JSON.stringify(merged));
    return merged;
}

/** @param {number} seconds @returns "6h 30m", or "6.50h" when duration_format is "decimal" */
function formatDuration(seconds) {
    if (prefs().duration_format == "decimal") return `${(seconds/3600).toFixed(2)}h`;
    return `${Math.floor(seconds/3600)}h ${String(Math.floor((seconds%3600)/60)).padStart(2, "0")}m`;
}

/** @param {number} epochSeconds @returns a HH:MM wall-clock time, 24h or 12h per time_format */
function formatTime(epochSeconds) {
    return new Date(epochSeconds*1000).toLocaleTimeString(undefined,
        {hour: "2-digit", minute: "2-digit", hour12: prefs().time_format == "12h"});
}

export const locale = {prefs, setPrefs, formatDuration, formatTime};
