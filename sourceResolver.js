
const ZENIX_HOST = "https://fluxora.sbs";

function isDirectVideoUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /\.(mp4|m3u8)$/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function extractCandidates(html, pageUrl) {
  const candidates = new Set();

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
        if (isDirectVideoUrl(absolute)) {
          candidates.add(absolute);
        }
      } catch {
        // Ignore les URL invalides.
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

    const iframeMatches = [
      ...html.matchAll(/<iframe\b[^>]*>/gi)
    ].map(match => {
      const src = match[0].match(/\bsrc=["']([^"']*)["']/i);
      return src ? src[1] : "(src absent)";
    });

    console.log("ZENIX HTML DEBUG :", {
      length: html.length,
      hasVideo: /<video\b/i.test(html),
      hasIframe: /<iframe\b/i.test(html),
      hasM3u8: /\.m3u8/i.test(html),
      hasMp4: /\.mp4/i.test(html)
    });

    console.log("ZENIX IFRAMES :", iframeMatches);

    const clues = [
      /hls-proxy\.php/ig,
      /stream\.fluxora\.sbs/ig,
      /player\.zxcstream\.xyz/ig,
      /\.m3u8/ig,
      /\.mp4/ig,
      /(?:file|source|streamUrl|videoUrl)\s*[:=]/ig
    ];

    for (const pattern of clues) {
      const matches = [...html.matchAll(pattern)];
      console.log(
        "ZENIX INDICE",
        pattern.source,
        "occurrences:",
        matches.length,
        "extraits:",
        matches.slice(0, 5).map(m =>
          html.slice(Math.max(0, m.index - 100), m.index + 220)
            .replace(/\s+/g, " ")
        )
      );
    }

    console.log("Zenix Resolver :", {
      status: response.status,
      candidates: candidates.length
    });

    if (!candidates.length) return null;

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
