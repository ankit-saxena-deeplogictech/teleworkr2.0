/** 
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed license.txt file.
 */

import {util} from "/framework/js/util.mjs";
import {router} from "/framework/js/router.mjs";
import {session} from "/framework/js/session.mjs";
import {loadbalancer} from "/framework/js/loadbalancer.mjs";
import {securityguard} from "/framework/js/securityguard.mjs";
import {apimanager as apiman} from "/framework/js/apimanager.mjs";
import {APP_CONSTANTS as AUTO_APP_CONSTANTS} from "./constants.mjs";

const init = async hostname => {
	window.monkshu_env.apps[AUTO_APP_CONSTANTS.APP_NAME] = {};
	const mustache = await router.getMustache();
	window.APP_CONSTANTS = JSON.parse(mustache.render(JSON.stringify(AUTO_APP_CONSTANTS), {hostname}));
	window.LOG = window.monkshu_env.frameworklibs.log;

	_addLoadbalancers();

	if (!session.get($$.MONKSHU_CONSTANTS.LANG_ID)) session.set($$.MONKSHU_CONSTANTS.LANG_ID, "en");

	securityguard.setPermissionsMap(APP_CONSTANTS.PERMISSIONS_MAP);
	securityguard.setCurrentRole(securityguard.getCurrentRole() || APP_CONSTANTS.GUEST_ROLE);

	apiman.registerAPIKeys(APP_CONSTANTS.API_KEYS, APP_CONSTANTS.KEY_HEADER); 
	const API_GETREMOTELOG = APP_CONSTANTS.API_PATH+"/getremotelog", API_REMOTELOG = APP_CONSTANTS.API_PATH+"/log";
	const remoteLogResponse = (await apiman.rest(API_GETREMOTELOG, "GET")), remoteLogFlag = remoteLogResponse?remoteLogResponse.remote_log:false;
	LOG.setRemote(remoteLogFlag, API_REMOTELOG);
}

const main = async (desiredURL, desiredData) => {
	await _addPageLoadInterceptors(); await _readConfig(); await _registerComponents();
	const decodedURL = new URL(desiredURL || router.decodeURL(window.location.href)), justURL = util.baseURL(decodedURL);

	if (justURL == APP_CONSTANTS.INDEX_HTML) router.loadPage(APP_CONSTANTS.LOGIN_HTML);
	else if (securityguard.isAllowed(justURL)) {
		if (router.getLastSessionURL() && (decodedURL.toString() == router.getLastSessionURL().toString())) router.reload();
		else router.loadPage(decodedURL.href, desiredData);
	} else router.loadPage(APP_CONSTANTS.LOGIN_HTML);
}

const interceptPageLoadData = _ => router.addOnLoadPageData("*", async (data, _url) => data.APP_CONSTANTS = APP_CONSTANTS);

async function _readConfig() {
	const conf = await $$.requireJSON(`${APP_CONSTANTS.CONF_PATH}/app.json`);
	for (const key of Object.keys(conf)) APP_CONSTANTS[key] = conf[key];
}

const _registerComponents = async _ => { for (const component of APP_CONSTANTS.COMPONENTS) 
	await import(`${APP_CONSTANTS.APP_PATH}/${component}/${component.substring(component.lastIndexOf("/")+1)}.mjs`); }

async function _addPageLoadInterceptors() {
	const interceptors = await $$.requireJSON(`${APP_CONSTANTS.CONF_PATH}/page_load_interceptors.json`);
	for (const interceptor of interceptors) {
		const modulePath = interceptor.module, functionName = interceptor.function;
		let module = await import(`${APP_CONSTANTS.APP_PATH}/${modulePath}`); module = module[Object.keys(module)[0]];
		(module[functionName])();
	}
}

async function _addLoadbalancers() {
	let lbConf; try {lbConf = await $$.requireJSON(`${APP_CONSTANTS.CONF_PATH}/lb.json`)} catch (err) {};
	if (!lbConf) return;	// no LBs configured

	for (const lbconfKey of Object.keys(lbConf)) {
		if (lbconfKey == "backends") lbConf[lbconfKey].roothost = new URL(APP_CONSTANTS.BACKEND).hostname;
		else if (lbconfKey == "frontends") lbConf[lbconfKey].roothost = new URL(APP_CONSTANTS.FRONTEND).hostname;
		else continue;	// not a known LB configuration
		
		const lbThis = loadbalancer.createLoadbalancer(lbConf[lbconfKey]);
		if (lbThis) {router.addLoadbalancer(lbThis); LOG.info(`Added load balancer for policy ${lbconfKey}`);}
		else LOG.error(`Bad load balancer policy ${lbconfKey}.`);
	}
}

export const application = {init, main, interceptPageLoadData};