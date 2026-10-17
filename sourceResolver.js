
const ALLOWED_VIDEO_EXTENSIONS = new Set([".mp4", ".m3u8"]);

function isDirectVideoUrl(value) {
  if (typeof value !== "string") return false;

  try {
    const url = new URL(value);

    if (url.protocol !== "https:") return false;

    const pathname = url.pathname.toLowerCase();

    return [...ALLOWED_VIDEO_EXTENSIONS].some(
      (extension) => pathname.endsWith(extension)
    );
  } catch {
    return false;
  }
}

/**
 * Accepte uniquement les URL directes communiquées par
 * une source autorisée ou son API officielle.
 *
 * Ce module ne visite pas le lecteur embarqué et ne tente
 * pas d'extraire des URL vidéo cachées.
 */
async function resolveDirectStream(providerResult) {
  if (!providerResult || typeof providerResult !== "object") {
    return null;
  }

  const candidates = [
    providerResult.url,
    providerResult.streamUrl,
    providerResult.videoUrl
  ];

  for (const candidate of candidates) {
    if (isDirectVideoUrl(candidate)) {
      return {
        url: candidate,
        name: "Source directe",
        description: "Flux vidéo direct"
      };
    }
  }

  return null;
}

module.exports = {
  isDirectVideoUrl,
  resolveDirectStream
};
