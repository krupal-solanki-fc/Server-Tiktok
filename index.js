import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

/**
 * Health check
 */
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "TikTok test server running"
  });
});

/**
 * Check server public IP & region
 */
app.get("/ip-check", async (req, res) => {
  try {
    const response = await axios.get("https://ipinfo.io/json", {
      timeout: 5000
    });
    res.json(response.data);
  } catch (err) {
    res.status(500).json({
      error: "IP check failed",
      details: err.message
    });
  }
});

/**
 * Test TikTok Business API DNS + HTTPS
 * (No auth required endpoint)
 */
app.get("/tiktok-dns-test", async (req, res) => {
  try {
    const response = await axios.get(
      "https://business-api.tiktok.com/open_api/v1.3/pixel/list/",
      {
        timeout: 5000,
        headers: {
          "User-Agent": "Render-Test-Server"
        },
        validateStatus: () => true
      }
    );

    res.json({
      status: "reachable",
      httpStatus: response.status
    });
  } catch (err) {
    res.status(500).json({
      status: "failed",
      error: err.message
    });
  }
});

/**
 * OPTIONAL: Test TikTok Events API (no data sent)
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
      status: "reachable",
      httpStatus: response.status
    });
  } catch (err) {
    res.status(500).json({
      status: "failed",
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
