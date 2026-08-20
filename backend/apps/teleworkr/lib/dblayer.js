/**
 * Database layer for the Teleworkr app.
 *
 * Owns the driver handle and the migration bootstrap. Entity access lives in the
 * module that owns the entity — spine.js for org, person and employment — rather
 * than accumulating here as one growing file of unrelated queries.
 *
 * Every accessor below is routed through a single serial queue. That is what
 * makes transactions atomic by construction: the Monkshu SQLite driver keeps one
 * shared connection per database path per process, and runs transactions as
 * BEGIN/COMMIT/ROLLBACK statements on that connection. Without the queue, any
 * concurrent query in the process interleaves inside an open transaction — and a
 * ROLLBACK triggered by one code path rolls back another path's in-flight work.
 * With every accessor on one queue, a transaction's statements run to completion
 * before anything else touches the connection.
 *
 * The queue is a small promise chain rather than the framework queueExecutor:
 * queueExecutor does not propagate a task's rejection to its caller (the returned
 * promise never settles when the task throws) and it throws outright when disabled
 * in conf. A rejection here is an answer the caller must see — an unlogged ledger
 * write or audit entry is not permitted to happen quietly.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * See enclosed LICENSE file.
 */

const path = require("path");
const migrations = require(`${TELEWORKR_CONSTANTS.LIBDIR}/migrations.js`);

const BOOTSTRAP_SQLS = require(`${TELEWORKR_CONSTANTS.DBDIR}/bootstrap_dbschema.json`);
const DB_PATH = (TELEWORKR_CONSTANTS.CONF.db_server_host||"") +
    path.resolve(`${TELEWORKR_CONSTANTS.DBDIR}/teleworkr.db`).replaceAll(path.sep, path.posix.sep);
const db = require(`${CONSTANTS.LIBDIR}/db.js`).getDBDriver("sqlite", DB_PATH, BOOTSTRAP_SQLS);

let readyPromise = null;    // memoised, so the schema is brought up exactly once per process

/**
 * Opens the database and brings the schema up to date.
 *
 * Unlike the reference app this does not swallow its errors. A database whose
 * schema did not migrate cannot serve the A6 spine, and every read after that
 * point would answer from a shape that does not match the code.
 *
 * Memoised, and awaited by every accessor below. The app entry point is a
 * synchronous initSync, so it can only start this work and not wait for it —
 * which means without the wait below, the first query can and does overtake the
 * migration. Ordering discipline would not survive contact with new call sites,
 * so readiness is enforced at the accessor rather than assumed at the caller.
 *
 * @throws If the database cannot be opened or a migration fails
 */
exports.initDBAsync = function() {
    if (readyPromise) return readyPromise;
    readyPromise = (async _ => {
        await db.init();
        const result = await migrations.migrateAsync(db, TELEWORKR_CONSTANTS.MIGRATIONSDIR);
        LOG.info(`Teleworkr schema ready — ${result.applied.length} applied now, ${result.skipped} already in place.`);
        return result;
    })();
    readyPromise.catch(_ => {});    // the rejection is delivered to whoever awaits it, not to the process
    return readyPromise;
}

/** Resolves once the schema is in place. Every accessor below waits on it. */
exports.readyAsync = _ => exports.initDBAsync();

// ---------------------------------------------------------------------------
// the serial queue
// ---------------------------------------------------------------------------

let _queueTail = Promise.resolve();

/**
 * Runs a task on the serial queue. The task's rejection reaches the caller; the
 * queue itself survives it, so one failed write never strands the ones behind it.
 * @param {function} task The task to run
 * @returns The task's result, or its rejection
 */
const _enqueue = task => {
    const run = _queueTail.then(task);
    _queueTail = run.catch(_ => {});
    return run;
}

/** Enqueues a task once the schema is in place. */
const _enqueueReady = async task => {await exports.readyAsync(); return await _enqueue(task);}

// ---------------------------------------------------------------------------
// accessors — every one of them through the queue
// ---------------------------------------------------------------------------

/**
 * Runs a command and throws on failure. The Monkshu driver returns false rather
 * than throwing, which is safe to ignore for a cache write and never safe to
 * ignore for a ledger or an audit entry.
 * @param {string} cmd The SQL to run
 * @param {array} params The parameters
 * @throws If the command failed
 */
exports.runCmdOrThrow = (cmd, params=[]) => _enqueueReady(async _ => {
    if (!await db.runCmd(cmd, params)) throw new Error(`Database write failed: ${cmd}`);
    return true;
})

/**
 * Runs a command without throwing, for writes whose failure is acceptable as
 * long as it is visible: cache stamps, telemetry, test cleanup. Returns false on
 * failure rather than raising, because a best-effort write must never take down
 * the decision it follows.
 * @param {string} cmd The SQL to run
 * @param {array} params The parameters
 * @returns true on success, false on failure
 */
exports.runCmdBestEffortAsync = (cmd, params=[]) => _enqueueReady(async _ => await db.runCmd(cmd, params));

/**
 * Runs a query and throws on failure, so that a driver error is never mistaken
 * for an empty result. The two are different answers and only one is safe.
 * @param {string} cmd The SQL to run
 * @param {array} params The parameters
 * @returns The rows, possibly empty
 * @throws If the query failed
 */
exports.getQueryOrThrow = (cmd, params=[]) => _enqueueReady(async _ => {
    const rows = await db.getQuery(cmd, params);
    if (rows === false) throw new Error(`Database query failed: ${cmd}`);
    return rows;
})

/**
 * Runs a sequence of commands as one transaction, and throws on failure.
 * @param {array} cmdObjs Array of {cmd, params}
 * @throws If the transaction failed and was rolled back
 */
exports.runTransactionOrThrow = function(cmdObjs) {
    return exports.runInTransactionAsync(async exec => {
        for (const cmdObj of cmdObjs) await exec.runCmd(cmdObj.cmd, cmdObj.params);
    });
}

/**
 * Runs a function inside a transaction on the serial queue.
 *
 * The function is the whole queued task, so nothing else in the process can touch
 * the connection between BEGIN and COMMIT. A throw rolls the transaction back and
 * the rejection reaches the caller; the queue survives it.
 *
 * Inside the function, every database access must go through the supplied exec —
 * calling a dblayer accessor in there enqueues a task behind the one currently
 * holding the queue, which is a self-deadlock and also wrong.
 *
 * @param {function} fn async (exec) => result, where exec has runCmd and getQuery,
 *      both throwing on failure
 * @returns Whatever fn returned, after the transaction committed
 * @throws If the transaction failed and was rolled back
 */
exports.runInTransactionAsync = async function(fn) {
    await exports.readyAsync();
    return await _enqueue(async _ => {
        if (!await db.runCmd("BEGIN TRANSACTION", [])) throw new Error("Could not begin the database transaction.");
        const exec = {
            runCmd: async (cmd, params=[]) => {
                if (!await db.runCmd(cmd, params)) throw new Error(`Database write failed inside a transaction: ${cmd}`);
            },
            getQuery: async (cmd, params=[]) => {
                const rows = await db.getQuery(cmd, params);
                if (rows === false) throw new Error(`Database query failed inside a transaction: ${cmd}`);
                return rows;
            }
        };
        try {
            const result = await fn(exec);
            if (!await db.runCmd("COMMIT", [])) throw new Error("Could not commit the database transaction.");
            return result;
        } catch (err) {
            try {await db.runCmd("ROLLBACK", []);}
            catch (rollbackErr) {LOG.error(`Rollback after a failed transaction also failed: ${rollbackErr}`);}
            throw err;
        }
    });
}
