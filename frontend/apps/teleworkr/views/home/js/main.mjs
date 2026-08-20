/** 
 * View main module for the home view. Views are self contained folders under
 * ./views/<viewname> and are loaded by teleworkrapp.mjs.
 * 
 * (C) 2026 Tekmonks Corp.
 */

import {i18n} from "/framework/js/i18n.mjs";
import {session} from "/framework/js/session.mjs";
import {router} from "/framework/js/router.mjs";

let VIEW_PATH, mustache;

/**
 * Called by teleworkrapp.mjs before the view's main.html is rendered. Anything
 * set into data here is available to the view's Mustache template.
 * @param {object} data The page data, modified in place
 * @param {object} _teleworkrapp The Teleworkr app module, to open or close views
 */
async function initView(data, _teleworkrapp) {
    mustache = await router.getMustache();
    window.monkshu_env.apps[APP_CONSTANTS.APP_NAME] = {
        ...(window.monkshu_env.apps[APP_CONSTANTS.APP_NAME]||{}), home_main: main};
    VIEW_PATH = data.viewpath; data.VIEW_PATH = VIEW_PATH;
    i18n.addPath(VIEW_PATH);    // so the view's own i18n files are searched too

    const username = session.get(APP_CONSTANTS.USERNAME)?.toString().split(" ")[0] || "";
    data.greeting = mustache.render(await i18n.get("HomeGreeting"), {name: username});
}

export const main = {initView};
