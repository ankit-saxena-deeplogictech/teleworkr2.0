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

const _today = _ => new Date().toISOString().substring(0, 10);

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

    let changed = ["status", "jurisdiction", "contract_type"].some(attr =>
        assertion[attr] && assertion[attr] != open[attr]);
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

exports.REQUIRED_ASSERTION_ATTRIBUTES = REQUIRED_ASSERTION_ATTRIBUTES;
exports.EMPLOYMENT_STATUSES = EMPLOYMENT_STATUSES;
