// ==========================================
// 1. CONFIGURATION & STATE
// ==========================================

// DOM Elements
const dashboard = document.querySelector("#dashboard");
const searchForm = document.querySelector("#searchForm");
const cityInput = document.querySelector("#cityInput");
const searchStatus = document.querySelector("#searchStatus");
const rainViewerUrl = "https://api.rainviewer.com/public/weather-maps.json";
const cycloneStatus = document.querySelector("#cycloneStatus");
const cycloneList = document.querySelector("#cycloneList");
const refreshCyclonesButton = document.querySelector("#refreshCyclones");
let radarAnimation;

// ==========================================
// 2. WEATHER FORECAST LOGIC (OPEN-METEO API)
// ==========================================

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function getHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function getCycloneBasin(longitude, latitude) {
  if (latitude >= 0) {
    if (longitude >= 40 && longitude <= 100) {
      return longitude < 68 ? "Arabian Sea" : "Bay of Bengal";
    }
    if (longitude > 100) return "Western Pacific Ocean";
    if (longitude >= 20) return "North Indian Ocean";
    if (longitude < -140) return "Central Pacific Ocean";
    if (longitude < -100) return "Eastern Pacific Ocean";
    if (longitude < -80) return "Gulf of Mexico";
    if (longitude < -60) return "Caribbean Sea";
    return "North Atlantic Ocean";
  }

  if (longitude >= 20 && longitude < 135) return "South Indian Ocean";
  if (longitude >= 135 || longitude < -70) return "South Pacific Ocean";
  return "South Atlantic Ocean";
}

function getWindSpeedInKnots(value, unit) {
  const speed = Number(value);
  if (!Number.isFinite(speed)) return null;
  if (unit === "km/h") return speed / 1.852;
  if (unit === "mph") return speed / 1.15078;
  if (unit === "m/s") return speed * 1.94384;
  return speed;
}

function formatCycloneDate(value) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function renderCyclones(events) {
  if (!events.length) {
    cycloneList.innerHTML = `
      <div class="cyclone-empty">
        No recently tracked tropical storms with sustained winds of at least 34 knots.
      </div>
    `;
    return;
  }

  cycloneList.innerHTML = events
    .map((event) => {
      const coordinates = event.location.coordinates;
      const longitude = Number(coordinates[0]);
      const latitude = Number(coordinates[1]);
      const basin =
        Number.isFinite(longitude) && Number.isFinite(latitude)
          ? getCycloneBasin(longitude, latitude)
          : "Ocean not available";
      const country =
        event.country ||
        (event.countryLookupFailed
          ? "Lookup unavailable"
          : "Open ocean — no nearby country reported");
      const wind = `${Math.round(event.windKnots * 1.852)} km/h (${Math.round(event.windKnots)} knots)`;
      const strength = event.windKnots >= 64 ? "Severe winds" : "Tropical storm";
      const strengthClass = event.windKnots >= 64 ? "red" : "orange";
      const reportUrl = event.sourceUrl;
      const name = event.title || "Unnamed cyclone";

      return `
        <article class="cyclone-card">
          <div class="cyclone-card-top">
            <h3>${escapeHTML(name)}</h3>
            <span class="cyclone-alert cyclone-alert-${strengthClass}">${strength}</span>
          </div>
          <dl class="cyclone-details">
            <div><dt>Country near center</dt><dd>${escapeHTML(country)}</dd></div>
            <div><dt>Sea / ocean</dt><dd>${escapeHTML(basin)}</dd></div>
            <div><dt>Latest wind</dt><dd>${escapeHTML(wind)}</dd></div>
            <div><dt>Last updated</dt><dd>${escapeHTML(formatCycloneDate(event.lastUpdated))}</dd></div>
          </dl>
          ${reportUrl ? `<a class="cyclone-report" href="${escapeHTML(reportUrl)}" target="_blank" rel="noopener noreferrer">View storm update from ${escapeHTML(event.sourceName)}</a>` : ""}
        </article>
      `;
    })
    .join("");
}

