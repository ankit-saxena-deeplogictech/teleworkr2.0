/** 
 * Loads the Teleworkr views inside the login app shell. A view is a self contained
 * folder under ./views/<viewname> holding a main.html, a js/main.mjs and its own i18n and images.
 * 
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

import {i18n} from "/framework/js/i18n.mjs";
import {util} from "/framework/js/util.mjs";
import {router} from "/framework/js/router.mjs";
import {session} from "/framework/js/session.mjs";

const MODULE_PATH = util.getModulePathFromURL(import.meta.url), IMAGE_DATA = "data:image",
    CUSTOM_INTERFACE = "custom", DEFAULT_MAX_PATH_LENGTH = 50;

let loginappMain;

const main = async (data, mainLoginAppModule) => {
    window.monkshu_env.apps[APP_CONSTANTS.APP_NAME] = {
        ...(window.monkshu_env.apps[APP_CONSTANTS.APP_NAME]||{}), teleworkrapp};
    loginappMain = mainLoginAppModule; loginappMain.addGoHomeListener(_ => session.remove(APP_CONSTANTS.FORCE_LOAD_VIEW));
    APP_CONSTANTS.VIEWS_PATH = util.resolveURL(`${APP_CONSTANTS.APP_PATH}${APP_CONSTANTS.VIEWS_RELATIVE_PATH}`);
    await _createdata(data);
    data.maincontent = data.viewcontent;     // this is the main entry point
}

async function _createdata(data) {
    let viewPath, views, activeview; delete data.showhome; delete data.shownotifications;
    const loginresponse = session.get(APP_CONSTANTS.LOGIN_RESPONSE),
        viewsAllowed = [...(loginresponse?.views||[{id: APP_CONSTANTS.DEFAULT_VIEW,
            interface: {type: APP_CONSTANTS.DEFAULT_VIEW}}])];

    const _getViewToForceLoadOrFalse = _ => session.get(APP_CONSTANTS.FORCE_LOAD_VIEW)?.toString()||false;
    const _loadForcedView = viewid => {
        if (viewsAllowed.length > 1) data.showhome = true;
        const viewidToOpen = viewid||_getViewToForceLoadOrFalse(),
            view = (viewsAllowed.filter(view => view.id == viewidToOpen))[0];
        viewPath = getViewPath(view, loginresponse?.org); activeview = view;
    }

    // load the given view if forced, or if only one view is allowed, else load the chooser
    if (viewsAllowed.length == 1) _loadForcedView(viewsAllowed[0].id);
    else if (_getViewToForceLoadOrFalse()) _loadForcedView();
    else {    // left with chooser
        viewPath = `${APP_CONSTANTS.VIEWS_PATH}/${APP_CONSTANTS.VIEW_CHOOSER}`;
        views = [];
        for (const view of viewsAllowed) if (view.interface != APP_CONSTANTS.VIEW_CHOOSER) views.push(  // views we can choose from
            {viewicon: (view.interface?.icon && view.interface.icon.toLowerCase().startsWith(IMAGE_DATA)) ? view.interface.icon :
                view.interface.type == CUSTOM_INTERFACE ? `${getViewPath(view, loginresponse?.org)}/img/logo.svg` :
                `${APP_CONSTANTS.VIEWS_PATH}/${view.interface.type.toString()}/img/icon.svg`,
            viewlabel: view.interface.label||await i18n.get(`ViewLabel_${view.interface.type.toString()}`),
            viewid: view.id});
    }

    // now load the view's HTML
    const viewURL = `${viewPath}/main.html`, viewMainMJS = `${viewPath}/js/main.mjs`;
    data.viewpath = viewPath; data.activeview = activeview; data.icons = {}; data.showrefresh = true;
    try { const viewMain = await import(viewMainMJS); await viewMain.main.initView(data, teleworkrapp); }    // init the view before loading it
    catch (err) { LOG.error(`Error in initializing view ${viewPath} due to error ${err}.`); }
    data.viewcontent = await router.loadHTML(viewURL, {...data, views});
}

const closeview = _ => loginappMain.gohome();

async function openView(viewid) {
    session.set(APP_CONSTANTS.FORCE_LOAD_VIEW, viewid);
    const {loginmanager} = await import (`${APP_CONSTANTS.LIB_PATH}/loginmanager.mjs`);
    loginmanager.addLogoutListener(`${MODULE_PATH}/teleworkrapp.mjs`, "teleworkrapp", "onlogout");

    router.navigate(APP_CONSTANTS.MAIN_HTML);
}

function onlogout() {session.remove(APP_CONSTANTS.FORCE_LOAD_VIEW);}

function getViewPath(view, org) {
    if (view.interface.type == CUSTOM_INTERFACE) return `${APP_CONSTANTS.VIEWS_PATH}/custom/${_convertToPathFriendlyString(org)}/${_convertToPathFriendlyString(view.id)}`;
    else return `${APP_CONSTANTS.VIEWS_PATH}/${view.interface.type}`;
}

function _convertToPathFriendlyString(s, maxPathLength=DEFAULT_MAX_PATH_LENGTH) {
	let tentativeFilepath = encodeURIComponent(s);
	if (tentativeFilepath.endsWith(".")) tentativeFilepath = tentativeFilepath.substring(0, tentativeFilepath.length - 1) + "%2E";
		
	if (tentativeFilepath.length > maxPathLength) {
		tentativeFilepath = tentativeFilepath + "." + Date.now();
		tentativeFilepath = tentativeFilepath.substring(tentativeFilepath.length-maxPathLength);
	}
	
	return tentativeFilepath;
}

export const teleworkrapp = {main, openView, closeview, onlogout};
