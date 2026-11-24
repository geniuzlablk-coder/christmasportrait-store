/**
 * Christmas Portrait Studio — AI Restyle Worker
 * ============================================================
 * POST /api/restyle — image-to-image Christmas restyle via Gemini.
 *
 * DEPLOYMENT — READ FIRST:
 * The store today is static-only (Workers Static Assets, see
 * wrangler.jsonc: { "assets": { "directory": "./" } } — it has NO
 * "main" entry). Pointing "main" at this file in that same config
 * would REPLACE the static-asset worker and take the store down.
 * Do NOT do that. Deploy this file as a SEPARATE worker instead
 * (recommended, Option A in PREVIEW-STUDIO-ARCHITECTURE.md), or
 * build the combined assets+API worker later (Option B).
 *
 *   Option A (recommended): separate worker, e.g.
 *     wrangler deploy worker.js --name christmasportrait-restyle
 *   then route api.christmasportrait.store -> this worker, and set
 *     wrangler secret put GEMINI_API_KEY
 *   The client snippet posts to the API origin configured in
 *   restyle-client-snippet.js (default "/api/restyle" for Option B).
 *
 * SECRETS:
 * - The Gemini API key comes ONLY from the Workers secret
 *   GEMINI_API_KEY (env binding). It is NEVER hardcoded here,
 *   NEVER accepted from the client, NEVER logged, and NEVER
 *   returned in any response. It is sent only to Google's
 *   generativelanguage.googleapis.com over HTTPS, via the
 *   `x-goog-api-key` header (not a URL query param, so it never
 *   lands in request logs).
 *
 * PRIVACY (also stated in the architecture doc — keep in sync):
 * - An uploaded photo is sent ONLY to the Gemini model API to
 *   perform the restyle. It is never used for model training
 *   (paid-tier API: content is not used to improve Google's
 *   products — see Google's pricing page), never shared with any
 *   other third party, and no face-recognition database or
 *   biometric template is ever built from it.
 * - If the customer does not order, the original and the restyle
 *   are deleted after 7 days. If they order, both are kept only
 *   for fulfilment + a 30-day reprint window, then deleted.
 *   (Enforcement: R2 lifecycle / scheduled purge — see
 *   "RETENTION" notes below. The worker enforces a 30-day max
 *   cache age on read as a backstop.)
 * - One-tap delete: DELETE /api/restyle { "cache_key": "<sha256>" }
 *   removes the cached restyle immediately.
 *
 * WATERMARKING — IMPORTANT:
 * This Worker does NOT watermark. The model output is returned to
 * the browser and the CLIENT draws the diagonal PREVIEW watermark
 * over it and displays it at reduced resolution (max 800 px) —
 * see restyle-client-snippet.js. The paid full-res version is
 * delivered watermark-free after payment + human check.
 *
 * PRICING (verified 2026-11-24, Google's official pricing page
 * https://ai.google.dev/gemini-api/docs/pricing):
 * - Gemini 2.5 Flash Image ("Nano Banana"): $0.039 per image
 *   (1,290 output tokens @ $30/1M), plus text/image input at
 *   $0.30 per 1M tokens. Batch/Flex: $0.0195 per image.
 * - ⚠️ DEPRECATION: Google lists gemini-2.5-flash-image as
 *   deprecated, shutting down 15 March 2027. Its replacement is
 *   Gemini 3.1 Flash Lite Image (gemini-3.1-flash-lite-image),
 *   $0.0336 per 1K image (1,120 tokens), input $0.25/1M.
 *   The model id is a single constant below (MODEL) — swap it
 *   to "gemini-3.1-flash-lite-image" to migrate. Do this well
 *   before March 2027 and re-test face preservation first.
 *
 * GEMINI STATUS — LIVE, 2026-11-24: the studio key is VERIFIED
 * (list-models returns real models incl. gemini-2.5-flash-image),
 * BUT the first image-edit call hit HTTP 429 from the image model:
 * the key is valid, the image endpoint is rate-limited on this key
 * (free-tier quota). That is the binding limit right now — not a
 * code bug. Raising the quota / enabling billing in Google AI
 * Studio lifts it. This worker therefore NEVER retries the model
 * in a loop and never hammers it: on a model 429 it returns 429
 * with the model's Retry-After (or 60s) and a plain message, and
 * the client may retry ONCE manually after the delay. The "queue"
 * is client-side single-flight (one transform at a time) + this
 * Retry-After contract — there is no server-side retry queue,
 * because a stateless Worker cannot queue without a Durable
 * Object (documented as the production upgrade). A model 429
 * does NOT count against the visitor's 5 free transforms.
 *
 * COST MATH: at $0.039/image, MAX_TRANSFORMS_PER_DAY = 200 caps
 * spend at ~$7.80/day worst case (+ tiny input-token cost).
 */

