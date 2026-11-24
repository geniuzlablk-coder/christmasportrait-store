/**
 * Christmas Portrait Studio — AI Restyle client snippet
 * ============================================================
 * HOW TO USE (parent agent — inline this file into index.html,
 * inside the existing Preview Studio <script>, or load it as a
 * <script src="restyle-client-snippet.js"> BEFORE the Studio script):
 *
 *   1. If the restyle Worker is deployed as a SEPARATE worker
 *      (recommended Option A), point ENDPOINT at it:
 *         CPSRestyle.configure({ endpoint: "https://api.christmasportrait.store/api/restyle" });
 *      If the combined worker (Option B) ever ships, the default
 *      "/api/restyle" (same origin) is correct — change nothing.
 *   2. Wire the "Transform with AI" button to:
 *         CPSRestyle.transform(fileOrDataUrl, selectedStyleId)
 *      where selectedStyleId is one of the six ids in STYLE_IDS
 *      (or "01"–"06" — the Worker accepts both).
 *   3. Listen for state changes to update the button / progress UI:
 *         CPSRestyle.onState(function (s) { ... s.state ... });
 *   4. On "ready", the watermarked low-res preview is already drawn
 *      into the featured stage (see WATERMARKING below). Use
 *      CPSRestyle.getPreviewDataURL() if the parent wants to feed
 *      the same preview into the product tiles.
 *
 * STATES: idle | uploading | transforming | ready | error | not_configured
 *   - uploading:    the photo is being sent to /api/restyle.
 *   - transforming: the Worker is waiting on the Gemini model.
 *   - ready:        preview drawn, transforms_remaining updated.
 *   - error:        state.message explains it; state.retryable
 *                   is true for overload/timeout (safe to retry).
 *   - not_configured: no GEMINI_API_KEY on the Worker yet. Show the
 *                   real example assets + this exact line:
 *                   "AI Transform opens the moment the studio key
 *                   is added." Do NOT show a broken button.
 *
 * WATERMARKING — READ THIS:
 * The Worker does NOT watermark. THIS file does. The model image
 * returned by the Worker is downscaled to max 800 px on its longest
 * side, drawn into an overlay canvas inside #pvFeatStage, and a
 * diagonal "PREVIEW" watermark is drawn over it (repeated, rotated
 * -30°, semi-transparent). The preview the customer sees is
 * therefore ALWAYS low-res + watermarked. The paid full-res version
 * is delivered watermark-free after payment + human check — never
 * from this canvas. Do not remove the watermark call.
 *
 * DEPENDENCY-FREE: plain browser JS, no libraries. Works with the
 * Studio's existing elements: #pvFeatStage (featured preview stage),
 * #pvFile (upload input) and #pvChips (style picker) are read-only
 * lookups — this file creates its own canvas (#pvAiCanvas) inside
 * #pvFeatStage and never rewrites the Studio's own markup.
 * No API key is ever present in this file or sent from it.
 */
