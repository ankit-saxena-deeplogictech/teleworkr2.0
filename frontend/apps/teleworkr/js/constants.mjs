/* 
 * (C) 2026 TekMonks. All rights reserved.
 * License: MIT - see enclosed license.txt file.
 */
const FRONTEND = new URL(window.location.href).protocol + "//" + new URL(window.location.href).host;
const BACKEND = new URL(window.location.href).protocol + "//" + new URL(window.location.href).hostname + ":9090";
const APP_NAME = "teleworkr";
const APP_PATH = `${FRONTEND}/apps/${APP_NAME}`;
const LIB_PATH = `${APP_PATH}/js`;
const CONF_PATH = `${APP_PATH}/conf`;
const API_PATH = `${BACKEND}/apps/${APP_NAME}`;
const COMPONENTS_PATH = `${APP_PATH}/components`;

const MAIN_HTML = APP_PATH+"/main.html";
const LOGIN_HTML = APP_PATH+"/login.html";
const INDEX_HTML = APP_PATH+"/index.html";
const ERROR_HTML = APP_PATH+"/error.html";
const LOGINRESULT_HTML = APP_PATH+"/loginresult.html";
const ALL_USER_PAGES = [window.location.origin, LOGIN_HTML, INDEX_HTML, ERROR_HTML, LOGINRESULT_HTML, 
    $$.MONKSHU_CONSTANTS.ERROR_HTML, `${APP_PATH}/.+\.html`];
const ABOUT_URL = "https://teleworkr.com/";

export const APP_CONSTANTS = {
    FRONTEND, BACKEND, APP_PATH, APP_NAME, COMPONENTS_PATH, API_PATH, LIB_PATH, CONF_PATH,  
    MAIN_HTML, LOGIN_HTML, INDEX_HTML, ERROR_HTML, LOGINRESULT_HTML, ABOUT_URL, 

    SESSION_NOTE_ID: "com_monkshu_ts",

    // Login constants
    TKMLOGIN_LIB: `${APP_PATH}/3p/tkmlogin.mjs`,
    API_LOGIN: API_PATH+"/login",
    TIMEOUT: 600000,
    AUTO_LOGOUT: false,
    USERID: "userid",
    USERNAME: "username",
    USERORG: "userorg",
    CURRENT_USERROLE: "currentuserrole",
    USERORGDOMAIN: "userorgdomain",
    LOGIN_RESPONSE: "loginresponse",

    USER_ROLE: "user",
    GUEST_ROLE: "guest",
    ADMIN_ROLE: "admin",

    // Permissions and keys
    PERMISSIONS_MAP: { 
        user:[...ALL_USER_PAGES, MAIN_HTML], admin:[...ALL_USER_PAGES, MAIN_HTML], guest:[...ALL_USER_PAGES] },
    API_KEYS: {"*":"fheiwu98237hjief8923ydewjidw834284hwqdnejwr79389"},
    KEY_HEADER: "X-API-Key"
}
