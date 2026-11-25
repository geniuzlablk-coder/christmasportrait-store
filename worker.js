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
};

// ------------------------------------------------------------------
// Style prompts — THE SAME TEXT is in PREVIEW-STUDIO-ARCHITECTURE.md.
// If you edit a prompt here, copy it to the doc (and vice versa).
// Face-preservation lock + no-text rule are identical in all styles
// EXCEPT "name-in-lights", whose whole point is the family name
// spelled out in lights — see its prompt comment below.
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Style prompts — MASTER PROMPTS v1 (DRAFT, UNTESTED against the live
// model — see RESEARCH-BILLION-DOLLAR-REDESIGN.md §5). THE SAME TEXT
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
const IDENTITY_LOCK = "**IDENTITY LOCK \u2014 do not change:** Use the uploaded family photograph as the sole reference for the people. Keep the same four people \u2014 father, mother, daughter, son \u2014 in the same positions, same relative heights, same poses and same grouping as the reference photo. Keep every face exactly as it is in the reference: same face shape, same eyes, same nose, same smile, same hair colour and style, same skin tone. Do not beautify, slim, smooth, age, or change any face. Preserve natural skin texture and pores. Do not add, remove, or swap any person.";

const STYLE_PROMPTS = {
  // Style 01 · Classic Santa Snow (MASTER PROMPT 1)
  "classic-santa-snow": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, now dressed for a classic Christmas morning: father in a deep forest-green knit jumper over a white shirt; mother in a warm cream cable-knit jumper with a red scarf; daughter in a red dress with a cream cardigan; son in a navy jumper with a small reindeer motif. Clothes are clean, well-fitted, real knitted wool \u2014 no costumes, no Santa suits on the family, no matching novelty outfits.\n\n**SETTING:** Outdoors in soft falling snow at dusk, in front of a tall, naturally decorated Christmas tree with warm white fairy lights and simple red and gold baubles. Snow-covered pine branches frame the edges. A dusting of snow on the ground, footprints behind them. No buildings, no strangers, no animals, no sleigh, no Santa figure.\n\n**LIGHT:** Low winter dusk light, cool blue-grey ambient, warmed by the golden glow of the tree lights falling on their faces from the front-left. Faces are bright, clear, and evenly lit \u2014 no face in shadow, no harsh flash. Gentle snowfall catching the light.\n\n**COLOUR:** Deep forest green, warm cream, classic Christmas red, and soft gold \u2014 restrained and elegant, not saturated. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, tree directly behind them, shallow depth of field so the background lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, calm, timeless \u2014 the photograph a family frames and keeps for twenty years. Genuine relaxed smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5\u00d77 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at sides or holding a mug, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
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
  "name-in-lights": IDENTITY_LOCK + "\n\n" + "**SUBJECT & CLOTHES:** The same family, dressed for a classic Christmas evening: father in a deep forest-green knit jumper over a white shirt; mother in a warm cream cable-knit jumper with a red scarf; daughter in a red dress with a cream cardigan; son in a navy jumper with a small reindeer motif. Clean, well-fitted, real knitted wool \u2014 no costumes, no Santa suits on the family, no matching novelty outfits.\n\n**SETTING:** Outdoors in soft falling snow at dusk, in front of a tall, naturally decorated Christmas tree with warm white fairy lights and simple red and gold baubles. Snow-covered pine branches frame the edges. A dusting of snow on the ground, footprints behind them. No buildings, no strangers, no animals, no sleigh, no Santa figure.\n\n**THE NAME IN LIGHTS \u2014 THE HERO DETAIL:** The family name \"{NAME}\" is spelled out in large, warm gold fairy lights, strung across the Christmas tree directly behind the family and glowing softly in the snow-lit air behind them, so the name reads clearly above and around their heads like a golden signature. Each letter is formed by the lights themselves \u2014 elegant, even, perfectly legible, the brightest and clearest thing in the scene after the family's faces. A guest reads the name at a glance. Spell the name EXACTLY as \"{NAME}\": the same letters, in the same order, with the same spelling and capitalisation. No extra words, no extra letters, no year, no greeting, no other text anywhere.\n\n**LIGHT:** Low winter dusk light, cool blue-grey ambient, warmed by the golden glow of the tree lights and the name in lights falling on their faces from the front-left. Faces are bright, clear, and evenly lit \u2014 no face in shadow, no harsh flash. Gentle snowfall catching the light.\n\n**COLOUR:** Deep forest green, warm cream, classic Christmas red, and soft gold \u2014 restrained and elegant, not saturated. The gold of the name in lights is warm metallic, never yellow. Snow is white with a faint blue shadow, never grey or yellow.\n\n**LENS & COMPOSITION:** Photorealistic family portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all four faces fully in frame with breathing room above the heads, family centred, tree and the name in lights directly behind them, shallow depth of field so the background lights melt into soft round bokeh \u2014 but the letters of the name stay sharp and readable. Portrait orientation, 3:4.\n\n**MOOD:** Warm, calm, proud \u2014 the photograph a family frames and keeps for twenty years, with their name shining in it. Genuine relaxed smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all four faces AND on the letters of the name, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas, ornament, and 5\u00d77 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image EXCEPT the family name \"{NAME}\" spelled out in lights. No changing any face. No extra people, no extra fingers, no extra limbs, no melted hands \u2014 hands relaxed at sides or holding a mug, fingers clearly separated. No cartoon, illustration, CGI, or plastic-skin look. No watermark, no logo, no border, no frame.",
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
  "drawing": "**DRAWING LOCK \u2014 do not change:** The uploaded image is a child's drawing, NOT a photograph. Keep the drawing's characters, shapes, colours and spirit exactly as the child drew them: every character the child drew stays in the scene, in the same poses and the same grouping, even the funny ones \u2014 a three-eyed monster keeps three eyes, a green dog stays green, purple hair stays purple, extra-long arms stay extra-long. Do not 'fix', tidy up, or normalise the drawing into ordinary people, and do not add, remove, or swap any character. Keep the child's colour choices wherever the drawing made them.\n\n**SUBJECT \u2014 DRAWING MADE REAL:** Render the drawing's characters as real, warm, photorealistic people (and creatures, where the child drew one) in a Christmas portrait scene, so each character is still clearly recognisable as the one the child drew: same faces, same hair, same colours, same expressions, same poses. A monster the child drew becomes a real, friendly creature with the same features \u2014 or a real child in a costume that keeps those features \u2014 whichever keeps the character recognisable. The result is a real photograph of the drawing's characters, not a drawing of a photograph.\n\n**SETTING:** A warm Christmas scene around them: a decorated tree with warm white fairy lights and simple red and gold baubles, a fireplace glow to one side, wrapped presents on the floor, gentle snow falling outside a window. The setting is real and photographic; only the characters carry the drawing's playful spirit. No strangers, no extra people, no animals the child did not draw.\n\n**LIGHT:** Warm, soft portrait light on every character from the front-left, faces bright and clear, no face in shadow, gentle glow from the tree lights and the fire. Warm, never orange or blown out.\n\n**COLOUR:** Warm and joyful, led by the colours the child chose, plus classic Christmas red, forest green and soft gold. Skin stays natural where the drawing made it natural; keep the child's bold colours where the drawing used them.\n\n**LENS & COMPOSITION:** Photorealistic family Christmas portrait photograph, shot on an 85mm portrait lens at f/2.8, head-to-waist framing, all characters fully in frame with breathing room above the heads, family centred, tree directly behind them, shallow depth of field so the background lights melt into soft round bokeh. Portrait orientation, 3:4.\n\n**MOOD:** Warm, playful, magical \u2014 a child's drawing come to life for Christmas, the portrait a family frames and keeps. Genuine relaxed smiles, looking at the camera.\n\n**PRINT SPEC:** Sharp focus on all characters' faces, clean edges, natural photographic detail, no noise, no JPEG artefacts, suitable for enlarging to canvas and 5\u00d77 card print.\n\n**FORBIDDEN:** No text or letters anywhere in the image. Do not 'correct' the drawing into ordinary people \u2014 a character the child drew with three eyes must still have three eyes. No extra characters, no extra fingers, no extra limbs, no melted hands. No cartoon or flat-illustration look \u2014 the result is a real photograph of the drawing's characters, not a drawing of a photograph. No watermark, no logo, no border, no frame."
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
  return resolved;
}

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
          // All eleven style prompts are written for 3:4 portrait. The model
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
      "Edit image 0. Keep the exact same faces, people, poses and grouping of the people in image 0 — do not change any face, do not add or remove any person. Only restyle the scene, clothes and lighting as follows. The family name must appear spelled out in warm gold fairy lights as the hero detail of the scene, exactly as written below — that lit-up name is required, and it is the ONLY text in the image. The result is a photorealistic family Christmas portrait, portrait orientation 3:4.\n\n" +
      body
    );
  }
  if (style === "drawing") {
    return (
      "Edit image 0. Image 0 is a child's drawing, not a photograph: keep the drawing's characters, shapes, colours and spirit exactly as drawn — every character, even the funny ones — and render them as real people and creatures in a photorealistic Christmas portrait scene, in the same poses and grouping. Do not 'fix' the drawing into ordinary people. The result is a photorealistic family Christmas portrait, portrait orientation 3:4. Do not add any text or letters anywhere in the image.\n\n" +
      body
    );
  }
  return (
    "Edit image 0. Keep the exact same faces, people, poses, clothing and grouping of the people in image 0 — do not change any face, do not add or remove any person. Only restyle the scene, clothes and lighting as follows. The result is a photorealistic family Christmas portrait, portrait orientation 3:4. Do not add any text or letters anywhere in the image.\n\n" +
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
