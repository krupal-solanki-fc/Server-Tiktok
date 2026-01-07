import express from "express";
import axios from "axios";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

// ES Module __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

// Trust proxy for correct IP detection behind load balancers
app.set("trust proxy", true);

const PORT = process.env.PORT || 5000;

// Constants
const TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3";
const REQUEST_TIMEOUT = 5000;

/**
 * Async handler wrapper to catch errors
 */
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Hash helper for PII data
 */
const hash = (value) =>
  crypto
    .createHash("sha256")
    .update(String(value).trim().toLowerCase())
    .digest("hex");

/**
 * Get client IP address (handles proxies)
 */
const getClientIP = (req) =>
  req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
  req.headers["x-real-ip"] ||
  req.ip ||
  req.socket?.remoteAddress ||
  "unknown";

/**
 * API health check
 */
app.get("/api", (req, res) => {
  res.json({
    status: "ok",
    service: "tiktok-connectivity-test",
    timestamp: new Date().toISOString(),
    endpoints: [
      "GET /api - Health check",
      "GET /ip-check - Check IP & region",
      "GET /tiktok-business-test - Test Business API",
      "GET /tiktok-events-test - Test Events API",
      "POST /test-track-tiktok - Send test event"
    ]
  });
});

/**
 * Robust IP + Region check
 * Uses multiple providers with fallback
 */
app.get(
  "/ip-check",
  asyncHandler(async (req, res) => {
    const providers = [
      {
        name: "ifconfig.me",
        url: "https://ifconfig.me/all.json"
      },
      {
        name: "ip-api",
        url: "http://ip-api.com/json"
      }
    ];

    const errors = [];

    for (const provider of providers) {
      try {
        const response = await axios.get(provider.url, {
          timeout: REQUEST_TIMEOUT
        });

        return res.json({
          provider: provider.name,
          data: response.data
        });
      } catch (err) {
        errors.push({
          provider: provider.name,
          error: err.message
        });
      }
    }

    res.status(500).json({
      error: "All IP providers failed",
      hint: "Outbound networking may be blocked",
      details: errors
    });
  })
);

/**
 * TikTok Business API connectivity test
 * 401 / 403 = SUCCESS (means reachable)
 */
app.get(
  "/tiktok-business-test",
  asyncHandler(async (req, res) => {
    const response = await axios.get(`${TIKTOK_API_BASE}/pixel/list/`, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        "User-Agent": "TikTok-Connectivity-Test/1.0"
      },
      validateStatus: () => true
    });

    const isReachable = response.status >= 200 && response.status < 500;

    res.json({
      reachable: isReachable,
      httpStatus: response.status,
      interpretation:
        response.status === 401 || response.status === 403
          ? "SUCCESS: TikTok API reachable (auth expected)"
          : response.status >= 200 && response.status < 300
            ? "SUCCESS: TikTok API reachable"
            : isReachable
              ? "Reachable but unexpected status"
              : "Server error from TikTok"
    });
  })
);

/**
 * TikTok Events API connectivity test
 * Does NOT send real events
 */
app.get(
  "/tiktok-events-test",
  asyncHandler(async (req, res) => {
    const response = await axios.post(
      `${TIKTOK_API_BASE}/event/track/`,
      {},
      {
        timeout: REQUEST_TIMEOUT,
        validateStatus: () => true
      }
    );

    const isReachable = response.status >= 200 && response.status < 500;

    res.json({
      reachable: isReachable,
      httpStatus: response.status,
      interpretation:
        response.status >= 400 && response.status < 500
          ? "SUCCESS: Events API reachable (auth/data error expected)"
          : "Unexpected response"
    });
  })
);

/**
 * Test track event to TikTok
 * Sends a real test event to TikTok Events API
 */
app.post(
  "/test-track-tiktok",
  asyncHandler(async (req, res) => {
    const {
      pixelId,
      accessToken,
      testEventCode,
      event = "PageView",
      url,
      email,
      value,
      currency,
      // TikTok-specific identifiers for better matching
      ttclid,
      ttp
    } = req.body;

    // Validate required fields
    if (!pixelId || !accessToken) {
      return res.status(400).json({
        success: false,
        error: "Validation failed",
        details: {
          pixelId: !pixelId ? "Required" : "OK",
          accessToken: !accessToken ? "Required" : "OK"
        }
      });
    }

    // Validate event type
    const validEvents = [
      "PageView",
      "ViewContent",
      "AddToCart",
      "InitiateCheckout",
      "PlaceAnOrder",
      "CompletePayment",
      "Contact",
      "SubmitForm",
      "Subscribe",
      "CompleteRegistration"
    ];

    if (!validEvents.includes(event)) {
      return res.status(400).json({
        success: false,
        error: `Invalid event type. Valid types: ${validEvents.join(", ")}`
      });
    }

    const eventId = `test_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const clientIP = getClientIP(req);

    const payload = {
      event_source: "web",
      event_source_id: pixelId,
      ...(testEventCode && { test_event_code: testEventCode }),
      data: [
        {
          event,
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          page: {
            url: url || "https://example.com"
          },
          user: {
            user_agent:
              req.get("User-Agent") ||
              "Mozilla/5.0 (compatible; TikTokTest/1.0)",
            ip: clientIP,
            ...(email && { email: [hash(email)] }),
            // TikTok click ID from URL parameter (ttclid)
            ...(ttclid && { ttclid }),
            // TikTok browser ID cookie (_ttp)
            ...(ttp && { ttp })
          },
          properties: {
            ...(currency && { currency: currency.toUpperCase() }),
            ...(value && { value: Number(value) })
          }
        }
      ]
    };

    const response = await axios.post(
      `${TIKTOK_API_BASE}/event/track/`,
      payload,
      {
        timeout: REQUEST_TIMEOUT,
        headers: {
          "Access-Token": accessToken,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({
      success: true,
      eventId,
      tiktokResponse: {
        code: response.data?.code,
        message: response.data?.message,
        data: response.data?.data
      }
    });
  })
);

/**
 * Global error handler
 */
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  // Handle Axios errors specifically
  if (err.isAxiosError) {
    return res.status(502).json({
      success: false,
      error: "External API request failed",
      details: {
        message: err.message,
        code: err.code,
        tiktokError: err.response?.data
      }
    });
  }

  res.status(500).json({
    success: false,
    error: err.message || "Internal server error"
  });
});

/**
 * 404 handler for API routes
 */
app.use((req, res) => {
  // Return JSON for API requests, redirect to app for others
  if (req.path.startsWith("/api") || req.accepts("html") !== "html") {
    return res.status(404).json({
      error: "Not found",
      path: req.path,
      availableEndpoints: [
        "GET /api",
        "GET /ip-check",
        "GET /tiktok-business-test",
        "GET /tiktok-events-test",
        "POST /test-track-tiktok"
      ]
    });
  }
  // Serve the main app for other routes (SPA fallback)
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌐 Web UI: http://localhost:${PORT}/`);
  console.log(`📍 API Health: http://localhost:${PORT}/api`);
});