async function loadCyclones() {
  if (!cycloneStatus || !cycloneList) return;

  if (refreshCyclonesButton) refreshCyclonesButton.disabled = true;
  cycloneStatus.textContent = "Checking worldwide cyclone tracks...";

  try {
    const response = await fetch(
      "https://eonet.gsfc.nasa.gov/api/v3/events?category=severeStorms&status=open&days=30",
    );
    if (!response.ok) {
      throw new Error("Cyclone track service is unavailable right now.");
    }

    const data = await response.json();
    if (!Array.isArray(data.events)) {
      throw new Error("Cyclone alert data is in an unexpected format.");
    }

    const now = Date.now();
    const activeEvents = data.events
      .map((event) => {
        const latest = event.geometry?.at(-1);
        const latestTime = latest ? new Date(latest.date).getTime() : NaN;
        const windKnots = getWindSpeedInKnots(
          latest?.magnitudeValue,
          latest?.magnitudeUnit,
        );
        if (
          !event.categories?.some((category) => category.id === "severeStorms") ||
          !/cyclone|storm|hurricane|typhoon/i.test(event.title || "") ||
          !latest ||
          !Number.isFinite(latestTime) ||
          latestTime > now ||
          now - latestTime > 24 * 60 * 60 * 1000 ||
          !Number.isFinite(windKnots) ||
          windKnots < 34
        ) {
          return null;
        }

        return {
          ...event,
          location: latest,
          lastUpdated: latest.date,
          windKnots,
        };
      })
      .filter(Boolean)
      .sort((left, right) => right.windKnots - left.windKnots);

    const eventsWithCountry = await Promise.all(
      activeEvents.map(async (event) => {
        try {
          const { coordinates } = event.location;
          const lookupUrl = new URL(
            "https://api.bigdatacloud.net/data/reverse-geocode-client",
          );
          lookupUrl.search = new URLSearchParams({
            latitude: coordinates[1],
            longitude: coordinates[0],
            localityLanguage: "en",
          });
          const countryResponse = await fetch(lookupUrl);
          if (!countryResponse.ok) {
            throw new Error("Country lookup is unavailable.");
          }
          const location = await countryResponse.json();
          return {
            ...event,
            country: location.countryName || "",
          };
        } catch {
          return { ...event, countryLookupFailed: true };
        }
      }),
    );

    const events = eventsWithCountry.map((event) => {
      const source = event.sources?.[0];
      return {
        ...event,
        sourceName: source?.id || "report",
        sourceUrl: getHttpsUrl(source?.url) || getHttpsUrl(event.link),
      };
    });
    renderCyclones(events);
    const lookupFailures = events.filter((event) => event.countryLookupFailed).length;
    cycloneStatus.textContent = `Updated ${new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })} · ${events.length} active cyclone${events.length === 1 ? "" : "s"}${
      lookupFailures ? ` · Country lookup unavailable for ${lookupFailures}` : ""
    }`;
  } catch (error) {
    cycloneStatus.textContent =
      error instanceof Error
        ? error.message
        : "Could not load cyclone alerts.";
    if (!cycloneList.innerHTML) {
      cycloneList.innerHTML = `
        <div class="cyclone-empty">
          Cyclone alerts could not be loaded. Please try again later.
        </div>
      `;
    }
  } finally {
    if (refreshCyclonesButton) refreshCyclonesButton.disabled = false;
  }
}

const weatherCodes = {
  0: ["Clear sky", "☀️"],
  1: ["Mainly clear", "🌤️"],
  2: ["Partly cloudy", "⛅"],
  3: ["Overcast", "☁️"],
  45: ["Foggy", "🌫️"],
  48: ["Rime fog", "🌫️"],
  51: ["Light drizzle", "🌦️"],
  53: ["Drizzle", "🌦️"],
  55: ["Heavy drizzle", "🌧️"],
  61: ["Light rain", "🌦️"],
  63: ["Rain", "🌧️"],
  65: ["Heavy rain", "🌩️"],
  71: ["Light snow", "🌨️"],
  73: ["Snow", "❄️"],
  75: ["Heavy snow", "❄️"],
  80: ["Rain showers", "🌦️"],
  81: ["Rain showers", "🌧️"],
  82: ["Heavy showers", "🌧️"],
  95: ["Thunderstorm", "⛈️"],
  96: ["Storm with hail", "⛈️"],
  99: ["Storm with hail", "⛈️"],
};

function getWeatherInfo(code) {
  return weatherCodes[code] || ["Unknown conditions", "❓"];
}

function renderWeatherIcon(icon, label) {
  return `<span class="weather-icon-image" aria-label="${label}" role="img">${icon}</span>`;
}

function formatHour(value) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric" });
}

function formatDay(value, index) {
  return index === 0
    ? "Today"
    : new Date(value).toLocaleDateString([], { weekday: "short" });
}

function round(value) {
  return Math.round(value);
}

