const http = require("http");
const https = require("https");
const fs = require("fs");
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { execSync } = require("child_process");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// ── Config Discord ──────────────────────────────────────────────
const DISCORD_CLIENT_ID     = "1534980941355683950";
const DISCORD_CLIENT_SECRET = "sMPhtifc26xWQQMqZyw8DAE4qMF7HaQr"; // ← mets ton secret ici
const DISCORD_REDIRECT_URI  = "https://myapi-1-nkwt.onrender.com/callback";
// ───────────────────────────────────────────────────────────────

// Enregistre snow:// dans le registre Windows au démarrage
function registerSnowProtocol() {
  try {
    // Cherche le launcher installé ou dans le dossier de build
    const launcherPaths = [
      "C:\\Program Files\\Retrac Launcher\\Retrac Launcher.exe",
      "C:\\Program Files (x86)\\Retrac Launcher\\Retrac Launcher.exe",
      path.join(__dirname, "..", "src-tauri", "target", "release", "retraclauncher.exe"),
    ];

    let launcherExe = launcherPaths.find(p => {
      try { require("fs").accessSync(p); return true; } catch { return false; }
    });

    if (!launcherExe) {
      console.warn("Launcher non trouvé, snow:// non enregistré");
      return;
    }

    const escaped = launcherExe.replace(/\\/g, "\\\\");

    const reg = `
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\\Software\\Classes\\snow]
@="URL:Snow Protocol"
"URL Protocol"=""

[HKEY_CURRENT_USER\\Software\\Classes\\snow\\shell]

[HKEY_CURRENT_USER\\Software\\Classes\\snow\\shell\\open]

[HKEY_CURRENT_USER\\Software\\Classes\\snow\\shell\\open\\command]
@="\\"${escaped}\\" \\"%1\\""
`;

    const regFile = path.join(__dirname, "snow_protocol.reg");
    require("fs").writeFileSync(regFile, reg);
    execSync(`regedit /s "${regFile}"`);
    console.log("Protocole snow:// enregistré pour:", launcherExe);
  } catch (err) {
    console.error("Erreur enregistrement protocole:", err.message);
  }
}

registerSnowProtocol();

// Retourne l'URL OAuth Discord au launcher
app.get("/snow/discord", (req, res) => {
  const url =
    "https://discord.com/oauth2/authorize" +
    "?client_id=" + DISCORD_CLIENT_ID +
    "&redirect_uri=" + encodeURIComponent(DISCORD_REDIRECT_URI) +
    "&response_type=code" +
    "&scope=identify%20email";

  res.json(url);
});

// Stocke les tokens en mémoire (discordId par token)
const tokenStore = new Map();
// Tokens en attente d'être récupérés par le launcher (sessionId → token)
const pendingTokens = new Map();

// Vérifie si le token est valide
app.get("/snow/player/okay", (req, res) => {
  const raw = req.headers.authorization || "";
  const token = decodeURIComponent(raw);
  if (!token || !tokenStore.has(token)) {
    return res.status(401).json({ error: "Token invalide" });
  }
  res.json("ok");
});

// Retourne les infos du joueur à partir du token
app.get("/snow/player", (req, res) => {
  const raw = req.headers.authorization || "";
  // Décode les caractères URL-encodés (%2B etc.)
  const token = decodeURIComponent(raw);
  console.log("GET /snow/player token:", token, "found:", tokenStore.has(token));

  if (!token || !tokenStore.has(token)) {
    return res.status(401).json({ error: "Token invalide" });
  }

  const user = tokenStore.get(token);

  res.json({
    ID: user.discordId,
    Account: {
      DisplayName: user.username,
      Discord: {
        Username: user.username,
        Avatar: user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatar}.png?size=128`
          : `https://cdn.discordapp.com/embed/avatars/0.png`,
      },
      Stats: {},
      State: {
        Packages: [],
        ClaimedPackages: {},
      },
    },
    Profiles: {
      athena: { Items: {}, Loadouts: [], Attributes: {} },
      common_core: { Items: {}, Loadouts: [], Attributes: {} },
    },
  });
});

