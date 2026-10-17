
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const TMDB_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 10000;
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";

const manifest = {
  id: "fr.cinema.addon",
  version: "1.0.0",
  name: "Cinema Addon",
  description:
    "Catalogue, recherche et sources vidéo modulaires.",
  logo: "",
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
    throw new Error("TMDB_API_KEY manquante dans Render");
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

function toMeta(item, type) {
  const isMovie = type === "movie";

  return {
    id: `tmdb:${isMovie ? "movie" : "tv"}:${item.id}`,
    type,
    name: item.title || item.name || "Sans titre",
    poster: item.poster_path
      ? IMG + item.poster_path
      : undefined,
    background: item.backdrop_path
      ? "https://image.tmdb.org/t/p/w1280" +
        item.backdrop_path
      : undefined,
    description: item.overview || "",
    releaseInfo: (
      item.release_date || item.first_air_date || ""
    ).slice(0, 4)
  };
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  try {
    const search = extra?.search?.trim();
    let data;

    if (search) {
      data = await tmdb("/search/multi", {
        query: search,
        include_adult: false,
        page: 1
      });
    } else if (type === "movie" && id === "cinema_movies") {
      data = await tmdb("/trending/movie/week");
    } else if (type === "series" && id === "cinema_series") {
      data = await tmdb("/trending/tv/week");
    } else {
      return { metas: [] };
    }

    const metas = (data.results || [])
      .filter((item) => {
        if (search) {
          return item.media_type === type;
        }
        return true;
      })
      .filter((item) => {
        if (!item.id) return false;
        if (!item.poster_path) return false;
        if (type === "movie") {
          return item.media_type === "movie" ||
            item.title !== undefined;
        }
        return item.media_type === "tv" ||
          item.name !== undefined;
      })
      .slice(0, 30)
      .map((item) => toMeta(item, type));

    return { metas };
  } catch (error) {
    console.error("Erreur catalogue :", error.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  try {
    const match = /^tmdb:(movie|tv):(\d+)$/.exec(id);

    if (!match) return { meta: null };

    const kind = match[1];
    const tmdbId = match[2];

    if (
      (type === "movie" && kind !== "movie") ||
      (type === "series" && kind !== "tv")
    ) {
      return { meta: null };
    }

    const endpoint = kind === "movie" ? "movie" : "tv";
    const item = await tmdb(`/${endpoint}/${tmdbId}`);

    const meta = {
      ...toMeta(item, type),
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
          meta.videos.push({
            id: `tmdb:tv:${tmdbId}:${episode.season_number}:${episode.episode_number}`,
            title: episode.name || `Épisode ${episode.episode_number}`,
            season: episode.season_number,
            episode: episode.episode_number,
            released: episode.air_date || undefined,
            overview: episode.overview || undefined,
            thumbnail: episode.still_path
              ? "https://image.tmdb.org/t/p/w500" +
                episode.still_path
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

  const parts = String(id).split(":");

  if (type === "series" && parts.length >= 3) {
    const episodeId = parts[0];
    const season = Number(parts[1]);
    const episode = Number(parts[2]);

    console.log("Épisode demandé :", {
      episodeId,
      season,
      episode
    });
  }

  return { streams: [] };
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Cinema Addon démarré sur le port ${PORT}`);
