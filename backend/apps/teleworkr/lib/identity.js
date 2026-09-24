/**
 * L1 — identity provisioning and org bootstrap.
 *
 * The IdP assertion is the pipe that carries employment_status, jurisdiction,
 * manager, start_date and contract_type into the rest of the product. This module
 * turns the assertion into records under the A6 rules: employment is
 * effective-dated, a person is global, and nothing is silently defaulted.
 *
 * L1 States, enforced rather than promised:
 *   - An assertion missing a required attribute creates the person, feature-flags
 *     them and writes an audit entry naming the missing attributes. The employment
 *     is withheld — a leave engine running on an invented jurisdiction is worse
 *     than one that knows it does not know.
 *   - Org bootstrap is one transaction: org, first admin, employment, built-in
 *     roles and the admin grant all land or none do. There is no half-created org.
 *
 * This module also carries the admin-facing half of L1: the provisioning-
 * incomplete queue (a flagged person's employment stays withheld until an
 * admin supplies what the assertion didn't), and a declared MFA policy per
 * role tier. It does not model multiple identity providers — this app has
 * exactly one real identity path (the JWT verify against tkmlogin_api, in
 * apis/login.js) — and it does not enforce MFA itself, the IdP does; the
 * policy here is the governance record of what's expected, not a control.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
const permissions = require(`${TELEWORKR_CONSTANTS.LIBDIR}/permissions.js`);
const audit = require(`${TELEWORKR_CONSTANTS.LIBDIR}/audit.js`);

/** The attributes an assertion must carry before an employment can be provisioned. */
const REQUIRED_ASSERTION_ATTRIBUTES = Object.freeze(["employment_status", "jurisdiction", "start_date", "contract_type"]);

/** Employment statuses are part of the schema contract, not free text. */
const EMPLOYMENT_STATUSES = Object.freeze(["active", "probation", "notice", "suspended", "ended"]);

/** What breaks without each attribute — shown next to the feature it feeds, not as an abstract field list. */
const ATTRIBUTE_IMPACT = Object.freeze([
    {attribute: "employment_status", breaks: "Earned-leave eligibility, probation and notice rules."},
    {attribute: "jurisdiction", breaks: "Which working-time rules apply. Not the office address."},
    {attribute: "manager", breaks: "Approval routes for time, leave and requisitions."},
    {attribute: "start_date", breaks: "Pro-rata accrual and probation windows."},
    {attribute: "contract_type", breaks: "Policy scope tags; whether guardrails apply at all."},
    {attribute: "home_timezone", breaks: "Seeds the working window. The person can override; the IdP can't."}
]);

const MFA_TIERS = Object.freeze(["standard", "elevated", "critical"]);
const MFA_STRENGTHS = Object.freeze(["idp_enforced", "phishing_resistant", "hardware_key"]);
/** HR/admin's declared expectation per tier, until an org overrides one. */
const DEFAULT_MFA_POLICY = Object.freeze({standard: "idp_enforced", elevated: "phishing_resistant", critical: "hardware_key"});

const _today = _ => new Date().toISOString().substring(0, 10);
const _now = _ => Math.floor(Date.now()/1000);

/** L1's own admin screen is gated by one capability throughout — reads and writes alike. */
async function _requireManageAsync(org_id, actor_person_id) {
    await permissions.requireAsync({org_id, actor_person_id, capability: "identity.manage"});
}

/**
 * Creates an org with its first admin in one transaction.
 *
 * The first admin is provisioned from the same attribute shape an IdP assertion
 * carries, because the Phase 0 gate is "create an org, sign in via IdP, read
 * jurisdiction and manager from the assertion" — one path for both.
 *
 * @param {object} request {org: {name, home_jurisdiction, org_id?},
 *      admin: {email, display_name, employment_status, jurisdiction, start_date,
 *              contract_type, manager, home_timezone}}
 * @returns {object} {org, person, employment, roles, grants}
 * @throws Naming the missing attribute, or if the transaction failed and rolled back
 */