// Reçoit le code Discord après connexion
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send("Code manquant");
  }

  try {
    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    "authorization_code",
        code:          code,
        redirect_uri:  DISCORD_REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const accessToken = tokenRes.data.access_token;

    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: "Bearer " + accessToken },
    });

    const discordId = userRes.data.id;
    const username  = userRes.data.username;
    console.log("Connexion Discord:", username, discordId);

    const launcherToken = Buffer.from(discordId + ":" + username + ":" + Date.now())
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    tokenStore.set(launcherToken, { discordId, username, avatar: userRes.data.avatar });

    // Stocke aussi dans pendingTokens pour que le launcher puisse le récupérer
    pendingTokens.set(discordId, launcherToken);
    // Nettoie après 5 minutes
    setTimeout(() => pendingTokens.delete(discordId), 5 * 60 * 1000);
    // Pour le polling du launcher
    lastToken = launcherToken;

    // Redirige vers /success pour éviter le rechargement de /callback
    res.redirect("/success?t=" + launcherToken);

  } catch (err) {
    const errorData = err.response?.data || err.message;
    console.error("Erreur OAuth complète:", JSON.stringify(errorData));
    console.error("redirect_uri utilisé:", DISCORD_REDIRECT_URI);
    console.error("code reçu:", code);
    res.status(500).send("Erreur lors de la connexion Discord: " + JSON.stringify(errorData));
  }
});

