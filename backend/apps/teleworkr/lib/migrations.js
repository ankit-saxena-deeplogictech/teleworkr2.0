/**
 * Schema migrations for the Teleworkr app.
 *
 * The Monkshu SQLite driver runs its creation DDL only when the database file
 * does not yet exist, so an already-deployed database never sees a schema
 * change. The A6 spine needs schema that evolves — effective-dated records,
 * append-only ledgers, versioned pointers — so migrations are applied here
 * instead, in filename order, exactly once, inside a transaction.
 *
 * A migration that has already been applied is never re-run and never edited.
 * If its content changes on disk the checksum stops matching and startup fails
 * loudly, for the same reason A6 says a version is a pointer and not an edit:
 * rewriting applied history makes every record that pinned it a fiction.
 *
 * (C) 2026 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MIGRATION_TABLE_DDL = "CREATE TABLE IF NOT EXISTS schema_migration(filename varchar not null primary key, checksum varchar not null, applied_at integer not null)";

/**
 * Applies every migration in the given directory that has not been applied yet.
 * @param {object} db A Monkshu DB driver, from db.js getDBDriver
 * @param {string} migrationsDir Directory holding the NNN_name.sql files
 * @returns {object} {applied: [filenames], skipped: count}
 * @throws If a migration fails, or if an applied migration's content has changed
 */
exports.migrateAsync = async function(db, migrationsDir) {
    if (!await db.runCmd(MIGRATION_TABLE_DDL, []))
        throw new Error("Migration bookkeeping table could not be created.");

    const appliedRows = await db.getQuery("SELECT filename, checksum FROM schema_migration", []);
    if (appliedRows === false) throw new Error("Could not read the applied migration list.");
    const applied = {}; for (const row of appliedRows) applied[row.filename] = row.checksum;

    const files = fs.existsSync(migrationsDir) ?
        fs.readdirSync(migrationsDir).filter(f => f.toLowerCase().endsWith(".sql")).sort() : [];

    const ranNow = []; let skipped = 0;
    for (const filename of files) {
        const sql = fs.readFileSync(path.resolve(migrationsDir, filename), "utf8");
        const checksum = crypto.createHash("sha256").update(sql).digest("hex");

        if (applied[filename]) {    // already applied - it must not have changed since
            if (applied[filename] != checksum) throw new Error(
                `Migration ${filename} has changed since it was applied. Applied migrations are immutable — add a new migration instead of editing this one.`);
            skipped++; continue;
        }

        const statements = exports.splitStatements(sql);
        if (!statements.length) {LOG.warn(`Migration ${filename} contains no statements, recording it as applied.`);}

        const cmdObjs = [...statements.map(cmd => ({cmd, params: []})),
            {cmd: "INSERT INTO schema_migration (filename, checksum, applied_at) VALUES (?,?,?)",
                params: [filename, checksum, Math.floor(Date.now()/1000)]}];

        if (!await db.runTransaction(cmdObjs)) throw new Error(
            `Migration ${filename} failed and was rolled back. The database is unchanged; see the log for the failing statement.`);

        LOG.info(`Applied migration ${filename} (${statements.length} statements).`);
        ranNow.push(filename);
    }

    if (ranNow.length) LOG.info(`Schema is up to date, applied ${ranNow.length} new migration(s).`);
    return {applied: ranNow, skipped};
}

/**
 * Splits a migration file into individual statements. The SQLite driver runs one
 * statement per call, so this strips comments and splits on semicolons that are
 * not inside a string literal.
 * @param {string} sql The migration file contents
 * @returns {array} The statements, trimmed, with empties removed
 */
exports.splitStatements = function(sql) {
    const statements = []; let current = "", inString = false;

    const withoutComments = sql.split("\n").map(line => {   // strip -- comments, but not inside a string
        let out = "", quoted = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch == "'") quoted = !quoted;
            if (!quoted && ch == "-" && line[i+1] == "-") break;    // rest of the line is a comment
            out += ch;
        }
        return out;
    }).join("\n");

    for (let i = 0; i < withoutComments.length; i++) {
        const ch = withoutComments[i];
        if (ch == "'") inString = !inString;
        if (ch == ";" && !inString) {statements.push(current); current = ""; continue;}
        current += ch;
    }
    statements.push(current);

    return statements.map(s => s.trim()).filter(s => s.length);
}
