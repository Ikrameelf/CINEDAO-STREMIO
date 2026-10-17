
const ZENIX_HOST = "https://fluxora.sbs";

function isDirectVideoUrl(value) {
  if (typeof value !== "string") return false;

  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return false;

    // N'accepte que des URL hébergées sur des domaines publics.
    if (
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local")
    ) {
      return false;
    }

    return /\.(mp4|m3u8)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function extractCandidates(html, pageUrl) {
  const candidates = new Set();

  // Recherche les URL directes présentes dans le HTML accessible.
  const patterns = [
    /https?:\\?\/\\?\/[^"'\\\s<>]+?\.(?:mp4|m3u8)(?:\?[^"'\\\s<>]*)?/gi,
    /["'](?:file|src|url|streamUrl|videoUrl)["']\s*:\s*["']([^"']+)["']/gi
  ];

  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const raw = (match[1] || match[0])
        .replace(/\\\//g, "/")
        .replace(/&amp;/g, "&")
        .replace(/\\u0026/g, "&");

      try {
        const absolute = new URL(raw, pageUrl).href;
        if (isDirectVideoUrl(absolute)) candidates.add(absolute);
      } catch {
        // Ignore les valeurs qui ne sont pas des URL.
      }
    }
  }

  return [...candidates];
}

async function resolveDirectStream({ tmdbId, season, episode }) {
  const pageUrl = new URL("/embed/zenix", ZENIX_HOST);

  pageUrl.searchParams.set("tmdb", String(tmdbId));
  pageUrl.searchParams.set("type", "tv");
  pageUrl.searchParams.set("lang", "vf");
  pageUrl.searchParams.set("season", String(season));
  pageUrl.searchParams.set("episode", String(episode));

  try {
    const response = await fetch(pageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.log("Zenix Resolver : HTTP", response.status);
      return null;
    }

    const html = await response.text();
    const candidates = extractCandidates(html, response.url);

console.log("ZENIX HTML DEBUG :", {
  length: html.length,
  hasVideo: /<video\b/i.test(html),
  hasIframe: /<iframe\b/i.test(html),
  hasM3u8: /\.m3u8/i.test(html),
  hasMp4: /\.mp4/i.test(html),
  hasPlayer: /player|source|stream|iframe/i.test(html)
});

console.log(
  "ZENIX HTML EXTRAIT :",
  html.slice(0, 1500)
);

    console.log("Zenix Resolver :", {
      status: response.status,
      candidates: candidates.length
    });

    if (candidates.length === 0) return null;

    return {
      url: candidates[0],
      name: "Zenix — flux direct détecté",
      description: `S${season}E${episode}`
    };
  } catch (error) {
    console.error("Zenix Resolver :", error.message);
    return null;
  }
}

module.exports = {
  isDirectVideoUrl,
  resolveDirectStream
};
