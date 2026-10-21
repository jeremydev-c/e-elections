import mongoose from "mongoose";

/**
 * Cached Mongoose connection.
 *
 * In development, Next.js hot-reloads modules, which would open a new
 * connection on every file save. We keep the connection on `globalThis`
 * so it survives reloads and is reused across API requests.
 */

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

const globalForMongoose = globalThis as unknown as {
  _mongoose?: MongooseCache;
};

const cache: MongooseCache =
  globalForMongoose._mongoose ?? (globalForMongoose._mongoose = { conn: null, promise: null });

export async function connectDB(): Promise<typeof mongoose> {
  if (cache.conn) return cache.conn;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set. Add it to .env.local (see .env.example).");
  }

  if (!cache.promise) {
    cache.promise = mongoose.connect(uri, {
      bufferCommands: false,
      serverSelectionTimeoutMS: 10_000,
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
