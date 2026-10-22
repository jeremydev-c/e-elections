import {
  CreateCollectionCommand,
  CreateFaceLivenessSessionCommand,
  DeleteFacesCommand,
  GetFaceLivenessSessionResultsCommand,
  IndexFacesCommand,
  RekognitionClient,
  SearchFacesByImageCommand,
} from "@aws-sdk/client-rekognition";
import { GetFederationTokenCommand, STSClient } from "@aws-sdk/client-sts";
import type { JWTPayload } from "jose";
import { signToken, verifyToken } from "@/lib/session";

/**
 * Face recognition through AWS Rekognition, used while our own in-browser
 * engine is being improved (switch with NEXT_PUBLIC_FACE_PROVIDER=aws).
 *
 *  - Liveness: AWS Face Liveness. The browser streams a short video to AWS,
 *    which returns a confidence that a real person was present and a
 *    reference image taken during the check.
 *  - Matching: that reference image is searched in a Rekognition collection
 *    that holds one face per voter. AWS stores face vectors, not photos, and
 *    only the voter's database id (never a name or National ID) goes with it.
 */

export const FACE_PROVIDER = process.env.NEXT_PUBLIC_FACE_PROVIDER === "aws" ? "aws" : "local";
export const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const COLLECTION_ID = process.env.AWS_REKOGNITION_COLLECTION || "e-elections-voters";

/** Minimum AWS liveness confidence (0-100) to accept a person as live. */
export const LIVENESS_MIN_CONFIDENCE = 85;
/** Minimum similarity (0-100) for a face to count as the same person. */
export const FACE_SIMILARITY_MIN = 95;
/** Any other voter at or above this similarity blocks a login or registration. */
export const RIVAL_SIMILARITY = 90;

const SESSION_TTL = 180; // AWS keeps liveness results for 3 minutes

const globalForAws = globalThis as unknown as {
  _rekognition?: RekognitionClient;
  _sts?: STSClient;
  _collectionReady?: Promise<void>;
  _usedLivenessSessions?: Map<string, number>;
};

function rekognition() {
  return (globalForAws._rekognition ??= new RekognitionClient({ region: AWS_REGION }));
}

function sts() {
  return (globalForAws._sts ??= new STSClient({ region: AWS_REGION }));
}

export function awsConfigured() {
  return !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);
}

/** Creates the voters' face collection the first time it is needed. */
function ensureCollection() {
  return (globalForAws._collectionReady ??= rekognition()
    .send(new CreateCollectionCommand({ CollectionId: COLLECTION_ID }))
    .then(() => undefined)
    .catch((err: Error) => {
      if (err.name === "ResourceAlreadyExistsException") return;
      globalForAws._collectionReady = undefined;
      throw err;
    }));
}

/* ---------------------------------------------------------------- liveness */

export type LivenessPurpose = "login" | "enroll";
type SessionPayload = JWTPayload & { kind: "aws-liveness"; sessionId: string; purpose: LivenessPurpose; subject: string };

/**
 * Starts an AWS Face Liveness session for one voter login (subject = National ID)
 * or one registration (subject = the official's username). Returns the session id,
 * a signed ticket that binds it to that subject, and short-lived browser
 * credentials that can do nothing except stream video to this liveness check.
 */
export async function startLivenessSession(purpose: LivenessPurpose, subject: string) {
  const { SessionId } = await rekognition().send(
    new CreateFaceLivenessSessionCommand({ Settings: { AuditImagesLimit: 0 } })
  );
  if (!SessionId) throw new Error("AWS did not return a liveness session");

  const { Credentials } = await sts().send(
    new GetFederationTokenCommand({
      Name: "eelections-liveness",
      DurationSeconds: 900, // the shortest AWS allows
      Policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "rekognition:StartFaceLivenessSession", Resource: "*" }],
      }),
    })
  );
  if (!Credentials?.AccessKeyId || !Credentials.SecretAccessKey || !Credentials.SessionToken) {
    throw new Error("AWS did not return browser credentials");
  }

  const ticket = await signToken({ kind: "aws-liveness", sessionId: SessionId, purpose, subject }, SESSION_TTL);
  return {
    sessionId: SessionId,
    ticket,
    region: AWS_REGION,
    credentials: {
      accessKeyId: Credentials.AccessKeyId,
      secretAccessKey: Credentials.SecretAccessKey,
      sessionToken: Credentials.SessionToken,
      expiration: Credentials.Expiration?.toISOString(),
    },
  };
}

