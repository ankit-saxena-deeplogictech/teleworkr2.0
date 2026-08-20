/**
 * Org bootstrap API. The Phase 0 gate is "create an org, sign in via IdP, read
 * jurisdiction and manager from the assertion" — this is the create half.
 *
 * Operations:
 *  op - create - Bootstraps an org with the caller as first admin. The first
 *      admin's attributes come from the signed-in token claims plus the request,
 *      and are required rather than defaulted.
 *
 * (C) 2026 TekMonks. All rights reserved.
 */

const identity = require(`${TELEWORKR_CONSTANTS.LIBDIR}/identity.js`);
const spine = require(`${TELEWORKR_CONSTANTS.LIBDIR}/spine.js`);

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}

    if (jsonReq.op == "create") return await _createOrg(jsonReq);
    else return CONSTANTS.FALSE_RESULT;
}

const _createOrg = async jsonReq => {
    try {
        const org_id = (jsonReq.org||"").toLowerCase();
        if (await spine.getOrgAsync(org_id)) return {...CONSTANTS.FALSE_RESULT,
            reason: `Org ${org_id} already exists. Creating a second org over the same claim is refused.`};

        const bootstrapped = await identity.bootstrapOrgAsync({
            org: {name: jsonReq.name, home_jurisdiction: jsonReq.home_jurisdiction, org_id},
            admin: {email: (jsonReq.id||"").toLowerCase(), display_name: jsonReq.display_name,
                employment_status: jsonReq.employment_status, jurisdiction: jsonReq.jurisdiction,
                start_date: jsonReq.start_date, contract_type: jsonReq.contract_type,
                manager: jsonReq.manager, home_timezone: jsonReq.home_timezone}});

        return {...CONSTANTS.TRUE_RESULT, org: bootstrapped.org,
            person_id: bootstrapped.person.person_id,
            roles: Object.keys(bootstrapped.roles), grants: bootstrapped.grants.length};
    } catch (err) {
        LOG.error(`Org creation failed: ${err}`);
        return {...CONSTANTS.FALSE_RESULT, reason: err.message};
    }
}

const validateRequest = jsonReq => jsonReq && jsonReq.op == "create" &&
    jsonReq.id && jsonReq.org && jsonReq.name &&
    jsonReq.employment_status && jsonReq.jurisdiction && jsonReq.start_date && jsonReq.contract_type;
