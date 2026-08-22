/**
 * The A6 spine — org, person and employment.
 *
 * Employment is the load-bearing one. It is an effective-dated record rather than
 * a set of fields on a person, which is what lets the product answer "what was
 * their jurisdiction in March" in September. Every read here takes a date, and
 * the callers that look current-only are asking as of today rather than reading
 * a current-only column.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMPLOYMENT_COLS = "employment_id, org_id, person_id, status, jurisdiction, manager_person_id, contract_type, contracted_pattern, valid_from, valid_to, recorded_at, recorded_by, source";

const _now = _ => Math.floor(Date.now()/1000);
const _today = _ => new Date().toISOString().substring(0, 10);

/** Run on the supplied transaction executor when given, else on the serial queue. */
const _run = (cmd, params, exec) => exec ? exec.runCmd(cmd, params) : dblayer.runCmdOrThrow(cmd, params);
/** Query on the supplied transaction executor when given, else on the serial queue. */
const _query = (cmd, params, exec) => exec ? exec.getQuery(cmd, params) : dblayer.getQueryOrThrow(cmd, params);

/**
 * @param {string} date The date to check
 * @param {string} label What to call it in the error
 * @returns The date, unchanged
 * @throws If the date is not an ISO calendar date
 */
function _assertISODate(date, label="date") {
    if ((typeof date != "string") || (!ISO_DATE.test(date))) throw new Error(
        `${label} must be an ISO calendar date (YYYY-MM-DD), got ${JSON.stringify(date)}.`);
    return date;
}

// ---------------------------------------------------------------------------
// org
// ---------------------------------------------------------------------------

/**
 * @param {object} org {name, home_jurisdiction, org_id?}
 * @param {object} exec Optional transaction executor
 * @returns The created org
 */
exports.createOrgAsync = async function(org, exec) {
    if (!org?.name) throw new Error("An org needs a name.");
    const row = {org_id: org.org_id || serverutils.generateUUID(false), name: org.name,
        home_jurisdiction: org.home_jurisdiction || null, created_at: _now(), status: "active"};
    await _run("INSERT INTO org (org_id, name, home_jurisdiction, created_at, status) VALUES (?,?,?,?,?)",
        [row.org_id, row.name, row.home_jurisdiction, row.created_at, row.status], exec);
    LOG.info(`Created org ${row.org_id} (${row.name}).`);
    return row;
}

/**
 * @param {string} org_id The org
 * @param {object} exec Optional transaction executor
 * @returns The org row, or null
 */