export type LiveFace = { ok: true; confidence: number; image: Uint8Array } | { ok: false; reason: string };

/**
 * Redeems a liveness ticket (once only, for this purpose and subject) and fetches
 * the AWS result. Succeeds only for a confident live person with a reference image.
 */
export async function redeemLiveFace(ticket: unknown, purpose: LivenessPurpose, subject: string): Promise<LiveFace> {
  if (typeof ticket !== "string") return { ok: false, reason: "Liveness ticket missing" };
  const p = await verifyToken<SessionPayload>(ticket);
  if (!p || p.kind !== "aws-liveness" || p.purpose !== purpose || p.subject !== subject) {
    return { ok: false, reason: "Liveness ticket invalid, expired or for someone else" };
  }

  const used = (globalForAws._usedLivenessSessions ??= new Map());
  const now = Date.now();
  for (const [id, until] of used) if (until < now) used.delete(id);
  if (used.has(p.sessionId)) return { ok: false, reason: "Liveness session already used" };
  used.set(p.sessionId, now + SESSION_TTL * 1000);

  const r = await rekognition().send(new GetFaceLivenessSessionResultsCommand({ SessionId: p.sessionId }));
  if (r.Status !== "SUCCEEDED") return { ok: false, reason: `AWS liveness status ${r.Status}` };
  const confidence = r.Confidence ?? 0;
  if (confidence < LIVENESS_MIN_CONFIDENCE) {
    return { ok: false, reason: `AWS liveness confidence ${confidence.toFixed(1)} below ${LIVENESS_MIN_CONFIDENCE}` };
  }
  const image = r.ReferenceImage?.Bytes;
  if (!image?.length) return { ok: false, reason: "AWS returned no reference image" };
  return { ok: true, confidence, image };
}

/* ---------------------------------------------------------------- matching */

export type FaceMatch = { faceId: string; voterId: string; similarity: number };

/** The registered voters whose faces look like this image (similarity >= RIVAL_SIMILARITY), best first. */
export async function searchFace(image: Uint8Array): Promise<FaceMatch[]> {
  await ensureCollection();
  try {
    const r = await rekognition().send(
      new SearchFacesByImageCommand({
        CollectionId: COLLECTION_ID,
        Image: { Bytes: image },
        MaxFaces: 5,
        FaceMatchThreshold: RIVAL_SIMILARITY,
      })
    );
    return (r.FaceMatches ?? [])
      .filter((m) => m.Face?.FaceId && m.Face.ExternalImageId)
      .map((m) => ({ faceId: m.Face!.FaceId!, voterId: m.Face!.ExternalImageId!, similarity: m.Similarity ?? 0 }))
      .sort((a, b) => b.similarity - a.similarity);
  } catch (err) {
    // An empty collection or a photo with no usable face: nobody matches.
    if ((err as Error).name === "InvalidParameterException") return [];
    throw err;
  }
}

/** Adds one voter's face to the collection, tagged with their database id. Returns the AWS face id. */
export async function enrollFace(image: Uint8Array, voterId: string): Promise<string | null> {
  await ensureCollection();
  const r = await rekognition().send(
    new IndexFacesCommand({
      CollectionId: COLLECTION_ID,
      Image: { Bytes: image },
      ExternalImageId: voterId,
      MaxFaces: 1,
      QualityFilter: "HIGH",
      DetectionAttributes: [],
    })
  );
  return r.FaceRecords?.[0]?.Face?.FaceId ?? null;
}

export async function removeFace(faceId: string) {
  await rekognition().send(new DeleteFacesCommand({ CollectionId: COLLECTION_ID, FaceIds: [faceId] }));
}
