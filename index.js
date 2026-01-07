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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
