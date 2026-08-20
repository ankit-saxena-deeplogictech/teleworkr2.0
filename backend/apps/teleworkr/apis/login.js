/**
 * Needs Tekmonks Unified Login to work.
 *
 * Operations are
 *  op - getotk - Returns one time key which can be passed to Unified login
 *  op - verify - Verifies the incoming JWT. This needs the following params
 *      op: "verify", jwt: "the JWT token from unified login"
 * (C) 2026 TekMonks. All rights reserved.
 */

const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const httpClient = require(`${CONSTANTS.LIBDIR}/httpClient.js`);
const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);

const LOGIN_LISTENERS_MEMORY_KEY = "__org_monkshu_teleworkr_login_listeners";

exports.doService = async jsonReq => {
	if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}

    if (jsonReq.op == "getotk") return _getOTK(jsonReq);
    else if (jsonReq.op == "verify") return await _verifyJWT(jsonReq);
    else return CONSTANTS.FALSE_RESULT;
}

exports.isValidLogin = headers => APIREGISTRY.getExtension("JWTTokenManager").checkToken(exports.getToken(headers));
exports.getID = headers => APIREGISTRY.getExtension("JWTTokenManager").getClaims(headers).id;
exports.getRole = headers => APIREGISTRY.getExtension("JWTTokenManager").getClaims(headers).sub;
exports.getOrg = headers => APIREGISTRY.getExtension("JWTTokenManager").getClaims(headers).org;
exports.getJWT = headers => APIREGISTRY.getExtension("JWTTokenManager").getToken(headers);
exports.getToken = headers => exports.getJWT(headers);

exports.addLoginListener = (modulePath, functionName) => {
	const loginlisteners = CLUSTER_MEMORY.get(LOGIN_LISTENERS_MEMORY_KEY, []);
	loginlisteners.push({modulePath, functionName});
	CLUSTER_MEMORY.set(LOGIN_LISTENERS_MEMORY_KEY, loginlisteners);
}

exports.getKey = headers => APIREGISTRY.getExtension("apikeychecker").getIncomingAPIKey(headers);

exports.getOrgKeys = async headersOrOrg => {
	const orgIn = typeof headersOrOrg == "string" ? headersOrOrg : exports.getOrg(headersOrOrg);
	return await dblayer.getOrgKeys(orgIn);
}

exports.isAPIKeySecure = async function(headers, org) {
	const incomingKey = APIREGISTRY.getExtension("apikeychecker").getIncomingAPIKey(headers);
	const orgKeys = await exports.getOrgKeys(org);
    if (!orgKeys) return false; // no org key found in db
	return orgKeys.includes(incomingKey);
}

exports.isAdmin = headers => (exports.getRole(headers))?.toLowerCase() == TELEWORKR_CONSTANTS.ROLES.ADMIN.toLowerCase();

function _getOTK(_jsonReq) {
    return {...CONSTANTS.TRUE_RESULT, otk: serverutils.generateUUID(false)};
}

async function _verifyJWT(jsonReq) {
    let tokenValidationResult; try {
        tokenValidationResult = await httpClient.fetch(`${TELEWORKR_CONSTANTS.CONF.tkmlogin_api}?jwt=${jsonReq.jwt}`);
    } catch (err) {
        LOG.error(`Network error validating JWT token ${jsonReq.jwt}, validation failed. Error is ${err}`);
        // A8: the IdP is an external dependency and this is its Degraded level —
        // named, so the login screen can banner a break-glass path rather than
        // showing a blank failure.
        return {...CONSTANTS.FALSE_RESULT, degraded: "idp_unreachable"};
    }

	if (!tokenValidationResult.ok) {
        LOG.error(`Fetch error validating JWT token ${jsonReq.jwt}, validation failed.`);
        return {...CONSTANTS.FALSE_RESULT, degraded: "idp_rejected"};
    }

    const responseJSON = await tokenValidationResult.json();
    if ((!responseJSON.result) || (responseJSON.jwt != jsonReq.jwt)) {
        LOG.error(`Validation error when validating JWT token ${jsonReq.jwt}.`);
        return {...CONSTANTS.FALSE_RESULT, degraded: "idp_rejected"};
    }

    try {
        const _decodeBase64 = string => Buffer.from(string, "base64").toString("utf8");
        const jwtClaims = JSON.parse(_decodeBase64(jsonReq.jwt.split(".")[1]));
        const finalResult = {...jwtClaims, org: jwtClaims.org.toLowerCase(), role: jwtClaims.role,
			...CONSTANTS.TRUE_RESULT, tokenflag: true};
		await _informLoginListeners(finalResult);
        return finalResult;
    } catch (err) {
        LOG.error(`Bad JWT token passed for login ${jsonReq.jwt}, validation succeeded but decode failed. Error is ${err}`);
        return CONSTANTS.FALSE_RESULT;
    }
}

const _informLoginListeners = async result => {
	const loginlisteners = CLUSTER_MEMORY.get(LOGIN_LISTENERS_MEMORY_KEY, []);
	for (const listener of loginlisteners) {
		const listenerFunction = require(listener.modulePath)[listener.functionName];
        const listenerFunctionResult = await listenerFunction(result);
		if (!listenerFunctionResult) return false;
	}
    return true;
}

const validateRequest = jsonReq => jsonReq && ((jsonReq.op=="verify" && jsonReq.jwt) || jsonReq.op=="getotk");
