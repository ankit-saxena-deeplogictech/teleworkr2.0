/**
 * E5 — office days, narrowed to status only. "Office presence is a
 * lightweight status on the same availability object as E4, not a separate
 * system" is honored in spirit, not literally: `working_window` is a
 * recurring weekly pattern over an effective-dated period, and its only
 * per-date exception (`travel`) is a full pattern substitution with no
 * free-text location label — neither shape fits "today specifically:
 * home/office/elsewhere + where," so this is its own small, one-row-per-
 * person-per-day table, surfaced right alongside E4.
 *
 * Narrowed, deliberately: no desk/office entity exists anywhere in this
 * app (confirmed by grep across every migration and lib file) — desk
 * booking, capacity, proximity picking and network-based auto-release are
 * dropped outright, not approximated. "No office (feature hidden
 * entirely)" isn't implementable either — there's no office registry to
 * check "does this org have one," so the screen is always reachable, same
 * as E4 itself. The co-location note states the opportunity only — no
 * "block an hour together," since no meeting/calendar-event entity exists
 * (the same confirmed gap E2/F1-F5 hit) — and is scoped to the visible
 * week, not a month-long historical scan.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);

const STATUSES = Object.freeze(["home", "office", "elsewhere"]);
const _now = _ => Math.floor(Date.now()/1000);
const _dateFor = (weekStart, i) => {
    const d = new Date(`${weekStart}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().substring(0, 10);
};

/** Peers, not reports — the same fallback lib/apps.js's _cohortAsync already established (G1). */
async function _cohortAsync(org_id, person_id) {
    const managerId = await spine.managerAsOfAsync(org_id, person_id);
    const roster = await spine.rosterAsOfAsync(org_id);
    const siblings = managerId ? roster.filter(p => p.manager_person_id == managerId && p.person_id != person_id) : [];
    return siblings.length ? siblings : roster.filter(p => p.person_id != person_id);
}

/**
 * Sets one person's status for one day — corrected in place, not
 * effective-dated; a day's status is a fact about that day, not a pattern.
 * @param {object} request {org_id, person_id, status_date, status, location}
 */
exports.setStatusAsync = async function(request) {
    const {org_id, person_id, status_date, status} = request;
    if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(", ")}.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(status_date || "")) throw new Error("status_date must be an ISO date.");

    await dblayer.runCmdOrThrow(
        `INSERT INTO office_day_status (org_id, person_id, status_date, status, location, updated_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT (org_id, person_id, status_date) DO UPDATE SET status=excluded.status,
                location=excluded.location, updated_at=excluded.updated_at`,
        [org_id, person_id, status_date, status, request.location?.trim() || null, _now()]);
    return "recorded";
}

/**
 * The week, for the caller and their cohort — Mon-Fri, same Monday-anchored
 * idiom every week-paged screen already uses for week_start.
 * @param {string} org_id The org
 * @param {string} actor_person_id The caller
 * @param {string} week_start ISO date, a Monday
 * @returns {object} {days, people: [{person_id, display_name, is_self, statuses: {date: {status, location}|null}}], co_location}
 */
exports.weekStatusAsync = async function(org_id, actor_person_id, week_start) {
    const days = [0, 1, 2, 3, 4].map(i => _dateFor(week_start, i));
    const cohort = await _cohortAsync(org_id, actor_person_id);
    const roster = await spine.rosterAsOfAsync(org_id);
    const self = roster.find(p => p.person_id == actor_person_id);
    const people = [self || {person_id: actor_person_id, display_name: actor_person_id}, ...cohort];
    const personIds = people.map(p => p.person_id);

    const placeholders = personIds.map(_ => "?").join(",");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT person_id, status_date, status, location FROM office_day_status
            WHERE org_id=? AND person_id IN (${placeholders}) AND status_date IN (${days.map(_ => "?").join(",")})`,
        [org_id, ...personIds, ...days]);
    const byPerson = new Map(personIds.map(id => [id, new Map()]));
    for (const row of rows) byPerson.get(row.person_id)?.set(row.status_date, {status: row.status, location: row.location});

    const peopleOut = people.map((p, i) => ({person_id: p.person_id, display_name: p.display_name || p.person_id,
        is_self: i == 0, statuses: Object.fromEntries(days.map(d => [d, byPerson.get(p.person_id)?.get(d) || null]))}));

    const co_location = days.filter(d => {
        const selfStatus = peopleOut[0].statuses[d];
        if (selfStatus?.status != "office") return false;
        return peopleOut.slice(1).some(p => p.statuses[d]?.status == "office");
    }).map(d => ({date: d, with: peopleOut.slice(1).filter(p => p.statuses[d]?.status == "office")
        .map(p => p.display_name)}));

    return {days, people: peopleOut, co_location};
}