async function findCity(query) {
  const response = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`,
  );

  if (!response.ok) {
    throw new Error("Could not search for that city.");
  }

  const data = await response.json();
  if (!data.results?.length) {
    throw new Error("City not found. Try a larger nearby city.");
  }

  return data.results[0];
}

async function loadWeather(place) {
  searchStatus.textContent = `Loading forecast for ${place.name}...`;

  const params = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    timezone: "auto",
    forecast_days: 7,
    current:
      "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m",
    hourly: "temperature_2m,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min",
  });

  const response = await fetch(
    `https://api.open-meteo.com/v1/forecast?${params}`,
  );
  if (!response.ok) {
    throw new Error("Weather service is unavailable right now.");
  }

  const data = await response.json();
  renderWeather(place, data);
  searchStatus.textContent = `Updated just now · ${data.timezone}`;
}

function renderWeather(place, data) {
  const radarLink = document.querySelector("#radarLink");
  if (radarLink) {
    const radarUrl = new URL("radar.html", window.location.href);
    radarUrl.search = new URLSearchParams({
      name: place.name,
      latitude: place.latitude,
      longitude: place.longitude,
    });
    radarLink.href = radarUrl.href;
  }

  const currentInfo = getWeatherInfo(data.current.weather_code);
  const startHour = data.hourly.time.findIndex(
    (time) => time >= data.current.time,
  );

  const hourly = data.hourly.time
    .slice(startHour, startHour + 8)
    .map((time, index) => {
      const hourIndex = startHour + index;
      const info = getWeatherInfo(data.hourly.weather_code[hourIndex]);
      const label = index === 0 ? "Now" : formatHour(time);

      return `
        <div class="hour">
          <span class="hour-time">${label}</span>
          <span class="hour-icon">${renderWeatherIcon(info[1], info[0])}</span>
          <span class="hour-temp">${round(data.hourly.temperature_2m[hourIndex])}°</span>
        </div>
      `;
    })
    .join("");

  const daily = data.daily.time
    .map((time, index) => {
      const info = getWeatherInfo(data.daily.weather_code[index]);

      return `
        <div class="day">
          <span class="day-name">${formatDay(time, index)}</span>
          <span class="day-icon">${renderWeatherIcon(info[1], info[0])}</span>
          <span class="day-temp">
            <strong>${round(data.daily.temperature_2m_max[index])}°</strong>
            <span>${round(data.daily.temperature_2m_min[index])}°</span>
          </span>
        </div>
      `;
    })
    .join("");

  const radarCard = window.matchMedia("(min-width: 801px)").matches
    ? `
      <article class="card radar-card">
        <div class="card-heading">
          <div>
            <h2>Live rain radar</h2>
            <p class="radar-status" id="radarStatus" role="status">Loading radar...</p>
          </div>
          <span class="radar-live"><span></span> LIVE</span>
        </div>
        <div id="radarMap" class="radar-map" aria-label="Interactive live precipitation radar map"></div>
        <div class="radar-controls">
          <button id="radarPlay" type="button" disabled>Play</button>
          <input id="radarTimeline" type="range" min="0" max="0" value="0" aria-label="Radar timeline" disabled />
          <time id="radarTime">--:--</time>
        </div>
        <p class="radar-attribution">Radar tiles by <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">API</a> · Map © OpenStreetMap</p>
      </article>
    `
    : "";

  dashboard.innerHTML = `
    <div class="weather-grid">
      <article class="card current-card">
        <p class="place">${place.name}${place.country_code ? `, ${place.country_code}` : ""}</p>
        <div class="current-line">
          <div>
            <div class="temperature">${round(data.current.temperature_2m)}°</div>
            <p class="condition">${currentInfo[0]}</p>
          </div>
          <span class="weather-icon">${renderWeatherIcon(currentInfo[1], currentInfo[0])}</span>
        </div>
        <p class="high-low">
          Today
          <strong>${round(data.daily.temperature_2m_max[0])}°</strong> high ·
          <strong>${round(data.daily.temperature_2m_min[0])}°</strong> low
        </p>
      </article>

      <div class="stats">
        <div class="stat">
          <span class="stat-label">Feels like</span>
          <span class="stat-value">${round(data.current.apparent_temperature)}°</span>
        </div>
        <div class="stat">
          <span class="stat-label">Humidity</span>
          <span class="stat-value">${data.current.relative_humidity_2m}%</span>
        </div>
        <div class="stat">
          <span class="stat-label">Wind</span>
          <span class="stat-value">${round(data.current.wind_speed_10m)} <small>km/h</small></span>
        </div>
        <div class="stat">
          <span class="stat-label">Daylight</span>
          <span class="stat-value">${data.current.is_day ? "Day" : "Night"}</span>
        </div>
      </div>

      <article class="card forecast-card">
        <div class="card-heading">
          <h2>Next hours</h2>
          <p>${data.timezone}</p>
        </div>
        <div class="hourly-list">${hourly}</div>
      </article>

      <article class="card forecast-card">
        <div class="card-heading">
          <h2>7-day outlook</h2>
          <p>High / low</p>
        </div>
        <div class="daily-list">${daily}</div>
      </article>

      ${radarCard}
    </div>
  `;

  initializeRadar(place);
}

