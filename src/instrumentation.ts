/** Runs once when the server starts: load and warm up the face engine in the background. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { warmUpFaceEngine } = await import("./lib/faceEngine");
    warmUpFaceEngine().catch((err) => console.error("Face engine warm-up failed:", (err as Error).message));
  }
}
