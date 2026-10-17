
const ZENIX_HOST = "https://fluxora.sbs";

function normalizeUrl(value, baseUrl) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(
      value.replace(/\\\//g, "/").replace(/&amp;/g, "&"),
      baseUrl
    );

    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

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
      "Zenix : INITIAL_PLAY JSON invalide :",
      error.message
    );
    return null;
  }
}

async function verifyMediaUrl(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Range": "bytes=0-1023"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000)
    });

    const html = await response.text();

console.log("Zenix HTML de stream_url :", {
  url,
  contentType: response.headers.get("content-type"),
  debut: html.slice(0, 2500),
  contientVideo: /<video\b/i.test(html),
  contientIframe: /<iframe\b/i.test(html),
  contientHls: /\.m3u8(?:[?#"']|$)/i.test(html),
  contientMp4: /\.mp4(?:[?#"']|$)/i.test(html)
});
    if (!response.ok) {
      console.log(
        "Zenix : vérification du flux HTTP",
        response.status
      );
      await response.body?.cancel();
      return false;
    }

    const contentType = (
      response.headers.get("content-type") || ""
    ).toLowerCase();

    const reader = response.body?.getReader();

    if (!reader) {
      return false;
    }

    const chunks = [];
    let total = 0;

    try {
      while (total < 1024) {
        const { done, value } = await reader.read();

        if (done) break;

        chunks.push(value);
        total += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    const beginning = new TextDecoder()
      .decode(bytes)
      .trimStart();

    const isHls =
      beginning.startsWith("#EXTM3U") ||
      contentType.includes("mpegurl");

    const isMp4 =
      contentType.includes("video/mp4") ||
      (
        bytes.length >= 8 &&
        String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
      );

    const isVideoContentType =
      contentType.startsWith("video/");

    const verified = isHls || isMp4 || isVideoContentType;

    console.log("Zenix : résultat vérification média", {
      status: response.status,
      contentType,
      isHls,
      isMp4,
      isVideoContentType,
      verified
    });

    return verified;
  } catch (error) {
    console.log(
      "Zenix : vérification média impossible :",
      error.message
    );

    return false;
  }
}

async function resolveDirectStream({
  tmdbId,
  season,
  episode
}) {
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
      console.log("Zenix : page HTTP", response.status);
      return null;
    }

    const html = await response.text();
    const play = extractInitialPlay(html);

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
        "Zenix : aucun flux initial fourni pour cet épisode."
      );
      return null;
    }

    const streamUrl = normalizeUrl(
      play.stream_url,
      response.url
    );

    if (!streamUrl) {
      console.log("Zenix : URL de flux invalide.");
      return null;
    }

    const verified = await verifyMediaUrl(streamUrl);

    if (!verified) {
      console.log(
        "Zenix : URL obtenue, mais média direct non confirmé."
      );
      return null;
    }

    return {
      url: streamUrl,
      name: "Zenix — flux vérifié",
      description: `VF — S${season}E${episode}`
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