exports.bootstrapOrgAsync = async function(request) {
    const org = request?.org, admin = request?.admin;
    if (!org?.name) throw new Error("An org needs a name.");
    if (!admin?.email) throw new Error("The first admin needs an email.");
    const missing = REQUIRED_ASSERTION_ATTRIBUTES.filter(attr => !admin[attr]);
    if (missing.length) throw new Error(
        `The first admin's assertion is missing required attributes: ${missing.join(", ")}. They are required, never defaulted.`);
    if (!EMPLOYMENT_STATUSES.includes(admin.employment_status)) throw new Error(
        `Unknown employment status ${JSON.stringify(admin.employment_status)}. Known: ${EMPLOYMENT_STATUSES.join(", ")}.`);

    return await dblayer.runInTransactionAsync(async exec => {
        const orgRow = await spine.createOrgAsync({name: org.name,
            home_jurisdiction: org.home_jurisdiction, org_id: org.org_id}, exec);
        const person = await spine.createPersonAsync({display_name: admin.display_name, email: admin.email,
            home_timezone: admin.home_timezone}, exec);

        // the manager attribute is an email; it resolves to a person if that
        // person is already known, and stays empty until they are
        const manager = admin.manager ?
            (await spine.getPersonByEmailAsync(admin.manager, exec))?.person_id || null : null;
        const employment = await spine.recordEmploymentAsync({org_id: orgRow.org_id,
            person_id: person.person_id, status: admin.employment_status, jurisdiction: admin.jurisdiction,
            manager_person_id: manager, contract_type: admin.contract_type,
            valid_from: admin.start_date, source: "idp", recorded_by: "idp"}, exec);

        const roles = await permissions.ensureBuiltinRolesAsync(orgRow.org_id, exec);
        const grants = await permissions.assignRoleAsync(orgRow.org_id, person.person_id, "admin",
            {granted_by: "system", valid_from: admin.start_date}, exec);

        await audit.insertEntryViaAsync(exec, {org_id: orgRow.org_id, action: "org.created",
            object_type: "org", object_ref: orgRow.org_id, actor_kind: "system",
            detail: {name: orgRow.name, admin: person.person_id}}, []);

        LOG.info(`Bootstrapped org ${orgRow.org_id} with first admin ${person.person_id}.`);
        return {org: orgRow, person, employment, roles, grants};
    });
}

/**
 * Provisions a person from a verified login result, and reads their employment
 * attributes back onto it. This is the sign-in path the login listener calls.
 *
 * The record wins over the assertion for values already in force — what the IdP
 * says today must not rewrite what was true in March. A person with no employment
 * is provisioned from the assertion; a missing required attribute flags them
 * instead of inventing a value.
 *
 * @param {object} result The login result from apis/login.js. Modified in place.
 * @returns true if an employment is in force for this sign-in, false otherwise
 */
exports.provisionFromAssertionAsync = async function(result) {
    if (!result.tokenflag) return false;
    const email = (result.id||"").toLowerCase();
    const org_id = (result.org||"").toLowerCase();
    if (!email || !org_id) return false;

    if (!await spine.getOrgAsync(org_id)) {
        result.provisioning_status = "no_org";
        LOG.warn(`Sign-in for ${email} references org ${org_id}, which does not exist.`);
        return false;
    }

    let person = await spine.getPersonByEmailAsync(email);
    if (!person) person = await spine.createPersonAsync(
        {email, display_name: result.display_name || null, home_timezone: result.home_timezone || null});

    let employment = await spine.getOpenEmploymentAsync(org_id, person.person_id);
    if (!employment) {
        const missing = REQUIRED_ASSERTION_ATTRIBUTES.filter(attr => !result[attr]);
        if (result.employment_status && !EMPLOYMENT_STATUSES.includes(result.employment_status) &&
            !missing.includes("employment_status")) missing.push("employment_status");

        if (missing.length) {
            const flag = missing.join(",");
            await dblayer.runCmdOrThrow("UPDATE person SET provisioning_status=? WHERE person_id=?",
                [flag, person.person_id]);
            await audit.writeAsync({org_id, action: "provisioning.incomplete", object_type: "person",
                object_ref: person.person_id, subject_person_id: person.person_id, actor_kind: "system",
                detail: {missing}});
            result.person_id = person.person_id;
            result.provisioning_status = flag;
            LOG.warn(`Incomplete IdP assertion for ${email} in ${org_id}: missing ${flag}. Account created, employment withheld.`);
            return false;
        }

        const manager = result.manager ?
            (await spine.getPersonByEmailAsync(result.manager))?.person_id || null : null;
        employment = await spine.recordEmploymentAsync({org_id, person_id: person.person_id,
            status: result.employment_status, jurisdiction: result.jurisdiction,
            manager_person_id: manager, contract_type: result.contract_type,
            valid_from: result.start_date, source: "idp", recorded_by: "idp"});
        await dblayer.runCmdOrThrow("UPDATE person SET provisioning_status=NULL WHERE person_id=?",
            [person.person_id]);
        await audit.writeAsync({org_id, action: "employment.provisioned", object_type: "employment",
            object_ref: employment.employment_id, subject_person_id: person.person_id,
            actor_kind: "system", detail: {source: "idp", start_date: employment.valid_from}});
        LOG.info(`Provisioned ${email} in ${org_id} from the IdP assertion, from ${employment.valid_from}.`);
        person.provisioning_status = null;      // the in-memory copy, cleared just now in the record
    }

    result.person_id = person.person_id;
    result.employment_status = employment.status;
    result.jurisdiction = employment.jurisdiction;
    result.manager_person_id = employment.manager_person_id;
    result.contract_type = employment.contract_type;
    result.start_date = employment.valid_from;
    result.home_timezone = person.home_timezone;
    result.provisioning_status = person.provisioning_status || "complete";
    return true;
}