// ------------------------------------------------------------------
// Config — change these, not the logic below.
// ------------------------------------------------------------------

/** Gemini image model. Swap to "gemini-3.1-flash-lite-image" before 15 Mar 2027. */
const MODEL = "gemini-2.5-flash-image";
/** Google AI Studio (Gemini Developer API) endpoint. */
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** Free restyles per visitor (CF-Connecting-IP) per UTC day. */
const FREE_PER_VISITOR_PER_DAY = 5;
/** Hard global cap: paid model calls per UTC day. 429 beyond this. */
const MAX_TRANSFORMS_PER_DAY = 200;
/** Max upload size: 10 MB. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Allowed upload MIME types. */
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Model call timeout. Gemini image edits usually take 5–30 s. */
const MODEL_TIMEOUT_MS = 60_000;
/** Cache: restyles are reusable for 30 days max (read-side backstop). */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Style ids the client may request. "01"–"06" are accepted as aliases. */
const STYLE_IDS = [
  "classic-santa-snow",
  "golden-christmas-movie-poster",
  "cozy-fireplace",
  "snow-globe",
  "colombo-christmas",
  "winter-royal",
];
const STYLE_ALIASES = {
  "01": "classic-santa-snow",
  "02": "golden-christmas-movie-poster",
  "03": "cozy-fireplace",
  "04": "snow-globe",
  "05": "colombo-christmas",
  "06": "winter-royal",
};

// ------------------------------------------------------------------
// Style prompts — THE SAME TEXT is in PREVIEW-STUDIO-ARCHITECTURE.md.
// If you edit a prompt here, copy it to the doc (and vice versa).
// Face-preservation lock + no-text rule are identical in all six.
// ------------------------------------------------------------------

const FACE_LOCK =
  "Edit the attached family photo into a professional Christmas portrait. " +
  "Keep the EXACT same people — same faces, same facial features, same ages, " +
  "same expressions, same number of people, same poses and framing. " +
  "Do not change any face, do not add or remove any person, do not change " +
  "anyone's age. Only change the setting, clothing and lighting to match " +
  "the Christmas style below. Photorealistic, warm, high-end studio " +
  "photography, natural skin tones, sharp focus. " +
  "Do not render any text, letters, words, logos or watermarks in the image.";

const STYLE_PROMPTS = {
  "classic-santa-snow":
    FACE_LOCK +
    " Style: Classic Santa Snow — the family outdoors in gently falling snow at dusk, " +
    "matching deep-red and cream Christmas sweaters, Santa hats that sit naturally on " +
    "each head, soft golden bokeh Christmas lights behind them, snow-dusted pine trees, " +
    "cool blue evening light mixed with warm light on their faces.",
  "golden-christmas-movie-poster":
    FACE_LOCK +
    " Style: Golden Christmas Movie Poster — a cinematic golden-hour Christmas movie " +
    "poster scene: warm amber and gold light, a softly glowing Christmas tree with gold " +
    "ornaments behind them, elegant festive outfits in deep green, gold and cream, " +
    "gentle snowfall, rich cinematic colour grade, dramatic but natural studio lighting.",
  "cozy-fireplace":
    FACE_LOCK +
    " Style: Cozy Fireplace — the family in a cozy living room beside a lit stone " +
    "fireplace with a decorated Christmas tree, warm firelight glow on their faces, " +
    "matching knit Christmas sweaters, stockings hung on the mantel, soft warm amber " +
    "light, intimate and homely.",
  "snow-globe":
    FACE_LOCK +
    " Style: Snow Globe — the family photographed as if inside a giant glass snow globe, " +
    "gentle snowflakes falling around them, a miniature snowy village and pine trees at " +
    "the base of the globe, soft magical glow, dreamy cool light with warm faces.",
  "colombo-christmas":
    FACE_LOCK +
    " Style: Colombo Christmas — a warm tropical Colombo Christmas: a bright airy veranda " +
    "with frangipani and poinsettia, palm leaves and fairy lights, elegant light festive " +
    "outfits in white, gold and deep green, warm Sri Lankan evening light, joyful and sunlit.",
  "winter-royal":
    FACE_LOCK +
    " Style: Winter Royal — an elegant winter-royal portrait: deep forest-green and gold " +
    "setting, velvet and fur-trimmed festive attire, a grand staircase with garlands and " +
    "candles, soft regal window light, luxurious, timeless, editorial portrait photography.",
};

