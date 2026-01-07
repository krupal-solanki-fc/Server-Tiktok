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
      "GET /api/server-info - Get server data",
      "GET /ip-check - Check IP & region",
      "GET /tiktok-business-test - Test Business API",
      "GET /tiktok-events-test - Test Events API",
      "POST /test-track-tiktok - Send test event"
    ]
  });
});

/**
 * Server info - shows what data the server sees
 * This helps debug what TikTok will receive
 */
app.get("/api/server-info", async (req, res) => {
  const clientIP = getClientIP(req);
  const userAgent = req.get("User-Agent") || "Unknown";
  
  // Try to get location from IP
  let location = "Unknown";
  try {
    const geoResponse = await axios.get(`http://ip-api.com/json/${clientIP}`, {
      timeout: 3000
    });
    if (geoResponse.data && geoResponse.data.status === "success") {
      location = `${geoResponse.data.city}, ${geoResponse.data.country}`;
    }
  } catch (err) {
    // Ignore geo lookup errors
  }
  
  res.json({
    clientIP,
    location,
    userAgent,
    headers: {
      "x-forwarded-for": req.headers["x-forwarded-for"] || "not set",
      "x-real-ip": req.headers["x-real-ip"] || "not set"
    },
    serverTime: new Date().toISOString()
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
      phone,
      value,
      currency,
      // TikTok-specific identifiers for better matching
      ttclid,
      ttp,
      // Browser data sent from frontend
      browserData = {}
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

    const eventId = `evt_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    
    // Use client's real IP from request headers (works with Render's proxy)
    const clientIP = getClientIP(req);
    
    // Use browser's User-Agent from frontend, fallback to request header
    const userAgent = browserData.userAgent || req.get("User-Agent") || "Mozilla/5.0";
    
    // Generate external_id for user matching (use email hash or generate one)
    const externalId = email 
      ? hash(email) 
      : `user_${crypto.randomBytes(8).toString("hex")}`;

    // Warning flags for debugging
    const warnings = [];
    if (!ttp) {
      warnings.push("Missing _ttp cookie - Load TikTok Pixel first for better matching");
    }
    if (!email && !phone) {
      warnings.push("No email/phone provided - Event matching may be limited");
    }

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
            url: url || "https://example.com",
            // Include referrer from browser
            ...(browserData.referrer && browserData.referrer !== "Direct" && { referrer: browserData.referrer })
          },
          user: {
            // CRITICAL: External ID helps TikTok match server events
            external_id: externalId,
            // Use the actual browser's User-Agent
            user_agent: userAgent,
            // Use real client IP (Render passes this via x-forwarded-for)
            ip: clientIP,
            // Locale from browser
            ...(browserData.language && { locale: browserData.language }),
            // Hashed email (TikTok requires array format)
            ...(email && { email: [hash(email)] }),
            // Hashed phone (TikTok requires array format)
            ...(phone && { phone: [hash(phone)] }),
            // TikTok click ID from URL parameter (ttclid) - IMPORTANT for attribution
            ...(ttclid && { ttclid }),
            // TikTok browser ID cookie (_ttp) - CRITICAL for server event matching
            ...(ttp && { ttp })
          },
          properties: {
            ...(currency && { currency: currency.toUpperCase() }),
            ...(value && { value: Number(value) }),
            // Add content_type for better event categorization
            content_type: "product"
          }
        }
      ]
    };
    
    // Log the full payload for debugging
    console.log("[TikTok Event] Sending:", JSON.stringify(payload, null, 2));

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

    // Log TikTok's response
    console.log("[TikTok Response]", JSON.stringify(response.data));

    // Determine if event was truly successful
    const tiktokCode = response.data?.code;
    const isSuccess = tiktokCode === 0;

    res.json({
      success: isSuccess,
      eventId,
      // Warnings about potential issues
      ...(warnings.length > 0 && { warnings }),
      // Show what data was sent (for debugging)
      sentData: {
        event,
        external_id: externalId.substring(0, 16) + "...",
        ip: clientIP,
        userAgent: userAgent.substring(0, 50) + "...",
        locale: browserData.language || "not set",
        url: url,
        ttp: ttp ? ttp.substring(0, 20) + "..." : "NOT SET - Load Pixel first!",
        ttclid: ttclid || "not present",
        hasEmail: !!email,
        hasPhone: !!phone
      },
      tiktokResponse: {
        code: tiktokCode,
        message: response.data?.message,
        data: response.data?.data
      },
      // Help text
      help: !ttp 
        ? "⚠️ For server events to show in TikTok: 1) Enter Pixel ID 2) Wait for pixel to load 3) Then send event"
        : "✅ Event sent with _ttp cookie - should appear in TikTok Data Sources"
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
