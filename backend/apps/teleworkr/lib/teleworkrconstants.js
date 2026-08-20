/** 
 * Teleworkr constants.
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const path = require("path");
const BACKEND_ROOT = path.resolve(`${__dirname}/../`);
const APPROOT = BACKEND_ROOT;

exports.APPROOT = path.resolve(APPROOT);
exports.APIDIR = path.resolve(`${APPROOT}/apis`);
exports.CONFDIR = path.resolve(`${APPROOT}/conf`);
exports.LIBDIR = path.resolve(`${APPROOT}/lib`);
exports.HTTPDCONFDIR = path.resolve(`${BACKEND_ROOT}/conf`);
exports.TEMPDIR = path.resolve(`${APPROOT}/temp`);
exports.THIRDPARTYDIR = path.resolve(`${APPROOT}/3p`);
exports.PLUGINSDIR = path.resolve(`${APPROOT}/plugins`);
exports.DBDIR = path.resolve(`${BACKEND_ROOT}/db/sqlite`);
exports.MIGRATIONSDIR = path.resolve(`${BACKEND_ROOT}/db/migrations`);
exports.CMSDIR = path.resolve(`${BACKEND_ROOT}/cms`);

exports.DEFAULT_ORG = "_org_teleworkr_defaultorg_";
exports.DEFAULT_ID = "_default_";

exports.ROLES = {ADMIN: "admin", USER: "user", GUEST: "guest"};

exports.CLUSTERCOUNT_KEY = "_teleworkr_cluster_count";

exports.getPlugin = name => require(`${exports.LIBDIR}/pluginhandler.js`).getPlugin(name);

exports.TELEWORKREVENT = "__org_monkshu_teleworkr_event";
exports.EVENTS = Object.freeze({USER_JOINED: "user_joined", USER_LEFT: "user_left",
    SESSION_STARTED: "session_started", SESSION_ENDED: "session_ended", NOTIFICATION: "notification"});
