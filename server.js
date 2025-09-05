
const express = require("express");
const fetch = require("node-fetch"); // node-fetch@2
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;


const STABILITY_API_KEY = process.env.STABILITY_API_KEY || "sk-jEV434w7MuYyOl28wNXg5VToqumcOrkPPpKqBxelWytup3TU";

if (!STABILITY_API_KEY) {
  console.warn("Warning: STABILITY_API_KEY is not set. Set environment variable before production use.");
}

app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));


const RATE_LIMIT = 5; // max images per window
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const requestsMap = new Map(); // key: ip string, value: array of timestamps (ms)

function getClientIp(req) {
  // Prefer X-Forwarded-For when behind proxies
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    return String(xff).split(',')[0].trim();
  }
  // fallback to Express's computed ip
  return req.ip || req.connection.remoteAddress || req.socket.remoteAddress || 'unknown';
}

function rateLimitMiddleware(req, res, next) {
  const ip = getClientIp(req);
  const now = Date.now();
  const arr = requestsMap.get(ip) || [];

  // keep only timestamps within the window
  const recent = arr.filter(ts => now - ts < WINDOW_MS);

  if (recent.length >= RATE_LIMIT) {
    // respond 429 so frontend can detect rate-limit and show friendly message
    return res.status(429).json({
      error: 'rate_limit',
      message: `Rate limit exceeded: max ${RATE_LIMIT} images per ${Math.floor(WINDOW_MS / 3600000)} hour(s).`
    });
  }

  // record current request
  recent.push(now);
  requestsMap.set(ip, recent);
  next();
}

// Endpoint: generate image (with rate-limit applied)
app.post("/generate-image", rateLimitMiddleware, async (req, res) => {
  try {
    const { prompt, cfg_scale = 7, width = 1024, height = 1024, steps = 30, samples = 1 } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Prompt is required" });
    }

    if (!STABILITY_API_KEY) {
      return res.status(500).json({ error: "server_config", message: "STABILITY_API_KEY not configured on server." });
    }

    // Call Stability AI text-to-image endpoint (example: SDXL 1024)
    const apiRes = await fetch("https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${STABILITY_API_KEY}`
      },
      body: JSON.stringify({
        text_prompts: [{ text: prompt }],
        cfg_scale: cfg_scale,
        width: width,
        height: height,
        steps: steps,
        samples: samples
      })
    });

    if (!apiRes.ok) {
      const text = await apiRes.text();
      console.error("Stability API error:", apiRes.status, text);
      // forward upstream status code (e.g., 429 from Stability) so frontend can handle appropriately
      return res.status(apiRes.status).json({ error: "Stability API error", status: apiRes.status, details: text });
    }

    const data = await apiRes.json();

    // Extract base64 image from Stability response (artifacts[0].base64)
    if (data && data.artifacts && data.artifacts[0] && data.artifacts[0].base64) {
      const b64 = data.artifacts[0].base64;
      return res.json({
        image_b64: b64,
        image_data_uri: `data:image/png;base64,${b64}`
      });
    }

    // No image returned
    return res.status(500).json({ error: "no_image_returned", raw: data });

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "server_error", message: err.message });
  }
});

// Optional: endpoint to check remaining requests for client IP (helpful for UI)
app.get("/rate-limit-status", (req, res) => {
  const ip = getClientIp(req);
  const now = Date.now();
  const arr = requestsMap.get(ip) || [];
  const recent = arr.filter(ts => now - ts < WINDOW_MS);
  const remaining = Math.max(0, RATE_LIMIT - recent.length);
  const resetMs = recent.length ? (WINDOW_MS - (now - recent[0])) : WINDOW_MS;
  return res.json({ limit: RATE_LIMIT, remaining, reset_ms: resetMs });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Proxy server with rate-limit running at http://0.0.0.0:${PORT} (Stability AI)`);
});