/**
 * Init and run the app. 
 * (C) 2026 TekMonks. All rights reserved.
 * See enclosed LICENSE file.
 */

const debug_mode = true;

_init();
async function _init() {
    const {webbundlesupport} = await import("/framework/js/webbundlesupport.mjs");    // use monkshu web bundles
    if (!await webbundlesupport.addWebbundleSupport()) 
        console.error("Webbundle loading failed or not available. Website performance will be slow.")
    
    await import("/framework/js/$$.js"); 
    $$.boot(undefined, undefined, !debug_mode); // now boot the app
}
