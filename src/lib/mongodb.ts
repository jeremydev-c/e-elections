import mongoose, { type ClientSession } from "mongoose";

/**
 * Cached Mongoose connection.
 *
 * In development, Next.js hot-reloads modules, which would open a new
 * connection on every file save. We keep the connection on `globalThis`
 * so it survives reloads and is reused across API requests. A small pool
 * keeps us well inside the MongoDB Atlas free-tier connection limit.
 */

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  transactions?: boolean;
};

const globalForMongoose = globalThis as unknown as {
  _mongoose?: MongooseCache;
};

const cache: MongooseCache =
  globalForMongoose._mongoose ?? (globalForMongoose._mongoose = { conn: null, promise: null });

export async function connectDB(): Promise<typeof mongoose> {
  if (cache.conn && mongoose.connection.readyState === 1) return cache.conn;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set. Add it to .env.local (see .env.example).");
  }

  if (!cache.promise) {
    mongoose.set("strictQuery", true);
    cache.promise = mongoose.connect(uri, {
      // Optional override, e.g. MONGODB_DB=e_elections_test for a throwaway demo database.
      ...(process.env.MONGODB_DB && { dbName: process.env.MONGODB_DB }),
      bufferCommands: false,
      serverSelectionTimeoutMS: 10_000,
      maxPoolSize: 10,
      minPoolSize: 0,
      maxIdleTimeMS: 60_000,
    });
  }

  try {
    cache.conn = await cache.promise;
  } catch (err) {
    cache.promise = null; // allow a retry on the next request
    throw err;
  }

  return cache.conn;
}

/**
 * Runs `fn` inside a multi-document ACID transaction (MongoDB Atlas is a
 * replica set, so this is the normal path). If the server is a standalone
 * local mongod that cannot do transactions, `fn` runs without a session;
 * callers must then rely on their own atomic guards (which ours do).
 */
export async function withTransaction<T>(fn: (session?: ClientSession) => Promise<T>): Promise<T> {
  const conn = await connectDB();
  if (cache.transactions === false) return fn(undefined);

  try {
    const result = await conn.connection.transaction((session) => fn(session));
    cache.transactions = true;
    return result;
  } catch (err) {
    const e = err as { code?: number; message?: string };
    const unsupported =
      e.code === 20 || /Transaction numbers are only allowed|replica set/i.test(e.message ?? "");
    if (!unsupported) throw err;
    cache.transactions = false;
    console.warn("MongoDB transactions unavailable (standalone server); using atomic single-document guards.");
    return fn(undefined);
  }
}
