/**
 * Teleworkr API client - the framework's apimanager with array request values made GET-safe.
 * The framework's GET encoder cannot carry an array (it keeps one element, and the server's query
 * decoder keeps one value per key anyway). The decoder JSON.parses every value though, so we send
 * each array as a single JSON string and the backend sees a real array again.
 * (C) 2026 TekMonks. All rights reserved.
 */

import {apimanager as frameworkApiman} from "/framework/js/apimanager.mjs";

const _arraysAsJSON = req => req && typeof req == "object" && !Array.isArray(req) ?
    Object.fromEntries(Object.entries(req).map(([key, val]) => [key, Array.isArray(val) ? JSON.stringify(val) : val])) : req;

const apiman = {...frameworkApiman, 
    rest: (urlOrOptions, type, req, ...rest) => frameworkApiman.rest(urlOrOptions, type, _arraysAsJSON(req), ...rest)};

export {apiman};
