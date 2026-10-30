// 免费天气查询（Open-Meteo，无需 key）。
//
// 只用固定公网域名，不接受用户传入 URL；城市名走官方 geocoding。
// 结果缓存 10 分钟，避免群里连续问同一城市时重复请求。

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 50;
const cache = new Map();

const WEATHER_TEXT = new Map([
  [0, '晴'], [1, '大致晴朗'], [2, '局部多云'], [3, '阴'],
  [45, '雾'], [48, '雾凇'],
  [51, '小毛毛雨'], [53, '毛毛雨'], [55, '大毛毛雨'],
  [56, '冻毛毛雨'], [57, '强冻毛毛雨'],
  [61, '小雨'], [63, '中雨'], [65, '大雨'],
  [66, '冻雨'], [67, '强冻雨'],
  [71, '小雪'], [73, '中雪'], [75, '大雪'], [77, '雪粒'],
  [80, '小阵雨'], [81, '阵雨'], [82, '强阵雨'],
  [85, '小阵雪'], [86, '强阵雪'],
  [95, '雷阵雨'], [96, '雷阵雨伴冰雹'], [99, '强雷阵雨伴冰雹']
]);

function weatherText(code) {
  return WEATHER_TEXT.get(Number(code)) || `天气代码 ${code}`;
}

function num(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null;
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'qq-bridge-weather/1.0' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`天气服务 HTTP ${res.status}`);
  return res.json();
}

export async function getWeather(city, { timeoutMs = 15000 } = {}) {
  const name = String(city || '').trim();
  if (!name) throw new Error('请提供城市名，例如“北京”');
  const cacheKey = name.toLowerCase();
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const geoUrl = new URL(GEO_URL);
  geoUrl.searchParams.set('name', name);
  geoUrl.searchParams.set('count', '1');
  geoUrl.searchParams.set('language', 'zh');
  geoUrl.searchParams.set('format', 'json');
  const geo = await fetchJson(geoUrl.toString(), timeoutMs);
  const place = Array.isArray(geo?.results) ? geo.results[0] : null;
  if (!place) throw new Error(`没找到城市「${name}」`);

  const forecastUrl = new URL(FORECAST_URL);
  forecastUrl.searchParams.set('latitude', String(place.latitude));
  forecastUrl.searchParams.set('longitude', String(place.longitude));
  forecastUrl.searchParams.set('current', 'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m');
  forecastUrl.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  forecastUrl.searchParams.set('timezone', 'auto');
  forecastUrl.searchParams.set('forecast_days', '1');
  const data = await fetchJson(forecastUrl.toString(), timeoutMs);

  const current = data?.current || {};
  const daily = data?.daily || {};
  const currentTemp = num(current.temperature_2m);
  const apparent = num(current.apparent_temperature);
  const precipitation = num(current.precipitation);
  const wind = num(current.wind_speed_10m);
  const description = weatherText(current.weather_code);
  const high = num(Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[0] : null);
  const low = num(Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[0] : null);
  const rainChance = num(Array.isArray(daily.precipitation_probability_max) ? daily.precipitation_probability_max[0] : null, 0);

  const parts = [`${place.name}现在 ${currentTemp ?? '?'}°C`];
  if (apparent != null) parts.push(`体感 ${apparent}°C`);
  parts.push(description);
  if (wind != null) parts.push(`风速 ${wind} km/h`);
  if (precipitation != null && precipitation > 0) parts.push(`当前降水 ${precipitation} mm`);
  if (high != null || low != null) parts.push(`今天 ${low ?? '?'}~${high ?? '?'}°C`);
  if (rainChance != null) parts.push(`降水概率 ${rainChance}%`);

  const value = {
    ok: true,
    city: {
      name: place.name,
      admin1: place.admin1 || '',
      country: place.country || '',
      latitude: place.latitude,
      longitude: place.longitude
    },
    current: {
      temperature: currentTemp,
      apparent: apparent,
      precipitation,
      weather: description,
      wind
    },
    today: { high, low, rainChance },
    summary: parts.join('，') + '。'
  };
  cache.set(cacheKey, { at: Date.now(), value });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}
