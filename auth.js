// Copyright 2023 IdeaVault, Inc. All rights reserved.

function getJwksUrl() {
  if (process.env.AUTH_JWKS_URL) return process.env.AUTH_JWKS_URL;
  const clientUrl =
    process.env.CLIENT_URL ||
    (process.env.NODE_ENV === "production"
      ? "https://ideavaultclient-beta.vercel.app"
      : "http://localhost:3000");
  return `${clientUrl.replace(/\/+$/, "")}/api/auth/jwks`;
}

let verifierPromise = null;

function getVerifier() {
  if (!verifierPromise) {
    verifierPromise = import("jose").then(({ createRemoteJWKSet, jwtVerify }) => {
      const jwks = createRemoteJWKSet(new URL(getJwksUrl()), {
        timeoutDuration: 6000,
        cooldownDuration: 30000,
      });
      return (token) => jwtVerify(token, jwks);
    });
  }
  return verifierPromise;
}

// Express middleware: 401 unless a valid token is present. Sets req.user.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ success: false, message: "Please log in to do that." });
  }

  try {
    const verify = await getVerifier();
    const { payload } = await verify(match[1]);
    if (!payload.email) {
      return res.status(401).json({ success: false, message: "Token has no user email." });
    }
    req.user = {
      id: payload.sub || payload.id,
      email: String(payload.email),
      name: payload.name ? String(payload.name) : "Anonymous Innovator",
    };
    next();
  } catch (error) {
    const expired = error && error.code === "ERR_JWT_EXPIRED";
    const unreachable =
      error && (error.code === "ERR_JWKS_TIMEOUT" || error.name === "TypeError" || error.code === "ECONNREFUSED");
    console.error("Auth verification failed:", error && (error.code || error.message));
    if (unreachable) {
      return res.status(503).json({
        success: false,
        message: `Could not reach the auth key endpoint (${getJwksUrl()}). Check CLIENT_URL on the server.`,
      });
    }
    res.status(401).json({
      success: false,
      message: expired ? "Your session expired. Please log in again." : "Invalid login token.",
    });
  }
}

const sameEmail = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();

module.exports = { requireAuth, sameEmail, getJwksUrl };