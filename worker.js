/**
 * Christmas Portrait Studio — AI Restyle Worker
 * ============================================================
 * POST /api/restyle — image-to-image Christmas restyle via Gemini
 * (quality path) with a free Cloudflare Workers AI fallback
 * (FLUX.2 klein-4b, $0) when Gemini fails or is not configured.
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
 *   then bind Workers AI in the Worker dashboard (Settings ->
 *   Bindings -> Add binding -> Workers AI, variable name "AI") so
 *   the free fallback works. The repo's wrangler.jsonc belongs to
 *   the STATIC site (assets only) — it does not configure this worker.
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
 * - An uploaded photo is sent ONLY to the image model that performs
 *   the restyle: the Gemini model API first, or Cloudflare Workers AI
 *   (FLUX.2 klein-4b — listed as zero data retention on Cloudflare's
 *   model page) when Gemini is unavailable. It is never used for
 *   model training (paid-tier Gemini API: content is not used to
 *   improve Google's products — see Google's pricing page), never
 *   shared with any other third party, and no face-recognition
 *   database or biometric template is ever built from it.
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
 *   to migrate. MIGRATION PLAN: test gemini-3.1-flash-lite-image
 *   (Nano Banana 2 Lite, 1K) and gemini-nano-banana-2.1 (2K/4K)
 *   by mid-Feb 2027 and be off gemini-2.5-flash-image before its
 *   15 Mar 2027 shutdown; re-test face preservation first. Do NOT
 *   migrate to gemini-3.1-flash-image — it is itself deprecated in
 *   favour of 2.1. Re-check Google's deprecations page that week.
 *
 * GEMINI STATUS — FREE TIER IS ZERO, 2026-11-25: the studio key is
 * VERIFIED (list-models returns real models incl. gemini-2.5-flash-image),
 * BUT Google's official pricing lists the Free Tier for image models
 * as "Not available": every image call returns HTTP 429, and the quota
 * did NOT come back at the daily reset (verified 02:11 CST 2026-11-25,
 * still 429). A second key in the same Google Cloud project shares the
 * same zero quota, so a fallback key does NOT help — the dashboard-only
 * GEMINI_API_KEY1 fallback is dropped by this version (it was never in
 * the repo; re-pasting this file overwrites it, which is intended).
 * Gemini only works with billing enabled in Google AI Studio.
 *
 * WORKERS AI FALLBACK (free, $0): when Gemini fails (429 or any model
 * error) — or is not configured at all — the Worker falls back to
 * Cloudflare Workers AI, @cf/black-forest-labs/flux-2-klein-4b, via the
 * env.AI binding. Free tier: 10,000 Neurons/day, resets 00:00 UTC;
 * ~109.6 Neurons per 1024x1024 image + 1 input, so ~91 images/day —
 * this Worker caps the path at 80/day for margin. HONEST LIMIT:
 * klein-4b is a 4-step distilled model; it drifts faces more than
 * Gemini — do not claim Gemini-grade face preservation for it. It also
 * needs input images < 512x512, so the client sends a 512px copy
 * (image_small / image_b64_small) alongside the full photo. Over the
 * free tier, Workers AI calls fail with HTTP 429 (error 3036) — treated
 * like model_rate_limited. This worker therefore NEVER retries the model
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
 * Gemini spend at ~$7.80/day worst case (+ tiny input-token cost).
 * The Workers AI path costs $0 while under its free tier
 * (10,000 Neurons/day); MAX_WORKERS_AI_TRANSFORMS_PER_DAY = 80
 * keeps it inside the tier with margin.
 */

// ------------------------------------------------------------------
// Config — change these, not the logic below.
// ------------------------------------------------------------------

/** Gemini image model. Kept on gemini-2.5-flash-image (still served).
 *  MIGRATION: test gemini-3.1-flash-lite-image + gemini-nano-banana-2.1 by
 *  mid-Feb 2027, before the 15 Mar 2027 shutdown. Never gemini-3.1-flash-image. */
const MODEL = "gemini-2.5-flash-image";
/** Google AI Studio (Gemini Developer API) endpoint. */
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

/** Free restyles per visitor (CF-Connecting-IP) per UTC day. */
const FREE_PER_VISITOR_PER_DAY = 5;
/** Hard global cap: paid model calls per UTC day. 429 beyond this. */
const MAX_TRANSFORMS_PER_DAY = 200;
/** Workers AI image model (free tier) — the $0 fallback when Gemini fails. */
const WORKERS_AI_MODEL = "@cf/black-forest-labs/flux-2-klein-4b";
/** Hard global cap: Workers AI calls per UTC day. Free tier is 10,000
 *  Neurons/day (resets 00:00 UTC); klein-4b costs ~109.6 Neurons per
 *  1024x1024 image + 1 input, so ~91/day — 80 keeps a margin. This is
 *  an estimate: verify the real Neuron cost in the Cloudflare
 *  dashboard after ~10 images and adjust if it is higher. */
const MAX_WORKERS_AI_TRANSFORMS_PER_DAY = 80;
/** klein-4b output size: 3:4 portrait, matching the master prompts.
 *  (Range 256–1920; steps are fixed at 4 and cannot be adjusted.) */
const KLEIN_WIDTH = 768;
const KLEIN_HEIGHT = 1024;
/** Max upload size: 10 MB. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Allowed upload MIME types. */
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Model call timeout. Gemini image edits usually take 5–30 s. */
const MODEL_TIMEOUT_MS = 60_000;
/** Cache: restyles are reusable for 30 days max (read-side backstop). */
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Style ids the client may request. "01"–"11" are accepted as aliases. */
const KIDS_STYLE_IDS = new Set([
  "santa-s-workshop",
  "christmas-village",
  "midnight-sleigh-ride",
  "northern-lights",
  "reindeer-flight",
  "gingerbread-house",
  "snow-globe-world",
  "elf-workshop",
  "toy-train",
  "candy-cane-forest",
  "ice-palace",
  "nutcracker-kingdom",
  "cocoa-cabin",
  "reindeer-school",
  "starry-stable",
  "penguin-parade",
  "sugar-plum-ballet",
  "frosty-forest",
  "lantern-walk",
  "carol-singers",
  "mistletoe-garden",
  "north-pole-post-office",
  "snowman-friend",
  "christmas-bakery",
  "twinkle-star-meadow",
  "polar-bear-picnic",
  "snowy-wishing-well",
  "holly-berry-wood",
  "angel-choir",
  "winter-fair",
  "candlelight-chapel",
  "snowflake-castle",
  "peppermint-lane",
  "robin-s-garden",
  "moonlit-toboggan",
  "christmas-library",
  "woodland-friends",
  "festival-of-lights",
  "toy-soldier-parade",
  "frosty-pond-skating",
  "christmas-tree-farm",
  "sweet-shop",
  "snowy-lighthouse",
  "arctic-fox-den",
  "christmas-eve-window",
  "night-train-to-the-north-pole",
  "snowy-owl-s-hollow",
  "snowy-picnic",
  "christmas-merry-go-round",
  "fireside-story-time",
]);
const PET_STYLE_IDS = new Set([
  "santa-s-little-helper",
  "reindeer-pup",
  "elf-cat",
  "snowman-dog",
  "christmas-pudding-pup",
  "mistletoe-kitty",
  "snowflake-spaniel",
  "gingerbread-cat",
  "sleigh-dog",
  "starlight-tabby",
  "candy-cane-kitten",
  "fireplace-hound",
  "carol-singer-cat",
  "nutcracker-dog",
  "holly-jolly-pup",
  "northern-lights-husky",
  "cracker-cat",
  "bauble-beagle",
  "chimney-cat",
  "wreath-whippet",
]);
const STYLE_IDS = [
  "classic-santa-snow",
  "golden-christmas-movie-poster",
  "cozy-fireplace",
  "snow-globe",
  "colombo-christmas",
  "winter-royal",
  "card-classic-red-gold",
  "card-snow-globe-flat",
  "card-golden-movie-poster",
  "name-in-lights",
  "drawing",
  "santa-s-workshop",
  "christmas-village",
  "midnight-sleigh-ride",
  "northern-lights",
  "reindeer-flight",
  "gingerbread-house",
  "snow-globe-world",
  "elf-workshop",
  "toy-train",
  "candy-cane-forest",
  "ice-palace",
  "nutcracker-kingdom",
  "cocoa-cabin",
  "reindeer-school",
  "starry-stable",
  "penguin-parade",
  "sugar-plum-ballet",
  "frosty-forest",
  "lantern-walk",
  "carol-singers",
  "mistletoe-garden",
  "north-pole-post-office",
  "snowman-friend",
  "christmas-bakery",
  "twinkle-star-meadow",
  "polar-bear-picnic",
  "snowy-wishing-well",
  "holly-berry-wood",
  "angel-choir",
  "winter-fair",
  "candlelight-chapel",
  "snowflake-castle",
  "peppermint-lane",
  "robin-s-garden",
  "moonlit-toboggan",
  "christmas-library",
  "woodland-friends",
  "festival-of-lights",
  "toy-soldier-parade",
  "frosty-pond-skating",
  "christmas-tree-farm",
  "sweet-shop",
  "snowy-lighthouse",
  "arctic-fox-den",
  "christmas-eve-window",
  "night-train-to-the-north-pole",
  "snowy-owl-s-hollow",
  "snowy-picnic",
  "christmas-merry-go-round",
  "fireside-story-time",
  "christmas-morning",
  "snowy-cabin",
  "victorian-christmas",
  "rustic-farmhouse",
  "tropical-christmas",
  "midnight-church",
  "golden-hour-snow",
  "aurora-night",
  "christmas-market",
  "frozen-pond",
  "christmas-kitchen",
  "santa-s-little-helper",
  "reindeer-pup",
  "elf-cat",
  "snowman-dog",
  "christmas-pudding-pup",
  "mistletoe-kitty",
  "snowflake-spaniel",
  "gingerbread-cat",
  "sleigh-dog",
  "starlight-tabby",
  "candy-cane-kitten",
  "fireplace-hound",
  "carol-singer-cat",
  "nutcracker-dog",
  "holly-jolly-pup",
  "northern-lights-husky",
  "cracker-cat",
  "bauble-beagle",
  "chimney-cat",
  "wreath-whippet",
];
const STYLE_ALIASES = {
  "01": "classic-santa-snow",
  "02": "golden-christmas-movie-poster",
  "03": "cozy-fireplace",
  "04": "snow-globe",
  "05": "colombo-christmas",
  "06": "winter-royal",
  "07": "card-classic-red-gold",
  "08": "card-snow-globe-flat",
  "09": "card-golden-movie-poster",
  "10": "name-in-lights",
  "11": "drawing",
  "12": "santa-s-workshop",
  "13": "christmas-village",
  "14": "midnight-sleigh-ride",
  "15": "northern-lights",
  "16": "reindeer-flight",
  "17": "gingerbread-house",
  "18": "snow-globe-world",
  "19": "elf-workshop",
  "20": "toy-train",
  "21": "candy-cane-forest",
  "22": "ice-palace",
  "23": "nutcracker-kingdom",
  "24": "cocoa-cabin",
  "25": "reindeer-school",
  "26": "starry-stable",
  "27": "penguin-parade",
  "28": "sugar-plum-ballet",
  "29": "frosty-forest",
  "30": "lantern-walk",
  "31": "carol-singers",
  "32": "mistletoe-garden",
  "33": "north-pole-post-office",
  "34": "snowman-friend",
  "35": "christmas-bakery",
  "36": "twinkle-star-meadow",
  "37": "polar-bear-picnic",
  "38": "snowy-wishing-well",
  "39": "holly-berry-wood",
  "40": "angel-choir",
  "41": "winter-fair",
  "42": "candlelight-chapel",
  "43": "snowflake-castle",
  "44": "peppermint-lane",
  "45": "robin-s-garden",
  "46": "moonlit-toboggan",
  "47": "christmas-library",
  "48": "woodland-friends",
  "49": "festival-of-lights",
  "50": "toy-soldier-parade",
  "51": "frosty-pond-skating",
  "52": "christmas-tree-farm",
  "53": "sweet-shop",
  "54": "snowy-lighthouse",
  "55": "arctic-fox-den",
  "56": "christmas-eve-window",
  "57": "night-train-to-the-north-pole",
  "58": "snowy-owl-s-hollow",
  "59": "snowy-picnic",
  "60": "christmas-merry-go-round",
  "61": "fireside-story-time",
  "62": "christmas-morning",
  "63": "snowy-cabin",
  "64": "victorian-christmas",
  "65": "rustic-farmhouse",
  "66": "tropical-christmas",
  "67": "midnight-church",
  "68": "golden-hour-snow",
  "69": "aurora-night",
  "70": "christmas-market",
  "71": "frozen-pond",
  "72": "christmas-kitchen",
  "73": "santa-s-little-helper",
  "74": "reindeer-pup",
  "75": "elf-cat",
  "76": "snowman-dog",
  "77": "christmas-pudding-pup",
  "78": "mistletoe-kitty",
  "79": "snowflake-spaniel",
  "80": "gingerbread-cat",
  "81": "sleigh-dog",
  "82": "starlight-tabby",
  "83": "candy-cane-kitten",
  "84": "fireplace-hound",
  "85": "carol-singer-cat",
  "86": "nutcracker-dog",
  "87": "holly-jolly-pup",
  "88": "northern-lights-husky",
  "89": "cracker-cat",
  "90": "bauble-beagle",
  "91": "chimney-cat",
  "92": "wreath-whippet",
};

