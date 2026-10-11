import type { Kysely, Transaction } from "kysely"

/**
 * Runs `fn` in a transaction, or in the caller's transaction if `db` already is one (Kysely
 * doesn't nest transactions).
 */
export async function inTransaction<DB, T>(
	db: Kysely<DB>,
	fn: (trx: Kysely<DB> | Transaction<DB>) => Promise<T>
): Promise<T> {
	if (db.isTransaction) return fn(db)
	return db.transaction().execute(fn)
}
