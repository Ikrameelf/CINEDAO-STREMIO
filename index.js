
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const TMDB_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 10000;
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";
const BACKDROP = "https://image.tmdb.org/t/p/w1280";
const { resolveDirectStream, getTrace } = require("./sourceResolver");const manifest = {
  id: "fr.cinema.addon",
  version: "1.1.0",
  name: "Cinema Addon",
  description: "Catalogue, recherche et sources modulaires.",
  resources: ["catalog", "meta", "stream"],
  types: ["movie", "series"],
  catalogs: [
    {
      type: "movie",
      id: "cinema_movies",
      name: "Films",
      extra: [{ name: "search", isRequired: false }]
    },
    {
      type: "series",
      id: "cinema_series",
      name: "Séries",
      extra: [{ name: "search", isRequired: false }]
    }
  ]
};

const builder = new addonBuilder(manifest);

async function tmdb(path, params = {}) {
  if (!TMDB_KEY) {
    throw new Error("TMDB_API_KEY absente dans Render");
  }

  const url = new URL(TMDB + path);
  url.searchParams.set("api_key", TMDB_KEY);
  url.searchParams.set("language", "fr-FR");

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`TMDB HTTP ${response.status}`);
  }

  return response.json();
}

function toMeta(item, type, idOverride) {
  return {
    id: idOverride ||
      `tmdb:${type === "movie" ? "movie" : "tv"}:${item.id}`,
    type,
    name: item.title || item.name || "Sans titre",
    poster: item.poster_path ? IMG + item.poster_path : undefined,
    background: item.backdrop_path
      ? BACKDROP + item.backdrop_path
      : undefined,
    description: item.overview || "",
    releaseInfo: (
      item.release_date || item.first_air_date || ""
    ).slice(0, 4)
  };
}