// ------------------------------------------------------------------
// Style prompts — THE SAME TEXT is in PREVIEW-STUDIO-ARCHITECTURE.md.
// If you edit a prompt here, copy it to the doc (and vice versa).
// Face-preservation lock + no-text rule are identical in all styles
// EXCEPT "name-in-lights", whose whole point is the family name
// spelled out in lights — see its prompt comment below.
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Style prompts — MASTER PROMPTS v2 (2026-11-25: FULL CHRISTMAS
// CONVERSION rule added to all locks after the live-site audit found
// tiles rendering as the same photo with only a tint; Classic Santa
// Snow now mandates Santa hats; kleinPrompt no longer tells the model
// to keep the original clothing). THE SAME TEXT
// is in PREVIEW-STUDIO-ARCHITECTURE.md. If you edit a prompt here,
// copy it to the doc (and vice versa). One shared IDENTITY LOCK opens
// every photo-based prompt; each style adds only its own body. No prompt
// asks for text in the image — all lettering is added in the print
// layout — EXCEPT "name-in-lights" (Style 10), whose prompt requires
// the family name spelled out in lights and nothing else. "drawing"
// (Style 11) does NOT use IDENTITY_LOCK: its reference is a child's
// drawing, not a photograph, so it has its own drawing-specific lock.
// Aspect ratio 3:4 is set in the API call (imageConfig), not just in
// the prompt text. Prompt changes go through a prompt review, not a
// code tweak; any change after testing gets a version number + reason.
// ------------------------------------------------------------------

// Shared identity lock — opens every master prompt, verbatim.
const IDENTITY_LOCK = "**IDENTITY LOCK \u2014 do not change:** Use the uploaded family photograph as the sole reference for the people. Keep the same four people \u2014 father, mother, daughter, son \u2014 in the same positions, same relative heights, same poses and same grouping as the reference photo. Keep every face exactly as it is in the reference: same face shape, same eyes, same nose, same smile, same hair colour and style, same skin tone. Do not beautify, slim, smooth, age, or change any face. Preserve natural skin texture and pores. Do not add, remove, or swap any person. **FULL CHRISTMAS CONVERSION \u2014 change everything except the faces:** Replace ALL clothing with the Christmas clothing described in the style below \u2014 Santa hats where the style has them, Christmas Fair Isle sweaters, elf outfits, workshop aprons, winter coats, and the rest \u2014 and replace the ENTIRE background and scene with the Christmas scene described in the style below. Keep ONLY the faces, poses, and number of people. Nothing from the original clothing or the original background survives unless the style brief below explicitly keeps it. Do not carry over the original outfit, the original room, the original outdoor background, or the original colours \u2014 the style below is the whole look, not a tint or a filter over the uploaded photo.";

// Shared lock for Kids' Christmas Worlds — one child, not four people.
const KIDS_LOCK = "**KIDS IDENTITY LOCK \u2014 do not change:** Use the uploaded photograph of the child as the sole reference. Keep the same child \u2014 same face, same eyes, same smile, same hair colour and style, same skin tone, same pose and grouping. Do not beautify, slim, smooth, age, or change any face. Preserve natural skin texture. Do not add, remove, or swap any person. **FULL CHRISTMAS CONVERSION \u2014 change everything except the child:** Replace ALL clothing with the Christmas clothing described in the style below \u2014 Santa hats where the style has them, Christmas Fair Isle sweaters, elf outfits, workshop aprons, winter coats, and the rest \u2014 and replace the ENTIRE background and scene with the Christmas scene described in the style below. Keep ONLY the child's face, pose, and grouping. Nothing from the original clothing or the original background survives unless the style brief below explicitly keeps it. Do not carry over the original outfit, the original room, the original outdoor background, or the original colours \u2014 the style below is the whole look, not a tint or a filter over the uploaded photo.";

// Shared lock for Pet Christmas Personas — one pet, never a different animal.
const PET_LOCK = "**PET LOCK \u2014 do not change:** Use the uploaded photograph of the pet as the sole reference. Keep the same pet \u2014 same breed, size, coat colour and markings, face, ears, eyes and nose, same pose and grouping. Do not turn it into a different animal, a different breed, or a cartoon. Do not add or remove any pet. Keep the pet's face fully visible at all times: no costume, hat, prop or decoration may cover its eyes, nose or mouth. Preserve natural fur texture. Do not beautify, slim, or change the pet's face. **FULL CHRISTMAS CONVERSION \u2014 change everything except the pet:** Replace the pet's outfit, collar, and accessories with the Christmas outfit described in the style below \u2014 Santa hats and suits, elf hats, reindeer antlers, Christmas jumpers, scarves, and the rest \u2014 and replace the ENTIRE background and scene with the Christmas scene described in the style below. Keep ONLY the pet, its face, and its pose. Nothing from the original outfit or the original background survives unless the style brief below explicitly keeps it. Do not carry over the original collar, the original room, the original outdoor background, or the original colours \u2014 the style below is the whole look, not a tint or a filter over the uploaded photo.";

const STYLE_PROMPTS = {
  // Style 01 · Classic Santa Snow (MASTER PROMPT 1)
  "classic-santa-snow": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, now dressed for a classic Christmas morning, EVERY person wearing a classic red Santa hat with white fur trim and a white pom-pom: father in a deep forest-green knit jumper over a white shirt and a Santa hat; mother in a warm cream cable-knit jumper with a red scarf and a Santa hat; daughter in a red dress with a cream cardigan and a Santa hat; son in a navy jumper with a small reindeer motif and a Santa hat. Every person wears a Santa hat \u2014 this is required, not optional. Clothes are clean, well-fitted, real knitted wool \u2014 no costumes, no Santa suits on the family (hats only), no matching novelty outfits.\n\n**SETTING:** Outdoors in soft falling snow at dusk, in front of a tall, naturally decorated Christmas tree with warm white fairy lights and simple red and gold baubles. Snow-covered pine branches frame the edges. A dusting of snow on the ground, footprints behind them. No buildings, no strangers, no animals, no sleigh, no Santa figure.\n\n**LIGHT:** Low winter dusk light, cool blue-grey ambient, warmed by the golden glow of the tree lights falling on their faces from the front-left. Faces are bright, clear, and evenly lit \u2014 no face in shadow, no harsh flash. Gentle snowfall catching the light.\n\n**COLOUR:** Deep forest green, warm cream, classic Christmas red, and soft gold \u2014 restrained and elegant, not saturated. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, tree directly behind them, shallow depth of field so the background lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, calm, timeless \u2014 the photograph a family frames and keeps for twenty years. Genuine relaxed smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5\u00d77 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at sides or holding a mug, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Style 02 · Golden Christmas Movie Poster (MASTER PROMPT 2)
  "golden-christmas-movie-poster": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed as if for the poster of a warm Christmas film: father in a tailored camel wool coat over a cream roll-neck; mother in an elegant deep-red wool coat with a gold scarf; daughter in a cream coat with a red bow in her hair; son in a charcoal coat with a mustard scarf. Tailored, cinematic, expensive-looking \u2014 no novelty Christmas jumpers, no costumes.\n\n**SETTING:** A grand, softly snow-dusted town square at golden hour, with a huge illuminated Christmas tree behind them, warm shop windows glowing, strings of golden lights overhead, gentle snow in the air. The square is empty except for the family \u2014 no crowd, no strangers.\n\n**LIGHT:** Golden-hour cinematography: low warm sun from the front-right kissing their faces, long soft shadows, golden rim light on hair and coats, tree lights adding warm sparkle behind. Faces bright and cinematic, never silhouetted, never in hard shadow.\n\n**COLOUR:** Rich cinematic gold, deep red, warm camel, charcoal, and cream \u2014 a golden, glowing palette with deep shadows. Warm gold dominates; no cold blue cast on skin.\n\n**LENS & COMPOSITION:** Cinematic movie-poster family portrait, shot on a 50mm lens at f/2.0, anamorphic-style widescreen feel within a portrait frame, head-to-waist, family centred and slightly low in the frame with the glowing tree towering behind them, shallow depth of field, gentle lens glow around the lights. Portrait orientation, 3:4.\n\n**MOOD:** Epic yet intimate \u2014 the warmth of a beloved Christmas film, wonder and togetherness, confident relaxed smiles to camera, as if this is the one photograph that tells the whole story of their Christmas.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, rich cinematic colour grading, no noise, no JPEG artefacts, suitable for enlarging to canvas and poster print.\n\n**FORBIDDEN:** No text, no letters, no title, no credits, no billing block anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Style 03 · Cozy Fireplace (MASTER PROMPT 3)
  "cozy-fireplace": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, in soft comfortable clothes for a Christmas evening at home: father in a warm rust-coloured knit jumper; mother in a soft oatmeal jumper with a plaid throw over her shoulders; daughter in a cream jumper holding a small mug of hot chocolate with both hands; son in a forest-green jumper, sitting close beside her. Knitwear looks soft and real, slightly lived-in, not new-out-of-the-packet.\n\n**SETTING:** A warm living room at night, the family grouped close together in front of a lit stone fireplace with a real wood fire, stockings hung on the mantelpiece, a small decorated tree with warm white lights to one side, a knitted blanket over the arm of a chair, a few wrapped presents on the floor. No television, no clutter, no other people.\n\n**LIGHT:** Firelight as the key light: warm amber fire glow from the front-left falling softly on their faces, with gentle fill from the tree lights so no face is lost in shadow. Embers glowing, flames soft and out of focus behind them. Warm, intimate, never orange or blown out.\n\n**COLOUR:** Warm amber, rust, oatmeal, forest green, and cream \u2014 a fireside palette. Skin tones stay natural and warm, never orange. Shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic intimate family portrait, shot on a 50mm lens at f/2.0, close head-and-shoulders to head-to-waist framing, family grouped tightly together and centred, fireplace glow behind them, shallow depth of field so the fire and tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet, safe, deeply cosy \u2014 the feeling of Christmas Eve at home, everyone relaxed, soft genuine smiles, looking at the camera as if a loved one just walked in with a camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, warm natural colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5\u00d77 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 the daughter's hands hold the mug simply, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Style 04 · Snow Globe (MASTER PROMPT 4)
  "snow-globe": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for snow: father in a navy winter coat; mother in a deep-red winter coat with a cream knitted scarf; daughter in a red coat with a cream bobble hat; son in a teal coat with a navy bobble hat. Real winter coats, zipped up, collars up against the cold \u2014 no costumes.\n\n**SETTING:** Inside a magical snow globe scene: the family stands together in a miniature snow-covered village square, a small decorated Christmas tree beside them, tiny snow-covered cottages with glowing windows behind, soft snowflakes drifting and suspended in the air around them, a soft glowing winter sky. The scene is self-contained and dreamlike, with a gentle sense of being inside glass \u2014 a soft luminous edge, never a visible glass rim or base in the frame.\n\n**LIGHT:** Soft, luminous, even winter light from above and front, as if the whole globe glows gently. Faces bright, clear, and evenly lit, with a faint cool sparkle from the snowflakes. No harsh shadows, no dark faces.\n\n**COLOUR:** Icy blue-white, soft silver, deep red, navy, and warm gold window-light \u2014 a cool scene with warm accents. Snow is luminous white; skin stays natural, never blue.\n\n**LENS & COMPOSITION:** Photorealistic family portrait with a magical snow-globe quality, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, tree and cottages behind, shallow depth of field, snowflakes sharp near the family and soft further back. Portrait orientation, 3:4.\n\n**MOOD:** Wonder and delight \u2014 the magic of shaking a snow globe and stepping inside it. Bright, joyful, gentle smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, luminous snow detail, no noise, no JPEG artefacts, suitable for enlarging to canvas, ornament, and 5\u00d77 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No visible snow-globe glass rim, base, or stand in the frame. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Style 05 · Colombo Christmas (MASTER PROMPT 5)
  "colombo-christmas": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for a tropical Christmas evening in Colombo: father in a crisp white short-sleeved shirt; mother in an elegant deep-red dress with a gold shawl; daughter in a cream dress with red flowers in her hair; son in a smart white shirt with rolled sleeves. Light, elegant, warm-weather clothes \u2014 no winter coats, no scarves, no wool, no fake snow on clothes.\n\n**SETTING:** A warm Colombo garden veranda at dusk, with a beautifully decorated tropical Christmas tree \u2014 frangipani and warm white fairy lights, red and gold baubles \u2014 beside them, lush green foliage and palm fronds softly out of focus behind, warm lanterns glowing, a glimpse of a colonial-style veranda with white pillars. No snow, no pine forest, no northern winter.\n\n**LIGHT:** Warm tropical dusk light: soft golden evening sun from the front-left, warm lantern glow filling the shadows, faces bright, warm, and clear. Golden, humid, glowing light \u2014 never cold, never blue, never harsh midday sun.\n\n**COLOUR:** Warm gold, deep red, cream, lush tropical green, and soft white \u2014 a warm, rich, celebratory palette. Greens are deep and alive; skin tones are warm and natural.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, tree and veranda behind them, shallow depth of field so the foliage and lanterns melt into warm golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Joyful, warm, and proud \u2014 Christmas as this family actually lives it, elegant and full of light, relaxed genuine smiles to camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, rich warm colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5\u00d77 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No snow, no winter coats, no scarves, no pine forest, no northern winter clich\u00e9s. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Style 06 · Winter Royal (MASTER PROMPT 6)
  "winter-royal": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for a formal Christmas portrait: father in a dark charcoal suit with a deep-red tie; mother in an elegant midnight-blue gown with a subtle gold shawl; daughter in a deep-red velvet dress; son in a small charcoal suit with a cream shirt. Formal, tailored, timeless \u2014 no crowns, no tiaras, no capes, no costume jewellery, no novelty.\n\n**SETTING:** An elegant room at night, deep green walls, a tall decorated Christmas tree with warm white lights and gold ornaments behind them, a marble fireplace with a gentle fire to one side, a large window showing soft falling snow outside, a few gold candles glowing. Understated luxury \u2014 no throne, no palace hall, no chandelier dominating the frame.\n\n**LIGHT:** Soft, directional portrait-studio light from the front-left, like a great formal portrait: faces sculpted with gentle shadow on one side, warm fill from the fire and candles so no face is dark, a soft glow from the tree behind. Skin luminous, never washed out, never harsh.\n\n**COLOUR:** Deep midnight blue, charcoal, deep red, warm gold, and cream \u2014 a regal, restrained palette with gold as the only bright accent. Shadows are deep and warm, never black holes.\n\n**LENS & COMPOSITION:** Formal photorealistic family portrait, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with generous breathing room above the heads, family centred and composed like a classic painted portrait, tree and fireplace behind, shallow depth of field, candlelight as soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Dignified, warm, and timeless \u2014 the formal Christmas portrait a family hangs above the fireplace for a generation. Calm, confident, gentle smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, rich formal colour grading, no noise, no JPEG artefacts, suitable for enlarging to large canvas and premium 5\u00d77 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No crowns, tiaras, capes, or costume. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Card A · Classic Red & Gold Folded (5x7) (MASTER PROMPT 7)
  "card-classic-red-gold": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family in classic Christmas dress: father in a deep forest-green knit jumper; mother in a cream jumper with a red scarf; daughter in a red dress; son in a navy jumper. Clean, real knitwear, well-fitted.\n\n**SETTING \u2014 CARD FRONT:** The family portrait fills the front of the card, full-bleed to the edges, in front of a tall Christmas tree with warm white lights and simple red and gold baubles, soft snow falling, a deep red background tone at the edges that will sit behind a thin gold border added in the print layout. The portrait itself is the card \u2014 no empty space left for a photo to be pasted in later.\n\n**LIGHT:** Warm tree-light glow on faces from the front-left, soft dusk ambient behind, faces bright and clear, no face in shadow.\n\n**COLOUR:** Classic red, deep forest green, warm gold, and cream. Red is rich, not bright or orange; gold is warm metallic in the tree lights, not yellow.\n\n**LENS & COMPOSITION:** Photorealistic family portrait, 85mm lens at f/2.8, head-to-waist, all four faces fully in frame, family centred with generous space at the top and bottom of the frame so the print layout can add a thin gold border and the greeting below the image without covering any face. Portrait orientation, 3:4 \u2014 the image will be printed on the front of a 5\u00d77 folded card, so the composition must survive a 5:7 crop with faces safe.\n\n**MOOD:** Classic, warm, and proud \u2014 the card a family is happy to send to everyone they love. Relaxed genuine smiles to camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, rich classic colour, no noise, no JPEG artefacts. The image must remain sharp when upscaled for 5\u00d77 print at 300 DPI. Leave clean, uncluttered space at the very bottom of the frame for the printed greeting \u2014 do not fill the bottom edge with faces, hands, or tree branches.\n\n**FORBIDDEN:** No text, no letters, no greeting, no names, no year, no \"Merry Christmas\" in the image \u2014 all lettering is added in the print layout. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border drawn in the image itself.",
  // Card B · Snow Globe Flat (5x7) (MASTER PROMPT 8)
  "card-snow-globe-flat": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family in winter coats: father navy, mother deep red with cream scarf, daughter red coat with cream bobble hat, son teal coat with navy bobble hat. Real winter clothes, zipped up.\n\n**SETTING \u2014 CARD FRONT:** The family stands together in a luminous snow-globe village square: a small decorated tree beside them, tiny cottages with glowing windows behind, snowflakes drifting in the air, a soft glowing winter sky, the whole scene bright and magical. The portrait fills the card front full-bleed; the globe feeling comes from the light and the snow, not from a drawn circle.\n\n**LIGHT:** Soft, even, luminous winter light from above and front; faces bright and clear; a faint sparkle from snowflakes; no harsh shadows.\n\n**COLOUR:** Icy blue-white, soft silver, deep red, navy, and warm gold window-light. Snow luminous white; skin natural, never blue.\n\n**LENS & COMPOSITION:** Photorealistic family portrait with snow-globe magic, 85mm lens at f/2.8, head-to-waist, all four faces fully in frame, family centred, generous space at the top and bottom so the print layout can add the greeting without covering any face. Portrait orientation, 3:4 \u2014 the image will be printed on a 5\u00d77 flat card, so it must survive a 5:7 crop with faces safe.\n\n**MOOD:** Wonder and delight \u2014 the card that makes the recipient smile before they read it. Bright, joyful smiles to camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, luminous snow detail, no noise, no JPEG artefacts. Must remain sharp when upscaled for 5\u00d77 print at 300 DPI. Leave clean space at the very bottom of the frame for the printed greeting.\n\n**FORBIDDEN:** No text, no letters, no greeting, no names in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No visible snow-globe rim, base, or stand. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border drawn in the image itself.",
  // Card C · Golden Movie Poster Flat (5x7) (MASTER PROMPT 9)
  "card-golden-movie-poster": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family in cinematic dress: father in a camel wool coat over a cream roll-neck; mother in a deep-red wool coat with a gold scarf; daughter in a cream coat with a red bow; son in a charcoal coat with a mustard scarf. Tailored, expensive-looking, no novelty jumpers.\n\n**SETTING \u2014 CARD FRONT:** A grand snow-dusted town square at golden hour, a huge illuminated Christmas tree behind the family, warm shop windows glowing, strings of golden lights overhead, gentle snow in the air. The square is empty except for the family. The portrait fills the card front full-bleed, cinematic and glowing.\n\n**LIGHT:** Golden-hour cinematography: low warm sun from the front-right on their faces, golden rim light on hair and coats, tree lights sparkling behind. Faces bright and cinematic, never silhouetted.\n\n**COLOUR:** Rich cinematic gold, deep red, warm camel, charcoal, and cream. Warm gold dominates; no cold blue cast on skin.\n\n**LENS & COMPOSITION:** Cinematic family portrait, 50mm lens at f/2.0, head-to-waist, family centred and slightly low in the frame with the glowing tree towering behind, shallow depth of field, gentle glow around the lights. Portrait orientation, 3:4 \u2014 the image will be printed on a 5\u00d77 flat card, so it must survive a 5:7 crop with faces safe. Leave clean space at the very bottom of the frame for the printed greeting and family name.\n\n**MOOD:** Epic yet intimate \u2014 the warmth of a beloved Christmas film. Confident, relaxed smiles to camera, as if this is the one photograph that tells the whole story of their Christmas.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, rich cinematic colour grading, no noise, no JPEG artefacts. Must remain sharp when upscaled for 5\u00d77 print at 300 DPI, on pearl-shimmer paper.\n\n**FORBIDDEN:** No text, no letters, no title, no credits, no names, no year in the image \u2014 all lettering is added in the print layout. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border drawn in the image itself.",
  // Style 10 · Name in Lights — hidden-name hero ornament.
  // THE DELIBERATE EXCEPTION to the no-text rule: the whole point of
  // this style is the family name spelled out in warm gold fairy
  // lights, so the prompt REQUIRES text — the name, and only the name.
  // "{NAME}" is a placeholder, replaced at call time by stylePrompt()
  // with the sanitized family name from the request body. The Worker
  // NEVER invents a name: name-in-lights with no valid name is
  // rejected in parseInput() with HTTP 400 invalid_name.
  "name-in-lights": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for a classic Christmas evening, EVERY person wearing a classic red Santa hat with white fur trim and a white pom-pom: father in a deep forest-green knit jumper over a white shirt and a Santa hat; mother in a warm cream cable-knit jumper with a red scarf and a Santa hat; daughter in a red dress with a cream cardigan and a Santa hat; son in a navy jumper with a small reindeer motif and a Santa hat. Every person wears a Santa hat \u2014 this is required, not optional. Clean, well-fitted, real knitted wool \u2014 no costumes, no Santa suits on the family (hats only), no matching novelty outfits.\n\n**SETTING:** Outdoors in soft falling snow at dusk, in front of a tall, naturally decorated Christmas tree with warm white fairy lights and simple red and gold baubles. Snow-covered pine branches frame the edges. A dusting of snow on the ground, footprints behind them. No buildings, no strangers, no animals, no sleigh, no Santa figure.\n\n**THE NAME IN LIGHTS \u2014 THE HERO DETAIL:** The family name \"{NAME}\" is spelled out in large, warm gold fairy lights, strung across the Christmas tree directly behind the family and glowing softly in the snow-lit air behind them, so the name reads clearly above and around their heads like a golden signature. Each letter is formed by the lights themselves \u2014 elegant, even, perfectly legible, the brightest and clearest thing in the scene after the family's faces. A guest reads the name at a glance. Spell the name EXACTLY as \"{NAME}\": the same letters, in the same order, with the same spelling and capitalisation. No extra words, no extra letters, no year, no greeting, no other text anywhere.\n\n**LIGHT:** Low winter dusk light, cool blue-grey ambient, warmed by the golden glow of the tree lights and the name in lights falling on their faces from the front-left. Faces are bright, clear, and evenly lit \u2014 no face in shadow, no harsh flash. Gentle snowfall catching the light.\n\n**COLOUR:** Deep forest green, warm cream, classic Christmas red, and soft gold \u2014 restrained and elegant, not saturated. The gold of the name in lights is warm metallic, never yellow. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, tree and the name in lights directly behind them, shallow depth of field so the background lights melt into soft round bokeh \u2014 but the letters of the name stay sharp and readable. Portrait orientation, 3:4.\n\n**MOOD:** Warm, calm, proud \u2014 the photograph a family frames and keeps for twenty years, with their name shining in it. Genuine relaxed smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces AND on the letters of the name, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas, ornament, and 5\u00d77 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image EXCEPT the family name \"{NAME}\" spelled out in lights. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at sides or holding a mug, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Style 11 · Drawing — child's drawing made real.
  // Deliberately does NOT reuse IDENTITY_LOCK: that lock says
  // "uploaded family photograph" and "same four people", but the
  // reference here is a CHILD'S DRAWING, not a photo, and the number
  // and kind of characters are whatever the child drew. The lock below
  // is drawing-specific: keep the drawing's characters, shapes,
  // colours and spirit exactly as drawn — three-eyed monsters included —
  // and render them as real, photorealistic Christmas-portrait
  // characters in the same poses and grouping. Works through both
  // providers: kleinPrompt() uses a drawing-specific prefix for it.
  "drawing": "**DRAWING LOCK \u2014 do not change:** The uploaded image is a child's drawing, NOT a photograph. Keep the drawing's characters, shapes, colours and spirit exactly as the child drew them: every character the child drew stays in the scene, in the same poses and the same grouping, even the funny ones \u2014 a three-eyed monster keeps three eyes, a green dog stays green, purple hair stays purple, extra-long arms stay extra-long. Do not 'fix', tidy up, or normalise the drawing into ordinary people, and do not add, remove, or swap any character. Keep the child's colour choices wherever the drawing made them. **FULL CHRISTMAS CONVERSION \u2014 scene only:** Replace the drawing's background entirely with the Christmas scene described in the style below \u2014 only the characters, their colours, and their poses carry over from the drawing. Nothing from the drawing's background survives unless the style brief below explicitly keeps it.\n\n**SUBJECT \u2014 DRAWING MADE REAL:** Render the drawing's characters as real, warm, photorealistic people (and creatures, where the child drew one) in a Christmas portrait scene, so each character is still clearly recognisable as the one the child drew: same faces, same hair, same colours, same expressions, same poses. A monster the child drew becomes a real, friendly creature with the same features \u2014 or a real child in a costume that keeps those features \u2014 whichever keeps the character recognisable. The result is a real photograph of the drawing's characters, not a drawing of a photograph.\n\n**SETTING:** A warm Christmas scene around them: a decorated tree with warm white fairy lights and simple red and gold baubles, a fireplace glow to one side, wrapped presents on the floor, gentle snow falling outside a window. The setting is real and photographic; only the characters carry the drawing's playful spirit. No strangers, no extra people, no animals the child did not draw.\n\n**LIGHT:** Warm, soft portrait light on every character from the front-left, faces bright and clear, no face in shadow, gentle glow from the tree lights and the fire. Warm, never orange or blown out.\n\n**COLOUR:** Warm and joyful, led by the colours the child chose, plus classic Christmas red, forest green and soft gold. Skin stays natural where the drawing made it natural; keep the child's bold colours where the drawing used them.\n\n**LENS & COMPOSITION:** Photorealistic family Christmas portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all characters fully in frame with breathing room above the heads, family centred, tree directly behind them, shallow depth of field so the background lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, playful, magical \u2014 a child's drawing come to life for Christmas, the portrait a family frames and keeps. Genuine relaxed smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all characters' faces, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5\u00d77 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. Do not 'correct' the drawing into ordinary people \u2014 a character the child drew with three eyes must still have three eyes. No extra characters, no extra fingers, no extra limbs, no melted hands. No cartoon or flat-illustration look \u2014 the result is a real photograph of the drawing's characters, not a drawing of a photograph. No watermark, no logo, no border, no frame.",
  // Kids santa-s-workshop
  "santa-s-workshop": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for making toys: a cosy red knitted jumper with a small cream apron, sleeves rolled to the elbows, and a red Santa hat with white fur trim.\n\n**SETTING:** Inside Santa's warm wooden workshop: workbenches with half-finished wooden toys, a rocking horse and a toy train, tools hung on the wall, warm lanterns glowing, a decorated Christmas tree with warm white lights to one side, sawdust and wood shavings on the bench. No Santa figure, no other people, no animals.\n\n**LIGHT:** Warm lantern light as the key light from the front-left, soft and golden on the child's face, with gentle fill from the tree lights so no part of the face is lost in shadow. Warm, never orange or blown out.\n\n**COLOUR:** Warm honey brown, deep red, cream, and soft gold \u2014 a workshop palette. Wood tones are rich and warm; skin stays natural.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, workbench and tree behind, shallow depth of field so the lanterns and tree lights melt into soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, busy, and magical \u2014 the joy of making Christmas with your own hands. A bright, proud smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids christmas-village
  "christmas-village": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for snow: a warm red winter coat, cream knitted scarf, and a cream bobble hat. Real winter clothes, zipped up.\n\n**SETTING:** A snowy Christmas village square at dusk: tiny cottages with glowing windows, a decorated Christmas tree in the middle of the square, market stalls with warm lights, gentle snow falling, footprints in fresh snow. The square is quiet and empty except for the child \u2014 no crowd, no strangers, no animals.\n\n**LIGHT:** Low winter dusk light, cool blue-grey ambient, warmed by the golden glow of the cottage windows and tree lights falling on the child's face from the front-left. Face bright, clear, and evenly lit, no harsh flash.\n\n**COLOUR:** Deep forest green, warm cream, classic Christmas red, and soft gold, with luminous white snow. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, tree and cottages behind, shallow depth of field so the village lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, cosy, and full of wonder \u2014 a village that feels like a Christmas card come to life. A gentle happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids midnight-sleigh-ride
  "midnight-sleigh-ride": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a night sleigh ride: a warm red winter coat, cream knitted hat, and a thick woollen blanket over the lap. Cosy and bundled up, not a costume.\n\n**SETTING:** In a wooden sleigh at midnight: soft moonlight, snow-covered pine trees passing by, stars overhead, a warm lantern glowing beside the child, soft snow on the sleigh's edges. The night is calm and still, the sleigh feels safe and slow. No driver, no reindeer in the frame, no other people.\n\n**LIGHT:** Cool moonlight from above and front, warmed by the amber glow of the lantern on the child's face. Face bright and clear, never lost in the dark, never in hard shadow. Stars sharp, snow catching the light.\n\n**COLOUR:** Deep midnight blue, soft silver, warm amber lantern light, and white snow \u2014 a quiet night palette. Skin stays natural and warm, never blue.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, lantern and snowy pines behind, shallow depth of field so the trees melt into soft blue bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Dreamy, peaceful, and magical \u2014 the hush of a Christmas night ride. A soft, sleepy-happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids northern-lights
  "northern-lights": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the cold north: a warm teal winter coat with a fur-trimmed hood down, and a cream knitted hat. Real winter clothes, zipped up.\n\n**SETTING:** Out in soft snow under the northern lights: green and violet ribbons of light dancing across a deep blue night sky, stars above, snow-covered pine trees at the edges, snow sparkling faintly at the child's feet. No buildings, no other people, no animals.\n\n**LIGHT:** Soft light from the sky itself, gentle green and violet glow from above, with a warm fill on the child's face so it stays bright, clear, and natural. No harsh shadows, no dark face.\n\n**COLOUR:** Deep midnight blue, glowing green and soft violet, luminous white snow, and warm skin tones. The lights are vivid but the child's face stays natural, never green or blue.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, the lights towering behind, shallow depth of field so the pines soften into dark bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Awe and quiet wonder \u2014 the night sky putting on its best show. A bright amazed smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids reindeer-flight
  "reindeer-flight": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a night flight: a warm red winter coat with a cream knitted scarf, scarf ends fluttering gently, mittens on. Cosy winter clothes, not a costume.\n\n**SETTING:** High above the clouds on Christmas Eve, beside a sleigh gliding through the night sky: soft moonlight, stars all around, snowy rooftops far below, a reindeer's antlers and harness just at the edge of the frame, never the whole animal. The sky is vast and calm. No Santa figure, no other people.\n\n**LIGHT:** Golden moonlight and starlight from the front-right, warm and cinematic on the child's face, with a soft golden rim light on hair and coat. Face bright and clear, never silhouetted.\n\n**COLOUR:** Rich gold, deep midnight blue, warm cream, and soft white cloud \u2014 a golden night palette. Warm gold dominates; no cold blue cast on skin.\n\n**LENS & COMPOSITION:** Cinematic child portrait, shot on a 50mm lens at f/2.0, head-to-waist framing, the child centred and slightly low in the frame with the night sky towering behind, shallow depth of field, gentle glow around the stars. Portrait orientation, 3:4.\n\n**MOOD:** Epic yet gentle \u2014 the thrill of flying on Christmas Eve. A wide, delighted smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids gingerbread-house
  "gingerbread-house": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for baking: a cosy cream knitted jumper with a red apron dusted with a little flour, sleeves rolled up. Homely and real, not a costume.\n\n**SETTING:** Beside a big gingerbread house: warm brown gingerbread walls with white icing, candy-cane pillars, a gumdrop roof, soft snow on the ground, warm golden light glowing from its little windows, a small decorated tree nearby. No other people, no animals.\n\n**LIGHT:** Warm golden light from the gingerbread windows and soft daylight from the front-left, falling gently on the child's face. Face bright, clear, and warmly lit, never orange or blown out.\n\n**COLOUR:** Warm gingerbread brown, cream icing white, candy red, and soft gold \u2014 a sweet, warm palette. Skin stays natural and warm.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, gingerbread house behind, shallow depth of field so the icing and lights soften into warm bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Sweet, warm, and joyful \u2014 Christmas you can almost taste. A proud, happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids snow-globe-world
  "snow-globe-world": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for snow: a warm red winter coat with a cream bobble hat and cream knitted scarf. Real winter clothes, zipped up.\n\n**SETTING:** Inside a magical snow globe world: the child stands in a miniature snow-covered village square, a small decorated Christmas tree beside them, tiny cottages with glowing windows behind, soft snowflakes drifting and suspended in luminous air all around. The scene is self-contained and dreamlike, with a soft luminous edge \u2014 never a visible glass rim or base in the frame.\n\n**LIGHT:** Soft, luminous, even winter light from above and front, as if the whole globe glows gently. Face bright, clear, and evenly lit, with a faint cool sparkle from the snowflakes. No harsh shadows, no dark face.\n\n**COLOUR:** Icy blue-white, soft silver, deep red, and warm gold window-light \u2014 a cool scene with warm accents. Snow is luminous white; skin stays natural, never blue.\n\n**LENS & COMPOSITION:** Photorealistic child portrait with a magical snow-globe quality, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, tree and cottages behind, shallow depth of field, snowflakes sharp near the child and soft further back. Portrait orientation, 3:4.\n\n**MOOD:** Wonder and delight \u2014 the magic of shaking a snow globe and stepping inside it. A bright, joyful smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No visible snow-globe glass rim, base, or stand in the frame. No watermark, no logo, no border, no frame.",
  // Kids elf-workshop
  "elf-workshop": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for making toys: a cosy green knitted jumper with a red apron, a small paintbrush in one hand. Work clothes, not a costume \u2014 no pointy hat, no elf ears.\n\n**SETTING:** In a cheerful little workshop: the child sits at a small wooden bench painting a wooden toy train, colourful toy shelves behind, spools of ribbon and jars of paint, warm golden light, a small Christmas tree in the corner, wrapped parcels stacked neatly. No other people, no animals.\n\n**LIGHT:** Warm, soft workshop light from the front-left, faces bright and clear, gentle glow from the tree lights and lanterns. Warm, never orange or blown out.\n\n**COLOUR:** Warm and joyful: forest green, deep red, cream, and soft gold, with bright toy colours in the background. Skin stays natural and warm.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on a 50mm lens at f/2.0, head-to-waist framing, the child centred with breathing room above the head, bench and shelves behind, shallow depth of field so the toys melt into soft warm bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Busy, happy, and playful \u2014 a workshop full of Christmas in the making. A proud smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids toy-train
  "toy-train": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a winter ride: a warm navy winter coat, cream knitted scarf, and a red bobble hat. Real winter clothes, zipped up.\n\n**SETTING:** On a little wooden toy train winding through soft snow: the child sits in the front carriage, pine trees dusted with snow on either side, a small decorated tree and a tiny station with warm glowing windows behind, gentle snow falling. The train is small and charming, clearly a toy come to life. No other people, no animals.\n\n**LIGHT:** Soft winter daylight from the front-left, cool and bright, warmed by the golden station windows on the child's face. Face bright, clear, and evenly lit.\n\n**COLOUR:** Deep navy, warm cream, classic red, and luminous white snow, with warm gold window-light. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, train and snowy pines behind, shallow depth of field so the snow and lights soften into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Joyful and full of adventure \u2014 a little train, a big snowy world. A big happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids candy-cane-forest
  "candy-cane-forest": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a sweet winter walk: a warm cream winter coat with a red knitted scarf and red mittens. Cosy winter clothes, not a costume.\n\n**SETTING:** In a magical candy cane forest: tall red-and-white striped candy canes stand like trees among snow-dusted pines, soft snow on the ground, warm fairy lights strung between the canes, a few giant wrapped sweets resting in the snow. The scene is playful and sweet, never garish. No other people, no animals.\n\n**LIGHT:** Soft, even winter light from above and front, with warm fairy-light glow on the child's face. Face bright, clear, and evenly lit, no harsh shadows.\n\n**COLOUR:** Candy red, crisp white, soft green pine, and warm gold light \u2014 a sweet, clean palette. Snow is luminous white; skin stays natural.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, candy canes and pines behind, shallow depth of field so the lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Sweet delight and wonder \u2014 a forest good enough to eat. A delighted smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids ice-palace
  "ice-palace": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a royal winter visit: a deep-blue velvet dress or a smart navy coat with a cream shirt, simple and elegant. Formal but comfortable \u2014 no crown, no cape, no costume jewellery.\n\n**SETTING:** Inside a grand ice palace: tall crystal-blue ice columns, a frozen staircase, sparkling icicles, a decorated Christmas tree with silver and white ornaments, soft snow falling outside tall ice windows. The palace is grand but warm and welcoming, not cold or forbidding. No other people, no animals.\n\n**LIGHT:** Soft, directional light from the front-left, like a great formal portrait, with a gentle icy-blue glow from the palace and warm fill from the tree lights so the face stays bright and natural. Skin luminous, never washed out, never blue.\n\n**COLOUR:** Ice blue, silver, deep midnight blue, and warm gold tree-light \u2014 a regal, cool palette with gold as the only warm accent. Shadows are deep and cool, never black holes.\n\n**LENS & COMPOSITION:** Formal photorealistic child portrait, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with generous breathing room above the head, ice columns and tree behind, shallow depth of field, tree lights as soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Dignified, calm, and magical \u2014 a palace made of winter itself. A gentle, proud smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids nutcracker-kingdom
  "nutcracker-kingdom": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a storybook ball: a deep-red velvet dress with a cream cardigan, or a smart charcoal suit with a cream shirt. Elegant and timeless \u2014 no crown, no cape, no costume.\n\n**SETTING:** In a grand Nutcracker kingdom hall: tall toy-soldier nutcrackers standing guard in two neat rows, a grand decorated Christmas tree, red and gold banners, a polished wooden floor, warm golden candlelight, a few wrapped presents at the foot of the tree. Understated and storybook, never cluttered. No other people, no animals.\n\n**LIGHT:** Soft, directional portrait light from the front-left, warm fill from the candles and tree lights so the face is sculpted with gentle shadow on one side and never dark. Skin luminous, never washed out, never harsh.\n\n**COLOUR:** Deep red, warm gold, charcoal, and cream \u2014 a regal, storybook palette with gold as the brightest accent. Shadows are deep and warm, never black holes.\n\n**LENS & COMPOSITION:** Formal photorealistic child portrait, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with generous breathing room above the head, nutcrackers and tree behind, shallow depth of field, candlelight as soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Storybook magic and quiet pride \u2014 a kingdom out of a favourite tale. A calm, happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids cocoa-cabin
  "cocoa-cabin": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a cabin evening: a soft cream knitted jumper with a red Santa hat with white fur trim and a red-and-cream Fair Isle scarf, holding a small mug of hot chocolate with both hands. Cosy and lived-in, not new-out-of-the-packet.\n\n**SETTING:** Inside a little log cabin at night: the child sits near a lit stone fireplace with a real wood fire, a knitted blanket over the arm of a chair, a small decorated tree with warm white lights, a tray with a jug of cocoa and marshmallows nearby, snow falling outside the window. No other people, no animals.\n\n**LIGHT:** Firelight as the key light: warm amber glow from the front-left falling softly on the child's face, with gentle fill from the tree lights so no part of the face is lost in shadow. Warm, intimate, never orange or blown out.\n\n**COLOUR:** Warm amber, rust, oatmeal, and cream \u2014 a fireside palette. Skin tones stay natural and warm, never orange. Shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic intimate child portrait, shot on a 50mm lens at f/2.0, close head-and-shoulders to head-to-waist framing, the child centred, fireplace glow behind, shallow depth of field so the fire and tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet, safe, deeply cosy \u2014 Christmas Eve at home, cocoa in hand. A soft, content smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids reindeer-school
  "reindeer-school": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for flying lessons: a warm red winter coat, cream knitted scarf, and small leather flying goggles pushed up on the forehead. Playful and practical, not a costume.\n\n**SETTING:** At a little reindeer school in a snowy clearing: wooden jumps and soft landing hay bales, pine trees dusted with snow, a small decorated tree, a reindeer with soft brown fur and gentle eyes standing calmly just at the edge of the frame, never the whole animal. The sky is bright winter blue. No other people.\n\n**LIGHT:** Bright, soft winter daylight from the front-left, with a warm golden fill on the child's face. Face bright, clear, and evenly lit, no harsh shadows.\n\n**COLOUR:** Warm red, cream, pine green, and bright winter blue \u2014 a cheerful, sunny palette. Snow is white, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, snowy clearing and pines behind, shallow depth of field so the trees soften into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Proud and excited \u2014 the first flying lesson, passed with flying colours. A big confident smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids starry-stable
  "starry-stable": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a quiet Christmas night: a soft cream nightdress-style dress or a cream knitted jumper, with a warm woollen shawl over the shoulders and a red Santa hat with white fur trim. Simple, soft, and warm.\n\n**SETTING:** In a quiet wooden stable at night: soft straw on the floor, warm lanterns glowing, a gentle donkey resting calmly in the background, a single bright star shining through the stable door, a small wreath on the wall. The scene is still and peaceful. No other people.\n\n**LIGHT:** Warm lantern light from the front-left and the soft glow of the star from behind, falling gently on the child's face. Face bright, clear, and warmly lit, never in shadow.\n\n**COLOUR:** Warm gold, soft cream, honey brown straw, and deep night blue through the door \u2014 a gentle, glowing palette. Skin stays natural and warm.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, lanterns and stable door behind, shallow depth of field so the lanterns melt into warm golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Still, gentle, and full of wonder \u2014 the quiet heart of Christmas night. A soft, peaceful smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids penguin-parade
  "penguin-parade": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the snow: a warm navy winter coat, red knitted scarf, and a navy bobble hat. Real winter clothes, zipped up.\n\n**SETTING:** On a snowy path beside a cheerful penguin parade: small penguins waddling in a neat line, snow-covered rocks, soft snow falling, a pale winter sun, a few pine trees dusted with snow. The penguins are charming and clearly in the background, never crowding the child. No other people.\n\n**LIGHT:** Soft, bright winter daylight from the front-left, cool and even, with a gentle warm fill on the child's face. Face bright, clear, and evenly lit, no harsh shadows.\n\n**COLOUR:** Crisp white snow, deep navy, cheerful red, and soft grey rock \u2014 a clean, bright palette. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, penguins and snowy path behind, shallow depth of field so the background softens into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Cheerful and full of giggles \u2014 a parade no one could march past without smiling. A big laughing smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids sugar-plum-ballet
  "sugar-plum-ballet": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the ballet: a soft lilac or pale-pink ballet dress with a full tulle skirt, ballet shoes, hair neatly tied back. A real ballet outfit, elegant and simple \u2014 no crown, no wand, no costume jewellery.\n\n**SETTING:** On a softly lit stage: a painted winter backdrop of snow and pine trees, a small decorated tree at the side of the stage, warm footlights glowing, a few paper snowflakes drifting gently in the stage light. The stage is empty except for the child. No audience, no other people.\n\n**LIGHT:** Warm stage light from the front-left, soft and flattering, with gentle fill so the face is bright and clear, never in hard shadow. A soft glow around the child, like a spotlight kept gentle.\n\n**COLOUR:** Soft lilac, pale pink, cream, and warm gold \u2014 a delicate, dreamy palette. Skin stays natural and luminous, never washed out.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, stage backdrop behind, shallow depth of field so the backdrop melts into soft dreamy bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Graceful and dreamy \u2014 the moment the music starts and the world goes quiet. A gentle, proud smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids frosty-forest
  "frosty-forest": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a frosty walk: a warm forest-green winter coat, cream knitted scarf, and cream mittens. Real winter clothes, zipped up, collars up against the cold.\n\n**SETTING:** In a quiet frosty forest: tall pine trees heavy with frost and snow, a soft path of untouched snow, a few red berries on a branch, a pale winter sun low through the trees, gentle snowflakes drifting. The forest is still and beautiful. No other people, no animals.\n\n**LIGHT:** Low, soft winter sunlight from the front-left through the trees, cool and bright, with a gentle warm fill on the child's face. Face bright, clear, and evenly lit, no harsh flash.\n\n**COLOUR:** Frost white, deep forest green, soft silver, and a touch of red berry \u2014 a cool, clean palette. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, frosted pines behind, shallow depth of field so the trees melt into soft white bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Calm and quietly amazed \u2014 a forest turned to glass by the frost. A soft, wondering smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids lantern-walk
  "lantern-walk": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a lantern walk: a warm deep-red winter coat, cream knitted scarf, and mittens, holding a small glowing paper lantern in one hand. Cosy winter clothes, not a costume.\n\n**SETTING:** On a snowy path at dusk: the child walks along a lane lined with glowing paper lanterns hung from low branches, a decorated tree glowing in the distance, soft snow falling, footprints in fresh snow. The lanterns make a warm golden path through the blue dusk. No other people, no animals.\n\n**LIGHT:** Low winter dusk light, cool blue-grey ambient, warmed by the golden glow of the lanterns falling on the child's face from the front-left. Face bright, clear, and evenly lit, no harsh flash.\n\n**COLOUR:** Deep blue dusk, warm gold lantern light, classic red, and luminous white snow \u2014 a glowing path through the dark. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, lantern-lit lane behind, shallow depth of field so the lanterns melt into soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm and hopeful \u2014 carrying a little light through the winter dark. A gentle, happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids carol-singers
  "carol-singers": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for carol singing: a warm red winter coat, cream knitted scarf, and a small songbook held in both hands. Cosy winter clothes, not a costume.\n\n**SETTING:** Outside a cottage door on a snowy evening: warm golden light spilling from the doorway, a wreath on the door, a small decorated tree in the window, gentle snow falling, a lantern glowing on the step. The evening is quiet and the song is sweet. No other people, no animals.\n\n**LIGHT:** Warm golden doorway light from the front-left, falling softly on the child's face, with cool dusk ambient behind. Face bright, clear, and warmly lit, never orange or blown out.\n\n**COLOUR:** Warm gold, deep red, cream, and soft blue dusk \u2014 a glowing evening palette. Skin stays natural and warm, never orange.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, cottage door and wreath behind, shallow depth of field so the doorway light melts into soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Joyful and warm-hearted \u2014 a song shared on a snowy night. A bright singing smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids mistletoe-garden
  "mistletoe-garden": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a winter garden: a soft cream knitted jumper with a deep-green coat over it, hair loose with a small sprig of holly tucked behind one ear. Simple and natural, not a costume.\n\n**SETTING:** In a walled winter garden: green mistletoe hanging from bare branches, winter roses in soft red and cream, a stone bench dusted with snow, warm lanterns along the path, a small decorated tree in the corner. The garden is quiet and green despite the winter. No other people, no animals.\n\n**LIGHT:** Soft, warm garden light from the front-left, gentle and even, with a warm fill so the face stays bright and clear. Light is soft and golden, never harsh midday sun.\n\n**COLOUR:** Deep green, soft red, cream, and warm gold \u2014 a garden palette, alive and warm. Greens are deep and alive; skin tones are warm and natural.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, mistletoe branches and roses behind, shallow depth of field so the garden melts into warm green bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Gentle and full of quiet joy \u2014 a garden that stays green all winter. A soft, happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids north-pole-post-office
  "north-pole-post-office": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the North Pole: a warm red winter coat, cream knitted scarf, and red mittens, holding a sealed envelope in one hand. Cosy winter clothes, not a costume.\n\n**SETTING:** Inside the North Pole post office: wooden counters, shelves of neatly stacked letters and parcels, a big red post box, warm lanterns, a decorated tree in the corner, a window showing soft falling snow outside. The room is busy with Christmas mail but calm and tidy. No other people, no animals.\n\n**LIGHT:** Warm indoor light from the front-left, soft and golden on the child's face, with gentle fill from the lanterns so no part of the face is lost in shadow. Warm, never orange or blown out.\n\n**COLOUR:** Warm red, honey brown wood, cream paper, and soft gold \u2014 a cosy working palette. Skin stays natural and warm.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, post box and shelves behind, shallow depth of field so the parcels melt into soft warm bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Excited and full of hope \u2014 the most important letter of the year, posted. A bright, proud smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids snowman-friend
  "snowman-friend": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for building a snowman: a warm red winter coat, navy knitted scarf, and red mittens, one mitten dusted with snow. Real winter clothes, zipped up.\n\n**SETTING:** In a snowy garden beside a friendly snowman: the snowman wears a carrot nose, coal eyes, and a small red scarf, a decorated tree behind, soft snow falling, a few snowballs resting on the ground. The snowman is charming and clearly made of snow, never a person. No other people, no animals.\n\n**LIGHT:** Soft, bright winter daylight from the front-left, cool and even, with a gentle warm fill on the child's face. Face bright, clear, and evenly lit, no harsh shadows.\n\n**COLOUR:** Luminous white snow, classic red, deep navy, and pine green \u2014 a bright, cheerful palette. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, snowman and tree behind, shallow depth of field so the snow softens into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Pure winter fun \u2014 a new friend, made of snow. A big laughing smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids christmas-bakery
  "christmas-bakery": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for baking: a cream knitted jumper with a red-and-white striped apron, a little flour on one cheek, sleeves rolled up. Homely and real, not a costume.\n\n**SETTING:** In a warm Christmas bakery: wooden counters, trays of mince pies and gingerbread cooling on racks, jars of cinnamon and dried oranges, a decorated tree in the window, warm oven light glowing. The bakery smells of Christmas. No other people, no animals.\n\n**LIGHT:** Warm oven and window light from the front-left, soft and golden on the child's face, with gentle fill so no part of the face is lost in shadow. Warm, never orange or blown out.\n\n**COLOUR:** Warm cream, honey brown, cinnamon red, and soft gold \u2014 a baking palette. Skin stays natural and warm, never orange.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on a 50mm lens at f/2.0, head-to-waist framing, the child centred with breathing room above the head, bakery counters and tree behind, shallow depth of field so the jars and lights melt into soft warm bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, happy, and a little bit proud \u2014 the best baker in the bakery. A proud smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids twinkle-star-meadow
  "twinkle-star-meadow": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a starry night: a warm deep-blue winter coat with a cream knitted scarf and cream bobble hat. Cosy winter clothes, not a costume.\n\n**SETTING:** In a snowy meadow at night where small stars glow softly among the snow: the child stands in a field of gentle starlight, pine trees at the edges, a deep blue sky full of stars above, soft snow sparkling underfoot. The stars are small and magical, like fireflies in the snow. No other people, no animals.\n\n**LIGHT:** Soft starlight from above and front, gentle and even, with a warm fill on the child's face so it stays bright, clear, and natural. No harsh shadows, no dark face.\n\n**COLOUR:** Deep midnight blue, soft silver starlight, warm cream, and luminous white snow \u2014 a quiet night palette. Skin stays natural and warm, never blue.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, starlit meadow and pines behind, shallow depth of field so the stars soften into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet wonder \u2014 a meadow full of fallen stars. A soft, amazed smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids polar-bear-picnic
  "polar-bear-picnic": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a snowy picnic: a warm cream winter coat, red knitted scarf, and red mittens, holding a small mug of cocoa. Cosy winter clothes, not a costume.\n\n**SETTING:** At a snowy picnic in a bright winter clearing: a red-and-white checked blanket spread on the snow with a basket and a plate of biscuits, a gentle polar bear sitting calmly nearby at a friendly distance, pine trees dusted with snow, soft snow falling. The bear is calm and kind, clearly in the background. No other people.\n\n**LIGHT:** Soft, bright winter daylight from the front-left, cool and even, with a gentle warm fill on the child's face. Face bright, clear, and evenly lit, no harsh shadows.\n\n**COLOUR:** Crisp white snow, warm cream, cheerful red, and pine green \u2014 a bright picnic palette. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, picnic blanket and pines behind, shallow depth of field so the snow softens into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Cheerful and a little bit brave \u2014 a picnic guest like no other. A big happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids snowy-wishing-well
  "snowy-wishing-well": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a winter wish: a warm forest-green winter coat, cream knitted scarf, and cream mittens, holding a small coin in one hand. Cosy winter clothes, not a costume.\n\n**SETTING:** Beside an old stone wishing well in a snowy garden: the well is dressed with holly and warm fairy lights, a small decorated tree nearby, soft snow falling, a stone path dusted with snow. The garden is quiet and still. No other people, no animals.\n\n**LIGHT:** Soft winter daylight from the front-left, cool and bright, warmed by the golden fairy lights on the child's face. Face bright, clear, and evenly lit.\n\n**COLOUR:** Forest green, warm cream, soft gold, and luminous white snow \u2014 a quiet, hopeful palette. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, wishing well and tree behind, shallow depth of field so the lights melt into soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Hopeful and hushed \u2014 a wish, made properly. A soft, hopeful smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids holly-berry-wood
  "holly-berry-wood": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a winter wood: a warm deep-red winter coat with a cream knitted scarf, hair loose. Real winter clothes, zipped up.\n\n**SETTING:** In a quiet winter wood: holly bushes heavy with red berries, bare branches dusted with snow, a robin perched on a branch nearby, soft light through the trees, a path of fallen leaves and snow. The wood is alive and green despite the winter. No other people.\n\n**LIGHT:** Soft, warm woodland light from the front-left, gentle and even, with a warm fill so the face stays bright and clear. Light is soft and golden, never harsh.\n\n**COLOUR:** Deep green holly, bright red berries, cream, and warm gold \u2014 a woodland palette, alive and warm. Greens are deep and alive; skin tones are warm and natural.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, holly and branches behind, shallow depth of field so the wood melts into warm green bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Gentle and curious \u2014 a wood full of small Christmas wonders. A soft, curious smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids angel-choir
  "angel-choir": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the choir: a simple cream robe-style dress or a cream jumper with a soft golden sash, hair neat. Simple and angelic, not a costume \u2014 no wings, no halo.\n\n**SETTING:** In a softly lit hall at dusk: tall candles glowing, a decorated tree with warm white lights, soft golden light falling through a high window, gentle snow visible outside. The hall is quiet and golden. No other people, no animals.\n\n**LIGHT:** Warm golden light from the front-left, soft and flattering, with gentle fill so the face is bright and clear, never in hard shadow. A soft glow around the child, like candlelight.\n\n**COLOUR:** Warm gold, soft cream, and deep blue dusk through the window \u2014 a golden, glowing palette. Warm gold dominates; no cold blue cast on skin.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, candles and tree behind, shallow depth of field so the candlelight melts into soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Peaceful and full of light \u2014 a song that fills the whole hall. A gentle, shining smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids winter-fair
  "winter-fair": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the fair: a warm red winter coat, cream knitted scarf, and a red bobble hat, holding a small candy apple. Cosy winter clothes, not a costume.\n\n**SETTING:** At a winter fair at dusk: strings of golden lights overhead, a small carousel glowing in the background, stalls with striped awnings and warm windows, gentle snow falling, a decorated tree at the centre of the fair. The fair is joyful and the square is quiet except for the child \u2014 no crowd, no strangers.\n\n**LIGHT:** Golden-hour fair light: low warm light from the front-right on the child's face, golden rim light on hair and coat, fair lights sparkling behind. Face bright and cinematic, never silhouetted, never in hard shadow.\n\n**COLOUR:** Rich gold, deep red, warm cream, and soft blue dusk \u2014 a golden fairground palette. Warm gold dominates; no cold blue cast on skin.\n\n**LENS & COMPOSITION:** Cinematic child portrait, shot on a 50mm lens at f/2.0, head-to-waist framing, the child centred and slightly low in the frame with the fair lights towering behind, shallow depth of field, gentle glow around the lights. Portrait orientation, 3:4.\n\n**MOOD:** Excited and full of laughter \u2014 the best night of the winter. A big joyful smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids candlelight-chapel
  "candlelight-chapel": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a quiet evening: a soft cream knitted jumper with a deep-green coat over it and a red knitted scarf, hands warm in pockets. Simple and warm, not a costume.\n\n**SETTING:** Inside a little chapel at night: rows of candles glowing on the windowsills, a small decorated tree by the door, a wreath on the wall, soft snow falling outside the windows. The chapel is small, quiet, and full of warm light. No other people, no animals.\n\n**LIGHT:** Warm candlelight from the front-left, soft and golden on the child's face, with gentle fill so no part of the face is lost in shadow. Warm, intimate, never orange or blown out.\n\n**COLOUR:** Warm amber, cream, deep green, and soft gold \u2014 a candlelit palette. Skin tones stay natural and warm, never orange. Shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic intimate child portrait, shot on a 50mm lens at f/2.0, head-to-waist framing, the child centred, candles and tree behind, shallow depth of field so the candlelight becomes soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet, safe, and full of peace \u2014 a little light in the winter dark. A soft, peaceful smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids snowflake-castle
  "snowflake-castle": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a royal winter visit: a pale-blue velvet dress or a smart navy coat with a cream shirt, simple and elegant. Formal but comfortable \u2014 no crown, no cape, no costume jewellery.\n\n**SETTING:** In a castle built of giant snowflakes: lacy white snowflake walls and towers, sparkling in soft light, a decorated tree with silver and white ornaments, a frozen fountain, soft snow falling outside tall windows. The castle is delicate and beautiful, like lace made of snow. No other people, no animals.\n\n**LIGHT:** Soft, directional light from the front-left, like a great formal portrait, with a gentle icy glow from the snowflake walls and warm fill from the tree lights so the face stays bright and natural. Skin luminous, never washed out, never blue.\n\n**COLOUR:** Lacy white, ice blue, silver, and warm gold tree-light \u2014 a delicate, regal palette with gold as the only warm accent. Shadows are deep and cool, never black holes.\n\n**LENS & COMPOSITION:** Formal photorealistic child portrait, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with generous breathing room above the head, snowflake towers and tree behind, shallow depth of field, tree lights as soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Delicate and full of wonder \u2014 a castle no winter could ever melt. A gentle, amazed smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids peppermint-lane
  "peppermint-lane": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a sweet winter walk: a warm red-and-white striped scarf over a cream winter coat, and red mittens. Cosy winter clothes, not a costume.\n\n**SETTING:** On a little snowy lane of peppermint shops: striped awnings, sweet jars glowing in the windows, a decorated tree at the end of the lane, soft snow falling, warm lights in every window. The lane is quiet and sweet. No other people, no animals.\n\n**LIGHT:** Soft, even winter light from above and front, with warm shop-window glow on the child's face. Face bright, clear, and evenly lit, no harsh shadows.\n\n**COLOUR:** Peppermint red, crisp white, soft green, and warm gold window-light \u2014 a sweet, clean palette. Snow is luminous white; skin stays natural.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, sweet shops and tree behind, shallow depth of field so the windows melt into soft warm bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Sweet and cheerful \u2014 a lane that smells of peppermint and snow. A happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids robin-s-garden
  "robin-s-garden": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a winter garden: a warm forest-green winter coat with a cream knitted scarf, holding a small handful of birdseed. Real winter clothes, zipped up.\n\n**SETTING:** In a snowy garden: a robin with a red breast perched on a branch close by, holly and winter roses, a stone bird table dusted with snow, warm lanterns along the path, a small decorated tree in the corner. The garden is quiet and green despite the winter. No other people.\n\n**LIGHT:** Soft, warm garden light from the front-left, gentle and even, with a warm fill so the face stays bright and clear. Light is soft and golden, never harsh midday sun.\n\n**COLOUR:** Deep green, robin red, cream, and warm gold \u2014 a garden palette, alive and warm. Greens are deep and alive; skin tones are warm and natural.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, robin and holly behind, shallow depth of field so the garden melts into warm green bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Gentle and full of quiet joy \u2014 a small bird, a big Christmas. A soft, delighted smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids moonlit-toboggan
  "moonlit-toboggan": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a moonlit ride: a warm navy winter coat, red knitted scarf, and a red bobble hat, sitting on a wooden toboggan with a blanket over the lap. Cosy winter clothes, not a costume.\n\n**SETTING:** On a snowy hill at night: the child sits on a wooden toboggan at the top of a gentle slope, moonlight on the snow, pine trees dusted with snow on either side, stars overhead, a small decorated tree glowing at the bottom of the hill. The night is calm and the hill looks safe and fun. No other people, no animals.\n\n**LIGHT:** Cool moonlight from above and front, with a warm fill on the child's face so it stays bright, clear, and natural. No harsh shadows, no dark face.\n\n**COLOUR:** Deep midnight blue, luminous white snow, warm red, and soft silver moonlight \u2014 a quiet night palette. Skin stays natural and warm, never blue.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, moonlit hill and pines behind, shallow depth of field so the trees soften into dark bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Excited and a little bit brave \u2014 the best hill, the best night. A big excited smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids christmas-library
  "christmas-library": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for story time: a soft cream knitted jumper with a red Santa hat with white fur trim and a red knitted scarf, sitting with a big Christmas picture book open on the lap. Cosy and comfortable, not a costume.\n\n**SETTING:** In a warm old library at night: tall wooden shelves full of books, a small decorated tree with warm white lights, a reading lamp glowing, a window showing soft falling snow, a few wrapped presents on a low table. The library is quiet and full of stories. No other people, no animals.\n\n**LIGHT:** Warm lamplight from the front-left, soft and golden on the child's face, with gentle fill from the tree lights so no part of the face is lost in shadow. Warm, intimate, never orange or blown out.\n\n**COLOUR:** Warm honey brown wood, cream pages, deep green, and soft gold \u2014 a library palette. Skin tones stay natural and warm, never orange. Shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic intimate child portrait, shot on a 50mm lens at f/2.0, head-to-waist framing, the child centred, bookshelves and tree behind, shallow depth of field so the lamp and tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet and full of wonder \u2014 the best story, read by lamplight. A soft, happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids woodland-friends
  "woodland-friends": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the woods: a warm forest-green winter coat, cream knitted scarf, and cream mittens. Real winter clothes, zipped up.\n\n**SETTING:** In a snowy woodland clearing: a gentle deer, a fox, and a rabbit resting calmly at a friendly distance among the pines, a small decorated tree, soft snow falling, a few red berries on a branch. The animals are calm and clearly in the background, never crowding the child. No other people.\n\n**LIGHT:** Soft winter daylight from the front-left, cool and bright, warmed by a gentle golden fill on the child's face. Face bright, clear, and evenly lit.\n\n**COLOUR:** Forest green, warm cream, soft brown, and luminous white snow \u2014 a natural woodland palette. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, woodland animals and pines behind, shallow depth of field so the trees soften into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Gentle and full of wonder \u2014 Christmas shared with the whole wood. A soft, delighted smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids festival-of-lights
  "festival-of-lights": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the festival: a warm deep-red winter coat, cream knitted scarf, and cream mittens, holding a small glowing paper star. Cosy winter clothes, not a costume.\n\n**SETTING:** At a festival of lights at dusk: strings of warm golden lights overhead, glowing paper stars and lanterns in every window, a huge decorated tree at the centre, soft snow falling, the whole town glowing gold against the blue dusk. The square is quiet except for the child \u2014 no crowd, no strangers.\n\n**LIGHT:** Low winter dusk light, cool blue-grey ambient, warmed by the golden glow of the festival lights falling on the child's face from the front-left. Face bright, clear, and evenly lit, no harsh flash.\n\n**COLOUR:** Deep blue dusk, warm gold light, classic red, and luminous white snow \u2014 a glowing festival palette. The gold is warm metallic, never yellow. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, glowing tree and lights behind, shallow depth of field so the lights melt into soft golden bokeh \u2014 but the paper star stays sharp. Portrait orientation, 3:4.\n\n**MOOD:** Warm, proud, and full of light \u2014 the whole town shining at once. A bright, happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids toy-soldier-parade
  "toy-soldier-parade": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the parade: a smart red coat with gold buttons and a small red cap, like a toy soldier's uniform made soft and warm. Playful and smart, not a stiff costume.\n\n**SETTING:** In a snowy town square at dusk: a parade of wooden toy soldiers marching in neat rows, drums and flags, a decorated tree glowing, warm shop windows, gentle snow falling. The soldiers are charming wooden toys, clearly in the background. No other people.\n\n**LIGHT:** Golden-hour light from the front-right on the child's face, golden rim light on hair and coat, parade lights sparkling behind. Face bright and cinematic, never silhouetted, never in hard shadow.\n\n**COLOUR:** Rich gold, deep red, warm cream, and soft blue dusk \u2014 a golden parade palette. Warm gold dominates; no cold blue cast on skin.\n\n**LENS & COMPOSITION:** Cinematic child portrait, shot on a 50mm lens at f/2.0, head-to-waist framing, the child centred and slightly low in the frame with the parade and tree towering behind, shallow depth of field, gentle glow around the lights. Portrait orientation, 3:4.\n\n**MOOD:** Proud and full of marching spirit \u2014 the grandest parade in town. A big proud smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids frosty-pond-skating
  "frosty-pond-skating": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for skating: a warm red winter coat, cream knitted scarf, mittens, and ice skates, standing on the ice with a steady, happy pose. Real winter clothes and real skates, not a costume.\n\n**SETTING:** On a frozen pond at sunset: smooth ice with a dusting of snow at the edges, pine trees dusted with snow around the pond, a small decorated tree on the bank, warm golden sunset light, soft snow falling. The pond is calm and safe. No other people, no animals.\n\n**LIGHT:** Low winter sunset light from the front-left, warm gold on the child's face, with cool blue ambient from the snow. Face bright, clear, and evenly lit, no harsh flash.\n\n**COLOUR:** Warm sunset gold, deep red, cream, and luminous white snow \u2014 a glowing winter palette. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, frozen pond and pines behind, shallow depth of field so the trees melt into soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Free and joyful \u2014 gliding on ice at the golden hour. A big happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids christmas-tree-farm
  "christmas-tree-farm": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the tree farm: a warm forest-green winter coat, red knitted scarf, and red mittens, holding a small pair of garden shears safely in one hand. Real winter clothes, zipped up.\n\n**SETTING:** At a Christmas tree farm on a bright winter day: neat rows of pine trees dusted with snow, a small wooden hut with warm glowing windows, a decorated tree by the hut, soft snow falling, a little red wagon with a freshly cut tree. The farm is quiet and sunny. No other people, no animals.\n\n**LIGHT:** Bright, soft winter daylight from the front-left, cool and even, with a gentle warm fill on the child's face. Face bright, clear, and evenly lit, no harsh shadows.\n\n**COLOUR:** Forest green, warm red, cream, and luminous white snow \u2014 a fresh, sunny palette. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, rows of pines behind, shallow depth of field so the trees soften into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Proud and excited \u2014 the perfect tree, found at last. A big proud smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids sweet-shop
  "sweet-shop": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the sweet shop: a soft cream knitted jumper with a red apron, holding a small paper bag of sweets. Homely and real, not a costume.\n\n**SETTING:** Inside a little old-fashioned sweet shop: wooden shelves with glass jars of sweets, candy canes and striped rock, a decorated tree in the window, warm golden light, a counter with a brass bell and a tray of wrapped toffees. The shop is sweet and warm. No other people, no animals.\n\n**LIGHT:** Warm indoor light from the front-left, soft and golden on the child's face, with gentle fill from the window so no part of the face is lost in shadow. Warm, never orange or blown out.\n\n**COLOUR:** Warm cream, candy red, honey brown wood, and soft gold \u2014 a sweet, warm palette. Skin stays natural and warm.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on a 50mm lens at f/2.0, head-to-waist framing, the child centred with breathing room above the head, sweet jars and tree behind, shallow depth of field so the jars melt into soft warm bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Sweet and delighted \u2014 the best shop in the whole town. A delighted smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids snowy-lighthouse
  "snowy-lighthouse": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the coast: a warm navy winter coat with a fur-trimmed hood down, and a cream knitted hat. Real winter clothes, zipped up.\n\n**SETTING:** Beside a snowy lighthouse at dusk: the lighthouse beam sweeping softly across a calm snowy sea, snow-covered rocks, a small decorated tree by the lighthouse door, warm golden light in the lighthouse windows, soft snow falling. The sea is calm and the night is quiet. No other people, no animals.\n\n**LIGHT:** Soft dusk light from above and front, cool and even, warmed by the golden lighthouse windows on the child's face. Face bright, clear, and evenly lit, no harsh shadows.\n\n**COLOUR:** Deep navy sea, luminous white snow, warm gold window-light, and soft silver beam \u2014 a calm coastal palette. Skin stays natural, never blue.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, lighthouse and sea behind, shallow depth of field so the beam softens into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Calm and quietly brave \u2014 a light that guides everyone home. A gentle, proud smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids arctic-fox-den
  "arctic-fox-den": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the snow: a warm cream winter coat, forest-green knitted scarf, and cream mittens. Real winter clothes, zipped up.\n\n**SETTING:** Outside a cosy arctic fox den in soft snow: a little white arctic fox curled up calmly nearby at a friendly distance, snow-covered rocks, pine trees dusted with snow, a small decorated tree, soft snow falling, a pale winter sun. The fox is calm and clearly in the background. No other people.\n\n**LIGHT:** Soft, bright winter daylight from the front-left, cool and even, with a gentle warm fill on the child's face. Face bright, clear, and evenly lit, no harsh shadows.\n\n**COLOUR:** Crisp white snow, warm cream, forest green, and soft grey rock \u2014 a clean, bright palette. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, fox den and pines behind, shallow depth of field so the snow softens into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Gentle and full of wonder \u2014 a new friend, small and white as snow. A soft, delighted smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids christmas-eve-window
  "christmas-eve-window": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for Christmas Eve: a soft cream nightdress-style dress or cream pyjamas with a warm woollen dressing gown over them, hair loose, and a red Santa hat with white fur trim. Cosy and sleepy, not a costume.\n\n**SETTING:** At a window on Christmas Eve night: the child looks out at soft falling snow, a decorated tree glowing behind them in the room, a small stocking hung by the fireplace, warm lamplight, stars in the night sky outside. The room is warm and the night is full of promise. No other people, no animals.\n\n**LIGHT:** Warm lamplight from the front-left, soft and golden on the child's face, with cool starlight from the window behind. Face bright, clear, and warmly lit, never orange or blown out.\n\n**COLOUR:** Warm amber, cream, deep night blue, and soft gold \u2014 a Christmas Eve palette. Skin tones stay natural and warm, never orange. Shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic intimate child portrait, shot on a 50mm lens at f/2.0, head-and-shoulders to head-to-waist framing, the child centred, window and tree behind, shallow depth of field so the tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Sleepy, hopeful, and full of wonder \u2014 waiting for the best morning of the year. A soft, sleepy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids night-train-to-the-north-pole
  "night-train-to-the-north-pole": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a night journey: a warm red winter coat, cream knitted scarf, and a small suitcase in one hand, a ticket tucked in the coat pocket. Cosy winter clothes, not a costume.\n\n**SETTING:** On a snowy station platform at night: a grand old steam train with warm golden windows and soft steam, a decorated tree on the platform, strings of golden lights, stars overhead, soft snow falling. The train is warm and welcoming, ready to leave. No other people, no animals.\n\n**LIGHT:** Golden station light from the front-right on the child's face, golden rim light on hair and coat, train windows sparkling behind. Face bright and cinematic, never silhouetted, never in hard shadow.\n\n**COLOUR:** Rich gold, deep midnight blue, warm cream, and soft white steam \u2014 a golden night palette. Warm gold dominates; no cold blue cast on skin.\n\n**LENS & COMPOSITION:** Cinematic child portrait, shot on a 50mm lens at f/2.0, head-to-waist framing, the child centred and slightly low in the frame with the train towering behind, shallow depth of field, gentle glow around the lights. Portrait orientation, 3:4.\n\n**MOOD:** Excited and full of adventure \u2014 all aboard for the North Pole. A big excited smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids snowy-owl-s-hollow
  "snowy-owl-s-hollow": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the woods: a warm deep-blue winter coat, cream knitted scarf, and cream mittens. Real winter clothes, zipped up.\n\n**SETTING:** In a snowy hollow among old pine trees: a snowy owl with soft white feathers perched calmly on a branch nearby, a small decorated tree, soft snow falling, a pale moon through the branches, a path of untouched snow. The hollow is quiet and still. No other people.\n\n**LIGHT:** Soft moonlight from above and front, gentle and even, with a warm fill on the child's face so it stays bright, clear, and natural. No harsh shadows, no dark face.\n\n**COLOUR:** Deep midnight blue, luminous white snow, soft silver moonlight, and warm cream \u2014 a quiet night palette. Skin stays natural and warm, never blue.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, owl and pines behind, shallow depth of field so the trees soften into dark bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet and wise \u2014 a hollow that keeps its secrets. A soft, wondering smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids snowy-picnic
  "snowy-picnic": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for a snowy picnic: a warm red winter coat, cream knitted scarf, and red mittens, holding a small mug of cocoa with both hands. Cosy winter clothes, not a costume.\n\n**SETTING:** At a snowy picnic in a bright winter clearing: a red-and-white checked blanket spread on the snow with a basket, a flask, and a plate of biscuits, pine trees dusted with snow, a small decorated tree, soft snow falling. The picnic is simple and joyful. No other people, no animals.\n\n**LIGHT:** Soft, bright winter daylight from the front-left, cool and even, with a gentle warm fill on the child's face. Face bright, clear, and evenly lit, no harsh shadows.\n\n**COLOUR:** Crisp white snow, cheerful red, warm cream, and pine green \u2014 a bright picnic palette. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic child portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, the child centred with breathing room above the head, picnic blanket and pines behind, shallow depth of field so the snow softens into gentle bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Cheerful and cosy \u2014 cocoa tastes best in the snow. A big happy smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids christmas-merry-go-round
  "christmas-merry-go-round": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for the fair: a warm cream winter coat with a red knitted scarf and red mittens, sitting on a painted carousel horse. Cosy winter clothes, not a costume.\n\n**SETTING:** On a golden Christmas merry-go-round at dusk: painted horses, warm golden lights, mirrors, a decorated tree at the centre, soft snow falling outside the carousel, warm shop windows in the background. The carousel is glowing and joyful. No other people, no animals.\n\n**LIGHT:** Golden-hour light from the front-right on the child's face, golden rim light on hair and coat, carousel lights sparkling behind. Face bright and cinematic, never silhouetted, never in hard shadow.\n\n**COLOUR:** Rich gold, deep red, warm cream, and soft blue dusk \u2014 a golden fairground palette. Warm gold dominates; no cold blue cast on skin.\n\n**LENS & COMPOSITION:** Cinematic child portrait, shot on a 50mm lens at f/2.0, head-to-waist framing, the child centred and slightly low in the frame with the carousel towering behind, shallow depth of field, gentle glow around the lights. Portrait orientation, 3:4.\n\n**MOOD:** Pure joy \u2014 round and round, under the golden lights. A big laughing smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Kids fireside-story-time
  "fireside-story-time": KIDS_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** One child, dressed for story time: a soft cream knitted jumper with a red Santa hat with white fur trim, wrapped in a plaid blanket, holding a big Christmas picture book open on the lap. Cosy and lived-in, not new-out-of-the-packet.\n\n**SETTING:** In a warm living room at night: the child sits near a lit stone fireplace with a real wood fire, stockings hung on the mantelpiece, a small decorated tree with warm white lights to one side, a few wrapped presents on the floor, a knitted blanket over the arm of a chair. No other people, no animals.\n\n**LIGHT:** Firelight as the key light: warm amber glow from the front-left falling softly on the child's face, with gentle fill from the tree lights so no part of the face is lost in shadow. Warm, intimate, never orange or blown out.\n\n**COLOUR:** Warm amber, rust, oatmeal, and cream \u2014 a fireside palette. Skin tones stay natural and warm, never orange. Shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic intimate child portrait, shot on a 50mm lens at f/2.0, close head-and-shoulders to head-to-waist framing, the child centred, fireplace glow behind, shallow depth of field so the fire and tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet, safe, deeply cosy \u2014 the best story, told by the fire. A soft, content smile, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the child's face, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the child's face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at the sides or holding one simple object, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family christmas-morning
  "christmas-morning": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, in soft matching knit jumpers and plaid pyjama bottoms, sitting together on a thick rug on the living-room floor on Christmas morning. The daughter holds a half-opened present with both hands; the son holds a wrapped box tied with a red ribbon. Clothes are soft, comfortable, and real \u2014 no costumes, no novelty outfits.\n\n**SETTING:** A warm living room at first light, a tall decorated Christmas tree with warm white lights and simple red and gold baubles beside them, wrapped presents and torn wrapping paper on the rug, two steaming mugs of hot chocolate on a low wooden table, a fireplace glowing softly to one side, soft snow falling outside the window. No strangers, no animals, no Santa figure.\n\n**LIGHT:** Soft, pale Christmas-morning light coming through the window from the front-left, warmed by the fire and the tree lights so every face is bright, clear, and evenly lit. Gentle, calm, never harsh, never orange.\n\n**COLOUR:** Warm cream, deep forest green, classic Christmas red, and soft gold \u2014 a quiet morning palette. Snow outside the window is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, tree directly behind them, shallow depth of field so the background lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Sleepy, happy, and unhurried \u2014 the best hour of Christmas Day, everyone still together on the floor before breakfast. Genuine relaxed smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands hold presents simply, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family snowy-cabin
  "snowy-cabin": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for snow: father in a dark green waxed winter coat; mother in a deep-red winter coat with a cream knitted scarf; daughter in a red coat with a cream bobble hat; son in a navy coat with a green bobble hat. Real winter coats, zipped up, collars up against the cold \u2014 no costumes.\n\n**SETTING:** Outdoors on the wooden porch of a small log cabin in a pine forest, snow falling softly all around, a wreath on the cabin door, a decorated Christmas tree glowing warmly through the cabin window behind them, deep snow on the porch rail and on the pine branches, footprints in the snow behind them. No strangers, no animals, no sleigh.\n\n**LIGHT:** Soft, even winter daylight from the front, warmed by the golden glow of the cabin window falling on their faces from behind and to one side. Faces are bright, clear, and evenly lit \u2014 no face in shadow, no harsh flash. Snowflakes catching the light.\n\n**COLOUR:** Deep pine green, warm cream, classic Christmas red, and soft gold window-light against white snow \u2014 restrained and calm, not saturated. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, cabin door and glowing window directly behind them, shallow depth of field so the falling snow and pine branches melt into soft bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet, fresh, and content \u2014 a family that has stepped out into the snow for one photograph before going back inside to the fire. Genuine relaxed smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family victorian-christmas
  "victorian-christmas": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for a Victorian Christmas: father in a dark charcoal frock coat with a cream shirt; mother in a deep burgundy gown with a lace collar and a gold brooch; daughter in a cream dress with a red sash; son in a small dark suit with a white collar. Elegant 19th-century dress, tailored and timeless \u2014 no costumes, no novelty, no crowns or tiaras.\n\n**SETTING:** A candlelit Victorian parlour at night, a tall Christmas tree dressed with real candles, dried orange slices, paper ornaments and red ribbons behind them, a fireplace with a gentle fire to one side, garlands of holly and ivy along the mantelpiece, a few wrapped parcels in brown paper and string on the floor. No strangers, no animals, no modern objects.\n\n**LIGHT:** Warm candlelight as the key light: soft amber glow from the front-left falling on their faces, gentle fill from the fire so no face is lost in shadow, candle flames soft and out of focus behind them. Warm, intimate, never orange or blown out.\n\n**COLOUR:** Deep burgundy, charcoal, cream, warm gold candlelight, and dark green holly \u2014 a rich, old-fashioned palette. Shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, tree directly behind them, shallow depth of field so the candles melt into soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Stately, warm, and old-fashioned \u2014 the Christmas portrait a family keeps above the fireplace for a generation. Calm, gentle smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, rich warm colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No modern objects, no electric lights, no plastic ornaments. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family rustic-farmhouse
  "rustic-farmhouse": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for a farmhouse Christmas: father in a red-and-cream plaid shirt over a white T-shirt; mother in a soft oatmeal knit jumper with a plaid scarf; daughter in a cream jumper with a red bow in her hair; son in a forest-green jumper. Simple, lived-in clothes, slightly worn, not new-out-of-the-packet \u2014 no costumes, no novelty jumpers.\n\n**SETTING:** A warm farmhouse kitchen at night, exposed wooden beams above, a wood-burning stove glowing to one side, a simple pine tree with wooden ornaments, dried orange slices and a string of warm white lights beside them, mason jars with candles and a jug of pine branches on the wooden table, a knitted blanket over a chair. No television, no clutter, no other people.\n\n**LIGHT:** Warm, soft kitchen light from the front-left, with the amber glow of the stove filling the shadows so no face is dark. Gentle, homely, never orange or blown out.\n\n**COLOUR:** Warm oatmeal, rust red, forest green, cream, and natural wood brown \u2014 an earthy, homemade palette. Skin tones stay natural and warm, never orange. Shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on a 50mm lens at f/2.0, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family grouped close together and centred, tree and stove behind them, shallow depth of field so the candles and lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Easy, honest, and homely \u2014 Christmas at the farmhouse table, everyone relaxed and at ease. Soft genuine smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, warm natural colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family tropical-christmas
  "tropical-christmas": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for a warm Christmas by the sea: father in a crisp white short-sleeved linen shirt; mother in a flowing coral dress with a flower in her hair; daughter in a light cream dress with a flower garland; son in a smart white shirt with rolled sleeves and light shorts. Light, elegant, warm-weather clothes \u2014 no winter coats, no scarves, no wool, no fake snow on clothes.\n\n**SETTING:** A warm beach at sunset, a tall palm tree dressed with warm white fairy lights, red and gold baubles and shells beside them, soft sand underfoot, the ocean and a soft pink-and-gold sky behind, a few lanterns glowing on the sand. No snow, no pine forest, no northern winter.\n\n**LIGHT:** Warm tropical sunset light: low golden sun from the front-left, warm lantern glow filling the shadows, faces bright, warm, and clear. Golden, soft, glowing light \u2014 never cold, never blue, never harsh midday sun.\n\n**COLOUR:** Warm gold, coral, cream, soft pink, and deep sea green \u2014 a warm, bright, celebratory palette. Skin tones are warm and natural.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, lit palm tree and ocean behind them, shallow depth of field so the sea and lanterns melt into warm golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Joyful, warm, and easy \u2014 Christmas as this family actually lives it, barefoot and full of light, relaxed genuine smiles to camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, rich warm colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No snow, no winter coats, no scarves, no pine forest, no northern winter cliches. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family midnight-church
  "midnight-church": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for midnight church: father in a dark charcoal wool coat over a cream scarf; mother in an elegant deep-green wool coat with a gold brooch; daughter in a deep-red coat with a cream bobble hat held in her hand; son in a charcoal coat with a navy scarf. Formal, warm, tailored winter dress \u2014 no costumes, no novelty.\n\n**SETTING:** Inside a beautiful old stone church at midnight, the family standing together in the aisle, hundreds of candles glowing on stands around them, a tall Christmas tree with warm white lights and gold ornaments beside the altar, wreaths and garlands along the pews, soft snow falling outside the tall arched windows. No congregation, no strangers, no clergy in frame.\n\n**LIGHT:** Candlelight as the key light: hundreds of soft amber candle flames from the front and sides falling gently on their faces, with cool moonlight from the windows behind so no face is lost in shadow. Warm, still, and reverent, never orange or blown out.\n\n**COLOUR:** Deep green, charcoal, deep red, warm gold candlelight, and cool midnight blue from the windows \u2014 a still, sacred palette with gold as the only bright accent. Shadows are deep and warm, never black holes.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, tree and candle stands behind them, shallow depth of field so the candles become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet, still, and full of wonder \u2014 the hush of midnight on Christmas Eve, everyone close together. Calm, gentle smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, rich warm-and-cool colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family golden-hour-snow
  "golden-hour-snow": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for snow at sunset: father in a camel wool coat over a cream roll-neck; mother in a deep-red wool coat with a gold scarf; daughter in a cream coat with a red bobble hat; son in a charcoal coat with a mustard scarf. Tailored, warm, expensive-looking winter dress \u2014 no novelty Christmas jumpers, no costumes.\n\n**SETTING:** Outdoors in a wide, open snowy field at sunset, untouched snow stretching to a line of snow-covered pine trees in the distance, a few gentle snowflakes drifting in the air, long soft shadows across the snow behind them, the sky a soft gradient of gold, pink, and pale blue. No buildings, no strangers, no animals, no sleigh.\n\n**LIGHT:** Low golden-hour sun from the front-right kissing their faces, long soft shadows, golden rim light on hair and coats, the whole field glowing warm. Faces bright and clear, never silhouetted, never in hard shadow.\n\n**COLOUR:** Rich warm gold, deep red, warm camel, charcoal, and cream against white snow \u2014 a golden, glowing palette with deep soft shadows. Warm gold dominates; no cold blue cast on skin.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on a 50mm lens at f/2.0, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred and slightly low in the frame with the glowing sky and pine line behind them, shallow depth of field, gentle glow around the snowflakes. Portrait orientation, 3:4.\n\n**MOOD:** Wide, golden, and full of wonder \u2014 the last light of Christmas Eve out in the snow, everyone together before dark. Confident, relaxed smiles to camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, rich golden colour grading, no noise, no JPEG artefacts, suitable for enlarging to canvas and poster print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family aurora-night
  "aurora-night": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for a cold northern night: father in a navy padded winter coat with a green knitted bobble hat; mother in a navy padded coat with a cream shearling collar and a green bobble hat; daughter in a navy coat over her green-and-gold knit jumper with a green bobble hat; son in a navy coat over his green-and-gold knit jumper with a green bobble hat. Real winter coats, zipped up, hats on \u2014 no costumes.\n\n**SETTING:** Outdoors on a snowy hill at night under rippling green and violet northern lights, a small decorated Christmas tree with warm white lights and gold baubles beside them, snow sparkling underfoot, a line of dark snow-covered pines and mountains far behind, a deep blue night sky full of stars. No buildings, no strangers, no animals.\n\n**LIGHT:** Soft, luminous night light from the aurora above and the tree lights beside them, with a gentle warm fill on their faces from the front so every face is bright, clear, and evenly lit. The sky glows green and violet; faces stay warm and natural, never green or blue. No harsh shadows, no dark faces.\n\n**COLOUR:** Deep midnight blue, aurora green and violet, navy, warm gold tree-light, and luminous white snow \u2014 a cool night scene with warm accents. Snow is luminous white; skin stays natural, never blue or green.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, tree to one side and the aurora filling the sky behind them, shallow depth of field, snowflakes sharp near the family and soft further back. Portrait orientation, 3:4.\n\n**MOOD:** Wonder and awe \u2014 the sky itself putting on a show for Christmas, the family looking up and then back to the camera. Bright, joyful, gentle smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, luminous night-sky detail, no noise, no JPEG artefacts, suitable for enlarging to canvas, ornament, and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family christmas-market
  "christmas-market": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for a cold evening out: father in a dark green wool coat with a cream scarf; mother in a deep-red wool coat with a knitted hat; daughter in a red coat with a cream bobble hat, holding a small paper cup with both hands; son in a navy coat with a green scarf, holding a small paper bag. Real winter coats, zipped up, collars up \u2014 no costumes.\n\n**SETTING:** A Christmas market at dusk, wooden stalls with striped awnings on either side strung with warm fairy lights, one stall piled with oranges and spices, another with wooden toys, strings of golden lights overhead, gentle snow in the air, a huge illuminated Christmas tree at the far end of the lane. The lane is empty except for the family \u2014 no crowd, no strangers.\n\n**LIGHT:** Warm stall-light and fairy-light glow from the front and sides falling softly on their faces, with cool blue dusk light behind so the family stands out warm against the evening. Faces bright and clear, never in hard shadow, never silhouetted.\n\n**COLOUR:** Warm gold, deep red, forest green, cream, and soft blue dusk \u2014 a bustling, glowing palette with warm light dominating. Skin tones stay natural and warm, never blue.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on a 50mm lens at f/2.0, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred in the market lane, stalls and lights leading the eye back to the tree behind them, shallow depth of field so the market lights melt into soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Bustling, joyful, and full of life \u2014 the best evening out before Christmas, everyone warm and happy with something small in their hands. Bright, relaxed smiles to camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, rich warm colour grading, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image, including on stall signs, cups, and bags. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 the daughter's hands hold the cup simply, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family frozen-pond
  "frozen-pond": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for skating: father in a navy winter coat and ice skates; mother in a deep-red winter coat with a cream knitted scarf; daughter in a red coat with a cream bobble hat and ice skates; son in a teal coat with a navy bobble hat and ice skates. Real winter coats and skates, scarves tucked in \u2014 no costumes.\n\n**SETTING:** Outdoors on a frozen pond at dusk, the family standing close together on the ice, snow-covered pine trees and a small wooden bridge behind them, warm lanterns on posts around the pond, a dusting of fresh snow on the ice, gentle snowflakes falling. No other skaters, no strangers, no animals.\n\n**LIGHT:** Soft blue dusk light from above, warmed by the golden glow of the lanterns falling on their faces from the front and sides. Faces bright, clear, and evenly lit \u2014 no face in shadow, no harsh flash. Lantern light sparkling on the ice.\n\n**COLOUR:** Icy blue-white, deep red, navy, teal, and warm gold lantern-light \u2014 a cool scene with warm accents. Ice is pale blue-white; skin stays natural, never blue.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred on the ice, pines and lanterns behind them, shallow depth of field so the lanterns melt into soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Playful, fresh, and full of laughter \u2014 the family that skated all afternoon and stopped for one photograph before hot chocolate. Bright, joyful smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, crisp ice and snow detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands. No one falling over, no blurred motion, no cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Family christmas-kitchen
  "christmas-kitchen": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, in aprons over soft home clothes: father in a cream jumper with a green apron; mother in a soft red jumper with a cream apron; daughter in a cream jumper with a small red apron, a dusting of flour on her cheek; son in a forest-green jumper with a small cream apron. Clothes are soft and lived-in, aprons plain with no writing \u2014 no costumes, no novelty.\n\n**SETTING:** A warm kitchen at night, the family gathered around a wooden table dusted with flour, a tray of star-shaped cookies ready for the oven, a bowl of dough, a rolling pin, and a jar of cinnamon sticks on the table, a small decorated tree with warm white lights on the counter behind them, a window showing soft snow falling outside. No television, no clutter, no other people.\n\n**LIGHT:** Warm, soft kitchen light from the front-left, with the gentle glow of the oven and the tree lights filling the shadows so no face is dark. Warm, homely, never orange or blown out.\n\n**COLOUR:** Warm cream, soft red, forest green, flour white, and natural wood brown \u2014 a homemade, cosy palette. Skin tones stay natural and warm, never orange. Shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on a 50mm lens at f/2.0, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family grouped close together around the table and centred, tree and window behind them, shallow depth of field so the tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Messy, happy, and together \u2014 the smell of baking in the air, everyone with flour on their hands and nowhere else to be. Soft genuine smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, warm natural colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image, including on aprons, jars, and packets. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands rest on the table or hold the rolling pin simply, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
  // Pet santa-s-little-helper
  "santa-s-little-helper": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed as Santa's little helper: a small red Santa suit with white fur trim and a Santa hat tilted back so the whole face stays fully visible. The suit is real soft fabric, well fitted, never covering the eyes, nose or mouth.\n\n**SETTING:** Outdoors in soft falling snow at dusk, sitting in front of a tall, naturally decorated Christmas tree with warm white fairy lights and simple red and gold baubles. Snow-covered pine branches frame the edges, a dusting of snow on the ground. No people, no other animals, no sleigh.\n\n**LIGHT:** Low winter dusk light, cool blue-grey ambient, warmed by the golden glow of the tree lights falling on the pet's face from the front-left. The face is bright, clear, and evenly lit \u2014 no face in shadow, no harsh flash. Gentle snowfall catching the light.\n\n**COLOUR:** Deep forest green, warm cream, classic Christmas red, and soft gold \u2014 restrained and elegant, not saturated. Snow is white with a faint blue shadow, never grey or yellow. Fur keeps its natural colour.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the pet centred and sitting, head and chest in frame with breathing room above the head, tree directly behind, shallow depth of field so the background lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, calm, timeless \u2014 the photograph a family frames and keeps for twenty years. The pet looks at the camera, relaxed and happy.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people, no extra limbs. No costume or prop covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet reindeer-pup
  "reindeer-pup": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, as a little reindeer: soft brown felt antlers on a comfortable headband that sits behind the ears, and a small red collar with a tiny gold bell. The antlers never cover the eyes or ears, and the whole face stays fully visible.\n\n**SETTING:** A snowy pine forest clearing at golden hour, gentle snow falling, a wooden sleigh with wrapped presents softly out of focus behind the pet. Snow-covered pines frame the edges. No people, no other animals, no Santa figure.\n\n**LIGHT:** Golden-hour light: low warm sun from the front-right on the pet's face, soft golden rim light on the fur and antlers, cool blue snow shadows behind. The face is bright and clear, never silhouetted, never in hard shadow.\n\n**COLOUR:** Warm gold, deep brown, classic Christmas red, and soft white snow \u2014 a warm, glowing palette. Fur keeps its natural colour; snow is white with a faint blue shadow.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the pet centred and sitting, head and chest in frame with breathing room above the antlers, sleigh softly behind, shallow depth of field. Portrait orientation, 3:4.\n\n**MOOD:** Joyful and playful \u2014 a pup ready to pull the sleigh, bright-eyed and proud, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No antlers, hat or prop covering the face or eyes. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet elf-cat
  "elf-cat": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a cat, dressed as a Christmas elf: a small green felt elf hat with a gold bell on the tip, worn tilted back between the ears, and a tiny green collar with a small gold bell. The hat never covers the eyes or ears, and the whole face stays fully visible.\n\n**SETTING:** A warm living room at night, the cat sitting beside a decorated Christmas tree with warm white fairy lights and gold baubles, a wrapped present beside it, a stone fireplace glowing softly to one side. No people, no other animals, no television, no clutter.\n\n**LIGHT:** Firelight as the key light: warm amber glow from the front-left falling softly on the cat's face, with gentle fill from the tree lights so no part of the face is lost in shadow. Warm, intimate, never orange or blown out.\n\n**COLOUR:** Warm amber, deep green, soft gold, and cream \u2014 a fireside palette. Fur keeps its natural colour and markings; shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the cat centred and sitting upright, head and chest in frame with breathing room above the hat, tree and fire behind, shallow depth of field so the fire and tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Mischievous and warm \u2014 the elf who runs the workshop, calm, bright-eyed, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No hat or collar covering the face, eyes or ears. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet snowman-dog
  "snowman-dog": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed for snow: a small red knitted scarf wrapped loosely around the neck, and a tiny black top hat tilted back so the whole face stays fully visible. Real knitted wool, soft and lived-in, never covering the eyes, nose or mouth.\n\n**SETTING:** Outdoors in fresh snow, the dog sitting beside a friendly snowman with a carrot nose, coal eyes and a red scarf, soft snow falling, a small decorated Christmas tree behind them, snow-covered pines in the distance. No people, no other animals.\n\n**LIGHT:** Soft, luminous, even winter light from above and front, as if the whole scene glows gently. The face is bright, clear, and evenly lit, with a faint cool sparkle from the snowflakes. No harsh shadows, no dark face.\n\n**COLOUR:** Icy blue-white, soft silver, classic Christmas red, and warm gold from the tree lights \u2014 a cool scene with warm accents. Snow is luminous white; fur keeps its natural colour, never blue.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the dog centred and sitting, head and chest in frame with breathing room above the hat, snowman beside it, tree behind, shallow depth of field, snowflakes sharp near the dog and soft further back. Portrait orientation, 3:4.\n\n**MOOD:** Wonder and delight \u2014 a dog's first snowman, bright, joyful, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, luminous snow detail, no noise, no JPEG artefacts, suitable for enlarging to canvas, ornament, and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No hat or scarf covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet christmas-pudding-pup
  "christmas-pudding-pup": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed for Christmas dinner: a small pudding-brown knitted jumper with a cream collar, real soft wool, well fitted, and a tiny sprig of holly pinned at the chest \u2014 never near the face. The whole face stays fully visible.\n\n**SETTING:** A warm dining room at night, the dog sitting beside a Christmas table dressed with a red tablecloth, gold candles, a Christmas pudding on a plate, and a small decorated tree with warm white lights behind. No people, no other animals, no food in the dog's mouth.\n\n**LIGHT:** Warm candlelight and tree light from the front-left falling softly on the pet's face, with gentle fill so no part of the face is lost in shadow. Warm, intimate, never orange or blown out.\n\n**COLOUR:** Warm brown, deep red, soft gold, and cream \u2014 a rich Christmas-dinner palette. Fur keeps its natural colour; shadows are warm brown, never black.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the dog centred and sitting, head and chest in frame with breathing room above the head, table and tree behind, shallow depth of field so the candles and tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, proud and well-fed \u2014 the guest of honour at Christmas dinner, relaxed, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No food in the pet's mouth, no costume covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet mistletoe-kitty
  "mistletoe-kitty": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a cat, dressed for a formal Christmas evening: a deep-green velvet collar with a small gold bell, and a sprig of mistletoe with white berries hanging above \u2014 never touching the face. The whole face stays fully visible, whiskers clear.\n\n**SETTING:** An elegant room at night, deep green walls, a tall decorated Christmas tree with warm white lights and gold ornaments behind, a marble fireplace with a gentle fire to one side, a large window showing soft falling snow outside. Understated luxury \u2014 no throne, no chandelier dominating the frame. No people, no other animals.\n\n**LIGHT:** Soft, directional portrait light from the front-left, like a great formal portrait: the face sculpted with gentle shadow on one side, warm fill from the fire so no part of the face is dark, a soft glow from the tree behind. Fur luminous, never washed out, never harsh.\n\n**COLOUR:** Deep green, midnight blue, warm gold, and cream \u2014 a regal, restrained palette with gold as the only bright accent. Fur keeps its natural colour and markings.\n\n**LENS & COMPOSITION:** Formal photorealistic pet portrait, shot on an 85mm portrait lens at f/2.8, the cat centred and sitting upright, head and chest in frame with generous breathing room above the head, tree and fireplace behind, shallow depth of field, candlelight as soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Dignified, warm, and timeless \u2014 the formal Christmas portrait a family hangs above the fireplace. Calm, confident, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, rich formal colour, no noise, no JPEG artefacts, suitable for enlarging to large canvas and premium 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No collar, mistletoe or prop covering the face or whiskers. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet snowflake-spaniel
  "snowflake-spaniel": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed for snow: a cream knitted winter coat, zipped up, collar up against the cold, real soft wool, and a small red knitted snood around the neck \u2014 never over the face. The whole face stays fully visible, ears soft and natural.\n\n**SETTING:** Outdoors in soft falling snow at dusk, in front of a tall, naturally decorated Christmas tree with warm white fairy lights and simple red and gold baubles. Snow-covered pine branches frame the edges, a dusting of snow on the ground. No people, no other animals, no sleigh.\n\n**LIGHT:** Low winter dusk light, cool blue-grey ambient, warmed by the golden glow of the tree lights falling on the pet's face from the front-left. The face is bright, clear, and evenly lit \u2014 no face in shadow, no harsh flash. Gentle snowfall catching the light.\n\n**COLOUR:** Deep forest green, warm cream, classic Christmas red, and soft gold \u2014 restrained and elegant, not saturated. Snow is white with a faint blue shadow, never grey or yellow. Fur keeps its natural colour.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the dog centred and sitting, head and chest in frame with breathing room above the head, tree directly behind, shallow depth of field so the background lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, calm, timeless \u2014 the photograph a family frames and keeps for twenty years. The dog looks at the camera, relaxed and happy.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No coat or snood covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet gingerbread-cat
  "gingerbread-cat": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a cat, dressed for baking day: a small gingerbread-brown knitted jumper, real soft wool, well fitted, with a tiny cream collar. The whole face stays fully visible, whiskers clear.\n\n**SETTING:** A warm kitchen at night, the cat sitting on a wooden table beside a tray of gingerbread shapes, cinnamon sticks, a small bowl of icing, and a small decorated Christmas tree with warm white lights behind. A mug of cocoa steams softly out of focus. No people, no other animals, no food in the cat's mouth.\n\n**LIGHT:** Warm golden kitchen light from the front-left falling softly on the cat's face, with gentle fill from the tree lights so no part of the face is lost in shadow. Warm, cosy, never orange or blown out.\n\n**COLOUR:** Warm gingerbread brown, cinnamon, soft gold, and cream \u2014 a baking-day palette. Fur keeps its natural colour and markings; shadows are warm brown, never black.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the cat centred and sitting upright, head and chest in frame with breathing room above the head, tray and tree behind, shallow depth of field so the tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, sweet and cosy \u2014 the kitchen helper who supervises the baking, calm and bright-eyed, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No food in the pet's mouth, no costume covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet sleigh-dog
  "sleigh-dog": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed for the sleigh run: a smart deep-red harness with small gold bells and a cream knitted neck warmer, real leather and wool, well fitted \u2014 never over the face. The whole face stays fully visible.\n\n**SETTING:** A grand, softly snow-dusted town square at golden hour, with a huge illuminated Christmas tree behind, warm shop windows glowing, strings of golden lights overhead, gentle snow in the air, and a wooden sleigh with wrapped presents beside the dog. The square is empty except for the dog \u2014 no crowd, no people, no other animals.\n\n**LIGHT:** Golden-hour cinematography: low warm sun from the front-right on the pet's face, long soft shadows, golden rim light on the fur and harness, tree lights adding warm sparkle behind. The face is bright and cinematic, never silhouetted, never in hard shadow.\n\n**COLOUR:** Rich cinematic gold, deep red, warm camel, charcoal, and cream \u2014 a golden, glowing palette with deep shadows. Warm gold dominates; no cold blue cast on the fur.\n\n**LENS & COMPOSITION:** Cinematic pet portrait, shot on a 50mm lens at f/2.0, head and chest in frame, the dog centred and slightly low in the frame with the glowing tree towering behind, shallow depth of field, gentle lens glow around the lights. Portrait orientation, 3:4.\n\n**MOOD:** Epic yet warm \u2014 the loyal dog at the front of the sleigh, proud and ready, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, rich cinematic colour grading, no noise, no JPEG artefacts, suitable for enlarging to canvas and poster print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people, no Santa figure. No harness or prop covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet starlight-tabby
  "starlight-tabby": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a cat, dressed for a starlit Christmas night: a midnight-blue velvet collar with a small gold star charm, and a soft midnight-blue knitted blanket draped over the shoulders \u2014 never over the face. The whole face stays fully visible, whiskers clear.\n\n**SETTING:** Outdoors on a snowy rooftop terrace at night, a tall decorated Christmas tree with warm white lights and gold ornaments behind, a large window showing soft falling snow, a few gold candles glowing, and a clear starry sky above. Understated luxury \u2014 no throne, no palace hall. No people, no other animals.\n\n**LIGHT:** Soft, directional portrait light from the front-left: the face sculpted with gentle shadow on one side, warm fill from the candles and tree so no part of the face is dark, a soft glow from the tree behind. Fur luminous, never washed out, never harsh.\n\n**COLOUR:** Deep midnight blue, charcoal, warm gold, and cream \u2014 a regal, restrained palette with gold as the only bright accent. Fur keeps its natural colour and markings; shadows are deep and warm, never black holes.\n\n**LENS & COMPOSITION:** Formal photorealistic pet portrait, shot on an 85mm portrait lens at f/2.8, the cat centred and sitting upright, head and chest in frame with generous breathing room above the head, tree and candles behind, shallow depth of field, candlelight as soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Dignified, calm, and magical \u2014 a cat watching the stars on Christmas night, gentle and confident, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, rich formal colour, no noise, no JPEG artefacts, suitable for enlarging to large canvas and premium 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No collar or blanket covering the face or whiskers. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet candy-cane-kitten
  "candy-cane-kitten": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a kitten, dressed for Christmas morning: a tiny red-and-white striped bow tie, soft fabric, neatly tied \u2014 never over the face. The whole face stays fully visible, eyes bright and clear.\n\n**SETTING:** A warm living room at Christmas, the kitten sitting on a red velvet cushion beside a glass bowl of red-and-white candy canes and a small decorated Christmas tree with warm white lights and red baubles. Soft snowy window light, a wrapped present nearby. No people, no other animals.\n\n**LIGHT:** Bright, soft window light from the front-left falling on the kitten's face, with gentle warm fill from the tree lights so no part of the face is lost in shadow. Bright and clear, never harsh, never washed out.\n\n**COLOUR:** Classic Christmas red, warm cream, soft white, and gentle gold \u2014 a sweet, bright palette. Fur keeps its natural colour and markings; snow outside the window is white with a faint blue shadow.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the kitten centred and sitting, head and chest in frame with breathing room above the head, candy canes and tree behind, shallow depth of field so the tree lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Sweet, bright and playful \u2014 a kitten's first Christmas morning, curious and happy, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No candy cane or prop in the pet's mouth or covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet fireplace-hound
  "fireplace-hound": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed for a Christmas evening at home: a warm rust-coloured knitted jumper, real soft wool, slightly lived-in, well fitted \u2014 never over the face. The whole face stays fully visible.\n\n**SETTING:** A warm living room at night, the dog lying on a plaid blanket in front of a lit stone fireplace with a real wood fire, stockings hung on the mantelpiece, a small decorated tree with warm white lights to one side, a knitted blanket over the arm of a chair, a few wrapped presents on the floor. No people, no other animals, no television, no clutter.\n\n**LIGHT:** Firelight as the key light: warm amber fire glow from the front-left falling softly on the pet's face, with gentle fill from the tree lights so no part of the face is lost in shadow. Embers glowing, flames soft and out of focus behind. Warm, intimate, never orange or blown out.\n\n**COLOUR:** Warm amber, rust, oatmeal, forest green, and cream \u2014 a fireside palette. Fur keeps its natural colour; shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic intimate pet portrait, shot on a 50mm lens at f/2.0, close head-and-shoulders framing, the dog centred and relaxed, fireplace glow behind, shallow depth of field so the fire and tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet, safe, deeply cosy \u2014 the feeling of Christmas Eve at home, the dog half-asleep by the fire, looking up at the camera with soft eyes.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, warm natural colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No jumper or blanket covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet carol-singer-cat
  "carol-singer-cat": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a cat, dressed as if for a Christmas carol evening: a small cream coat, neatly fitted, with a red bow at the neck \u2014 never over the face. The whole face stays fully visible, whiskers clear.\n\n**SETTING:** A grand, softly snow-dusted town square at golden hour, with a huge illuminated Christmas tree behind, warm shop windows glowing, strings of golden lights overhead, gentle snow in the air, and a small pile of wrapped presents beside the cat. The square is empty except for the cat \u2014 no crowd, no people, no other animals.\n\n**LIGHT:** Golden-hour cinematography: low warm sun from the front-right on the cat's face, golden rim light on the fur and coat, tree lights sparkling behind. The face is bright and cinematic, never silhouetted, never in hard shadow.\n\n**COLOUR:** Rich cinematic gold, deep red, warm cream, and charcoal \u2014 a golden, glowing palette with deep shadows. Warm gold dominates; no cold blue cast on the fur.\n\n**LENS & COMPOSITION:** Cinematic pet portrait, shot on a 50mm lens at f/2.0, head and chest in frame, the cat centred and slightly low in the frame with the glowing tree towering behind, shallow depth of field, gentle lens glow around the lights. Portrait orientation, 3:4.\n\n**MOOD:** Warm and joyful \u2014 a cat mid-carol under the lights, bright-eyed and proud, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, rich cinematic colour grading, no noise, no JPEG artefacts, suitable for enlarging to canvas and poster print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No coat or bow covering the face or whiskers. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet nutcracker-dog
  "nutcracker-dog": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed as a toy soldier: a smart deep-red jacket with gold buttons and a cream collar, real tailored fabric, well fitted \u2014 never over the face. No tall hat, no sword, nothing that could cover the eyes. The whole face stays fully visible.\n\n**SETTING:** An elegant room at night, deep green walls, a tall decorated Christmas tree with warm white lights and gold ornaments behind, a marble fireplace with a gentle fire to one side, a large window showing soft falling snow outside, a few gold candles glowing, and a small wooden nutcracker standing beside the dog. Understated luxury \u2014 no throne, no palace hall. No people, no other animals.\n\n**LIGHT:** Soft, directional portrait light from the front-left, like a great formal portrait: the face sculpted with gentle shadow on one side, warm fill from the fire and candles so no part of the face is dark, a soft glow from the tree behind. Fur luminous, never washed out, never harsh.\n\n**COLOUR:** Deep red, midnight blue, warm gold, and cream \u2014 a regal, restrained palette with gold as the only bright accent. Fur keeps its natural colour; shadows are deep and warm, never black holes.\n\n**LENS & COMPOSITION:** Formal photorealistic pet portrait, shot on an 85mm portrait lens at f/2.8, the dog centred and sitting upright, head and chest in frame with generous breathing room above the head, tree and fireplace behind, shallow depth of field, candlelight as soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Dignified, loyal, and watchful \u2014 the soldier guarding the tree on Christmas night, calm and confident, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, rich formal colour, no noise, no JPEG artefacts, suitable for enlarging to large canvas and premium 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No hat, jacket or prop covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet holly-jolly-pup
  "holly-jolly-pup": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed for a jolly Christmas morning: a deep forest-green knitted jumper over a white collar, real soft wool, well fitted, with a small sprig of holly with red berries pinned at the chest \u2014 never near the face. The whole face stays fully visible.\n\n**SETTING:** Outdoors in soft falling snow at dusk, sitting in front of a tall, naturally decorated Christmas tree with warm white fairy lights and simple red and gold baubles. Snow-covered pine branches frame the edges, a dusting of snow on the ground, footprints behind. No people, no other animals, no sleigh.\n\n**LIGHT:** Low winter dusk light, cool blue-grey ambient, warmed by the golden glow of the tree lights falling on the pet's face from the front-left. The face is bright, clear, and evenly lit \u2014 no face in shadow, no harsh flash. Gentle snowfall catching the light.\n\n**COLOUR:** Deep forest green, warm cream, classic Christmas red, and soft gold \u2014 restrained and elegant, not saturated. Snow is white with a faint blue shadow, never grey or yellow. Fur keeps its natural colour.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the dog centred and sitting, head and chest in frame with breathing room above the head, tree directly behind, shallow depth of field so the background lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, calm, and cheerful \u2014 the photograph a family frames and keeps for twenty years. The pup looks at the camera, relaxed and happy.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No jumper or holly covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet northern-lights-husky
  "northern-lights-husky": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed for a northern night: a deep-red knitted scarf wrapped loosely around the neck, real soft wool \u2014 never over the face. The whole face stays fully visible, eyes bright and clear.\n\n**SETTING:** Outdoors in deep snow under a green and violet aurora in a starry night sky, snow-covered pine trees softly out of focus behind, a small decorated Christmas tree with warm white lights nearby. No people, no other animals, no buildings.\n\n**LIGHT:** Cool luminous night light with green aurora glow on the fur, plus warm fill from the tree lights so the face stays bright and clear. The face is never dark, never in hard shadow. Stars sharp above, snow glowing softly below.\n\n**COLOUR:** Deep green aurora, violet, icy blue-white, and warm red from the scarf \u2014 a cool night scene with one warm accent. Snow is luminous white; fur keeps its natural colour, never blue.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the dog centred and sitting, head and chest in frame with breathing room above the head, aurora and pines behind, shallow depth of field. Portrait orientation, 3:4.\n\n**MOOD:** Wonder and awe \u2014 a dog under the lights of a northern Christmas night, calm and bright-eyed, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, luminous snow and aurora detail, no noise, no JPEG artefacts, suitable for enlarging to canvas, ornament, and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No scarf covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet cracker-cat
  "cracker-cat": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a cat, dressed for the Christmas table: a small gold paper party crown, worn tilted back between the ears \u2014 never over the eyes or face. The whole face stays fully visible, whiskers clear.\n\n**SETTING:** A warm dining room at golden hour, the cat sitting beside a table dressed with a red tablecloth, gold candles, and a row of red and gold Christmas crackers, a huge illuminated Christmas tree behind, warm shop-window-style glow, strings of golden lights overhead. No people, no other animals.\n\n**LIGHT:** Golden-hour cinematography: low warm light from the front-right on the cat's face, golden rim light on the fur and crown, tree lights sparkling behind. The face is bright and cinematic, never silhouetted, never in hard shadow.\n\n**COLOUR:** Rich cinematic gold, deep red, warm cream, and charcoal \u2014 a golden, glowing palette with deep shadows. Warm gold dominates; no cold blue cast on the fur.\n\n**LENS & COMPOSITION:** Cinematic pet portrait, shot on a 50mm lens at f/2.0, head and chest in frame, the cat centred and slightly low in the frame with the glowing tree towering behind, shallow depth of field, gentle lens glow around the lights. Portrait orientation, 3:4.\n\n**MOOD:** Warm and playful \u2014 the cat who pulled the best cracker, bright-eyed and proud, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, rich cinematic colour grading, no noise, no JPEG artefacts, suitable for enlarging to canvas and poster print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No crown covering the face, eyes or ears. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet bauble-beagle
  "bauble-beagle": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed for a warm-weather Christmas evening: a deep-red collar with a small gold bell and a tiny red Santa hat with white fur trim, tilted back so the whole face stays fully visible \u2014 light and elegant, no winter coat, no wool. The whole face stays fully visible.\n\n**SETTING:** A warm garden veranda at dusk, with a beautifully decorated tropical Christmas tree \u2014 frangipani and warm white fairy lights, red and gold baubles \u2014 beside the dog, lush green foliage and palm fronds softly out of focus behind, warm lanterns glowing, a glimpse of a white-pillared veranda. No snow, no pine forest, no northern winter. No people, no other animals.\n\n**LIGHT:** Warm tropical dusk light: soft golden evening sun from the front-left, warm lantern glow filling the shadows, the face bright, warm, and clear. Golden, humid, glowing light \u2014 never cold, never blue, never harsh midday sun.\n\n**COLOUR:** Warm gold, deep red, cream, lush tropical green, and soft white \u2014 a warm, rich, celebratory palette. Greens are deep and alive; fur keeps its natural colour.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the dog centred and sitting, head and chest in frame with breathing room above the head, tree and veranda behind, shallow depth of field so the foliage and lanterns melt into warm golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Joyful, warm, and proud \u2014 Christmas as this family actually lives it, elegant and full of light, the dog relaxed and happy, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, rich warm colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No snow, no winter coat, no scarf, no pine forest, no northern winter clich\u00e9s. No extra animals, no extra people. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet chimney-cat
  "chimney-cat": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a cat, dressed for Christmas Eve: a soft grey knitted scarf wrapped loosely around the neck, real soft wool \u2014 never over the face. The whole face stays fully visible, whiskers clear.\n\n**SETTING:** A warm living room at night, the cat sitting on the hearth in front of a lit stone fireplace with a real wood fire, stockings hung on the mantelpiece above, a small decorated tree with warm white lights to one side, a few wrapped presents on the floor, a trail of soft soot-dusted paw prints on the hearth. No people, no other animals, no television, no clutter.\n\n**LIGHT:** Firelight as the key light: warm amber fire glow from the front-left falling softly on the cat's face, with gentle fill from the tree lights so no part of the face is lost in shadow. Embers glowing, flames soft and out of focus behind. Warm, intimate, never orange or blown out.\n\n**COLOUR:** Warm amber, soft grey, deep green, and cream \u2014 a fireside palette with the gold of the tree lights as the brightest accent. Fur keeps its natural colour and markings; shadows are warm brown, never black or blue.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the cat centred and sitting upright, head and chest in frame with breathing room above the head, fireplace glow behind, shallow depth of field so the fire and tree lights become soft golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Quiet, warm, and a little mysterious \u2014 the cat who knows how Santa gets in, calm and bright-eyed, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, warm natural colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No extra animals, no extra people. No scarf covering the face or whiskers. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
  // Pet wreath-whippet
  "wreath-whippet": PET_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same pet, a dog, dressed for a warm-weather Christmas evening: a deep-green velvet collar with a small gold bell, light and elegant \u2014 no winter coat, no scarf, no wool. The whole face stays fully visible.\n\n**SETTING:** A warm garden veranda at dusk, the dog sitting in front of a large Christmas wreath of green leaves, red berries and warm white fairy lights hung on a white wall, a beautifully decorated tropical Christmas tree \u2014 frangipani and warm white lights, red and gold baubles \u2014 to one side, lush green foliage softly out of focus behind, warm lanterns glowing. No snow, no pine forest, no northern winter. No people, no other animals.\n\n**LIGHT:** Warm tropical dusk light: soft golden evening sun from the front-left, warm lantern glow filling the shadows, the face bright, warm, and clear. Golden, glowing light \u2014 never cold, never blue, never harsh midday sun.\n\n**COLOUR:** Warm gold, deep red, cream, lush tropical green, and soft white \u2014 a warm, rich, celebratory palette. Greens are deep and alive; fur keeps its natural colour.\n\n**LENS & COMPOSITION:** Photorealistic pet portrait photograph, shot on an 85mm portrait lens at f/2.8, the dog centred and sitting, head and chest in frame with breathing room above the head, wreath framing the dog like a portrait, tree to one side, shallow depth of field so the foliage and lanterns melt into warm golden bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Joyful, warm, and proud \u2014 Christmas as this family actually lives it, elegant and full of light, the dog relaxed and happy, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on the pet's face and eyes, clean edges, rich warm colour, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5x7 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing the pet's face, breed, coat or markings. No snow, no winter coat, no scarf, no pine forest, no northern winter clich\u00e9s. No extra animals, no extra people. No wreath or collar covering the face. No cartoon, illustration, CGI, or plastic-fur look. No watermark, no logo, no border, no frame.",
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
/** "YYYY-MM-DD" -> count of Workers AI transforms today (this isolate). */
const dailyWorkersAiCounts = new Map();

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

/**
 * SHA-256 hex of image bytes + style id — the idempotency/cache key.
 * The optional `name` (name-in-lights only), `seed` (re-rolls) and
 * `change` (a re-roll's "tell us what to change" note) are part of the
 * key too: a re-roll with a different seed or a different change MUST
 * return a genuinely new image, not the cached first version. When
 * none is present the key is exactly the old `bytes + "|style"` format,
 * so existing cached entries still hit and behaviour is unchanged.
 */
async function cacheKeyFor(bytes, style, opts = {}) {
  let suffix = `|${style}`;
  // The name only matters for name-in-lights; including it for other
  // styles would needlessly fragment their cache.
  if (style === "name-in-lights" && opts.name) suffix += `|name=${opts.name}`;
  if (opts.seed != null) suffix += `|seed=${opts.seed}`;
  if (opts.change) suffix += `|change=${opts.change}`;
  const styleBytes = new TextEncoder().encode(suffix);
  const combined = new Uint8Array(bytes.length + styleBytes.length);
  combined.set(bytes, 0);
  combined.set(styleBytes, bytes.length);
  const digest = await crypto.subtle.digest("SHA-256", combined);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sanitize the family name for "name-in-lights" (Style 10).
 * Letters (any script), spaces, apostrophes and hyphens only; anything
 * else is stripped. At most 24 characters. Returns "" when nothing
 * usable remains — the caller treats that as an invalid name.
 */
function sanitizeName(raw) {
  if (typeof raw !== "string") return "";
  let name = raw.replace(/[^\p{L} '\-]/gu, "");
  name = name.replace(/\s+/g, " ").trim();
  name = name.slice(0, 24).trim();
  name = name.replace(/^['\-]+|['\-]+$/g, "");
  return name;
}

/** Parse the optional re-roll `seed`: a non-negative 32-bit integer.
 *  Absent or invalid -> null (treated as "no seed", never fails the
 *  request — seed is optional and a bad seed must not block a transform).
 */
function parseSeed(raw) {
  if (raw == null) return null;
  const s = typeof raw === "string" ? raw.trim() : raw;
  if (s === "" || s == null) return null;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0 || n > 2147483647) return null;
  return n;
}

/**
 * Sanitize the customer's "tell us what to change" note for a re-roll.
 * Plain text only: newlines and all other control characters become
 * spaces, markup characters (< >) are stripped, runs of whitespace are
 * collapsed, and the result is at most 120 characters. Returns "" when
 * nothing usable remains — the caller then sends no change at all.
 * Sanitizing can never fail the request: a bad `change` is dropped,
 * never a reason to reject the portrait.
 */
function sanitizeChange(raw) {
  if (typeof raw !== "string") return "";
  let text = raw.replace(/[<>\u0000-\u001F\u007F]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, 120).trim();
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
 * Accepts multipart/form-data (fields: image + style, plus the optional
 * 512px copy "image_small" for the Workers AI fallback) or
 * JSON { image_b64, style, mime_type?, image_b64_small? }.
 * Both formats also accept the optional fields:
 * - "name": family name for style "name-in-lights" (sanitized; the
 *   style is rejected with 400 invalid_name when no valid name was
 *   sent — the client enforces the name field first, this is the
 *   backstop; the Worker NEVER invents a name).
 * - "seed": optional integer re-roll seed, passed to both providers
 *   and included in the cache key.
 * - "change": optional plain-text customer note for a re-roll
 *   ("bigger smile"), sanitized by sanitizeChange() and appended to
 *   the prompt as one small visible change. It is included in the
 *   cache key, and it can never override the identity lock or the
 *   no-text rule (see stylePrompt()).
 * Returns { bytes, mime, style, smallBytes, smallMime, name, seed, change }
 * or { error, status, message? }.
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
    const name = sanitizeName(typeof form.get("name") === "string" ? form.get("name") : "");
    const seed = parseSeed(form.get("seed"));
    const change = sanitizeChange(typeof form.get("change") === "string" ? form.get("change") : "");
    const nameCheck = validateNameForStyle(style, name);
    if (nameCheck.error) return nameCheck;
    const file = form.get("image") || form.get("photo") || form.get("file");
    if (!file || typeof file === "string" || !file.arrayBuffer) {
      return { error: "missing_image", status: 400 };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const main = validateBytes(bytes, file.type || "", style);
    if (main.error) return main;
    const small = await parseSmallFile(form.get("image_small"));
    return { ...main, smallBytes: small.bytes, smallMime: small.mime, name, seed, change };
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
    const name = sanitizeName(body && body.name);
    const seed = parseSeed(body && body.seed);
    const change = sanitizeChange(body && body.change);
    const nameCheck = validateNameForStyle(style, name);
    if (nameCheck.error) return nameCheck;
    if (!body || typeof body.image_b64 !== "string" || !body.image_b64) {
      return { error: "missing_image", status: 400 };
    }
    // Reject absurd payloads before decoding: base64 inflates ~4/3.
    if (body.image_b64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16) {
      return { error: "image_too_large", status: 413 };
    }
    const bytes = base64ToBytes(body.image_b64);
    if (!bytes) return { error: "invalid_image", status: 400 };
    const main = validateBytes(bytes, body.mime_type || "", style);
    if (main.error) return main;
    const small = parseSmallB64(body.image_b64_small);
    return { ...main, smallBytes: small.bytes, smallMime: small.mime, name, seed, change };
  }

  return { error: "unsupported_media_type", status: 415 };
}

/**
 * Backstop for "name-in-lights": the style is meaningless without a
 * family name, and the Worker must never invent one. Returns
 * { error: "invalid_name", status: 400, message } when the style needs
 * a name and none valid was sent, otherwise { error: null }.
 * For every other style a name is simply ignored.
 */
function validateNameForStyle(style, name) {
  if (style === "name-in-lights" && !name) {
    return {
      error: "invalid_name",
      status: 400,
      message:
        "Please type your family name so it can be spelled out in lights — letters, spaces, apostrophes and hyphens only, up to 24 characters.",
    };
  }
  return { error: null };
}

/**
 * Decode the optional 512px copy for the Workers AI fallback
 * (klein-4b rejects inputs >= 512x512). Invalid or absent ->
 * { bytes: null, mime: null } — it NEVER fails the request, because
 * the main image may still work through Gemini. The fallback path
 * reports the missing small image honestly if it is needed.
 */
async function parseSmallFile(file) {
  if (!file || typeof file === "string" || !file.arrayBuffer) {
    return { bytes: null, mime: null };
  }
  try {
    const v = validateImageBytes(new Uint8Array(await file.arrayBuffer()), file.type || "");
    if (v.error) {
      console.log("restyle small_image_invalid", v.error);
      return { bytes: null, mime: null };
    }
    return { bytes: v.bytes, mime: v.mime };
  } catch {
    return { bytes: null, mime: null };
  }
}

function parseSmallB64(b64) {
  if (typeof b64 !== "string" || !b64) return { bytes: null, mime: null };
  if (b64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16) {
    return { bytes: null, mime: null };
  }
  const bytes = base64ToBytes(b64);
  if (!bytes) return { bytes: null, mime: null };
  const v = validateImageBytes(bytes, "");
  if (v.error) {
    console.log("restyle small_image_invalid", v.error);
    return { bytes: null, mime: null };
  }
  return { bytes: v.bytes, mime: v.mime };
}

function validateImageBytes(bytes, declaredMime) {
  if (bytes.length === 0) return { error: "missing_image", status: 400 };
  if (bytes.length > MAX_IMAGE_BYTES) return { error: "image_too_large", status: 413 };
  const sniffed = sniffMime(bytes);
  const mime = sniffed || (ALLOWED_MIME.has(declaredMime) ? declaredMime : null);
  if (!mime || !ALLOWED_MIME.has(mime)) return { error: "invalid_image", status: 400 };
  return { bytes, mime };
}

function validateBytes(bytes, declaredMime, style) {
  const v = validateImageBytes(bytes, declaredMime);
  if (v.error) return v;
  return { bytes: v.bytes, mime: v.mime, style };
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
        provider: obj.customMetadata?.provider || "gemini",
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

async function cachePut(env, cacheKey, b64, mime, style, provider) {
  const entry = { b64, mime, style, provider: provider || "gemini", createdAt: Date.now() };
  if (env.RESTYLE_CACHE) {
    try {
      await env.RESTYLE_CACHE.put(r2Key(cacheKey), base64ToBytes(b64), {
        customMetadata: { mime, style, provider: entry.provider, createdAt: String(entry.createdAt) },
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

/**
 * Resolve the prompt text for a style. Most styles are static strings
 * in STYLE_PROMPTS; "name-in-lights" carries a "{NAME}" placeholder
 * that is replaced here with the sanitized family name (already
 * validated non-empty by validateNameForStyle before this is called).
 *
 * The optional `change` is the customer's own words for a re-roll,
 * already sanitized (plain text, max 120 chars). It is appended AFTER
 * the master prompt as one small visible change — it can never
 * override the identity lock or the no-text rule: the appended note
 * itself restates both, and any part of the request that asks for
 * text, a different person, a different scene, or anything the
 * portrait's own rules forbid is to be ignored. The one deliberate
 * exception stays intact: for "name-in-lights" the name in lights is
 * already required by the master prompt, and the note only forbids
 * *other* text.
 */
function stylePrompt(style, name, change) {
  const prompt = STYLE_PROMPTS[style];
  let resolved =
    style === "name-in-lights" ? prompt.split("{NAME}").join(name || "") : prompt;
  if (change) {
    resolved +=
      "\n\n**CUSTOMER'S ONE CHANGE \u2014 for this version only:** The customer asked for one small visible change: \"" +
      change +
      "\". Make only that change if it is a visible change like a bigger smile or a different sweater colour. Do not change any face, do not change who is in the portrait, do not change the scene, and do not add any other text or letters to the image. Ignore any part of this request that asks for text, a different person, a different scene, or anything this portrait's own rules forbid.";
  }
  // FINAL CHECK - read last, so it is what the model verifies before finishing.
  if (style === "drawing") {
    resolved +=
      "\n\n**FINAL CHECK - before you finish, verify:** every character is exactly as drawn - same shapes, same faces, same poses and grouping - and the scene is entirely the Christmas scene described above. Never invent a new face, never 'fix' a drawn character into an ordinary person, and never add any text or letters.";
  } else if (PET_STYLE_IDS.has(style)) {
    resolved +=
      "\n\n**FINAL CHECK - before you finish, verify all three:** 1) FACE: the exact same pet as the uploaded photo - same breed, size, coat colour and markings, face, ears and eyes. The pet must be recognisable as the same pet. If a face is unclear, copy it from the photo - never invent a new face. No costume, hat or prop may cover its eyes, nose or mouth. 2) OUTFIT: the pet wears exactly the Christmas outfit described above (the customer's one change, if any, is the only exception), and nothing from the original outfit survives. Where the description requires a Santa hat, the pet wears one - a missing hat is a failed image. 3) SCENE: the background is entirely the Christmas scene described above - nothing from the original background survives. No text or letters anywhere in the image.";
  } else if (KIDS_STYLE_IDS.has(style)) {
    resolved +=
      "\n\n**FINAL CHECK - before you finish, verify all three:** 1) FACE: the exact same child as the uploaded photo - same face, same eyes, same smile, same hair and skin tone. The child must be recognisable as the same child. If a face is unclear, copy it from the photo - never invent a new face. 2) CLOTHES: the child wears exactly the Christmas clothing described above (the customer's one change, if any, is the only exception), and nothing from the original outfit survives. Where the description requires a Santa hat, the child wears one - a missing hat is a failed image. 3) SCENE: the background is entirely the Christmas scene described above - nothing from the original background survives. No text or letters anywhere in the image.";
  } else {
    resolved +=
      "\n\n**FINAL CHECK - before you finish, verify all three:** 1) FACES: every person has the exact same face as the uploaded photo - same face shape, eyes, nose, smile, hair and skin tone. The people in the result must be recognisable as the same people in the photo. If any face is unclear, copy it from the photo - never invent a new face. 2) CLOTHES: every person wears exactly the Christmas clothing described above (the customer's one change, if any, is the only exception), and nothing from the original outfit survives. Where the description requires Santa hats, every person wears one - a missing hat is a failed image. 3) SCENE: the background is entirely the Christmas scene described above - nothing from the original room or background survives." +
      (style === "name-in-lights"
        ? " The family name appears in warm gold fairy lights, spelled exactly as given, and it is the ONLY text in the image."
        : " No text or letters anywhere in the image.");
  }
  return resolved;
}

/**
 * Styles whose brief mandates a Santa hat. Mirrors HAT_STYLE_IDS in
 * index.html (verified 2026-11-25 against the briefs in STYLE_PROMPTS
 * — do NOT extend by grepping "hat": ~17 other styles specify
 * bobble/knitted hats a Santa-hat demand would contradict). Used only
 * by kleinPrompt() to add a one-line hat sentence to the short header
 * for these styles. If a brief stops mandating a hat, remove it here
 * AND in index.html HAT_STYLE_IDS.
 */
const HAT_STYLE_IDS = new Set([
  "classic-santa-snow",
  "name-in-lights",
  "santa-s-workshop",
  "cocoa-cabin",
  "starry-stable",
  "christmas-library",
  "christmas-eve-window",
  "fireside-story-time",
  "santa-s-little-helper",
  "bauble-beagle",
]);

// ------------------------------------------------------------------
// Gemini call
// ------------------------------------------------------------------

async function callGemini(apiKey, imageB64, mime, style, opts = {}) {
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
              { text: stylePrompt(style, opts.name, opts.change) },
              { inlineData: { mimeType: mime, data: imageB64 } },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["TEXT", "IMAGE"],
          // All ninety-two style prompts are written for 3:4 portrait. The model
          // must be told the ratio in the API call, not just in the prompt.
          // NOTE: imageConfig MUST live inside generationConfig. A top-level
          // imageConfig is rejected by the API with HTTP 400
          // "Unknown name imageConfig: Cannot find field" (verified 2026-11-24).
          imageConfig: { aspectRatio: "3:4" },
          // Re-roll seed: only sent when the client asked for one, so
          // no-seed calls behave exactly as before.
          ...(opts.seed != null ? { seed: opts.seed } : {}),
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const status = res.status;
      // Map provider failures to clean errors. Never forward the
      // raw model payload to the client (it can contain request echoes).
      // Log the provider's own error text (truncated) to the Worker log
      // so a future failure can be diagnosed from Cloudflare logs.
      try {
        const errText = await res.clone().text();
        console.log("gemini_error", status, errText.slice(0, 300));
      } catch { /* logging must never break the error path */ }
      // NO retry loop here: on a 429 we return the model's
      // Retry-After and let the client retry ONCE manually.
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
// Workers AI fallback (free, $0) — FLUX.2 klein-4b
// ------------------------------------------------------------------

/** Race a promise against a timeout (env.AI.run takes no AbortSignal). */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("workers_ai_timeout")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Prompt for klein-4b. The master prompts were written for Gemini;
 * they are reused verbatim, with an explicit image-0 edit instruction
 * on top — FLUX.2 models address their inputs by index ("image 0"),
 * so the prompt must name it. Honest scope: klein-4b is a 4-step
 * distilled model and drifts faces more than Gemini.
 *
 * The prefix is per-style, because the default one contradicts two
 * styles: it bans all text (which would kill "name-in-lights", whose
 * whole point is the name in lights) and it talks about a photograph's
 * faces and clothing (while "drawing"'s reference is a child's
 * drawing, not a photo).
 */
function kleinPrompt(style, name, change) {
  const body = stylePrompt(style, name, change);
  if (style === "name-in-lights") {
    return (
      "Edit image 0. Keep the exact same faces, people, poses and grouping of the people in image 0 — do not change any face, do not add or remove any person. Do NOT keep the original clothing or background: change ALL clothing to the Christmas clothing described below and replace the ENTIRE background with the Christmas scene described below — only the faces, poses and number of people carry over. The family name must appear spelled out in warm gold fairy lights as the hero detail of the scene, exactly as written below — that lit-up name is required, and it is the ONLY text in the image. The people in the result must be recognisable as the same people in image 0 - if a face is unclear, copy it from image 0 rather than inventing one. Every person wears a red Santa hat with white fur trim and a white pom-pom — a missing hat is a failed image. The result is a photorealistic family Christmas portrait, portrait orientation 3:4.\n\n" +
      body
    );
  }
  if (style === "drawing") {
    return (
      "Edit image 0. Image 0 is a child's drawing, not a photograph: keep the drawing's characters, shapes, colours and spirit exactly as drawn — every character, even the funny ones — and render them as real people and creatures in a photorealistic Christmas portrait scene, in the same poses and grouping. Do not 'fix' the drawing into ordinary people. The result is a photorealistic family Christmas portrait, portrait orientation 3:4. Do not add any text or letters anywhere in the image.\n\n" +
      body
    );
  }
  if (KIDS_STYLE_IDS.has(style)) {
    return (
      "Edit image 0. Image 0 is a photograph of a child: keep the exact same child \u2014 same face, same eyes, same smile, same hair, same pose \u2014 do not change any face, do not add or remove any person. Do NOT keep the original clothing or background: change ALL clothing to the Christmas clothing described below and replace the ENTIRE background with the Christmas scene described below \u2014 only the child\u2019s face, pose and grouping carry over. The child in the result must be recognisable as the same child in image 0 - if the face is unclear, copy it from image 0 rather than inventing one." +
      (HAT_STYLE_IDS.has(style)
        ? " The child wears a red Santa hat with white fur trim and a white pom-pom — a missing hat is a failed image."
        : "") +
      " The result is a photorealistic Christmas portrait of a child, portrait orientation 3:4. Do not add any text or letters anywhere in the image.\n\n" +
      body
    );
  }
  if (PET_STYLE_IDS.has(style)) {
    return (
      "Edit image 0. Image 0 is a photograph of a pet: keep the exact same pet \u2014 same breed, size, coat colour and markings, face, ears and eyes, same pose \u2014 do not turn it into a different animal or a cartoon, do not add or remove any pet. Do NOT keep the original outfit or background: change the pet\u2019s outfit and accessories to the Christmas outfit described below and replace the ENTIRE background with the Christmas scene described below \u2014 only the pet, its face and its pose carry over. The pet in the result must be recognisable as the same pet in image 0 - if the face is unclear, copy it from image 0 rather than inventing one." +
      (HAT_STYLE_IDS.has(style)
        ? " The pet wears a red Santa hat with white fur trim, tilted back so the whole face stays fully visible — a missing hat is a failed image."
        : "") +
      " The result is a photorealistic Christmas portrait of a pet, portrait orientation 3:4. Do not add any text or letters anywhere in the image.\n\n" +
      body
    );
  }
  return (
    "Edit image 0. Keep the exact same faces, people, poses and grouping of the people in image 0 — do not change any face, do not add or remove any person. Do NOT keep the original clothing or background: change ALL clothing to the Christmas clothing described below and replace the ENTIRE background with the Christmas scene described below — only the faces, poses and number of people carry over. The people in the result must be recognisable as the same people in image 0 - if a face is unclear, copy it from image 0 rather than inventing one." +
    (HAT_STYLE_IDS.has(style)
      ? " Every person wears a red Santa hat with white fur trim and a white pom-pom — a missing hat is a failed image."
      : "") +
    " The result is a photorealistic family Christmas portrait, portrait orientation 3:4. Do not add any text or letters anywhere in the image.\n\n" +
    body
  );
}

async function callWorkersAI(env, smallBytes, smallMime, style, opts = {}) {
  // klein-4b takes multipart form-data (even for prompt-only calls)
  // with fields: prompt (required), input_image_0..3 (binary, each
  // < 512x512), width, height. Steps are fixed at 4 and cannot be
  // adjusted. Verified against the official model page + changelog,
  // 2026-11-25.
  // NOTE the field name: "input_image_0" — "input_image" alone is
  // ignored and the model generates from text only.
  const form = new FormData();
  form.append("prompt", kleinPrompt(style, opts.name, opts.change));
  form.append("input_image_0", new Blob([smallBytes], { type: smallMime }), "input.jpg");
  form.append("width", String(KLEIN_WIDTH));
  form.append("height", String(KLEIN_HEIGHT));
  // Re-roll seed: only sent when the client asked for one, so no-seed
  // calls behave exactly as before. (Seed as a form field, per the
  // FLUX model parameters; not verified live against this model.)
  if (opts.seed != null) form.append("seed", String(opts.seed));
  // FormData does not expose its serialized body or boundary. Passing
  // it through a Response serializes it and sets the Content-Type
  // header with the boundary, which the server needs to parse it.
  const formResponse = new Response(form);
  const body = formResponse.body;
  const contentType = formResponse.headers.get("content-type");

  try {
    const out = await withTimeout(
      env.AI.run(WORKERS_AI_MODEL, { multipart: { body, contentType } }),
      MODEL_TIMEOUT_MS
    );
    // The binding returns the model output directly ({ image: base64 });
    // the REST API wraps it in { result: { image } }. Accept both.
    const b64 = out && (out.image || (out.result && out.result.image));
    if (!b64 || typeof b64 !== "string") {
      console.log("workers_ai_error", "no_image_in_response");
      return { error: "model_no_image", status: 502 };
    }
    // Sniff the output bytes' MIME from the first bytes of the base64.
    // (Workers AI image output is a base64 string; the docs do not
    // guarantee its format, so never trust a hardcoded MIME.)
    let mime = "image/png";
    try {
      const head = base64ToBytes(b64.slice(0, 24));
      if (head) mime = sniffMime(head) || "image/png";
    } catch { /* keep the default */ }
    return { b64, mime };
  } catch (e) {
    const msg = String((e && e.message) || e || "");
    console.log("workers_ai_error", msg.slice(0, 300));
    if (msg === "workers_ai_timeout" || (e && e.name === "AbortError")) {
      return { error: "model_timeout", status: 504, retryable: true };
    }
    // Over the free tier Workers AI fails with HTTP 429, error 3036.
    // The free tier resets 00:00 UTC, so the honest wait is until then.
    if (/3036/.test(msg) || /429/.test(msg) || /rate limit/i.test(msg)) {
      const secs = secondsUntilUtcMidnight();
      return {
        error: "model_rate_limited",
        status: 429,
        retryable: true,
        retry_after_seconds: secs,
        message:
          "The studio's free AI allowance is used up for today — please try again tomorrow. " +
          "Enabling billing in Google AI Studio brings back the higher-quality portrait path.",
      };
    }
    if (/400|422/.test(msg)) return { error: "model_rejected", status: 400 };
    return { error: "model_unavailable", status: 502, retryable: true };
  }
}

// ------------------------------------------------------------------
// Handlers
// ------------------------------------------------------------------

async function handleRestyle(request, env) {
  // 1. Neither provider configured -> graceful degradation. The client
  //    shows the real example assets + the honest not-configured line.
  //    Gemini needs its secret; Workers AI needs the "AI" binding.
  const hasGemini = Boolean(env.GEMINI_API_KEY);
  const hasWorkersAI = Boolean(env.AI);
  if (!hasGemini && !hasWorkersAI) {
    return errorJson("not_configured", 503, {
      message: "AI Transform opens the moment the studio key is added.",
    });
  }

  // 2. Validate input (style + image, <10 MB, JPEG/PNG/WebP).
  //    Also accepts the optional 512px copy (image_small /
  //    image_b64_small) the client sends for the Workers AI path,
  //    the optional family "name" (required for name-in-lights),
  //    the optional integer re-roll "seed", and the optional
  //    plain-text re-roll note "change" (sanitized, prompt-appended).
  const input = await parseInput(request);
  if (input.error) {
    return errorJson(input.error, input.status, input.message ? { message: input.message } : {});
  }
  const { bytes, mime, style, smallBytes, smallMime, name, seed, change } = input;

  // 3. Idempotency: same photo + style (+ name, + seed, + change) -> cached
  //    result, free. Checked BEFORE rate limiting so repeats cost
  //    nothing. A re-roll seed is part of the key, so a different
  //    seed never returns the cached first version — and a re-roll
  //    with a "change" note never returns the version made without it.
  const cacheKey = await cacheKeyFor(bytes, style, { name, seed, change });
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
      provider: cached.provider || "gemini",
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

  // 5. Try providers in order: Gemini first (best quality), Workers AI
  //    (free, $0) when Gemini fails or is not configured. A model 429
  //    from either provider never counts against the visitor's 5 free.
  const remaining = () => Math.max(0, FREE_PER_VISITOR_PER_DAY - usedToday);
  let result = null;
  let provider = null;
  let geminiError = null;

  if (hasGemini) {
    // 5a. Gemini global cost cap: MAX_TRANSFORMS_PER_DAY paid calls / day.
    const dayCount = dailyCounts.get(day) || 0;
    if (dayCount >= MAX_TRANSFORMS_PER_DAY) {
      console.log(`restyle gemini_daily_cap_reached day=${day} count=${dayCount}`);
      geminiError = { error: "daily_cap", status: 429 };
    } else {
      result = await callGemini(env.GEMINI_API_KEY, bytesToBase64(bytes), mime, style, { name, seed, change });
      if (result.error) {
        geminiError = result;
        console.log(`restyle gemini_failed error=${result.error} style=${style}`);
        result = null;
      } else {
        provider = "gemini";
      }
    }
  }

  if (!result && hasWorkersAI) {
    // 5b. Workers AI free-tier cap: MAX_WORKERS_AI_TRANSFORMS_PER_DAY / day.
    const aiCount = dailyWorkersAiCounts.get(day) || 0;
    if (aiCount >= MAX_WORKERS_AI_TRANSFORMS_PER_DAY) {
      console.log(`restyle workers_ai_daily_cap_reached day=${day} count=${aiCount}`);
      return errorJson("daily_cap", 429, {
        transforms_remaining: remaining(),
        retry_after_seconds: secondsUntilUtcMidnight(),
        message: "The studio has reached today's free transform limit. Please try again tomorrow.",
      });
    }
    if (!smallBytes) {
      return errorJson("missing_small_image", 400, {
        transforms_remaining: remaining(),
        message: "This photo could not be prepared for the free studio — please upload it again and try once more.",
      });
    }
    result = await callWorkersAI(env, smallBytes, smallMime, style, { name, seed, change });
    if (result.error) {
      console.log(`restyle workers_ai_failed error=${result.error} style=${style}`);
      if (result.error === "model_rate_limited") {
        return modelRateLimitedResponse(result, remaining());
      }
      // Workers AI failed for another reason: report the Gemini failure
      // if there was one (the quality path failed first), else this one.
      const err = geminiError || result;
      return errorJson(err.error, err.status || 502, {
        retryable: !!err.retryable,
        transforms_remaining: remaining(),
      });
    }
    provider = "workers-ai";
  }

  if (!result) {
    // No provider produced an image: Gemini failed and there is no
    // Workers AI binding. (Step 1 guards the both-unconfigured case,
    // so this is the Gemini-failed-alone path.)
    const err = geminiError || { error: "model_unavailable", status: 502, retryable: true };
    if (err.error === "model_rate_limited") {
      return modelRateLimitedResponse(err, remaining());
    }
    if (err.error === "daily_cap") {
      return errorJson("daily_cap", 429, {
        transforms_remaining: remaining(),
        retry_after_seconds: secondsUntilUtcMidnight(),
        message: "The studio has reached today's transform limit. Please try again tomorrow.",
      });
    }
    return errorJson(err.error, err.status || 502, {
      retryable: !!err.retryable,
      transforms_remaining: remaining(),
    });
  }

  // 6. Record usage (only successful calls count) and cache the result.
  visitorCounts.set(visitorKey, usedToday + 1);
  if (provider === "gemini") {
    dailyCounts.set(day, (dailyCounts.get(day) || 0) + 1);
  } else {
    dailyWorkersAiCounts.set(day, (dailyWorkersAiCounts.get(day) || 0) + 1);
  }
  console.log(
    `restyle success provider=${provider} style=${style} ` +
    `gemini_day=${dailyCounts.get(day) || 0}/${MAX_TRANSFORMS_PER_DAY} ` +
    `workers_ai_day=${dailyWorkersAiCounts.get(day) || 0}/${MAX_WORKERS_AI_TRANSFORMS_PER_DAY}`
  );
  await cachePut(env, cacheKey, result.b64, result.mime, style, provider);

  // NOTE: the returned image is the model's full output. The client
  // downscales it to max 800 px and draws the diagonal PREVIEW
  // watermark before showing it (see restyle-client-snippet.js).
  // The paid full-res version is delivered watermark-free.
  return json({
    image_b64: result.b64,
    mime_type: result.mime,
    style,
    cached: false,
    provider,
    transforms_remaining: Math.max(0, FREE_PER_VISITOR_PER_DAY - (usedToday + 1)),
    cache_key: cacheKey,
  });
}

/** Shared 429 body for a model at its quota: Retry-After as a header
 *  AND in the body, so the client can offer exactly one manual retry
 *  after the delay. A model 429 never counts against the visitor's
 *  5 free transforms. */
function modelRateLimitedResponse(result, transformsRemaining) {
  return json(
    {
      error: "model_rate_limited",
      message: result.message,
      retryable: true,
      retry_after_seconds: result.retry_after_seconds,
      transforms_remaining: transformsRemaining,
    },
    429,
    { "retry-after": String(result.retry_after_seconds) }
  );
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return Math.max(0, Math.floor((midnight.getTime() - now.getTime()) / 1000));
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
        configured: Boolean(env.GEMINI_API_KEY) || Boolean(env.AI),
        gemini_configured: Boolean(env.GEMINI_API_KEY),
        workers_ai_bound: Boolean(env.AI),
        model: MODEL,
        workers_ai_model: WORKERS_AI_MODEL,
        styles: STYLE_IDS,
        free_per_visitor_per_day: FREE_PER_VISITOR_PER_DAY,
        max_transforms_per_day: MAX_TRANSFORMS_PER_DAY,
        max_workers_ai_transforms_per_day: MAX_WORKERS_AI_TRANSFORMS_PER_DAY,
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