// Page de succès — ouvre le launcher via snow://
app.get("/success", (req, res) => {
  const token = req.query.t;
  if (!token) return res.status(400).send("Token manquant");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8"/>
  <title>Connexion réussie</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#1a1a2e; color:#fff; font-family:Arial,sans-serif;
           display:flex; justify-content:center; align-items:center; height:100vh; }
    .box { text-align:center; background:#16213e; padding:48px 40px;
           border-radius:14px; box-shadow:0 0 40px rgba(88,101,242,0.4); }
    h2 { color:#5865f2; margin-bottom:12px; }
    p  { color:#aaa; margin-bottom:20px; }
    a  { display:inline-block; padding:12px 28px; background:#5865f2; color:#fff;
         text-decoration:none; border-radius:8px; font-weight:bold; }
    a:hover { background:#4752c4; }
  </style>
</head>
<body>
  <div class="box">
    <h2>Connexion réussie !</h2>
    <p id="msg">Ouverture du launcher...</p>
    <a href="snow://auth@${token}">Ouvrir le Launcher</a>
  </div>
  <script>
    var opened = false;
    function openLauncher() {
      if (opened) return;
      opened = true;
      window.location.href = "snow://auth@${token}";
      setTimeout(function() {
        document.getElementById("msg").textContent = "Si le launcher ne s'ouvre pas, clique sur le bouton.";
      }, 2000);
    }
    setTimeout(openLauncher, 500);
  </script>
</body>
</html>`);
});

app.get("/", (req, res) => res.send("Retrac backend OK"));

// Retourne le dernier token généré (pour polling du launcher en dev)
let lastToken = null;
app.get("/snow/last-token", (req, res) => {
  if (!lastToken) return res.status(204).send();
  const t = lastToken;
  lastToken = null; // consommé une seule fois
  res.json(t);
});

// Génère un code d'échange pour Fortnite
app.get("/snow/player/code", (req, res) => {
  const raw = req.headers.authorization || "";
  const token = decodeURIComponent(raw);
  if (!token || !tokenStore.has(token)) {
    return res.status(401).json({ error: "Token invalide" });
  }
  res.json(token);
});

app.listen(3000, "0.0.0.0", () => {
  console.log("Backend lancé sur http://127.0.0.1:3000");
});

// ── Fortnite Auth Endpoints ─────────────────────────────────────
// Ces endpoints imitent l'API Epic Games pour bypasser le login

// OAuth token — Fortnite demande un token ici
app.post("/account/api/oauth/token", (req, res) => {
  const body = req.body;

  // Cherche l'utilisateur dans le tokenStore via le code d'échange (password)
  let displayName = "EchoPlayer";
  let accountId = "echoplayer" + Date.now().toString(36);

  const exchangeCode = body.password || body.exchange_code || "";
  if (exchangeCode && tokenStore.has(exchangeCode)) {
    const user = tokenStore.get(exchangeCode);
    displayName = user.username;
    accountId = user.discordId;
  } else {
    // Cherche par correspondance partielle si le code est transformé
    for (const [token, user] of tokenStore.entries()) {
      if (exchangeCode && (exchangeCode === token || exchangeCode.includes(user.discordId))) {
        displayName = user.username;
        accountId = user.discordId;
        break;
      }
    }
  }

  const accessToken = "eg1~" + Buffer.from(accountId + ":" + displayName + ":" + Date.now()).toString("base64").replace(/[+=\/]/g, "");

  res.json({
    access_token: accessToken,
    expires_in: 28800,
    expires_at: new Date(Date.now() + 28800000).toISOString(),
    token_type: "bearer",
    account_id: accountId,
    client_id: "3f69e56c7649492c8cc29f1af08a8a12",
    internal_client: true,
    client_service: "fortnite",
    displayName: displayName,
    app: "fortnite",
    in_app_id: accountId,
  });
});

// Exchange code → token
app.get("/account/api/oauth/exchange", (req, res) => {
  const auth = req.headers.authorization || "";
  res.json({
    expiresInSeconds: 300,
    code: auth.replace("bearer ", "").replace("eg1~", "").slice(0, 32),
    creatingClientId: "3f69e56c7649492c8cc29f1af08a8a12",
  });
});

// Verify token
app.get("/account/api/oauth/verify", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^bearer /i, "");

  // Décode le token eg1~ pour récupérer accountId et displayName
  let accountId = "echodefault";
  let displayName = "EchoPlayer";
  try {
    const raw = token.replace("eg1~", "");
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length >= 2) {
      accountId = parts[0];
      displayName = parts[1];
    }
  } catch {}

  res.json({
    token: token,
    session_id: token.slice(0, 32),
    token_type: "bearer",
    client_id: "3f69e56c7649492c8cc29f1af08a8a12",
    internal_client: true,
    client_service: "fortnite",
    account_id: accountId,
    displayName: displayName,
    app: "fortnite",
    in_app_id: accountId,
    expires_in: 28800,
    expires_at: new Date(Date.now() + 28800000).toISOString(),
  });
});

// Account info
app.get("/account/api/public/account/:id", (req, res) => {
  const accountId = req.params.id;

  // Cherche dans le tokenStore si on a les infos pour cet accountId (discordId)
  let displayName = "EchoPlayer";
  for (const [, user] of tokenStore.entries()) {
    if (user.discordId === accountId) {
      displayName = user.username;
      break;
    }
  }

  res.json({
    id: accountId,
    displayName: displayName,
    name: displayName,
    email: "echo@echo.site",
    failedLoginAttempts: 0,
    lastLogin: new Date().toISOString(),
    numberOfDisplayNameChanges: 0,
    ageGroup: "UNKNOWN",
    headless: false,
    country: "FR",
    lastName: "Player",
    links: {},
    preferredLanguage: "fr",
    canUpdateDisplayName: false,
    tfaEnabled: false,
    emailVerified: true,
    minorVerified: false,
    minorExpected: false,
    minorStatus: "UNKNOWN",
  });
});

// Lookup by display name
app.get("/account/api/public/account/displayName/:name", (req, res) => {
  res.json({
    id: "echodefault",
    displayName: req.params.name,
  });
});

// Fortnite entitlement
app.get("/entitlement/api/account/:id/entitlements", (req, res) => {
  res.json([]);
});

// Friends
app.get("/friends/api/public/friends/:id", (req, res) => {
  res.json([]);
});

// Presence
app.get("/presence/api/v1/:ns/:id/settings/subscriptions", (req, res) => {
  res.json({});
});

// Lightswitch
app.get("/lightswitch/api/service/bulk/status", (req, res) => {
  res.json([{
    serviceInstanceId: "fortnite",
    status: "UP",
    message: "Echo is UP",
    maintenanceUri: null,
    overrideCatalogIds: ["a7f138b2e51945ffbfdacc1af0541053"],
    allowedActions: ["PLAY", "DOWNLOAD"],
    banned: false,
  }]);
});

// Catalog
app.get("/catalog/api/shared/bulk/offers", (req, res) => {
  res.json({ elements: [], paging: { count: 0, total: 0 } });
});

// User search
app.post("/datarouter/api/v1/public/data", (req, res) => {
  res.status(204).send();
});

// Crash reporter
app.post("/fortnite/api/game/v2/tryPlayOnPlatform/account/:id", (req, res) => {
  res.send("true");
});

app.post("/fortnite/api/game/v2/enabled_features", (req, res) => {
  res.json([]);
});

// Cloudstorage
app.get("/fortnite/api/cloudstorage/system", (req, res) => {
  res.json([]);
});

app.get("/fortnite/api/cloudstorage/user/:id", (req, res) => {
  res.json([]);
});

// Profile
app.post("/fortnite/api/game/v2/profile/:id/client/:action", (req, res) => {
  res.json({
    profileRevision: 1,
    profileId: req.query.profileId || "athena",
    profileChangesBaseRevision: 1,
    profileChanges: [],
    profileCommandRevision: 1,
    serverTime: new Date().toISOString(),
    responseVersion: 1,
  });
});

// MCP
app.post("/fortnite/api/game/v2/profile/:id/dedicated_server/:action", (req, res) => {
  res.json({
    profileRevision: 1,
    profileId: "athena",
    profileChangesBaseRevision: 1,
    profileChanges: [],
    profileCommandRevision: 1,
    serverTime: new Date().toISOString(),
    responseVersion: 1,
  });
});

console.log("Endpoints Fortnite Auth ajoutés");