exports.getOrgAsync = async function(org_id, exec) {
    const rows = await _query("SELECT * FROM org WHERE org_id=?", [org_id], exec);
    return rows.length ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// person — global, with org membership expressed as employment
// ---------------------------------------------------------------------------

/**
 * @param {object} person {display_name, email, home_timezone, person_id?,
 *      source, imported_at, import_batch_id}
 * @param {object} exec Optional transaction executor
 * @returns The created person
 */
exports.createPersonAsync = async function(person, exec) {
    const row = {person_id: person.person_id || serverutils.generateUUID(false),
        display_name: person.display_name || null, email: person.email || null,
        home_timezone: person.home_timezone || null, created_at: _now(),
        source: person.source || null, imported_at: person.imported_at || null,
        import_batch_id: person.import_batch_id || null};
    await _run(
        "INSERT INTO person (person_id, display_name, email, home_timezone, created_at, source, imported_at, import_batch_id) VALUES (?,?,?,?,?,?,?,?)",
        [row.person_id, row.display_name, row.email, row.home_timezone, row.created_at,
            row.source, row.imported_at, row.import_batch_id], exec);
    return row;
}

/**
 * @param {string} person_id The person
 * @param {object} exec Optional transaction executor
 * @returns The person row, or null
 */
exports.getPersonAsync = async function(person_id, exec) {
    const rows = await _query("SELECT * FROM person WHERE person_id=?", [person_id], exec);
    return rows.length ? rows[0] : null;
}

/**
 * @param {string} email The email to look up
 * @param {object} exec Optional transaction executor
 * @returns The person row, or null
 */
exports.getPersonByEmailAsync = async function(email, exec) {
    if (!email) return null;
    const rows = await _query("SELECT * FROM person WHERE email=?", [email], exec);
    return rows.length ? rows[0] : null;
}

// ---------------------------------------------------------------------------
// employment — effective-dated
// ---------------------------------------------------------------------------

/**
 * Records a new employment period, closing the open one at the same date.
 *
 * This is the only write path. There is no update: a promotion, a relocation or a
 * manager change supersedes the previous period rather than overwriting it, so
 * the record of what was true in March survives being true no longer.
 *
 * @param {object} employment {org_id, person_id, status, jurisdiction, manager_person_id,
 *      contract_type, contracted_pattern, valid_from, valid_to, source, recorded_by}
 * @param {object} exec Optional transaction executor
 * @returns The recorded period
 * @throws If the period would overlap or predate the one it supersedes
 */
exports.recordEmploymentAsync = async function(employment, exec) {
    const {org_id, person_id} = employment;
    if (!org_id || !person_id) throw new Error("Employment needs both an org_id and a person_id.");
    for (const required of ["status", "jurisdiction", "contract_type"])
        if (!employment[required]) throw new Error(`Employment needs a ${required}.`);

    const valid_from = _assertISODate(employment.valid_from, "valid_from");
    const valid_to = employment.valid_to ? _assertISODate(employment.valid_to, "valid_to") : null;
    if (valid_to && valid_to <= valid_from) throw new Error(
        `valid_to (${valid_to}) must be after valid_from (${valid_from}).`);

    const open = await exports.getOpenEmploymentAsync(org_id, person_id, exec);
    if (open && open.valid_from > valid_from) throw new Error(
        `Cannot record an employment period starting ${valid_from} behind the open period starting ${open.valid_from}. Backdating a correction is its own path, not a silent insert.`);

    const row = {employment_id: employment.employment_id || serverutils.generateUUID(false),
        org_id, person_id, status: employment.status, jurisdiction: employment.jurisdiction,
        manager_person_id: employment.manager_person_id || null, contract_type: employment.contract_type,
        contracted_pattern: employment.contracted_pattern ?
            (typeof employment.contracted_pattern == "string" ? employment.contracted_pattern :
                JSON.stringify(employment.contracted_pattern)) : null,
        valid_from, valid_to, recorded_at: _now(),
        recorded_by: employment.recorded_by || null, source: employment.source || "manual",
        import_batch_id: employment.import_batch_id || null};

    const cmdObjs = [];
    if (open) cmdObjs.push({cmd: "UPDATE employment SET valid_to=? WHERE employment_id=?",
        params: [valid_from, open.employment_id]});     // close the outgoing period where the new one starts
    cmdObjs.push({cmd: `INSERT INTO employment (${EMPLOYMENT_COLS}, import_batch_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        params: [row.employment_id, row.org_id, row.person_id, row.status, row.jurisdiction,
            row.manager_person_id, row.contract_type, row.contracted_pattern, row.valid_from,
            row.valid_to, row.recorded_at, row.recorded_by, row.source, row.import_batch_id]});

    if (exec) for (const cmdObj of cmdObjs) await exec.runCmd(cmdObj.cmd, cmdObj.params);
    else await dblayer.runTransactionOrThrow(cmdObjs);
    LOG.info(`Recorded employment for ${person_id} in ${org_id} from ${valid_from}${open?`, superseding ${open.employment_id}`:""}.`);
    return row;
}

/**
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {object} exec Optional transaction executor
 * @returns The period with no end date, or null
 */
exports.getOpenEmploymentAsync = async function(org_id, person_id, exec) {
    const rows = await _query(
        "SELECT * FROM employment WHERE org_id=? AND person_id=? AND valid_to IS NULL ORDER BY valid_from DESC",
        [org_id, person_id], exec);
    return rows.length ? rows[0] : null;
}

/**
 * The question A6 exists to make answerable — what was true for this person on
 * this date, regardless of what is true now.
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} asOf ISO date, defaults to today
 * @returns The employment period in force on that date, or null
 */
exports.employmentAsOfAsync = async function(org_id, person_id, asOf=_today()) {
    _assertISODate(asOf, "asOf");
    const rows = await dblayer.getQueryOrThrow(
        `SELECT * FROM employment WHERE org_id=? AND person_id=? AND valid_from <= ?
            AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from DESC`,
        [org_id, person_id, asOf, asOf]);
    return rows.length ? rows[0] : null;
}

/**
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} asOf ISO date, defaults to today
 * @returns The jurisdiction in force, or null. C6 reads this, not the office address.
 */
exports.jurisdictionAsOfAsync = async function(org_id, person_id, asOf=_today()) {
    return (await exports.employmentAsOfAsync(org_id, person_id, asOf))?.jurisdiction || null;
}

/**
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {string} asOf ISO date, defaults to today
 * @returns The manager in force, or null. C7, J5 and K3 route approvals on this.
 */
exports.managerAsOfAsync = async function(org_id, person_id, asOf=_today()) {
    return (await exports.employmentAsOfAsync(org_id, person_id, asOf))?.manager_person_id || null;
}

/**
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @returns Every period recorded for this person, oldest first
 */
exports.employmentHistoryAsync = async function(org_id, person_id) {
    return await dblayer.getQueryOrThrow(
        "SELECT * FROM employment WHERE org_id=? AND person_id=? ORDER BY valid_from ASC", [org_id, person_id]);
}

/**
 * Backs the direct_reports scope in L2. Evaluated as of a date, so an approval
 * routed in March is still explicable after a reorg in June.
 * @param {string} org_id The org
 * @param {string} manager_person_id The manager
 * @param {string} asOf ISO date, defaults to today
 * @returns The employment periods reporting to this manager on that date
 */
exports.directReportsAsOfAsync = async function(org_id, manager_person_id, asOf=_today()) {
    _assertISODate(asOf, "asOf");
    return await dblayer.getQueryOrThrow(
        `SELECT * FROM employment WHERE org_id=? AND manager_person_id=? AND valid_from <= ?
            AND (valid_to IS NULL OR valid_to > ?)`,
        [org_id, manager_person_id, asOf, asOf]);
}

/**
 * The multi-org read. A person is global, so a contractor serving two clients has
 * two employments and this returns both.
 * @param {string} person_id The person
 * @param {string} asOf ISO date, defaults to today
 * @returns The employment periods in force across every org on that date
 */
/**
 * Everyone with employment in force in an org on a date, person and employment
 * joined lightly. This is the org's roster as of that date — E3's overlap board
 * and C1's presence summary both need "who is here", not "who was ever hired".
 * @param {string} org_id The org
 * @param {string} asOf ISO date, defaults to today
 * @returns {array} {person_id, display_name, home_timezone, manager_person_id, jurisdiction}
 */
exports.rosterAsOfAsync = async function(org_id, asOf=_today()) {
    _assertISODate(asOf, "asOf");
    return await dblayer.getQueryOrThrow(
        `SELECT p.person_id, p.display_name, p.home_timezone, e.manager_person_id, e.jurisdiction
            FROM employment e JOIN person p ON p.person_id = e.person_id
            WHERE e.org_id=? AND e.valid_from <= ? AND (e.valid_to IS NULL OR e.valid_to > ?)`,
        [org_id, asOf, asOf]);
}

exports.orgsForPersonAsOfAsync = async function(person_id, asOf=_today()) {
    _assertISODate(asOf, "asOf");
    return await dblayer.getQueryOrThrow(
        `SELECT * FROM employment WHERE person_id=? AND valid_from <= ?
            AND (valid_to IS NULL OR valid_to > ?) ORDER BY org_id`,
        [person_id, asOf, asOf]);
}
