/**
 * E3/E4 — one availability model, read by every other screen.
 *
 * A working window is an effective-dated record: declared hours and travel are
 * the same object over time, superseded rather than edited, so an overlap board
 * asked about a past date answers with the window that was in force then (A6).
 * The calendar is not the timezone — offsets are derived from the IANA zone for
 * the specific date, never stored, which is what makes DST transitions answerable
 * instead of silently wrong.
 *
 * Overlap is projected, never stored (A6): it is recomputed from the windows on
 * every read, because storing it is wrong the moment someone changes a window.
 * A team with no shared minutes gets a named callout with evidence, not an empty
 * board (E3).
 *
 * Night shifts crossing midnight are first-class: end_minute < start_minute is a
 * wrap, not an error (E4 edge cases).
 *
 * Leave and public holidays are deliberately not here yet — leave lands with the
 * J-section, holidays with the calendar. The overlap projection takes windows
 * only; leave spans plug into the same projection when they exist.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const time = require(`${TELEWORKR_CONSTANTS.LIBDIR}/time.js`);

const KINDS = Object.freeze({DECLARED: "declared", TRAVEL: "travel"});
const DAYS_IN_WEEK = 7, MINUTES_IN_DAY = 1440;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);

// ---------------------------------------------------------------------------
// timezone mechanics
// ---------------------------------------------------------------------------

function _assertISODate(date, label="date") {
    if ((typeof date != "string") || (!ISO_DATE.test(date))) throw new Error(
        `${label} must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(date)}.`);
    return date;
}

function _assertTimezone(timezone) {
    try {new Intl.DateTimeFormat("en-US", {timeZone: timezone}).format(0); return timezone;}
    catch (err) {throw new Error(`${timezone} is not an IANA timezone.`);}
}

const _tzFormat = timezone => new Intl.DateTimeFormat("en-US", {timeZone: timezone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"});

function _formatParts(date, timezone) {
    const parts = {};
    for (const part of _tzFormat(timezone).formatToParts(date))
        if (part.type != "literal") parts[part.type] = parseInt(part.value, 10);
    return parts;
}

/**
 * Converts local wall-clock minutes on a date to epoch minutes, in the zone.
 * The two-step Intl trick makes this correct across DST transitions, because the
 * offset is derived for the instant itself, not looked up in a table.
 * @param {string} dateISO The date
 * @param {number} localMinutes Minutes from local midnight (may exceed 1440 for wraps)
 * @param {string} timezone The IANA zone
 * @returns Epoch minutes
 */
function _localToUTCMinutes(dateISO, localMinutes, timezone) {
    const wallAsUTC = Date.parse(`${dateISO}T00:00:00Z`) + localMinutes*60000;
    const parts = _formatParts(new Date(wallAsUTC), timezone);
    const asIfUTC = Date.UTC(parts.year, parts.month-1, parts.day, parts.hour, parts.minute, parts.second);
    const offsetMs = asIfUTC - wallAsUTC;
    return (wallAsUTC - offsetMs)/60000;
}

/**
 * The zone's UTC offset on a date, minutes, west-positive (UTC minus local).
 * Measured at local noon: a DST transition day keeps its old offset at midnight,
 * so midday is the time of day that reflects the changed clock (E3's flag and
 * E4's transition warning both care about working hours, not midnight).
 */
function _offsetMinutesAt(dateISO, timezone) {
    const utcOfNoon = _localToUTCMinutes(dateISO, 720, timezone);
    const utcMidnight = Date.parse(`${dateISO}T00:00:00Z`)/60000;
    return Math.round(utcOfNoon - utcMidnight - 720);
}

/** The window's UTC span on a date, in epoch minutes. Wrap windows span midnight. */
function _utcSpan(window, dateISO) {
    const end = window.end_minute <= window.start_minute ?
        window.end_minute + MINUTES_IN_DAY : window.end_minute;
    return {from: _localToUTCMinutes(dateISO, window.start_minute, window.timezone),
        to: _localToUTCMinutes(dateISO, end, window.timezone)};
}