// ------------------------------------------------------------------
// In-memory state (single-isolate only — see production notes).
//
// PRODUCTION UPGRADE: these Maps live in ONE Worker isolate. Under
// real traffic, requests land on many isolates, so per-visitor rate
// limits and the daily cap are approximate here, not exact. The
// production path is:
//   - Per-visitor rate limit -> a Durable Object keyed by IP (or
//     Cloudflare Rate Limiting rules on the route), and
//   - Daily global cap + usage log -> a Durable Object counter (or
//     D1 row), and
//   - Cache -> the R2 binding (RESTYLE_CACHE) below, which IS shared.
// Until then, this simple version is safe because the caps fail
// OPEN per isolate only in the sense that each isolate counts
// separately — worst case is a somewhat higher daily spend, bounded
// by (isolates × cap). Keep MAX_TRANSFORMS_PER_DAY low until the
// Durable Object counter lands.
// ------------------------------------------------------------------

/** cacheKey -> { b64, mime, style, createdAt } — R2 is the production path. */
const memoryCache = new Map();
/** "ip|YYYY-MM-DD" -> count of PAID transforms today (cached hits are free). */
const visitorCounts = new Map();
/** "YYYY-MM-DD" -> count of PAID transforms today (this isolate). */
const dailyCounts = new Map();

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function utcDay() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function errorJson(error, status, extra = {}) {
  // Never include model payloads, keys, or stack traces in errors.
  return json({ error, ...extra }, status);
}

function normalizeStyle(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (STYLE_IDS.includes(s)) return s;
  if (STYLE_ALIASES[s]) return STYLE_ALIASES[s];
  return null;
}

