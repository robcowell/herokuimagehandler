// server.js
// Dynamic Image Service — Heroku + Salesforce AppLink
//
// Features:
// - GET /img/<key>?w=&h=&fit=&fmt=&q=&signature=&expires=  -> on-the-fly transform from S3
// - GET /image-url?key=&w=&h=&fit=&fmt=&q=                 -> returns a signed, cacheable URL
// - POST /sign-upload { key }                              -> S3 pre-signed POST for direct browser uploads
// - GET /health                                            -> liveness
//
// Env vars (set via `heroku config:set`):
//   S3_BUCKET, S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//   IMG_SIGNING_SECRET             // HMAC key for URL signing (replaces Secrets Manager)  [Lambda: validateRequestSignature]
//   AUTO_WEBP=Yes|No               // enable WebP negotiation via Accept header             [Lambda: getOutputFormat]
//   CORS_ENABLED=Yes|No, CORS_ORIGIN=https://your.sf.site    // CORS headers                [Lambda: getResponseHeaders]
//   BASE_PUBLIC_URL=https://img.example.com  // optional, used by /image-url
//
// Notes:
// - Signature stringToSign = path + "?" + rawQueryString(sorted, excluding `signature`).
// - `expires` is optional. If present, must be UTC in YYYYMMDDTHHmmssZ and not in the past.
// - Cache headers are long-lived for deterministic transform URLs.

const express = require("express");
const crypto = require("crypto");
const sharp = require("sharp");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { createPresignedPost } = require("@aws-sdk/s3-presigned-post");
const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
dayjs.extend(utc);

const app = express();
app.use(express.json());

const {
  S3_BUCKET,
  S3_REGION,
  IMG_SIGNING_SECRET,
  AUTO_WEBP = "No",
  CORS_ENABLED = "No",
  CORS_ORIGIN = "*",
  BASE_PUBLIC_URL = "",
} = process.env;

if (!S3_BUCKET || !S3_REGION || !IMG_SIGNING_SECRET) {
  console.error("Missing required env vars: S3_BUCKET, S3_REGION, IMG_SIGNING_SECRET");
  process.exit(1);
}

const s3 = new S3Client({ region: S3_REGION });

// ---------- Utilities ----------
function corsHeaders(isError = false) {
  // Mirrors Lambda's getResponseHeaders with CORS toggles. :contentReference[oaicite:1]{index=1}
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
  };
  if (CORS_ENABLED === "Yes") headers["Access-Control-Allow-Origin"] = CORS_ORIGIN;
  if (isError) headers["Content-Type"] = "application/json";
  return headers;
}

function errorBody(status, code, message) {
  return JSON.stringify({ status, code, message });
}