function _weekdayOf(dateISO) {
    return ((new Date(`${dateISO}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;   // 1=Mon..7=Sun
}

// ---------------------------------------------------------------------------
// writing — supersede, never edit
// ---------------------------------------------------------------------------

/**
 * Declares or changes a person's working window. The open window is closed where
 * the new one starts; nothing is edited in place. Ending travel early is this
 * same call with a valid_from inside the travel period.
 *
 * @param {object} window {org_id, person_id, timezone, start_minute, end_minute,
 *      days, valid_from, note, recorded_by}
 * @returns The recorded period
 * @throws If the values cannot describe a window, or the start is behind the open one
 */
exports.setWindowAsync = async function(window) {
    const row = _prepareWindow(window, KINDS.DECLARED, window.note);
    return await dblayer.runInTransactionAsync(async exec => {
        let open = await exports.getOpenWindowAsync(window.org_id, window.person_id, exec);
        if (open && open.valid_from > row.valid_from) {
            // Ending a trip early: the new date falls inside the travel the open
            // auto-resumed base came from. Shorten the trip and drop the empty resume.
            const travel = await _travelResumedByAsync(exec, open);
            if (!travel || row.valid_from <= travel.valid_from) throw new Error(
                `Cannot record a window starting ${row.valid_from} behind the open period starting ${open.valid_from}. A correction is its own path, not a silent insert.`);
            await exec.runCmd("UPDATE working_window SET valid_to=? WHERE window_id=?",
                [row.valid_from, travel.window_id]);
            await exec.runCmd("DELETE FROM working_window WHERE window_id=?", [open.window_id]);
            open = null;
        }

        if (open) await exec.runCmd("UPDATE working_window SET valid_to=? WHERE window_id=?",
            [row.valid_from, open.window_id]);
        await exec.runCmd(`INSERT INTO working_window (window_id, org_id, person_id, kind, timezone,
            start_minute, end_minute, days, valid_from, valid_to, note, recorded_at, recorded_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [row.window_id, row.org_id, row.person_id, row.kind, row.timezone, row.start_minute,
                row.end_minute, JSON.stringify(row.days), row.valid_from, row.valid_to, row.note,
                row.recorded_at, row.recorded_by]);
        return row;
    });
}

/**
 * Travel is a dated state (E4): the base window closes where the travel starts,
 * a travel window covers the trip, and the base window resumes where the trip
 * ends — one call, three effective-dated periods.
 *
 * @param {object} travel {org_id, person_id, timezone, valid_from, valid_to,
 *      start_minute, end_minute, note, recorded_by}
 * @returns The travel period
 * @throws If there is no open window to travel from, or the open window is itself travel
 */
exports.setTravelAsync = async function(travel) {
    const {org_id, person_id} = travel;
    const timezone = _assertTimezone(travel.timezone);
    const valid_from = _assertISODate(travel.valid_from, "valid_from");
    const valid_to = _assertISODate(travel.valid_to, "valid_to");
    if (valid_to <= valid_from) throw new Error(`valid_to (${valid_to}) must be after valid_from (${valid_from}).`);

    return await dblayer.runInTransactionAsync(async exec => {
        const open = await exports.getOpenWindowAsync(org_id, person_id, exec);
        if (!open) throw new Error("No open working window to travel from. Declare one first.");
        if (open.kind != KINDS.DECLARED) throw new Error(
            "The open window is itself a travel period. End it early by declaring a window, then travel again.");
        if (open.valid_from > valid_from) {
            const trip = await _travelResumedByAsync(exec, open);
            if (trip && valid_from > trip.valid_from) throw new Error(
                "A trip is already in force over that date. End it early with a declared window first.");
            throw new Error(
                `Travel cannot start ${valid_from}, behind the open window starting ${open.valid_from}.`);
        }

        const travelRow = _prepareWindow({org_id, person_id, timezone,
            start_minute: travel.start_minute !== undefined ? travel.start_minute : open.start_minute,
            end_minute: travel.end_minute !== undefined ? travel.end_minute : open.end_minute,
            days: travel.days || JSON.parse(open.days), valid_from, valid_to,
            note: travel.note}, KINDS.TRAVEL, travel.note, travel.recorded_by);

        // close the base at departure, insert the trip, resume the base at return
        await exec.runCmd("UPDATE working_window SET valid_to=? WHERE window_id=?",
            [valid_from, open.window_id]);
        await _insertWindowViaAsync(exec, travelRow);
        const resumed = _prepareWindow({org_id, person_id, timezone: open.timezone,
            start_minute: open.start_minute, end_minute: open.end_minute,
            days: JSON.parse(open.days), valid_from: valid_to, valid_to: null,
            note: `Resumed after travel to ${timezone}.`}, KINDS.DECLARED, null, travel.recorded_by);
        await _insertWindowViaAsync(exec, resumed);

        LOG.info(`Travel for ${person_id} in ${org_id}: ${timezone} from ${valid_from} to ${valid_to}.`);
        return travelRow;
    });
}

function _prepareWindow(window, kind, note, recorded_by) {
    const {org_id, person_id} = window;
    if (!org_id || !person_id) throw new Error("A working window needs both an org_id and a person_id.");
    const timezone = _assertTimezone(window.timezone);
    const start_minute = window.start_minute, end_minute = window.end_minute;
    if (!Number.isInteger(start_minute) || !Number.isInteger(end_minute) ||
        start_minute < 0 || start_minute >= MINUTES_IN_DAY || end_minute < 0 || end_minute >= MINUTES_IN_DAY)
        throw new Error("start_minute and end_minute must be minutes in [0, 1440).");
    if (start_minute == end_minute) throw new Error("A window needs a positive length.");

    const days = Array.isArray(window.days) ? window.days : (typeof window.days == "string" ? JSON.parse(window.days) : null);
    if (!days || !days.length) throw new Error("A window needs its working days, e.g. [1,2,3,4,5].");
    const bad = days.filter(day => !Number.isInteger(day) || day < 1 || day > DAYS_IN_WEEK);
    if (bad.length) throw new Error(`Working days are ISO weekday numbers 1..7; got ${JSON.stringify(bad)}.`);
    if (new Set(days).size != days.length) throw new Error("Working days must not repeat.");

    return {window_id: serverutils.generateUUID(false), org_id, person_id, kind,
        timezone, start_minute, end_minute, days, valid_from: _assertISODate(window.valid_from, "valid_from"),
        valid_to: window.valid_to ? _assertISODate(window.valid_to, "valid_to") : null,
        note: note || null, recorded_at: _now(), recorded_by: recorded_by || null};
}

async function _insertWindowViaAsync(exec, row) {
    await exec.runCmd(`INSERT INTO working_window (window_id, org_id, person_id, kind, timezone,
        start_minute, end_minute, days, valid_from, valid_to, note, recorded_at, recorded_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [row.window_id, row.org_id, row.person_id, row.kind, row.timezone, row.start_minute,
            row.end_minute, JSON.stringify(row.days), row.valid_from, row.valid_to, row.note,
            row.recorded_at, row.recorded_by]);
}

/** The travel period an auto-resumed base came from, identified by its end date. */
async function _travelResumedByAsync(exec, resumed) {
    const rows = await exec.getQuery(
        `SELECT * FROM working_window WHERE org_id=? AND person_id=? AND kind='travel' AND valid_to=?
            ORDER BY valid_from DESC LIMIT 1`,
        [resumed.org_id, resumed.person_id, resumed.valid_from]);
    return rows.length ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {object} exec Optional transaction executor — required when called inside runInTransactionAsync
 * @returns The open window (valid_to IS NULL), or null
 */
exports.getOpenWindowAsync = async function(org_id, person_id, exec) {
    const sql = "SELECT * FROM working_window WHERE org_id=? AND person_id=? AND valid_to IS NULL ORDER BY valid_from DESC";
    const rows = exec ? await exec.getQuery(sql, [org_id, person_id]) :
        await dblayer.getQueryOrThrow(sql, [org_id, person_id]);
    return rows.length ? rows[0] : null;
}

/**
 * The window in force on a date — the question E3 exists to make answerable for
 * any past date.
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} asOf ISO date, defaults to today
 * @returns The window period in force, or null
 */
exports.windowAsOfAsync = async function(org_id, person_id, asOf=_today()) {
    _assertISODate(asOf, "asOf");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT * FROM working_window WHERE org_id=? AND person_id=? AND valid_from <= ?
            AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from DESC`,
        [org_id, person_id, asOf, asOf]);
    return rows.length ? rows[0] : null;
}

/**
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @returns Every window period, oldest first
 */
exports.windowHistoryAsync = async function(org_id, person_id) {
    return await dblayer.getQueryOrThrow(
        "SELECT * FROM working_window WHERE org_id=? AND person_id=? ORDER BY valid_from ASC",
        [org_id, person_id]);
}

/**
 * The availability story for one person on one date: the window in force and
 * whether the date is a working day. Absence is named — undeclared and off-day
 * are different facts and E3 shows them differently.
 * @returns {object} {window, workday, reason} where reason is undeclared | off_day | null
 */
exports.availabilityForDateAsync = async function(org_id, person_id, date) {
    _assertISODate(date);
    const window = await exports.windowAsOfAsync(org_id, person_id, date);
    if (!window) return {window: null, workday: false, reason: "undeclared"};
    const workday = JSON.parse(window.days).includes(_weekdayOf(date));
    return {window, workday, reason: workday ? null : "off_day"};
}

// ---------------------------------------------------------------------------
// the overlap projection
// ---------------------------------------------------------------------------

/**
 * Projects the shared window for a set of people on a date. Overlap is never
 * stored — it is recomputed here on every read (A6). People with no window or
 * an off day are named with a reason rather than silently dropped.
 *
 * @param {string} org_id The org
 * @param {array} person_ids The people
 * @param {string} date ISO date
 * @param {object} options {unavailable: [{person_id, reason}]} — callers name
 *      people who are not working that day (for example approved leave) without
 *      this module knowing what leave is. Named, excluded from the shared span.
 * @returns {object} {shared_minutes, span, per_person, undeclared, off_day, unavailable}
 */
exports.overlapForDateAsync = async function(org_id, person_ids, date, options={}) {
    _assertISODate(date);
    const unavailableBy = new Map((options.unavailable || []).map(absence => [absence.person_id, absence]));
    const per_person = [], undeclared = [], off_day = [], unavailable = [];
    let sharedFrom = null, sharedTo = null;

    for (const person_id of person_ids) {
        const absence = unavailableBy.get(person_id);
        if (absence) {unavailable.push({...absence, person_id});
            per_person.push({person_id, workday: false, reason: absence.reason || "unavailable"}); continue;}

        const availability = await exports.availabilityForDateAsync(org_id, person_id, date);
        if (!availability.window) {undeclared.push(person_id);
            per_person.push({person_id, workday: false, reason: "undeclared"}); continue;}
        if (!availability.workday) {off_day.push(person_id);
            per_person.push({person_id, workday: false, reason: "off_day",
                window: availability.window.window_id}); continue;}

        const span = _utcSpan(availability.window, date);
        per_person.push({person_id, workday: true, reason: null,
            window: availability.window.window_id, span,
            timezone: availability.window.timezone,
            kind: availability.window.kind});
        sharedFrom = sharedFrom === null ? span.from : Math.max(sharedFrom, span.from);
        sharedTo = sharedTo === null ? span.to : Math.min(sharedTo, span.to);
    }

    const sharedMinutes = (sharedFrom !== null && sharedTo > sharedFrom) ? sharedTo - sharedFrom : 0;
    return {shared_minutes: sharedMinutes, span: sharedMinutes ? {from: sharedFrom, to: sharedTo} : null,
        per_person, undeclared, off_day, unavailable};
}

/**
 * The board's headline and its zero-overlap evidence. Every available pair with
 * no shared minutes is named with its spans, because "who can I actually talk
 * to" is the fact only this screen produces (E3).
 *
 * @param {string} org_id The org
 * @param {array} person_ids The people
 * @param {string} date ISO date
 * @param {object} options Passed to overlapForDateAsync ({unavailable: ...})
 * @returns {object} {shared_minutes, span, zero_overlap_pairs, undeclared, off_day, unavailable}
 */
exports.teamOverlapAsync = async function(org_id, person_ids, date, options) {
    const projected = await exports.overlapForDateAsync(org_id, person_ids, date, options);
    const available = projected.per_person.filter(p => p.workday);
    const zeroOverlapPairs = [];
    for (let i = 0; i < available.length; i++) for (let j = i+1; j < available.length; j++) {
        const a = available[i], b = available[j];
        if (a.span.to <= b.span.from || b.span.to <= a.span.from)
            zeroOverlapPairs.push({a: a.person_id, b: b.person_id, a_span: a.span, b_span: b.span});
    }
    return {...projected, zero_overlap_pairs: zeroOverlapPairs};
}

/**
 * The E3 DST flag: whose zone changes offset within the coming week, and by how
 * much. Derived from the IANA zone per date, so it is announced before the
 * transition rather than discovered after it.
 *
 * @param {string} org_id The org
 * @param {array} person_ids The people
 * @param {string} date ISO date
 * @returns {array} [{person_id, timezone, offset_minutes, offset_in_a_week}]
 */
exports.dstTransitionFlagsAsync = async function(org_id, person_ids, date) {
    _assertISODate(date);
    const weekLater = new Date(`${date}T00:00:00Z`);
    weekLater.setUTCDate(weekLater.getUTCDate() + 7);
    const later = weekLater.toISOString().substring(0, 10);

    const flags = [];
    for (const person_id of person_ids) {
        const window = await exports.windowAsOfAsync(org_id, person_id, date);
        if (!window) continue;
        const nowOffset = _offsetMinutesAt(date, window.timezone);
        const laterOffset = _offsetMinutesAt(later, window.timezone);
        if (nowOffset != laterOffset) flags.push({person_id, timezone: window.timezone,
            offset_minutes: nowOffset, offset_in_a_week: laterOffset});
    }
    return flags;
}

/**
 * The E4 nudge: declared hours that clock-in history contradicts. Computed from
 * the time ledger, never from any additional collection — early clock-ins over
 * the window's start, beyond a grace, are evidence the declaration drifted.
 *
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {object} options {days, grace_minutes}
 * @returns {object} {window, days_with_events, early_days, suggested_start_minute}
 */
exports.driftAsync = async function(org_id, person_id, options={}) {
    const window = await exports.getOpenWindowAsync(org_id, person_id);
    if (!window) return {window: null, days_with_events: 0, early_days: 0, suggested_start_minute: null};

    const days = options.days || 14, grace = options.grace_minutes || 30;
    const today = new Date();
    let daysWithEvents = 0, earlyDays = 0, earliest = null;

    for (let i = 0; i < days; i++) {
        const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
        const iso = date.toISOString().substring(0, 10);
        if (!JSON.parse(window.days).includes(_weekdayOf(iso))) continue;   // off days are not evidence
        const events = await time.eventsForDayAsync(org_id, person_id, iso);
        if (!events.some(event => event.started_at)) continue;
        daysWithEvents++;

        const offset = _offsetMinutesAt(iso, window.timezone);
        const localStart = Math.min(...events.filter(e => e.started_at)
            .map(e => ((e.started_at % (MINUTES_IN_DAY*60)) / 60 - offset + MINUTES_IN_DAY) % MINUTES_IN_DAY));
        if (earliest === null || localStart < earliest) earliest = localStart;
        if (localStart < window.start_minute - grace) earlyDays++;
    }

    return {window: window.window_id, days_with_events: daysWithEvents, early_days: earlyDays,
        suggested_start_minute: (earliest !== null && earliest < window.start_minute - grace) ?
            Math.floor(earliest) : null};
}

exports.KINDS = KINDS;
