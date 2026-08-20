/**
 * Processes and informs about Teleworkr events.
 *
 * (C) 2026 Tekmonks Corp. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const blackboard = require(`${CONSTANTS.LIBDIR}/blackboard.js`);

const EVENTS_KEY = "__org_monkshu_teleworkr_events_key", MEM_TO_USE = CLUSTER_MEMORY;

exports.initSync = _ => blackboard.subscribe(TELEWORKR_CONSTANTS.TELEWORKREVENT, message => {
    if (!message?.id) return;   // we can't route an event without knowing whom it is for

    const usermemory = _getUserMemory(message.id, message.org);
    if (!usermemory.events) usermemory.events = {};
    usermemory.events[message.type] = [...(usermemory.events[message.type]||[]), message];
    _setUserMemory(message.id, message.org, usermemory);
});

exports.doService = async jsonReq => {
    if (!validateRequest(jsonReq)) {LOG.error("Validation failure."); return CONSTANTS.FALSE_RESULT;}

    const usermemory = _getUserMemory(jsonReq.id, jsonReq.org);
    return {events: (usermemory.events||{}), ...CONSTANTS.TRUE_RESULT};
}

/** Broadcasts an event to all the cluster members */
exports.publish = (type, id, org, data={}) => blackboard.publish(TELEWORKR_CONSTANTS.TELEWORKREVENT,
    {type, id, org, timestamp: Date.now(), ...data});

const _setUserMemory = (id, org, usermemory) => { const memory = MEM_TO_USE.get(EVENTS_KEY, {});
    memory[_getmemkey(id, org)] = usermemory; MEM_TO_USE.set(EVENTS_KEY, memory); }
const _getUserMemory = (id, org) => { const memory = MEM_TO_USE.get(EVENTS_KEY, {});
    if (!memory[_getmemkey(id, org)]) memory[_getmemkey(id, org)] = {}; return memory[_getmemkey(id, org)]; }
const _getmemkey = (id, org) => `${id}_${org}`;

const validateRequest = jsonReq => (jsonReq && jsonReq.id && jsonReq.org);