/**
 * The mover path, for when a later assertion (typically a SCIM push) carries a
 * change. Supersedes the open employment period rather than editing it, so the
 * old jurisdiction and manager stay answerable for the period they covered.
 *
 * @param {string} org_id The org
 * @param {string} person_id The person
 * @param {object} assertion The new assertion attributes
 * @returns The new employment period, or null if nothing changed
 */
exports.syncEmploymentFromAssertionAsync = async function(org_id, person_id, assertion) {
    const open = await spine.getOpenEmploymentAsync(org_id, person_id);
    if (!open) return null;     // nothing to supersede; provisionFromAssertionAsync creates the first period

    // employment_status is the assertion's own name for the column employment stores as `status` —
    // every other attribute here happens to share its name on both sides.
    let changed = (assertion.employment_status && assertion.employment_status != open.status) ||
        ["jurisdiction", "contract_type"].some(attr => assertion[attr] && assertion[attr] != open[attr]);
    if (assertion.start_date) {const valid_from = String(assertion.start_date); changed = changed || (valid_from > open.valid_from);}

    let manager_person_id = open.manager_person_id;
    if (assertion.manager) {
        const manager = await spine.getPersonByEmailAsync(assertion.manager);
        changed = changed || (manager?.person_id != open.manager_person_id);
        manager_person_id = manager?.person_id || null;
    }
    if (!changed) return null;

    return await spine.recordEmploymentAsync({org_id, person_id,
        status: assertion.employment_status || open.status,
        jurisdiction: assertion.jurisdiction || open.jurisdiction,
        manager_person_id, contract_type: assertion.contract_type || open.contract_type,
        valid_from: assertion.start_date || _today(), source: "idp", recorded_by: "idp"});
}

// ---------------------------------------------------------------------------
// L1's admin screen — attribute map, provider status, MFA policy,
// the provisioning-incomplete queue, and joiners/movers/leavers
// ---------------------------------------------------------------------------

/** The six attributes the wireframe names, each with what breaks without it and whether it's hard-required. */
exports.attributeMap = _ => ATTRIBUTE_IMPACT.map(row => ({...row, required: REQUIRED_ASSERTION_ATTRIBUTES.includes(row.attribute)}));

/**
 * The one real identity path this app has — not a multi-provider catalogue,
 * since no second one exists to manage. Real numbers only: whether the IdP
 * endpoint is configured, its host, and how many current employments trace
 * to it.
 * @param {string} org_id The org
 */
exports.providerStatusAsync = async function(org_id) {
    const total = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM employment WHERE org_id=? AND valid_to IS NULL", [org_id]))[0].c;
    const viaIdp = (await dblayer.getQueryOrThrow(
        "SELECT COUNT(*) AS c FROM employment WHERE org_id=? AND valid_to IS NULL AND source='idp'", [org_id]))[0].c;
    const endpoint = TELEWORKR_CONSTANTS.CONF.tkmlogin_api || null;
    let host = null;
    if (endpoint) try {host = new URL(endpoint).host;} catch (err) {host = endpoint;}
    return {configured: Boolean(endpoint), host, people_via_idp: viaIdp, people_total: total};
}

