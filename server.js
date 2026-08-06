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

    tokenStore.set(launcherToken, { discordId, username });

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

app.listen(3000, "0.0.0.0", () => {
  console.log("Backend lancé sur http://127.0.0.1:3000");
});