async function resolveId(type, id) {
  const value = String(id);
  const tmdbMatch = /^tmdb:(movie|tv):(\d+)$/.exec(value);

  if (tmdbMatch) {
    const kind = tmdbMatch[1];
    const tmdbId = tmdbMatch[2];

    if (
      (type === "movie" && kind !== "movie") ||
      (type === "series" && kind !== "tv")
    ) {
      return null;
    }

    return { kind, tmdbId, imdbId: null };
  }

  if (/^tt\d+$/.test(value)) {
    const found = await tmdb(`/find/${value}`, {
      external_source: "imdb_id"
    });

    const kind = type === "movie" ? "movie" : "tv";
    const results = kind === "movie"
      ? found.movie_results
      : found.tv_results;

    if (!results || !results.length) {
      return null;
    }

    return {
      kind,
      tmdbId: String(results[0].id),
      imdbId: value
    };
  }

  return null;
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    const search = String(extra?.search || "")
      .replace(/\.json.*$/i, "")
      .trim();

    let data;

    if (search) {
      const endpoint = type === "series"
        ? "/search/tv"
        : "/search/movie";

      data = await tmdb(endpoint, {
        query: search,
        page: 1,
        include_adult: false
      });
    } else if (type === "movie" && id === "cinema_movies") {
      data = await tmdb("/trending/movie/week");
    } else if (type === "series" && id === "cinema_series") {
      data = await tmdb("/trending/tv/week");
    } else {
      return { metas: [] };
    }

    const metas = (data.results || [])
      .filter((item) => item.id && item.poster_path)
      .slice(0, 30)
      .map((item) => toMeta(item, type));

    console.log("Recherche catalogue :", {
      type,
      search,
      resultats: metas.length
    });

    return { metas };
  } catch (error) {
    console.error("Erreur catalogue :", error.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const resolved = await resolveId(type, id);

    if (!resolved) {
      return { meta: null };
    }

    const { kind, tmdbId, imdbId } = resolved;
    const endpoint = kind === "movie" ? "movie" : "tv";
    const item = await tmdb(`/${endpoint}/${tmdbId}`);

    let canonicalImdbId = imdbId;

    if (kind === "tv" && !canonicalImdbId) {
      try {
        const external = await tmdb(`/tv/${tmdbId}/external_ids`);
        canonicalImdbId = external.imdb_id || null;
      } catch (error) {
        console.error("IMDb ID indisponible :", error.message);
      }
    }

    const meta = {
      ...toMeta(item, type, id),
      genres: (item.genres || []).map((genre) => genre.name),
      runtime: item.runtime || undefined,
      videos: []
    };

    if (kind === "tv") {
      const seasons = (item.seasons || [])
        .filter((season) => season.season_number > 0)
        .slice(0, 10);

      const seasonResults = await Promise.all(
        seasons.map(async (season) => {
          try {
            return await tmdb(
              `/tv/${tmdbId}/season/${season.season_number}`
            );
          } catch (error) {
            console.error(
              "Erreur saison",
              season.season_number,
              error.message
            );
            return { episodes: [] };
          }
        })
      );

      for (const season of seasonResults) {
        for (const episode of season.episodes || []) {
          const episodeId = canonicalImdbId
            ? `${canonicalImdbId}:${episode.season_number}:${episode.episode_number}`
            : `tmdb:tv:${tmdbId}:${episode.season_number}:${episode.episode_number}`;

          meta.videos.push({
            id: episodeId,
            title: episode.name ||
              `Épisode ${episode.episode_number}`,
            season: episode.season_number,
            episode: episode.episode_number,
            released: episode.air_date || undefined,
            overview: episode.overview || undefined,
            thumbnail: episode.still_path
              ? IMG + episode.still_path
              : undefined
          });
        }
      }
    }

    return { meta };
  } catch (error) {
    console.error("Erreur métadonnées :", error.message);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  console.log("Demande de flux :", type, id);

  if (type !== "series") {
    return { streams: [] };
  }

  const value = String(id);
  const imdbEpisode = /^(tt\d+):(\d+):(\d+)$/.exec(value);
  const tmdbEpisode = /^tmdb:tv:(\d+):(\d+):(\d+)$/.exec(value);

  if (!imdbEpisode && !tmdbEpisode) {
    console.log("Format de flux non reconnu :", value);
    return { streams: [] };
  }

  const match = imdbEpisode || tmdbEpisode;
  const season = Number(match[2]);
  const episode = Number(match[3]);

  if (season < 0 || episode < 1) {
    return { streams: [] };
  }

  try {
    let tmdbId;

    if (tmdbEpisode) {
      tmdbId = tmdbEpisode[1];
    } else {
      const resolved = await resolveId("series", imdbEpisode[1]);
      if (!resolved) return { streams: [] };
      tmdbId = resolved.tmdbId;
    }

    const streams = [];

    // 1. Flux direct (lecteur interne de Stremio)
    const directStream = await resolveDirectStream({
      tmdbId,
      season,
      episode
    });

    if (directStream?.url) {
      console.log("Zenix : flux direct détecté.");
      streams.push({
        name: directStream.name,
        description: directStream.description,
        url: directStream.url,
        behaviorHints: directStream.behaviorHints
      });
    } else {
      console.log("Zenix : aucun flux direct, repli sur lien externe.");
    }

    // DIAGNOSTIC TEMPORAIRE : à supprimer une fois le problème réglé
    const debugText = getTrace().join("\n");
    for (let i = 0; i < 3; i++) {
      const part = debugText.slice(i * 3500, (i + 1) * 3500);
      if (!part) break;
      streams.push({
        name: `Zenix DEBUG ${i + 1}`,
        description: part,
        externalUrl: "https://fluxora.sbs/"
      });
    }

    // 2. Lien externe (repli, jamais bloquant)
    let vfConfirmee = false;

    try {
      const availabilityUrl = new URL(
        "https://fluxora.sbs/api/embed-player/availability"
      );
      availabilityUrl.searchParams.set("tmdb", tmdbId);
      availabilityUrl.searchParams.set("type", "tv");
      availabilityUrl.searchParams.set("season", String(season));
      availabilityUrl.searchParams.set("episode", String(episode));

      const response = await fetch(availabilityUrl, {
        signal: AbortSignal.timeout(10000)
      });

      if (response.ok) {
        const availability = await response.json();
        vfConfirmee =
          availability.ok === true &&
          availability.available === true &&
          availability.vf === true &&
          availability.pending !== true;
      }
    } catch (error) {
      console.log("Disponibilité Zenix indisponible :", error.message);
    }

    const params = new URLSearchParams({
      tmdb: tmdbId,
      type: "tv",
      lang: "vf",
      season: String(season),
      episode: String(episode)
    });

    streams.push({
      name: "Zenix (navigateur)",
      description: `${vfConfirmee ? "VF confirmée" : "Disponibilité à vérifier"} — S${season}E${episode} — lecteur externe`,
      externalUrl: `https://fluxora.sbs/embed/zenix?${params.toString()}`
    });

    return { streams };
  } catch (error) {
    console.error("Erreur de flux :", error.message);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });

console.log(`Cinema Addon démarré sur le port ${PORT}`);