async function initializeRadar(place) {
  if (radarAnimation) {
    window.clearInterval(radarAnimation);
    radarAnimation = undefined;
  }

  const mapElement = document.querySelector("#radarMap");
  const statusElement = document.querySelector("#radarStatus");
  const playButton = document.querySelector("#radarPlay");
  const timeline = document.querySelector("#radarTimeline");
  const timeLabel = document.querySelector("#radarTime");

  if (!mapElement || !statusElement || !playButton || !timeline || !timeLabel)
    return;
  if (!window.L) {
    statusElement.textContent =
      "Map library could not be loaded. Check your connection and reload.";
    return;
  }

  const map = window.L.map(mapElement, { zoomControl: true }).setView(
    [Number(place.latitude), Number(place.longitude)],
    6,
  );
  window.requestAnimationFrame(() => map.invalidateSize({ pan: false }));
  window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  try {
    const response = await fetch(rainViewerUrl);
    if (!response.ok) {
      throw new Error("API radar service is unavailable right now.");
    }

    const data = await response.json();
    const frames = [...(data.radar?.past || []), ...(data.radar?.nowcast || [])]
      .filter(
        (frame, index, allFrames) =>
          frame.path &&
          allFrames.findIndex((item) => item.time === frame.time) === index,
      )
      .sort((left, right) => left.time - right.time);

    if (!data.host || !frames.length) {
      throw new Error("No radar frames are available for this area right now.");
    }

    let frameIndex = Math.max(
      0,
      frames.findIndex(
        (frame) => frame.time === data.radar?.past?.at(-1)?.time,
      ),
    );
    const radarLayer = window.L.tileLayer("", {
      opacity: 0.72,
      zIndex: 10,
      tileSize: 256,
      attribution: '<a href="https://xyz.example.com/">XYZ</a>',
    }).addTo(map);

    const showFrame = (index) => {
      frameIndex = index;
      const frame = frames[frameIndex];
      radarLayer.setUrl(`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`);
      timeline.value = String(frameIndex);
      timeLabel.dateTime = new Date(frame.time * 1000).toISOString();
      timeLabel.textContent = new Date(frame.time * 1000).toLocaleTimeString(
        [],
        {
          hour: "2-digit",
          minute: "2-digit",
        },
      );
    };

    timeline.max = String(frames.length - 1);
    timeline.disabled = false;
    playButton.disabled = false;
    timeline.addEventListener("input", () => showFrame(Number(timeline.value)));
    showFrame(frameIndex);
    statusElement.textContent = `${frames.length} radar frames · ${place.name}`;

    playButton.addEventListener("click", () => {
      if (radarAnimation) {
        window.clearInterval(radarAnimation);
        radarAnimation = undefined;
        playButton.textContent = "Play";
        return;
      }

      playButton.textContent = "Pause";
      radarAnimation = window.setInterval(() => {
        showFrame((frameIndex + 1) % frames.length);
      }, 700);
    });
  } catch (error) {
    statusElement.textContent =
      error instanceof Error ? error.message : "Could not load the radar.";
  }
}

async function searchWeather(query) {
  const cleanQuery = query.trim();
  if (!cleanQuery) return;

  searchStatus.textContent = "Finding that place...";

  try {
    const place = await findCity(cleanQuery);
    await loadWeather(place);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Something went wrong.";
    dashboard.innerHTML = `<div class="error">${message}</div>`;
    searchStatus.textContent = "Try searching again.";
  }
}

if (searchForm) {
  searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    searchWeather(cityInput.value);
  });
}

// ==========================================
// 3. BOOTSTRAP
// ==========================================

window.addEventListener("DOMContentLoaded", () => {
  if (cycloneStatus) {
    loadCyclones();
    window.setInterval(loadCyclones, 15 * 60 * 1000);
  }

  if (refreshCyclonesButton) {
    refreshCyclonesButton.addEventListener("click", loadCyclones);
  }

  if (searchForm) {
    searchWeather("New Delhi");
    return;
  }

  if (document.querySelector("#radarMap")) {
    const params = new URLSearchParams(window.location.search);
    const latitude = Number(params.get("latitude"));
    const longitude = Number(params.get("longitude"));
    const place = {
      name: params.get("name") || "New Delhi",
      latitude: Number.isFinite(latitude) ? latitude : 28.6139,
      longitude: Number.isFinite(longitude) ? longitude : 77.209,
    };
    initializeRadar(place);
  }
});
