const ZENIX_HOST = "https://fluxora.sbs";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DEBUG = process.env.DEBUG_ZENIX === "1";
const MAX_DEPTH = 3;

let trace = [];

function log(...args) {
  const line = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  trace.push(line);
  if (DEBUG) console.log("[Zenix]", line);
}

function getTrace() {
  return trace.slice();
}

function normalizeUrl(value, baseUrl = ZENIX_HOST) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(
      value.trim().replace(/\\\//g, "/").replace(/\\u0026/g, "&"),
      baseUrl
    ).href;
  } catch {
    return null;
  }
}

function isDirectVideoUrl(value) {
  return (
    typeof value === "string" &&
    /\.(mp4|m3u8)(?:[?#]|$)/i.test(value)
  );
}

function extractInitialPlay(html) {
  const match = html.match(
    /\bINITIAL_PLAY\s*=\s*(\{[\s\S]*?\})\s*;/
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (error) {
    log("INITIAL_PLAY illisible :", error.message);
    return null;
  }
}

function findMediaUrls(text, baseUrl) {
  const cleaned = text
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/&amp;/g, "&");

  const found = new Set();

  const absolute =
    /https?:\/\/[^\s"'`<>\\]+?\.(?:m3u8|mp4)(?:\?[^\s"'`<>\\]*)?/gi;
  for (const m of cleaned.matchAll(absolute)) {
    found.add(m[0]);
  }

  const relative =
    /["'`]((?:\/|\.\/)[^"'`\s<>]+?\.(?:m3u8|mp4)[^"'`\s<>]*)["'`]/gi;
  for (const m of cleaned.matchAll(relative)) {
    const url = normalizeUrl(m[1], baseUrl);
    if (url) found.add(url);
  }

  return [...found];
}

function findIframes(html, baseUrl) {
  const urls = [];
  for (const m of html.matchAll(
    /<iframe\b[^>]*\bsrc=["']([^"']+)["']/gi
  )) {
    const url = normalizeUrl(m[1], baseUrl);
    if (url) urls.push(url);
  }
  return urls;
}

function findScripts(html, baseUrl) {
  const urls = [];
  for (const m of html.matchAll(
    /<script\b[^>]*\bsrc=["']([^"']+)["']/gi
  )) {
    const url = normalizeUrl(m[1], baseUrl);
    if (url) urls.push(url);
  }
  return urls;
}

function headersFor(referer) {
  const headers = { "User-Agent": UA, Accept: "*/*" };
  if (referer) {
    headers.Referer = referer;
    try {
      headers.Origin = new URL(referer).origin;
    } catch {}
  }
  return headers;
}

async function isPlayable(url, referer) {
  try {
    const response = await fetch(url, {
      headers: { ...headersFor(referer), Range: "bytes=0-2047" },
      redirect: "follow",
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok && response.status !== 206) {
      log("Média refusé :", response.status, url);
      return false;
    }

    const type = (
      response.headers.get("content-type") || ""
    ).toLowerCase();

    if (/\.m3u8(?:[?#]|$)/i.test(url) || type.includes("mpegurl")) {
      const body = await response.text();
      return body.trimStart().startsWith("#EXTM3U");
    }

    return (
      type.startsWith("video/") ||
      type.includes("octet-stream") ||
      type.includes("mp4")
    );
  } catch (error) {
    log("Vérification impossible :", error.message);
    return false;
  }
}

async function crawl(url, referer, depth, seen) {
  if (depth > MAX_DEPTH || seen.has(url)) return null;
  seen.add(url);
  log("Analyse", depth, url);

  if (isDirectVideoUrl(url) && (await isPlayable(url, referer))) {
    return { url, referer };
  }

  let response;
  try {
    response = await fetch(url, {
      headers: {
        ...headersFor(referer),
        Accept: "text/html,application/xhtml+xml,*/*"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    log("Erreur réseau :", error.message);
    return null;
  }

  if (!response.ok) {
    log("HTTP", response.status, url);
    return null;
  }

  const finalUrl = response.url || url;
  const type = (
    response.headers.get("content-type") || ""
  ).toLowerCase();

  if (type.startsWith("video/") || type.includes("mpegurl")) {
    return { url: finalUrl, referer };
  }

  const html = await response.text();
  if (html.trimStart().startsWith("#EXTM3U")) {
    return { url: finalUrl, referer };
  }

  // 1. Médias directs dans le HTML
  for (const media of findMediaUrls(html, finalUrl)) {
    if (await isPlayable(media, finalUrl)) {
      log("Média trouvé :", media);
      return { url: media, referer: finalUrl };
    }
  }

  // 2. Iframes imbriquées
  for (const frame of findIframes(html, finalUrl)) {
    const result = await crawl(frame, finalUrl, depth + 1, seen);
    if (result) return result;
  }

  // 3. Scripts du même domaine (3 maximum)
  const origin = new URL(finalUrl).origin;
  const scripts = findScripts(html, finalUrl)
    .filter((s) => s.startsWith(origin))
    .slice(0, 3);

  for (const script of scripts) {
    try {
      const r = await fetch(script, {
        headers: headersFor(finalUrl),
        signal: AbortSignal.timeout(8000)
      });
      if (!r.ok) continue;
      const js = await r.text();
      for (const media of findMediaUrls(js, script)) {
        if (await isPlayable(media, finalUrl)) {
          return { url: media, referer: finalUrl };
        }
      }
    } catch {}
  }

  log("Rien trouvé sur", finalUrl);
  return null;
}

async function resolveDirectStream({ tmdbId, season, episode }) {
  try {
        trace = [];
    const params = new URLSearchParams({
      tmdb: String(tmdbId),
      type: "tv",
      lang: "vf",
      season: String(season),
      episode: String(episode)
    });

    const pageUrl = `${ZENIX_HOST}/embed/zenix?${params.toString()}`;
    log("Page embed :", pageUrl);

    const response = await fetch(pageUrl, {
      headers: {
        ...headersFor(ZENIX_HOST + "/"),
        Accept: "text/html,application/xhtml+xml"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      log("Embed HTTP", response.status);
      return null;
    }

    const html = await response.text();
    const finalPage = response.url || pageUrl;
    const play = extractInitialPlay(html);
    log(
      "Embed HTML :",
      html.length,
      "caractères, début :",
      html.slice(0, 400).replace(/\s+/g, " ")
    );
        const snip = (re, n, before = 60, after = 160) =>
      [...html.matchAll(re)]
        .slice(0, n)
        .map((m) =>
          html
            .slice(
              Math.max(0, m.index - before),
              Math.min(html.length, m.index + after)
            )
            .replace(/\s+/g, " ")
        );

    log("INITIAL_PLAY occurrences :", snip(/INITIAL_PLAY/g, 3));
    log("iframes :", findIframes(html, finalPage));
    log("scripts :", findScripts(html, finalPage));
    log("api :", snip(/\/api\/[a-z0-9_\-\/]*/gi, 8, 30, 120));
    log("m3u8/mp4 :", snip(/\.(?:m3u8|mp4)/gi, 4));
    log("fetch :", snip(/fetch\(/g, 5, 40, 200));
    log("INITIAL_PLAY :", {
      present: Boolean(play),
      ok: play?.ok,
      mode: play?.mode,
      provider: play?.provider,
      hasStreamUrl: Boolean(play?.stream_url)
    });

    const seen = new Set();
    let result = null;

    if (play?.ok && play.stream_url) {
      const streamUrl = normalizeUrl(play.stream_url, finalPage);
      if (streamUrl) {
        result = await crawl(streamUrl, finalPage, 0, seen);
      }
    }

    // Plan B : chercher directement dans la page embed
    if (!result) {
      for (const media of findMediaUrls(html, finalPage)) {
        if (await isPlayable(media, finalPage)) {
          result = { url: media, referer: finalPage };
          break;
        }
      }
    }

    if (!result) {
      log("Aucun flux direct exploitable.");
      return null;
    }

    const referer = result.referer || finalPage;
    let origin = ZENIX_HOST;
    try {
      origin = new URL(referer).origin;
    } catch {}

    return {
      url: result.url,
      name: "Zenix",
      description: `VF — S${season}E${episode}`,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: {
            Referer: referer,
            Origin: origin,
            "User-Agent": UA
          }
        }
      }
    };
  } catch (error) {
    console.error("Zenix Resolver : erreur :", error.message);
    return null;
  }
}

module.exports = {
  isDirectVideoUrl,
  resolveDirectStream,
  getTrace
};
