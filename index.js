import express from "express";
import axios from "axios";
import crypto from "crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;

/**
 * Root health check
 */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "tiktok-connectivity-test",
    timestamp: new Date().toISOString()
  });
});

/**
 * Robust IP + Region check
 * Uses multiple providers with fallback
 */
app.get("/ip-check", async (req, res) => {
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

  for (const provider of providers) {
    try {
      const response = await axios.get(provider.url, {
        timeout: 5000
      });

      return res.json({
        provider: provider.name,
        data: response.data
      });
    } catch (err) {
      // try next provider
    }
  }

  res.status(500).json({
    error: "All IP providers failed",
    hint: "Outbound networking may be blocked"
  });
});

/**
 * TikTok Business API connectivity test
 * 401 / 403 = SUCCESS (means reachable)
 */
app.get("/tiktok-business-test", async (req, res) => {
  try {
    const response = await axios.get(
      "https://business-api.tiktok.com/open_api/v1.3/pixel/list/",
      {
        timeout: 5000,
        headers: {
          "User-Agent": "Render-TikTok-Test"
        },
        validateStatus: () => true
      }
    );

    res.json({
      reachable: true,
      httpStatus: response.status,
      interpretation:
        response.status === 401 || response.status === 403
          ? "SUCCESS: TikTok API reachable (auth expected)"
          : "Unexpected status but network reachable"
    });
  } catch (err) {
    res.status(500).json({
      reachable: false,
      error: err.message,
      interpretation: "Network / DNS / TLS failure"
    });
  }
});

/**
 * TikTok Events API connectivity test
 * Does NOT send real events
 */
app.get("/tiktok-events-test", async (req, res) => {
  try {
    const response = await axios.post(
      "https://business-api.tiktok.com/open_api/v1.3/event/track/",
      {},
      {
        timeout: 5000,
        validateStatus: () => true
      }
    );

    res.json({
      reachable: true,
      httpStatus: response.status,
      interpretation:
        response.status >= 400 && response.status < 500
          ? "SUCCESS: Events API reachable (auth/data expected)"
          : "Unexpected response"
    });
  } catch (err) {
    res.status(500).json({
      reachable: false,
      error: err.message,
      interpretation: "Network / DNS / TLS failure"
    });
  }
});



const hash = (v) =>
  crypto.createHash("sha256").update(v.trim().toLowerCase()).digest("hex");

app.post("/test-track-tiktok", async (req, res) => {
  try {
    const {
      pixelId,
      accessToken,
      testEventCode,
      event = "PageView",
      url,
      email,
      value,
      currency
    } = req.body;

    if (!pixelId || !accessToken) {
      return res.status(400).json({
        error: "pixelId and accessToken are required"
      });
    }

    const payload = {
      pixel_code: pixelId,
      event_source: "web",
      test_event_code: testEventCode,
      events: [
        {
          event,
          event_time: Math.floor(Date.now() / 1000),
          event_id: `test_${Date.now()}`,
          page: {
            url: url || "https://example.com"
          },
          user: {
            user_agent: req.get("User-Agent") || "Mozilla/5.0",
            ip: req.ip,
            ...(email && { email: [hash(email)] })
          },
          properties: {
            ...(currency && { currency }),
            ...(value && { value: Number(value) })
          }
        }
      ]
    };

    const response = await axios.post(
      "https://business-api.tiktok.com/open_api/v1.3/event/track/",
      payload,
      {
        headers: {
          "Access-Token": accessToken,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ success: true, data: response.data });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      tiktokError: err.response?.data
    });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
