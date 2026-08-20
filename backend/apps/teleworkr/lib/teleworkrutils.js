/**
 * Utility functions for the Teleworkr app.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const DEFAULT_MAX_PATH_LENGTH = 50;

/** @return a path friendly version of the given string, e.g. an org or user id */
exports.convertToPathFriendlyString = function(s, maxPathLength=DEFAULT_MAX_PATH_LENGTH) {
    let tentativeFilepath = encodeURIComponent(s);
    if (tentativeFilepath.endsWith(".")) tentativeFilepath = tentativeFilepath.substring(0, tentativeFilepath.length-1) + "%2E";

    if (tentativeFilepath.length > maxPathLength) {
        tentativeFilepath = tentativeFilepath + "." + Date.now();
        tentativeFilepath = tentativeFilepath.substring(tentativeFilepath.length-maxPathLength);
    }

    return tentativeFilepath;
}

/** @return a shallow copy of the object with the given keys removed */
exports.stripKeys = function(object, keys=[]) {
    const clone = {...object}; for (const key of keys) delete clone[key]; return clone;
}
