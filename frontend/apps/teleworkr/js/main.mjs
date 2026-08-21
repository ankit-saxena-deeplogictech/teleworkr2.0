/* 
 * (C) 2026 TekMonks. All rights reserved.
 * License: See enclosed license.txt file.
 */
import {shell} from "./shell.mjs";
import {loginmanager} from "./loginmanager.mjs"
import {router} from "/framework/js/router.mjs";

const gohomeListeners = [];

const logoutClicked = _ => {shell.stopShell(); loginmanager.logout();};

// The shell fetches its own projection once the page is up, so there is nothing to
// resolve here before render. What a person can reach is decided by the server (A7).
const interceptPageData = _ => router.addOnLoadPageData(APP_CONSTANTS.MAIN_HTML, async _data => {});

async function gohome() {
    for (const listener of gohomeListeners) await listener();
    shell.setSurface(shell.projection?.home);
}

const addGoHomeListener = listener => gohomeListeners.push(listener);

export const main = {logoutClicked, interceptPageData, gohome, addGoHomeListener}