function buildQueryStringWithoutSignature(qsObj) {
  // Same canonicalization as Lambda: sort entries, drop `signature`. :contentReference[oaicite:2]{index=2}
  return Object.entries(qsObj || {})
    .filter(([k]) => k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function verifySignature(reqPath, query) {
  const canonicalQS = buildQueryStringWithoutSignature(query);
  const toSign = canonicalQS ? `${reqPath}?${canonicalQS}` : reqPath;
  const expected = crypto.createHmac("sha256", IMG_SIGNING_SECRET).update(toSign).digest("hex");
  return expected;
}

function checkExpiry(expiresStr) {
  // Matches Lambda’s format & semantics for `expires`. :contentReference[oaicite:3]{index=3}
  if (expiresStr == null) return; // optional
  const expiry = dayjs.utc(expiresStr, "YYYYMMDDTHHmmss[Z]", true);
  if (!expiry.isValid()) {
    const msg = "Invalid expires; must be YYYYMMDDTHHmmssZ (e.g., 19700102T120304Z).";
    throw { status: 400, code: "ImageRequestExpiryFormat", message: msg };
  }
  if (dayjs.utc().isAfter(expiry)) {
    throw { status: 403, code: "ImageRequestExpired", message: "Request has expired." };
  }
}

function negotiateOutputFormat(req, explicitFmt) {
  // Mirrors Lambda’s AUTO_WEBP logic when no explicit format is provided. :contentReference[oaicite:4]{index=4}
  if (explicitFmt) return explicitFmt;
  if (AUTO_WEBP === "Yes") {
    const accept = req.headers["accept"] || "";
    if (accept.includes("image/webp")) return "webp";
  }
  return null; // let Sharp keep original
}

function clampInt(val, min, max) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return undefined;
  return Math.min(Math.max(n, min), max);
}

function setCacheHeaders(res) {
  // Long-lived for content-addressed transform URLs
  res.set("Cache-Control", "public, max-age=31536000, immutable");
}

// ---------- Core: transform ----------
async function transformFromS3({ key, w, h, fit, fmt, q }, req, res) {
  // Fetch object stream
  const getCmd = new GetObjectCommand({ Bucket: S3_BUCKET, Key: key });
  const s3Resp = await s3.send(getCmd);
  const readStream = s3Resp.Body; // stream

  // Build Sharp pipeline
  let img = sharp();
  readStream.pipe(img);

  const resize = {};
  if (w) resize.width = clampInt(w, 1, 4096);
  if (h) resize.height = clampInt(h, 1, 4096);
  if (fit) resize.fit = fit; // cover|contain|fill|inside|outside

  if (resize.width || resize.height) {
    img = img.resize(resize);
  }

  const quality = q ? clampInt(q, 1, 100) : undefined;
  const negotiatedFmt = negotiateOutputFormat(req, fmt);
  if (negotiatedFmt === "webp") img = img.webp(quality ? { quality } : {});
  else if (negotiatedFmt === "avif") img = img.avif(quality ? { quality } : {});
  else if (negotiatedFmt === "jpeg" || negotiatedFmt === "jpg") img = img.jpeg(quality ? { quality } : {});
  else if (negotiatedFmt === "png") img = img.png(); // png ignores `quality` in sharp

  // Stream to response
  setCacheHeaders(res);
  if (negotiatedFmt) res.type(negotiatedFmt);
  else if (s3Resp.ContentType) res.type(s3Resp.ContentType);

  // Important for Heroku 30s first-byte window: start piping immediately.
  img.on("error", (e) => {
    console.error("Sharp pipeline error:", e);
    if (!res.headersSent) res.set(corsHeaders(true));
    res.status(500).send(errorBody(500, "InternalError", "Image processing failed."));
  });
  img.pipe(res);
}

// ---------- Routes ----------
app.options("*", (req, res) => {
  res.set(corsHeaders(false));
  res.status(204).send("");
});

app.get("/health", (req, res) => {
  res.set(corsHeaders(false));
  res.status(200).send("ok");
});

// GET /img/<key> transform
app.get("/img/*", async (req, res) => {
  try {
    res.set(corsHeaders(false));
    // Validate signature & expiry (if provided)
    const provided = req.query.signature;
    if (!provided) {
      return res
        .status(400)
        .json({ status: 400, code: "AuthorizationQueryParametersError", message: "Missing signature query param." }); // :contentReference[oaicite:5]{index=5}
    }
    checkExpiry(req.query.expires); // may throw
    const expected = verifySignature(req.path, req.query);
    if (provided !== expected) {
      return res.status(403).json({ status: 403, code: "SignatureDoesNotMatch", message: "Signature does not match." }); // :contentReference[oaicite:6]{index=6}
    }

    // Extract key from wildcard (preserve slashes after /img/)
    const key = req.params[0];
    if (!key) return res.status(400).json({ status: 400, code: "MissingKey", message: "No S3 key in path." });

    await transformFromS3(
      {
        key,
        w: req.query.w,
        h: req.query.h,
        fit: req.query.fit,
        fmt: req.query.fmt,
        q: req.query.q,
      },
      req,
      res
    );
  } catch (err) {
    console.error("Transform error:", err);
    const status = err.status || 500;
    res.set(corsHeaders(true));
    res.status(status).send(errorBody(status, err.code || "InternalError", err.message || "Unexpected error."));
  }
});

// GET /image-url -> returns signed transform URL to use in <img src="">
app.get("/image-url", (req, res) => {
  try {
    res.set(corsHeaders(false));

    const { key, w, h, fit, fmt, q, expires } = req.query;
    if (!key) return res.status(400).json({ error: "`key` is required" });

    const params = new URLSearchParams();
    if (w) params.set("w", w);
    if (h) params.set("h", h);
    if (fit) params.set("fit", fit);
    if (fmt) params.set("fmt", fmt);
    if (q) params.set("q", q);
    if (expires) {
      // Validate format now so callers get immediate feedback
      checkExpiry(expires); // may throw
      params.set("expires", expires);
    }

    const path = `/img/${key}`;
    const canonical = params.toString();
    const toSign = canonical ? `${path}?${canonical}` : path;
    const sig = crypto.createHmac("sha256", IMG_SIGNING_SECRET).update(toSign).digest("hex"); // :contentReference[oaicite:7]{index=7}
    params.set("signature", sig);

    const base = BASE_PUBLIC_URL || "";
    const url = `${base}${path}?${params.toString()}`;

    res.json({ url });
  } catch (err) {
    const status = err.status || 500;
    res.set(corsHeaders(true));
    res.status(status).send(errorBody(status, err.code || "InternalError", err.message || "Unexpected error."));
  }
});

// POST /sign-upload -> { key }  -> S3 pre-signed POST (browser direct upload)
app.post("/sign-upload", async (req, res) => {
  try {
    res.set(corsHeaders(false));
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: "`key` is required" });

    // Allow 15 minutes to upload
    const { url, fields } = await createPresignedPost(s3, {
      Bucket: S3_BUCKET,
      Key: key,
      Expires: 900,
      Conditions: [
        ["content-length-range", 0, 25 * 1024 * 1024], // 25 MB default; tune as needed
      ],
    });

    res.json({ url, fields });
  } catch (err) {
    console.error("sign-upload error:", err);
    res.set(corsHeaders(true));
    res.status(500).send(errorBody(500, "PresignError", "Could not create presigned POST"));
  }
});

// Root helper (optional)
app.get("/", (req, res) => {
  res.set(corsHeaders(false));
  res.status(200).send("Dynamic Image Service ready");
});

// ---------- Start ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Image service listening on :${PORT}`);
});
