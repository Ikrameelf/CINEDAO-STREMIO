
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");

const TMDB_KEY = process.env.TMDB_API_KEY;
const PORT = process.env.PORT || 10000;
const TMDB = "https://api.themoviedb.org/3";
const IMG = "https://image.tmdb.org/t/p/w500";
const BACKDROP = "https://image.tmdb.org/t/p/w1280";

const manifest = {
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
    poster: item.poster_path
      ? IMG + item.poster_path
      : undefined,
    background: item.backdrop_path
      ? BACKDROP + item.backdrop_path
      : undefined,
    description: item.overview || "",
    releaseInfo: (
      item.release_date || item.first_air_date || ""
    ).slice(0, 4)
  };
}

// Accepte les IDs TMDB et les IDs IMDb.
async function resolveId(type, id) {
  const tmdbMatch =
    /^tmdb:(movie|tv):(\d+)$/.exec(String(id));

  if (tmdbMatch) {
    const kind = tmdbMatch[1];
    const tmdbId = tmdbMatch[2];

    if (
      (type === "movie" && kind !== "movie") ||
      (type === "series" && kind !== "tv")
    ) {
      return null;
    }

    return {
      kind,
      tmdbId,
      imdbId: null
    };
  }

  if (/^tt\d+$/.test(String(id))) {
    const found = await tmdb(`/find/${id}`, {
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
      imdbId: id
    };
  }

  return null;
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

    const expectedMediaType = type === "series" ? "tv" : "movie";

    const metas = (data.results || [])
      .filter((item) => {
        if (!item.id || !item.poster_path) return false;

        if (search) {
          return item.media_type === expectedMediaType;
        }

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
        .filter((season) => season.season_number > 0);

      // Les épisodes sont chargés à la demande, saison par saison.
      // Pour éviter de dépasser les limites, on ne charge ici
      // que les dix premières saisons.
      const selectedSeasons = seasons.slice(0, 10);

      const seasonResults = await Promise.all(
        selectedSeasons.map(async (season) => {
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

  const value = String(id);
  let parsed = null;

  // Format IMDb : tt1234567:1:2
  const imdbEpisode = /^(tt\d+):(\d+):(\d+)$/.exec(value);

  // Format interne : tmdb:tv:123:1:2
  const tmdbEpisode =
    /^tmdb:tv:(\d+):(\d+):(\d+)$/.exec(value);

  if (type === "series" && imdbEpisode) {
    parsed = {
      sourceId: imdbEpisode[1],
      season: Number(imdbEpisode[2]),
      episode: Number(imdbEpisode[3]),
      idType: "imdb"
    };
  } else if (type === "series" && tmdbEpisode) {
    parsed = {
      sourceId: tmdbEpisode[1],
      season: Number(tmdbEpisode[2]),
      episode: Number(tmdbEpisode[3]),
      idType: "tmdb"
    };
  }

  if (parsed) {
    console.log("Épisode analysé :", parsed);
  } else {
    console.log("Format de flux non reconnu :", value);
  }

  // Aucun flux n'est annoncé tant qu'une source compatible
  // et autorisée n'a pas été vérifiée.
  return { streams: [] };
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Cinema Addon démarré sur le port ${PORT}`);
