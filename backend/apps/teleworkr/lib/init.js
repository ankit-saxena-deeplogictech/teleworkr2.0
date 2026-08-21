/**
 * Teleworkr app initialization - reads the conf and boots the app's libraries.
 * (C) 2026 TekMonks. All rights reserved.
 */

const fs = require("fs");
const mustache = require("mustache");

exports.initSync = _approot => {
    _readConfSync();    // the files below need constants to be setup properly so require them after conf is setup

    const events = require(`${TELEWORKR_CONSTANTS.APIDIR}/events.js`);
    const sseevents = require(`${TELEWORKR_CONSTANTS.APIDIR}/sseevents.js`);
    const dblayer = require(`${TELEWORKR_CONSTANTS.LIBDIR}/dblayer.js`);
    const loginhandler = require(`${TELEWORKR_CONSTANTS.LIBDIR}/loginhandler.js`);
    const shell = require(`${TELEWORKR_CONSTANTS.LIBDIR}/shell.js`);

    // The schema must be in place before anything reads it. A failure here is fatal
    // rather than logged, because every read after it would answer from a shape
    // that does not match the code.
    dblayer.initDBAsync().catch(err =>
        LOG.error(`Teleworkr schema initialization failed, the app cannot serve requests: ${err}`));
    // A surface naming a capability that does not exist would hide itself from
    // everyone, and would look exactly like a permission working correctly.
    shell.validateCatalogueSync();

    loginhandler.initSync();
    events.initSync();
    sseevents.initSync();

    const clusterSize = TELEWORKR_CONSTANTS.CONF.cluster_size ||     // if conf has cluster size use it, else try from distributed memory, else use local core count
        (DISTRIBUTED_MEMORY.get(TELEWORKR_CONSTANTS.CLUSTERCOUNT_KEY) ?
            DISTRIBUTED_MEMORY.get(TELEWORKR_CONSTANTS.CLUSTERCOUNT_KEY) + 1 : undefined) || CLUSTER_MEMORY.configured_cluster_count;
    DISTRIBUTED_MEMORY.set(TELEWORKR_CONSTANTS.CLUSTERCOUNT_KEY, clusterSize);
}

function _readConfSync() {
    const hostname = fs.existsSync(`${TELEWORKR_CONSTANTS.HTTPDCONFDIR}/hostname.json`) ?
        require(`${TELEWORKR_CONSTANTS.HTTPDCONFDIR}/hostname.json`) : CONSTANTS.HOSTNAME;

    const confjson = mustache.render(fs.readFileSync(`${TELEWORKR_CONSTANTS.CONFDIR}/teleworkr.json`, "utf8"),
        {...TELEWORKR_CONSTANTS, hostname, APPROOT: TELEWORKR_CONSTANTS.APPROOT}).replace(/\\/g, "\\\\");   // escape windows paths
    TELEWORKR_CONSTANTS.CONF = JSON.parse(confjson);
    global.TELEWORKR_CONSTANTS = TELEWORKR_CONSTANTS;
}
