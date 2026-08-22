/* 
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed license.txt file.
 */
import {i18n} from "/framework/js/i18n.mjs";
import {application} from "./application.mjs";
import {router} from "/framework/js/router.mjs";
import {session} from "/framework/js/session.mjs";
import {securityguard} from "/framework/js/securityguard.mjs";
import {apimanager as apiman} from "/framework/js/apimanager.mjs";

const LOGOUT_LISTENERS = "__loginmanager_logout_listeners", 
    TIMEOUT_CURRENT = "__loginmanager_timeout_current";

function handleLoginResult(fetchResponse) {
    session.set(LOGOUT_LISTENERS, []); // reset listeners on sign in

    const apiURL = fetchResponse.url, headers = fetchResponse.headers, jsonResponseObject = fetchResponse.response;
    if (jsonResponseObject && jsonResponseObject.result) {
        apiman.addJWTToken(apiURL, headers, jsonResponseObject);
        session.set(APP_CONSTANTS.USERID, jsonResponseObject.id); 
        session.set(APP_CONSTANTS.USERNAME, jsonResponseObject.name);
        session.set(APP_CONSTANTS.USERORG, jsonResponseObject.org);
        session.set(APP_CONSTANTS.CURRENT_USERROLE, jsonResponseObject.role); 
        session.set(APP_CONSTANTS.USERORGDOMAIN, jsonResponseObject.domain);
        session.set(APP_CONSTANTS.LOGIN_RESPONSE, jsonResponseObject);
        securityguard.setCurrentRole(jsonResponseObject.role);
        LOG.info(`Teleworkr login succeeded for ${jsonResponseObject.id}.`);
        if (APP_CONSTANTS.AUTO_LOGOUT) startAutoLogoutTimer();  
        router.loadPage(APP_CONSTANTS.MAIN_HTML);
    } else {LOG.error(`Teleworkr login failed.`); router.loadPage(`${APP_CONSTANTS.LOGIN_HTML}?_error=true`);}
}

const addLogoutListener = (modulePath, exportToCall, functionToCall) => {
    const logoutListeners = session.get(LOGOUT_LISTENERS);
    logoutListeners.push({modulePath, exportToCall, functionToCall});
    session.set(LOGOUT_LISTENERS, logoutListeners);
}

async function logout(dueToTimeout) {
    LOG.info(`Logout of user ID: ${session.get(APP_CONSTANTS.USERID)}${dueToTimeout?" due to timeout":""}.`);

    for (const listener of (session.get(LOGOUT_LISTENERS)||[])) {
        try {
            const module = await import(listener.modulePath);
            module[listener.exportToCall][listener.functionToCall]();
        } catch (err) {LOG.error("Error calling logout listener "+JSON.stringify(listener));}
    }
    _stopAutoLogoutTimer(); 

    const savedLang = session.get($$.MONKSHU_CONSTANTS.LANG_ID);
    session.remove(APP_CONSTANTS.USERID); session.remove(APP_CONSTANTS.USERNAME);
    session.remove(APP_CONSTANTS.USERORG); session.remove(APP_CONSTANTS.CURRENT_USERROLE);
    session.remove(APP_CONSTANTS.USERORGDOMAIN); session.remove(APP_CONSTANTS.LOGIN_RESPONSE);
    session.set($$.MONKSHU_CONSTANTS.LANG_ID, savedLang); securityguard.setCurrentRole(APP_CONSTANTS.GUEST_ROLE);
    
    if (dueToTimeout) application.main(APP_CONSTANTS.ERROR_HTML, {error: await i18n.get("Timeout_Error"), 
        button: await i18n.get("Relogin"), link: router.encodeURL(APP_CONSTANTS.LOGIN_HTML)}); 
    else application.main(APP_CONSTANTS.LOGIN_HTML);
}

const getSessionUser = _ => { return {id: session.get(APP_CONSTANTS.USERID), name: session.get(APP_CONSTANTS.USERNAME),
    org: session.get(APP_CONSTANTS.USERORG)} }

function startAutoLogoutTimer() { 
    if (!session.get(APP_CONSTANTS.USERID)) return; // no one is logged in
    
    const events = ["load", "mousemove", "mousedown", "click", "scroll", "keypress"];
    const resetTimer = _=> {_stopAutoLogoutTimer(); session.set(TIMEOUT_CURRENT, setTimeout(_=>logout(true), APP_CONSTANTS.TIMEOUT));}
    for (const event of events) {document.addEventListener(event, resetTimer);}
    resetTimer();   // start the timing
}

const interceptPageLoadData = _ => {
    $$.librouter.addOnLoadPageData(APP_CONSTANTS.LOGIN_HTML, async (data, _url) => {
            data.LOGIN_API_KEY = apiman.getAPIKeyFor(`${APP_CONSTANTS.API_PATH}/login`); });
    $$.librouter.addOnLoadPageData(APP_CONSTANTS.LOGINRESULT_HTML, async (data, _url) => {
        data.LOGIN_API_KEY = apiman.getAPIKeyFor(`${APP_CONSTANTS.API_PATH}/login`); });
}

const isAdmin = _ => session.get(APP_CONSTANTS.CURRENT_USERROLE).toString() == "admin";

const _stopAutoLogoutTimer = _ => { 
    const currTimeout = session.get(TIMEOUT_CURRENT);
    if (currTimeout) {clearTimeout(currTimeout); session.remove(TIMEOUT_CURRENT);} 
}

export const loginmanager = {handleLoginResult, logout, startAutoLogoutTimer, addLogoutListener, getSessionUser, 
    isAdmin, interceptPageLoadData};