(function () {
  "use strict";

  // ---- config (change ENDPOINT for the separate-worker deploy) ----
  var ENDPOINT = "/api/restyle"; // Option B default. Option A: "https://api.christmasportrait.store/api/restyle"
  var MAX_PREVIEW_PX = 800; // longest side of the displayed preview
  var PREVIEW_WATERMARK = "PREVIEW";

  var STYLE_IDS = [
    "classic-santa-snow",
    "golden-christmas-movie-poster",
    "cozy-fireplace",
    "snow-globe",
    "colombo-christmas",
    "winter-royal",
  ];

  // ---- state ----
  var state = {
    state: "idle", // idle|uploading|transforming|ready|error|not_configured
    style: null,
    message: "",
    retryable: false,
    transformsRemaining: null, // null = unknown yet (no call made)
    cached: false,
    cacheKey: null,
  };
  var listeners = [];
  var previewDataURL = null; // watermarked, low-res data URL (for tiles)
  var currentRequest = 0; // guards against overlapping transforms

  function setState(patch) {
    for (var k in patch) state[k] = patch[k];
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (e) { /* listener errors must not break the Studio */ }
    }
  }

  // ---- watermarked preview rendering ----
  // Draws the model image downscaled (max 800 px) into an overlay
  // canvas inside #pvFeatStage, with a diagonal PREVIEW watermark.
  // Returns a Promise resolving to the watermarked data URL.
  function drawWatermarkedPreview(imgSrc) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var scale = Math.min(1, MAX_PREVIEW_PX / Math.max(img.naturalWidth, img.naturalHeight));
          var w = Math.max(1, Math.round(img.naturalWidth * scale));
          var h = Math.max(1, Math.round(img.naturalHeight * scale));

          var stage = document.getElementById("pvFeatStage");
          var canvas = document.getElementById("pvAiCanvas");
          if (!canvas) {
            if (!stage) throw new Error("Preview Studio stage (#pvFeatStage) not found");
            canvas = document.createElement("canvas");
            canvas.id = "pvAiCanvas";
            canvas.setAttribute("aria-label", "AI restyled preview — watermarked");
            canvas.style.cssText =
              "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:5;";
            stage.appendChild(canvas);
          }
          // Canvas pixels = the low-res preview itself (never full-res).
          canvas.width = w;
          canvas.height = h;
          var ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, w, h);

          // Diagonal PREVIEW watermark, repeated across the image.
          // This is the honesty mechanism — never skip it.
          ctx.save();
          ctx.translate(w / 2, h / 2);
          ctx.rotate((-30 * Math.PI) / 180);
          ctx.font = "bold " + Math.max(28, Math.round(w / 12)) + "px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "rgba(255,255,255,0.38)";
          ctx.strokeStyle = "rgba(0,0,0,0.25)";
          ctx.lineWidth = 2;
          var step = Math.round(w / 2.4);
          for (var y = -h; y <= h; y += step) {
            for (var x = -w; x <= w; x += step) {
              ctx.fillText(PREVIEW_WATERMARK, x, y);
              ctx.strokeText(PREVIEW_WATERMARK, x, y);
            }
          }
          ctx.restore();

          canvas.style.display = "block";
          previewDataURL = canvas.toDataURL("image/jpeg", 0.82);
          resolve(previewDataURL);
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = function () { reject(new Error("Could not load the restyled preview")); };
      img.src = imgSrc;
    });
  }

  function hidePreview() {
    var canvas = document.getElementById("pvAiCanvas");
    if (canvas) canvas.style.display = "none";
    previewDataURL = null;
  }

  // ---- API call ----
  // Accepts a File/Blob (from #pvFile) or a data URL string.
  // Returns a Promise resolving to the state object.
  function transform(fileOrDataUrl, styleId) {
    var requestId = ++currentRequest;
    var style = (styleId || "").trim().toLowerCase();
    if (STYLE_IDS.indexOf(style) === -1 && !/^[0-6]{2}$/.test(style)) {
      setState({ state: "error", message: "Pick a style first, then tap Transform with AI.", retryable: false });
      return Promise.resolve(state);
    }

    var form = new FormData();
    form.append("style", style);
    var bodyPromise;
    if (typeof fileOrDataUrl === "string") {
      // Data URL -> Blob, so the upload stays multipart like a file.
      var parts = fileOrDataUrl.split(",");
      var mime = (parts[0].match(/data:(.*?);/) || [])[1] || "image/jpeg";
      var bin = atob(parts[1] || "");
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      form.append("image", new Blob([bytes], { type: mime }), "photo.jpg");
      bodyPromise = Promise.resolve(form);
    } else {
      form.append("image", fileOrDataUrl);
      bodyPromise = Promise.resolve(form);
    }

    setState({ state: "uploading", style: style, message: "Uploading your photo…", retryable: false });

    return bodyPromise
      .then(function (body) {
        if (requestId !== currentRequest) return state; // superseded
        setState({ state: "transforming", message: "Transforming with AI — this takes a few seconds…" });
        return fetch(ENDPOINT, { method: "POST", body: body });
      })
      .then(function (res) {
        if (requestId !== currentRequest) return state;
        // The Worker answers 503 not_configured until the studio key lands.
        if (res.status === 503) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (data && data.error === "not_configured") {
              setState({
                state: "not_configured",
                message: "AI Transform opens the moment the studio key is added.",
                retryable: false,
              });
            } else {
              setState({ state: "error", message: "The AI studio is busy — please try again.", retryable: true });
            }
            return state;
          });
        }
        return res.json().catch(function () { return null; }).then(function (data) {
          if (!data) {
            setState({ state: "error", message: "The AI studio did not answer — please try again.", retryable: true });
            return state;
          }
          if (!res.ok) {
            var msg = "Something went wrong — please try again.";
            if (data.error === "rate_limited" || data.error === "daily_cap") {
              msg = data.message || "You have used today's free AI transforms. Try again tomorrow.";
            } else if (data.error === "model_rate_limited") {
              // Gemini image model at its free-tier quota (verified live
              // 2026-11-24). The Worker already waited out nothing and
              // did NOT retry in a loop — this is the one manual retry.
              msg = data.message || "The AI studio is busy right now — please wait a minute and try again.";
              if (typeof data.retry_after_seconds === "number" && data.retry_after_seconds > 0) {
                msg += " (about " + (data.retry_after_seconds < 90 ? data.retry_after_seconds + " seconds" : Math.round(data.retry_after_seconds / 60) + " minutes") + ")";
              }
            } else if (data.error === "invalid_style") msg = "That style is not available — pick another.";
            else if (data.error === "image_too_large") msg = "That photo is over 10 MB — try a smaller one.";
            else if (data.error === "invalid_image" || data.error === "missing_image") msg = "That file is not a photo (JPEG, PNG or WebP).";
            if (typeof data.transforms_remaining === "number") {
              setState({ transformsRemaining: data.transforms_remaining });
            }
            setState({ state: "error", message: msg, retryable: !!data.retryable || res.status === 429 });
            return state;
          }
          // Success: draw the watermarked low-res preview.
          if (typeof data.transforms_remaining === "number") {
            setState({ transformsRemaining: data.transforms_remaining });
          }
          var mimeType = data.mime_type || "image/png";
          return drawWatermarkedPreview("data:" + mimeType + ";base64," + data.image_b64)
            .then(function () {
              setState({
                state: "ready",
                style: style,
                cached: !!data.cached,
                cacheKey: data.cache_key || null,
                message: data.cached
                  ? "Preview ready — restored from your earlier transform."
                  : "Preview ready — this is a watermarked preview. Pay to unlock the full-res portrait.",
              });
              return state;
            })
            .catch(function () {
              setState({ state: "error", message: "The transform finished but the preview could not be shown.", retryable: true });
              return state;
            });
        });
      })
      .catch(function (err) {
        if (requestId !== currentRequest) return state;
        // Network failure (Worker down / offline) — not a model error.
        setState({ state: "error", message: "Could not reach the AI studio — check your connection and try again.", retryable: true });
        return state;
      });
  }

  // ---- public API ----
  window.CPSRestyle = {
    STYLE_IDS: STYLE_IDS,
    /** Current state object (see STATES above). */
    getState: function () { return state; },
    /** Remaining free transforms today (null until the first call). */
    getTransformsRemaining: function () { return state.transformsRemaining; },
    /** Watermarked low-res preview data URL, or null. Feed it to product tiles. */
    getPreviewDataURL: function () { return previewDataURL; },
    /** Subscribe to state changes: fn(state). Returns an unsubscribe fn. */
    onState: function (fn) {
      listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    /** Override the endpoint (Option A separate worker). */
    configure: function (opts) {
      if (opts && typeof opts.endpoint === "string" && opts.endpoint) ENDPOINT = opts.endpoint;
    },
    /** Run a transform. fileOrDataUrl: File/Blob or data-URL string. */
    transform: transform,
    /** Hide the AI preview and return to idle (e.g. style changed, photo removed). */
    clear: function () {
      currentRequest++; // cancel any in-flight transform
      hidePreview();
      setState({ state: "idle", style: null, message: "", retryable: false, cached: false, cacheKey: null });
    },
    /** Ask the Worker whether the studio key is configured (GET probe). */
    probe: function () {
      return fetch(ENDPOINT, { method: "GET" })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data && data.configured === false) {
            setState({ state: "not_configured", message: "AI Transform opens the moment the studio key is added.", retryable: false });
          }
          return data;
        })
        .catch(function () { return null; });
    },
  };
})();
