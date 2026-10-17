
const ZENIX_HOST = "https://fluxora.sbs";

function normalizeUrl(value, baseUrl = ZENIX_HOST) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    return new URL(
      value.replace(/\\\//g, "/"),
      baseUrl
    ).href;
  } catch {
    return null;
  }
}

function isDirectVideoUrl(value) {
  if (typeof value !== "string") {
    return false;
  }

  return /\.(mp4|m3u8)(?:[?#]|$)/i.test(value);
}

function extractInitialPlay(html) {
  const match = html.match(
    /\bINITIAL_PLAY\s*=\s*(\{[\s\S]*?\}|null)\s*;/
  );

  if (!match || match[1] === "null") {
    return null;
  }

  try {
    return JSON.parse(match[1]);
  } catch (error) {
    console.log(
      "Zenix : impossible de lire INITIAL_PLAY :",
      error.message
    );
    return null;
  }
}

/*
 * Diagnostic temporaire :
 * récupère le HTML renvoyé par stream_url pour identifier
 * l'iframe et les scripts du lecteur intégré.
 *
 * Cette fonction renvoie volontairement false :
 * le HTML n'est pas un flux vidéo direct confirmé.
 */
async function verifyMediaUrl(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Range": "bytes=0-4095"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000)
    });

    const contentType = (
      response.headers.get("content-type") || ""
    ).toLowerCase();

    const html = await response.text();

console.log("Zenix occurrences INITIAL_PLAY :", 
  [...html.matchAll(/INITIAL_PLAY/g)]
    .slice(0, 10)
    .map(match => html.slice(
      Math.max(0, match.index - 180),
      Math.min(html.length, match.index + 450)
    ))
);

console.log("Zenix références lecteur :", 
  [...html.matchAll(
    /(?:iframe|stream_url|embed-stream|hls-proxy|\.m3u8|\.mp4)/gi
  )]
    .slice(0, 20)
    .map(match => html.slice(
      Math.max(0, match.index - 100),
      Math.min(html.length, match.index + 250)
    ))
);

    console.log("Zenix HTML de stream_url :", {
      status: response.status,
      contentType,
      urlFinale: response.url,
      debut: html.slice(0, 5000),

      iframes: [...html.matchAll(
        /<iframe\b[^>]*>/gi
      )]
        .map(match => match[0])
        .slice(0, 5),

      scripts: [...html.matchAll(
        /<script\b[^>]*src=["']([^"']+)["']/gi
      )]
        .map(match => match[1])
        .slice(0, 10),

      contientHls: /\.m3u8(?:[?#"'&]|$)/i.test(html),
      contientMp4: /\.mp4(?:[?#"'&]|$)/i.test(html)
    });

    if (!response.ok) {
      console.log(
        "Zenix : réponse HTTP non valide :",
        response.status
      );
      return false;
    }

    return false;
  } catch (error) {
    console.log(
      "Zenix : erreur pendant l'analyse :",
      error.message
    );

    return false;
  }
}

async function inspectZenixGuestScript() {
  const url =
    `${ZENIX_HOST}/static/js/zenix-guest-watch.js`;

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000)
    });

    const js = await response.text();

    console.log("Zenix guest-watch diagnostic :", {
      status: response.status,
      contentType: response.headers.get("content-type"),
      longueur: js.length,
      debut: js.slice(0, 12000),
      references: [...js.matchAll(
        /(?:iframe|src|stream_url|embed-stream|hls|m3u8|player|fetch|XMLHttpRequest)/gi
      )]
        .slice(0, 35)
        .map(match => js.slice(
          Math.max(0, match.index - 100),
          Math.min(js.length, match.index + 250)
        ))
    });
  } catch (error) {
    console.log(
      "Zenix guest-watch : erreur :",
      error.message
    );
  }
}

async function resolveDirectStream({
  tmdbId,
  season,
  episode
}) {
  try {
    const params = new URLSearchParams({
      tmdb: String(tmdbId),
      type: "tv",
      lang: "vf",
      season: String(season),
      episode: String(episode)
    });

    const pageUrl =
      `${ZENIX_HOST}/embed/zenix?${params.toString()}`;

    console.log("Zenix Resolver : analyse de", {
      tmdbId,
      season,
      episode,
      pageUrl
    });

    const response = await fetch(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.log(
        "Zenix Resolver : réponse HTTP",
        response.status
      );
      return null;
    }

    const html = await response.text();
    const play = extractInitialPlay(html);
console.log("Zenix diagnostic HTML :", {
  status: response.status,
  urlFinale: response.url,
  longueurHTML: html.length,
  contientInitialPlay: html.includes("INITIAL_PLAY"),
  contientEmbedPlayer: html.includes("embed-player"),
  debutHTML: html.slice(0, 1800),
  declarationsInitialPlay: [
    ...html.matchAll(/INITIAL_PLAY/g)
  ].length
});
    console.log("Zenix INITIAL_PLAY :", {
      present: Boolean(play),
      ok: play?.ok,
      mode: play?.mode,
      provider: play?.provider,
      source: play?.source,
      lang: play?.lang,
      hasStreamUrl: Boolean(play?.stream_url)
    });

    if (!play?.ok || !play.stream_url) {
      console.log(
        "Zenix Resolver : aucun stream_url exploitable."
      );
      return null;
    }

    const streamUrl = normalizeUrl(
      play.stream_url,
      response.url || pageUrl
    );

    if (!streamUrl) {
      console.log(
        "Zenix Resolver : URL stream_url invalide."
      );
      return null;
    }

    console.log(
      "Zenix : URL obtenue, analyse du lecteur intégré."
    );

    const verified = await verifyMediaUrl(streamUrl);

    if (!verified) {
      console.log(
        "Zenix : URL obtenue, mais média direct non confirmé."
      );
      return null;
    }

    // Le diagnostic actuel ne valide aucun flux direct.
    return {
      url: streamUrl,
      name: "Zenix — flux vérifié",
      description: `VF — S${season}E${episode}`
    };
  } catch (error) {
    console.log(
      "Zenix Resolver : erreur :",
      error.message
    );

    return null;
  }
}

module.exports = {
  isDirectVideoUrl,
  resolveDirectStream
};