/**
 * The declared MFA policy per role tier — a governance record, not a control
 * this app enforces itself. Unset tiers read the default, flagged as such.
 * @param {string} org_id The org
 * @param {string} actor_person_id The reader
 */
exports.mfaPolicyAsync = async function(org_id, actor_person_id) {
    await _requireManageAsync(org_id, actor_person_id);
    const rows = await dblayer.getQueryOrThrow("SELECT * FROM identity_mfa_policy WHERE org_id=?", [org_id]);
    const overrides = Object.fromEntries(rows.map(row => [row.role_tier, row]));
    return {policy: MFA_TIERS.map(tier => ({role_tier: tier,
        strength: overrides[tier]?.strength || DEFAULT_MFA_POLICY[tier],
        is_default: !overrides[tier], updated_at: overrides[tier]?.updated_at || null}))};
}

/** @param {object} request {org_id, actor_person_id, role_tier, strength} */
exports.updateMfaPolicyAsync = async function(request) {
    if (!MFA_TIERS.includes(request.role_tier)) throw new Error(
        `Unknown role tier ${JSON.stringify(request.role_tier)}. Known: ${MFA_TIERS.join(", ")}.`);
    if (!MFA_STRENGTHS.includes(request.strength)) throw new Error(
        `Unknown MFA strength ${JSON.stringify(request.strength)}. Known: ${MFA_STRENGTHS.join(", ")}.`);

    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "identity.manage",
        audit: {action: "identity.mfa_policy_updated", object_type: "identity_mfa_policy", object_ref: request.role_tier,
            detail: {role_tier: request.role_tier, strength: request.strength}},
        action: async exec => {
            await exec.runCmd(
                `INSERT INTO identity_mfa_policy (org_id, role_tier, strength, updated_at, updated_by) VALUES (?,?,?,?,?)
                    ON CONFLICT (org_id, role_tier) DO UPDATE SET strength=excluded.strength,
                        updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
                [request.org_id, request.role_tier, request.strength, _now(), request.actor_person_id]);
            return {role_tier: request.role_tier, strength: request.strength};
        }});
}

/**
 * Every person currently flagged with an incomplete assertion — uncapped,
 * with the missing attributes and when they were flagged. Same org-scoping
 * join setup.js's own health panel already uses, since person is global and
 * provisioning_status alone doesn't say which org's sign-in flagged it.
 * @param {string} org_id The org
 * @param {string} actor_person_id The reader
 */
exports.flaggedPeopleAsync = async function(org_id, actor_person_id) {
    await _requireManageAsync(org_id, actor_person_id);
    const rows = await dblayer.getQueryOrThrow(
        `SELECT p.person_id, p.email, p.display_name, p.provisioning_status,
            MAX(a.occurred_at) AS flagged_at
         FROM person p JOIN audit_event a ON a.subject_person_id=p.person_id
             AND a.org_id=? AND a.action='provisioning.incomplete'
         WHERE p.provisioning_status IS NOT NULL
         GROUP BY p.person_id ORDER BY flagged_at DESC`, [org_id]);
    return {people: rows.map(row => ({...row, missing: row.provisioning_status.split(",")}))};
}

/**
 * An admin supplies what a flagged person's assertion didn't, closing the
 * loop provisionFromAssertionAsync opened — until now the only way to
 * un-flag someone was a corrected IdP assertion on their next sign-in.
 * @param {object} request {org_id, actor_person_id, person_id, employment_status,
 *      jurisdiction, manager, start_date, contract_type}
 */
exports.resolveFlaggedPersonAsync = async function(request) {
    const person = await spine.getPersonAsync(request.person_id);
    if (!person) throw new Error(`Person ${request.person_id} was not found.`);
    if (!person.provisioning_status) throw new Error("This person is not flagged — nothing to resolve.");

    const missing = REQUIRED_ASSERTION_ATTRIBUTES.filter(attr => !request[attr]);
    if (missing.length) throw new Error(
        `Still missing: ${missing.join(", ")}. They are required, never defaulted.`);
    if (!EMPLOYMENT_STATUSES.includes(request.employment_status)) throw new Error(
        `Unknown employment status ${JSON.stringify(request.employment_status)}.`);
    const manager = request.manager ? (await spine.getPersonByEmailAsync(request.manager))?.person_id || null : null;

    // No subject_person_id on the permission check itself: ORG scope, when given a
    // subject, requires that subject to already have an employment in force to be
    // covered — exactly what a flagged person doesn't have yet, which is the entire
    // reason they're being resolved. The audit entry still names them as the subject.
    return await audit.performAsync({
        org_id: request.org_id, actor_person_id: request.actor_person_id, capability: "identity.manage",
        audit: {action: "identity.provisioning_resolved", object_type: "person", object_ref: request.person_id,
            subject_person_id: request.person_id,
            detail: {jurisdiction: request.jurisdiction, contract_type: request.contract_type}},
        action: async exec => {
            const employment = await spine.recordEmploymentAsync({org_id: request.org_id, person_id: request.person_id,
                status: request.employment_status, jurisdiction: request.jurisdiction, manager_person_id: manager,
                contract_type: request.contract_type, valid_from: request.start_date, source: "manual",
                recorded_by: request.actor_person_id}, exec);
            await exec.runCmd("UPDATE person SET provisioning_status=NULL WHERE person_id=?", [request.person_id]);
            return employment;
        }});
}

/**
 * Joiners (dormant until a future start date, already true of the schema —
 * getOpenEmploymentAsync finds them, employmentAsOfAsync doesn't), movers
 * (superseded within the window, diffed against their prior period), and
 * leavers (an open period already declaring notice/suspended/ended — real
 * enum values nothing else in this app sets yet, so this is often empty,
 * which is honest rather than invented).
 * @param {string} org_id The org
 * @param {string} actor_person_id The reader
 * @param {object} options {days} — the mover window, default 90
 */
exports.joinersMoversLeaversAsync = async function(org_id, actor_person_id, options={}) {
    await _requireManageAsync(org_id, actor_person_id);
    const since = _now() - (options.days || 90) * 86400;

    const joiners = await dblayer.getQueryOrThrow(
        `SELECT e.*, p.display_name, p.email FROM employment e JOIN person p ON p.person_id=e.person_id
            WHERE e.org_id=? AND e.valid_to IS NULL AND e.valid_from > ? ORDER BY e.valid_from ASC`,
        [org_id, _today()]);

    const leavers = await dblayer.getQueryOrThrow(
        `SELECT e.*, p.display_name, p.email FROM employment e JOIN person p ON p.person_id=e.person_id
            WHERE e.org_id=? AND e.valid_to IS NULL AND e.status IN ('notice','suspended','ended')
            ORDER BY e.valid_from DESC`, [org_id]);

    const moverCandidates = await dblayer.getQueryOrThrow(
        `SELECT person_id, COUNT(*) AS c, MAX(recorded_at) AS latest FROM employment WHERE org_id=?
            GROUP BY person_id HAVING c > 1 AND latest >= ? ORDER BY latest DESC`, [org_id, since]);
    const movers = [];
    for (const candidate of moverCandidates) {
        const history = await spine.employmentHistoryAsync(org_id, candidate.person_id);
        const previous = history[history.length - 2], current = history[history.length - 1];
        const person = await spine.getPersonAsync(candidate.person_id);
        movers.push({person_id: candidate.person_id, display_name: person?.display_name, email: person?.email,
            effective_from: current.valid_from,
            changes: ["jurisdiction", "manager_person_id", "contract_type", "status"]
                .filter(field => previous[field] != current[field])
                .map(field => ({field, from: previous[field], to: current[field]}))});
    }

    return {joiners, movers, leavers};
}

exports.REQUIRED_ASSERTION_ATTRIBUTES = REQUIRED_ASSERTION_ATTRIBUTES;
exports.EMPLOYMENT_STATUSES = EMPLOYMENT_STATUSES;
exports.MFA_TIERS = MFA_TIERS;
exports.MFA_STRENGTHS = MFA_STRENGTHS;
