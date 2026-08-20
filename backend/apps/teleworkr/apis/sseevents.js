/**
 * Streams Teleworkr events to the frontend over SSE.
 *
 * (C) 2026 Tekmonks Corp. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const blackboard = require(`${CONSTANTS.LIBDIR}/blackboard.js`);

const EVENTS_KEY = "__org_monkshu_teleworkr_sseevents_key", MEM_TO_USE = CLUSTER_MEMORY,
    TW_EVENT_NAME = "teleworkrevent";

exports.initSync = _ => blackboard.subscribe(TELEWORKR_CONSTANTS.TELEWORKREVENT, message => {
    if (!message?.id) return;   // we can't route an event without knowing whom it is for

    const usermemory = _getUserMemory(message.id, message.org);
    if (!usermemory.events) usermemory.events = {};
    usermemory.events[message.type] = [...(usermemory.events[message.type]||[]), message];
    _setUserMemory(message.id, message.org, usermemory);
});

exports.doSSE = async (jsonReq, sseEventSender) => {
    const usermemory = _getUserMemory(jsonReq.id, jsonReq.org);
    if (usermemory) sseEventSender({event: TW_EVENT_NAME, id: Date.now(), data: {events: (usermemory.events||{})}});
}

const _setUserMemory = (id, org, usermemory) => { const memory = MEM_TO_USE.get(EVENTS_KEY, {});
    memory[_getmemkey(id, org)] = usermemory; MEM_TO_USE.set(EVENTS_KEY, memory); }
const _getUserMemory = (id, org) => { const memory = MEM_TO_USE.get(EVENTS_KEY, {});
    if (!memory[_getmemkey(id, org)]) memory[_getmemkey(id, org)] = {}; return memory[_getmemkey(id, org)]; }
const _getmemkey = (id, org) => `${id}_${org}`;