/** SHA-256 hex of image bytes + style id — the idempotency/cache key. */
async function cacheKeyFor(bytes, style) {
  const styleBytes = new TextEncoder().encode(`|${style}`);
  const combined = new Uint8Array(bytes.length + styleBytes.length);
  combined.set(bytes, 0);
  combined.set(styleBytes, bytes.length);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Light magic-byte sniff so a renamed .exe cannot pass as an image. */
function sniffMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

function base64ToBytes(b64) {
  // atob is available in Workers; reject non-base64 input.
  const clean = b64.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) return null;
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/**
 * Parse the request body.
 * Accepts multipart/form-data (fields: image + style) or
 * JSON { image_b64, style, mime_type? }.
 * Returns { bytes, mime, style } or { error, status }.
 */
async function parseInput(request) {
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    let form;
    try {
      form = await request.formData();
    } catch {
      return { error: "bad_request", status: 400 };
    }
    const style = normalizeStyle(form.get("style"));
    if (!style) return { error: "invalid_style", status: 400 };
    const file = form.get("image") || form.get("photo") || form.get("file");
    if (!file || typeof file === "string" || !file.arrayBuffer) {
      return { error: "missing_image", status: 400 };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return validateBytes(bytes, file.type || "", style);
  }

  if (contentType.includes("application/json")) {
    let body;
    try {
      body = await request.json();
    } catch {
      return { error: "bad_request", status: 400 };
    }
    const style = normalizeStyle(body && body.style);
    if (!style) return { error: "invalid_style", status: 400 };
    if (!body || typeof body.image_b64 !== "string" || !body.image_b64) {
      return { error: "missing_image", status: 400 };
    }
    // Reject absurd payloads before decoding: base64 inflates ~4/3.
    if (body.image_b64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16) {
      return { error: "image_too_large", status: 413 };
    }
    const bytes = base64ToBytes(body.image_b64);
    if (!bytes) return { error: "invalid_image", status: 400 };
    return validateBytes(bytes, body.mime_type || "", style);
  }

  return { error: "unsupported_media_type", status: 415 };
}

function validateBytes(bytes, declaredMime, style) {
  if (bytes.length === 0) return { error: "missing_image", status: 400 };
  if (bytes.length > MAX_IMAGE_BYTES) return { error: "image_too_large", status: 413 };
  const sniffed = sniffMime(bytes);
  const mime = sniffed || (ALLOWED_MIME.has(declaredMime) ? declaredMime : null);
  if (!mime || !ALLOWED_MIME.has(mime)) return { error: "invalid_image", status: 400 };
  return { bytes, mime, style };
}

// ------------------------------------------------------------------
// Cache (R2 if bound, otherwise in-memory Map).
//
// R2 binding (wrangler): [[r2_buckets]] binding = "RESTYLE_CACHE"
//   bucket_name = "christmasportrait-restyles"
// Object key: `restyles/<cacheKey>.png` (model output bytes).
// RETENTION: entries carry customMetadata { style, createdAt }.
// A nightly Cron Trigger (not yet built) should delete objects
// older than 7 days with no matching order, and older than 30 days
// otherwise. Until it exists, the worker refuses to serve entries
// older than CACHE_MAX_AGE_MS (30 days) and the doc records the
// purge job as an open item. Do NOT promise deletion in the UI
// beyond what this worker + the purge job actually do.
// ------------------------------------------------------------------

function r2Key(cacheKey) {
  return `restyles/${cacheKey}.bin`;
}

async function cacheGet(env, cacheKey) {
  if (env.RESTYLE_CACHE) {
    try {
      const obj = await env.RESTYLE_CACHE.get(r2Key(cacheKey));
      if (!obj) return null;
      const createdAt = Number(obj.customMetadata?.createdAt || 0);
      if (createdAt && Date.now() - createdAt > CACHE_MAX_AGE_MS) return null;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      return {
        b64: bytesToBase64(bytes),
        mime: obj.customMetadata?.mime || "image/png",
        style: obj.customMetadata?.style || "",
        createdAt,
      };
    } catch (e) {
      console.log("restyle cache_get r2_error", e && e.message ? e.message : "unknown");
      return null; // Cache failure must never fail the request.
    }
  }
  const hit = memoryCache.get(cacheKey);
  if (!hit) return null;
  if (Date.now() - hit.createdAt > CACHE_MAX_AGE_MS) {
    memoryCache.delete(cacheKey);
    return null;
  }
  return hit;
}

async function cachePut(env, cacheKey, b64, mime, style) {
  const entry = { b64, mime, style, createdAt: Date.now() };
  if (env.RESTYLE_CACHE) {
    try {
      await env.RESTYLE_CACHE.put(r2Key(cacheKey), base64ToBytes(b64), {
        customMetadata: { mime, style, createdAt: String(entry.createdAt) },
      });
      return;
    } catch (e) {
      console.log("restyle cache_put r2_error", e && e.message ? e.message : "unknown");
      // Fall through to memory so this request still benefits.
    }
  }
  // In-memory fallback: cap at 50 entries, evict oldest first.
  if (memoryCache.size >= 50) {
    const oldest = memoryCache.keys().next().value;
    if (oldest) memoryCache.delete(oldest);
  }
  memoryCache.set(cacheKey, entry);
}

async function cacheDelete(env, cacheKey) {
  let deleted = false;
  if (env.RESTYLE_CACHE) {
    try {
      await env.RESTYLE_CACHE.delete(r2Key(cacheKey));
      deleted = true;
    } catch (e) {
      console.log("restyle cache_delete r2_error", e && e.message ? e.message : "unknown");
    }
  }
  if (memoryCache.delete(cacheKey)) deleted = true;
  return deleted;
}

/** Parse a Retry-After header (seconds, or an HTTP date) to seconds. Default 60. */
function parseRetryAfter(ra) {
  if (!ra) return 60;
  const n = parseInt(ra, 10);
  if (!Number.isNaN(n) && n > 0) return Math.min(n, 3600);
  const t = Date.parse(ra);
  if (!Number.isNaN(t)) return Math.max(1, Math.min(3600, Math.round((t - Date.now()) / 1000)));
  return 60;
}

function fmtWait(secs) {
  if (secs < 90) return secs + " seconds";
  return Math.round(secs / 60) + " minutes";
}

// ------------------------------------------------------------------
// Gemini call
// ------------------------------------------------------------------

async function callGemini(apiKey, imageB64, mime, style) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey, // header, never a URL param / log line
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: STYLE_PROMPTS[style] },
              { inlineData: { mimeType: mime, data: imageB64 } },
            ],
          },
        ],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      // Map provider failures to clean errors. Never forward the
      // raw model payload (it can contain request echoes / keys).
      // NO retry loop here: on a 429 we return the model's
      // Retry-After and let the client retry ONCE manually.
      const status = res.status;
      if (status === 429) {
        const ra = res.headers.get("retry-after");
        const secs = parseRetryAfter(ra);
        return {
          error: "model_rate_limited",
          status: 429,
          retryable: true,
          retry_after_seconds: secs,
          message:
            "The AI studio is busy right now — the image model is at its free-tier quota. " +
            "Please wait about " + fmtWait(secs) + " and try again. Raising the quota in Google AI Studio lifts this limit.",
        };
      }
      if (status === 400) return { error: "model_rejected", status: 400 };
      if (status === 401 || status === 403)
        return { error: "model_config_error", status: 502 };
      if (status >= 500) return { error: "model_unavailable", status: 502, retryable: true };
      return { error: "model_error", status: 502 };
    }

    const data = await res.json();
    const parts = (data?.candidates?.[0]?.content?.parts) || [];
    const img = parts.find(
      (p) => p?.inlineData?.data && typeof p.inlineData.data === "string"
    );
    if (!img) return { error: "model_no_image", status: 502 };
    return {
      b64: img.inlineData.data,
      mime: img.inlineData.mimeType || "image/png",
    };
  } catch (e) {
    if (e && e.name === "AbortError") {
      return { error: "model_timeout", status: 504, retryable: true };
    }
    return { error: "model_unavailable", status: 502, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------

async function handleRestyle(request, env) {
  // 1. No key yet -> graceful degradation. The client shows the real
  //    example assets + "AI Transform opens the moment the studio
  //    key is added". This is the expected state until setup.
  if (!env.GEMINI_API_KEY) {
    return errorJson("not_configured", 503, {
      message: "AI Transform opens the moment the studio key is added.",
    });
  }

  // 2. Validate input (style + image, <10 MB, JPEG/PNG/WebP).
  const input = await parseInput(request);
  if (input.error) return errorJson(input.error, input.status);
  const { bytes, mime, style } = input;

  // 3. Idempotency: same photo + style -> cached result, free.
  //    Checked BEFORE rate limiting so repeats cost nothing.
  const cacheKey = await cacheKeyFor(bytes, style);
  const cached = await cacheGet(env, cacheKey);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const day = utcDay();
  const visitorKey = `${ip}|${day}`;
  const usedToday = visitorCounts.get(visitorKey) || 0;
  if (cached && cached.style === style) {
    console.log(`restyle cache_hit style=${style}`);
    return json({
      image_b64: cached.b64,
      mime_type: cached.mime,
      style,
      cached: true,
      transforms_remaining: Math.max(0, FREE_PER_VISITOR_PER_DAY - usedToday),
      cache_key: cacheKey,
    });
  }

  // 4. Per-visitor rate limit: 5 free transforms / day.
  if (usedToday >= FREE_PER_VISITOR_PER_DAY) {
    return errorJson("rate_limited", 429, {
      transforms_remaining: 0,
      retry_after_seconds: secondsUntilUtcMidnight(),
      message: "You have used today's 5 free AI transforms. Try again tomorrow.",
    });
  }

  // 5. Global cost cap: MAX_TRANSFORMS_PER_DAY paid calls / day.
  const dayCount = dailyCounts.get(day) || 0;
  if (dayCount >= MAX_TRANSFORMS_PER_DAY) {
    console.log(`restyle daily_cap_reached day=${day} count=${dayCount}`);
    return errorJson("daily_cap", 429, {
      transforms_remaining: Math.max(0, FREE_PER_VISITOR_PER_DAY - usedToday),
      retry_after_seconds: secondsUntilUtcMidnight(),
      message: "The studio has reached today's transform limit. Please try again tomorrow.",
    });
  }

  // 6. Call the model.
  const result = await callGemini(env.GEMINI_API_KEY, bytesToBase64(bytes), mime, style);
  if (result.error) {
    console.log(`restyle model_error error=${result.error} style=${style}`);
    // Model 429: surface Retry-After as a header AND in the body, so the
    // client can offer exactly one manual retry after the delay.
    // A model 429 never counts against the visitor's 5 free transforms.
    if (result.error === "model_rate_limited") {
      return json(
        {
          error: result.error,
          message: result.message,
          retryable: true,
          retry_after_seconds: result.retry_after_seconds,
          transforms_remaining: Math.max(0, FREE_PER_VISITOR_PER_DAY - usedToday),
        },
        429,
        { "retry-after": String(result.retry_after_seconds) }
      );
    }
    return errorJson(result.error, result.status, {
      retryable: !!result.retryable,
      transforms_remaining: Math.max(0, FREE_PER_VISITOR_PER_DAY - usedToday),
    });
  }

  // 7. Record usage (only paid calls count) and cache the result.
  visitorCounts.set(visitorKey, usedToday + 1);
  dailyCounts.set(day, dayCount + 1);
  console.log(
    `restyle success style=${style} day_count=${dayCount + 1}/${MAX_TRANSFORMS_PER_DAY}`
  );
  await cachePut(env, cacheKey, result.b64, result.mime, style);

  // NOTE: the returned image is the model's full output. The client
  // downscales it to max 800 px and draws the diagonal PREVIEW
  // watermark before showing it (see restyle-client-snippet.js).
  // The paid full-res version is delivered watermark-free.
  return json({
    image_b64: result.b64,
    mime_type: result.mime,
    style,
    cached: false,
    transforms_remaining: Math.max(0, FREE_PER_VISITOR_PER_DAY - (usedToday + 1)),
    cache_key: cacheKey,
  });
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(0, Math.floor((midnight - now) / 1000));
}

async function handleDelete(request, env) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return errorJson("bad_request", 400);
  }
  const key = typeof body.cache_key === "string" ? body.cache_key : "";
  if (!/^[0-9a-f]{64}$/.test(key)) return errorJson("invalid_cache_key", 400);
  const deleted = await cacheDelete(env, key);
  console.log(`restyle delete cache_key=${key.slice(0, 8)}… deleted=${deleted}`);
  return json({ deleted });
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    // CORS preflight (the API lives on a different origin in Option A).
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }

    if (url.pathname !== "/api/restyle") {
      return errorJson("not_found", 404);
    }

    if (request.method === "GET") {
      // Status probe — lets the client degrade gracefully without
      // spending a transform. Never reveals key presence beyond
      // the boolean the client already needs for its UI.
      return json({
        status: "ok",
        configured: Boolean(env.GEMINI_API_KEY),
        model: MODEL,
        styles: STYLE_IDS,
        free_per_visitor_per_day: FREE_PER_VISITOR_PER_DAY,
        max_transforms_per_day: MAX_TRANSFORMS_PER_DAY,
        cache: env.RESTYLE_CACHE ? "r2" : "memory",
      });
    }

    if (request.method === "POST") {
      try {
        return await handleRestyle(request, env);
      } catch (e) {
        console.log("restyle unexpected_error", e && e.message ? e.message : "unknown");
        return errorJson("internal_error", 500);
      }
    }

    if (request.method === "DELETE") {
      try {
        return await handleDelete(request, env);
      } catch (e) {
        console.log("restyle delete_error", e && e.message ? e.message : "unknown");
        return errorJson("internal_error", 500);
      }
    }

    return errorJson("method_not_allowed", 405);
  },
};
