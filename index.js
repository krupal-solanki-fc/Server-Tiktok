import express from "express";
import axios from "axios";

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

app.post("/test-track-tiktok", async (req, res) => {
    try {
      const {
        pixelId,
        accessToken,
        testEventCode,
        event = "PageView",
        eventId,
        url,
        ip,
        userAgent,
        ttp,
        ttclid,
        email,
        phone,
        firstName,
        lastName,
        currency,
        value
      } = req.body;
  
      // Basic validation
      if (!pixelId || !accessToken) {
        return res.status(400).json({
          error: "pixelId and accessToken are required"
        });
      }
  
      const eventData = {
        event,
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId || `test_${Date.now()}`,
        page: {
          url: url || "https://example.com"
        },
        user: {
          ip: ip || req.ip,
          user_agent: userAgent || req.get("User-Agent")
        },
        properties: {}
      };
  
      // Optional identifiers
      if (ttp) eventData.user.ttp = ttp;
      if (ttclid) eventData.user.ttclid = ttclid;
  
      // Hashed identifiers (TikTok requires arrays)
      if (email) eventData.user.email = [email];
      if (phone) eventData.user.phone = [phone];
      if (firstName) eventData.user.first_name = [firstName];
      if (lastName) eventData.user.last_name = [lastName];
  
      // Properties
      if (currency) eventData.properties.currency = currency;
      if (value) eventData.properties.value = Number(value);
  
      const payload = {
        pixel_code: pixelId,
        event_source: "web",
        events: [eventData]
      };
  
      // Test mode (strongly recommended)
      if (testEventCode) {
        payload.test_event_code = testEventCode;
      }
  
      const tiktokResponse = await axios.post(
        "https://business-api.tiktok.com/open_api/v1.3/event/track/",
        payload,
        {
          headers: {
            "Access-Token": accessToken,
            "Content-Type": "application/json"
          },
          timeout: 5000
        }
      );
  
      res.json({
        success: true,
        request: payload,
        tiktokResponse: tiktokResponse.data
      });
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
