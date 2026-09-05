import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
    Calendar, UtensilsCrossed, CheckSquare, Users, MapPin, Bus, Check, Undo2, Maximize2, Minimize2, X,
    Sun, CloudSun, Cloud, CloudRain, CloudSnow, CloudLightning, CloudFog, Settings as SettingsIcon, Search,
} from 'lucide-react';
import { addDays, format, getISODay, startOfWeek } from 'date-fns';
import { api } from '../lib/api';
import { useWebSocketUpdates } from '../hooks/useWebSocketUpdates';
import { useAuth } from '../contexts/AuthContext';
import { intlLocale } from '../i18n/format';
import { cn, formatTime } from '../lib/utils';
import { Dialog, Input } from '../components/ui';

// Custom module for this family's fork — not part of upstream OpenFamily. Reuses
// the existing appointments/tasks/meal-plans/planning APIs (read the same data
// as the built-in Kiosk view) with a different layout: a day view plus three
// grid views (3 jours / weekend / semaine), and a live public-transit widget
// for the family's own bus stops. Rendered outside <Layout> (see App.tsx, same
// treatment as /kiosk) so it can go chrome-less fullscreen on the wall tablet.

interface Member { id: string; name: string; color: string }
interface Appointment { id: string; title: string; start_time: string; end_time?: string; location?: string; family_members_data?: Member[] }
interface Task { id: string; title: string; is_completed: boolean; points?: number; due_date?: string }
interface MealPlan { id: string; date: string; meal_type: string; custom_meal?: string; recipe?: { name: string } }
interface PlanningEntry { id: string; family_member_name: string; family_member_color: string; title: string; day_of_week: number; start_time: string; end_time: string }

const MEAL_ORDER = ['Petit-déjeuner', 'Déjeuner', 'Dîner', 'Snack'];
// Official TPF (Transports publics fribourgeois) line colors, sampled from their
// 2026 network map (tpf.ch/…/Plan Agglo (Fribourg).pdf) — only the lines this
// family actually uses so far; unlisted numbers just fall back to the neutral style.
// Keyed by line number AND scoped to TPF (checked against the departure's own
// `operator` field before use) — a bare line number isn't unique across Swiss
// transit operators, and stops added later via the settings panel could belong
// to a different one.
const TPF_LINE_COLORS: Record<string, string> = { '5': '#0492D2', '9': '#A32B9B' };
const busLineColor = (b: Pick<BusDeparture, 'number' | 'operator'>): string | undefined =>
    b.operator?.startsWith('TPF') ? TPF_LINE_COLORS[b.number] : undefined;
const MEAL_SHORT_LABEL: Record<string, string> = { 'Petit-déjeuner': 'Déj.', 'Déjeuner': 'Midi', 'Dîner': 'Soir', Snack: 'Snack' };
const ROW_LABEL_W = 72; // px — day label column, week view
const ROW_SIDE_W = 130; // px — meals / tasks columns, week view
const LANE_H = 32; // px — height of one block lane in the week timeline
const GRID_START = 7;
const GRID_END = 22;
const GRID_SPAN = GRID_END - GRID_START; // 15 one-hour cells: [7,8) … [21,22)
const GRID_CELLS = Array.from({ length: GRID_SPAN }, (_, i) => i + GRID_START); // 7 … 21
const GRID_TICKS = Array.from({ length: GRID_SPAN + 1 }, (_, i) => i + GRID_START); // 7 … 22
const hourPct = (h: number) => ((h - GRID_START) / GRID_SPAN) * 100;

// '#RRGGBB' → 'rgba(r,g,b,a)'; anything else falls back to undefined (no tint).
const withAlpha = (hex: string | undefined, alpha: number): string | undefined => {
    if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return undefined;
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
const hhmm = formatTime;
// Push into a Map<K, V[]>, creating the array on first insert — the grouping
// pattern used by every "group X by day" memo below.
const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
    const list = map.get(key);
    if (list) list.push(value); else map.set(key, [value]);
};

// 'HH:MM' or 'HH:MM:SS' → fractional hour (e.g. '14:30' → 14.5), clamped to the
// visible 7h-22h grid so a block never renders outside it.
const toFractionalHour = (hms: string): number => {
    const [h, m] = hms.split(':').map(Number);
    return Math.min(GRID_END, Math.max(GRID_START, h + m / 60));
};

interface RawBlock {
    id: string;
    type: 'rdv' | 'planning';
    chipLabel: string; // short text shown inside the block itself
    title: string; // full title, for the detail dialog
    timeLabel: string; // e.g. "09:15–10:00", unclamped, for the detail dialog
    meta?: string; // location (rdv) or member's full name (planning), for the detail dialog
    color?: string;
    startHour: number; // clamped to [GRID_START, GRID_END], for positioning
    endHour: number; // clamped to [GRID_START, GRID_END], for positioning
}
interface LaidBlock extends RawBlock { lane: number; lanes: number }

// Calendar-style block layout: blocks span their full start→end duration, and
// concurrent (overlapping) blocks share the row width in side-by-side lanes —
// same idea as how a day view lays out overlapping events in most calendar apps.
const layoutBlocks = (raw: RawBlock[]): LaidBlock[] => {
    const sorted = [...raw].sort((a, b) => a.startHour - b.startHour || a.endHour - b.endHour);
    const result: LaidBlock[] = [];
    let cluster: RawBlock[] = [];
    let clusterEnd = -Infinity;

    const flushCluster = () => {
        if (cluster.length === 0) return;
        const laneEnds: number[] = [];
        const withLane: (RawBlock & { lane: number })[] = [];
        for (const b of cluster) {
            let lane = laneEnds.findIndex((end) => end <= b.startHour);
            if (lane === -1) { lane = laneEnds.length; laneEnds.push(b.endHour); }
            else { laneEnds[lane] = b.endHour; }
            withLane.push({ ...b, lane });
        }
        for (const b of withLane) result.push({ ...b, lanes: laneEnds.length });
        cluster = [];
    };

    for (const b of sorted) {
        if (b.startHour >= clusterEnd) flushCluster();
        cluster.push(b);
        clusterEnd = Math.max(clusterEnd, b.endHour);
    }
    flushCluster();
    return result;
};

// ── Bus times & weather: both configurable per device (⚙️ button), same idea as
// Kiosk's own settings — persisted to localStorage, defaulting to the family's
// actual stop/town so the board isn't empty on first load. Swiss public transport
// (transport.opendata.ch) and weather (Open-Meteo) — both free, no key, CORS-open,
// fetched straight from the browser (no server-side code for either widget).
interface BusRoute { number: string; to: string }
interface BusStopConfig { stationId: string; stationName: string; routes: BusRoute[] }
interface WeatherLocation { name: string; lat: number; lon: number }
interface BoardSettings { busStops: BusStopConfig[]; weatherLocation: WeatherLocation }
// Old, single-stop shape (pre this feature) — kept only to migrate anyone's
// already-saved localStorage settings into the new multi-stop shape.
interface LegacyBoardSettings { busStationId?: string; busStationName?: string; busRoutes?: BusRoute[] }

const SETTINGS_KEY = 'openfamily.familyBoardSettings';
// Defaults match what this family actually uses: from Marteray, line 9 towards
// Givisiez (both Givisiez-bound termini pass through Fribourg, Charmettes right
// after this stop — the other line-9 direction heads away from town and is
// excluded by default) and line 5 towards Fribourg, Charmettes directly;
// weather for Villars-sur-Glâne. The family has a second stop near home too —
// added via the settings panel (⚙️), not hardcoded, since only they know which.
const DEFAULT_SETTINGS: BoardSettings = {
    busStops: [
        {
            stationId: '8592393',
            stationName: 'Villars-sur-Glâne, Marteray',
            routes: [
                { number: '9', to: 'Givisiez, La Faye' },
                { number: '9', to: "Givisiez, route de l'Epinay" },
                { number: '5', to: 'Fribourg, Charmettes' },
            ],
        },
    ],
    weatherLocation: { name: 'Villars-sur-Glâne', lat: 46.79054, lon: 7.11717 },
};

const loadSettings = (): BoardSettings => {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return DEFAULT_SETTINGS;
        const parsed = JSON.parse(raw) as Partial<BoardSettings> & LegacyBoardSettings;
        if (parsed.busStops) return { ...DEFAULT_SETTINGS, ...parsed, busStops: parsed.busStops };
        // Migrate the old single-stop shape into a one-entry busStops list.
        if (parsed.busStationId) {
            return {
                weatherLocation: parsed.weatherLocation ?? DEFAULT_SETTINGS.weatherLocation,
                busStops: [{ stationId: parsed.busStationId, stationName: parsed.busStationName ?? parsed.busStationId, routes: parsed.busRoutes ?? [] }],
            };
        }
        return { ...DEFAULT_SETTINGS, ...parsed };
    } catch { /* corrupted settings → defaults */ }
    return DEFAULT_SETTINGS;
};

interface BusDeparture { time: string; to: string; number: string; operator: string; minutesUntil: number; stationName: string }

const fetchBusTimes = async (stops: BusStopConfig[]): Promise<BusDeparture[]> => {
    const now = Date.now() / 1000;
    const perStop = await Promise.all(stops.map(async (stop): Promise<BusDeparture[]> => {
        if (stop.routes.length === 0) return [];
        try {
            const resp = await fetch(`https://transport.opendata.ch/v1/stationboard?id=${stop.stationId}&limit=30`);
            if (!resp.ok) return [];
            const data = await resp.json() as { stationboard: Array<{ number: string; to: string; operator: string; stop: { departureTimestamp: number } }> };
            return data.stationboard
                .filter((entry) => stop.routes.some((r) => r.number === entry.number && r.to === entry.to))
                .map((entry) => ({
                    time: new Date(entry.stop.departureTimestamp * 1000).toISOString(),
                    to: entry.to,
                    number: entry.number,
                    operator: entry.operator,
                    stationName: stop.stationName,
                    minutesUntil: Math.max(0, Math.round((entry.stop.departureTimestamp - now) / 60)),
                }));
        } catch {
            return []; // one stop's API hiccup shouldn't blank out the others
        }
    }));
    return perStop.flat().sort((a, b) => a.minutesUntil - b.minutesUntil).slice(0, 6);
};

interface DailyForecast { date: string; code: number; max: number; min: number }
interface WeatherState { temp: number; code: number; isDay: boolean; daily: DailyForecast[] }

const fetchWeather = async (loc: WeatherLocation): Promise<WeatherState> => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
        + '&current=temperature_2m,weather_code,is_day'
        + '&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=8&timezone=auto';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const d = await resp.json() as {
        current: { temperature_2m: number; weather_code: number; is_day: number };
        daily: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[] };
    };
    const daily = d.daily.time.map((date, i) => ({ date, code: d.daily.weather_code[i], max: d.daily.temperature_2m_max[i], min: d.daily.temperature_2m_min[i] }));
    return { temp: d.current.temperature_2m, code: d.current.weather_code, isDay: d.current.is_day === 1, daily };
};

interface GeoResult { id: number; name: string; latitude: number; longitude: number; admin1?: string; country?: string }
interface StationResult { id: string; name: string }

// WMO weather code → lucide icon, condensed version of Kiosk's mapping.
const weatherIcon = (code: number, isDay: boolean, className: string): React.ReactElement => {
    if (code === 0 || code === 1) return isDay ? <Sun className={className} /> : <Cloud className={className} />;
    if (code === 2) return <CloudSun className={className} />;
    if (code === 45 || code === 48) return <CloudFog className={className} />;
    if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return <CloudRain className={className} />;
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return <CloudSnow className={className} />;
    if (code >= 95) return <CloudLightning className={className} />;
    return <Cloud className={className} />;
};

// Heading used by every card in the day view (icon + label), pulled out since
// the same markup was repeated for Rendez-vous / Qui est où / À faire / Repas.
const SectionTitle: React.FC<{ icon: React.ReactNode; children: React.ReactNode; tight?: boolean }> = ({ icon, children, tight }) => (
    <h2 className={cn('flex items-center gap-2.5 font-serif text-h2', tight ? 'mb-3' : 'mb-4')}>
        {icon} {children}
    </h2>
);

// A debounced-search text field + result list, shared by the settings panel's
// bus-stop and weather-city pickers (same search-then-pick shape, different
// data source). `results` is only shown once 2+ characters are typed.
function SearchPicker<T>({ value, onChange, placeholder, results, getKey, renderResult, onPick }: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    results: T[];
    getKey: (item: T) => string;
    renderResult: (item: T) => React.ReactNode;
    onPick: (item: T) => void;
}) {
    return (
        <>
            <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="pl-9" />
            </div>
            {value.trim().length >= 2 && (
                results.length === 0 ? (
                    <p className="px-1 text-caption text-muted-foreground">Aucun résultat.</p>
                ) : (
                    <div className="divide-y divide-border overflow-hidden rounded-input border border-border">
                        {results.map((item) => (
                            <button key={getKey(item)} type="button" onClick={() => onPick(item)} className="flex w-full items-center gap-2 px-3 py-2.5 text-left active:bg-surface-2">
                                {renderResult(item)}
                            </button>
                        ))}
                    </div>
                )
            )}
        </>
    );
}

type ViewMode = 'day' | '3days' | 'weekend' | 'week';

const FamilyBoard: React.FC = () => {
    const { isModuleEnabled } = useAuth();
    const mealsEnabled = isModuleEnabled('meals');
    const planningEnabled = isModuleEnabled('planning');
    const [mode, setMode] = useState<ViewMode>('day');
    const [appointments, setAppointments] = useState<Appointment[]>([]);
    const [tasks, setTasks] = useState<Task[]>([]);
    const [meals, setMeals] = useState<MealPlan[]>([]);
    const [planning, setPlanning] = useState<PlanningEntry[]>([]);
    // null = not loaded yet, 'error' = last refresh failed (previous list, if
    // any, is discarded rather than shown stale — a failed poll should read as
    // "unknown", not silently keep displaying a departure that may be long gone).
    const [buses, setBuses] = useState<BusDeparture[] | 'error' | null>(null);
    const [doneTasks, setDoneTasks] = useState<{ id: string; title: string }[]>([]);
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [now, setNow] = useState(new Date());
    const [weather, setWeather] = useState<WeatherState | null>(null);
    const [selectedBlock, setSelectedBlock] = useState<LaidBlock | null>(null);
    const [busDialogOpen, setBusDialogOpen] = useState(false);

    // Per-device settings (bus stop/line, weather town) — same idea as Kiosk.
    const [settings, setSettings] = useState<BoardSettings>(loadSettings);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [citySearch, setCitySearch] = useState('');
    const [cityResults, setCityResults] = useState<GeoResult[]>([]);
    const [stationSearch, setStationSearch] = useState('');
    const [stationResults, setStationResults] = useState<StationResult[]>([]);
    // Available lines/directions per configured stop, keyed by stationId — 'loading'/'error'
    // while (re)fetching, otherwise the deduped list to render as toggle chips.
    const [availableRoutes, setAvailableRoutes] = useState<Record<string, BusRoute[] | 'loading' | 'error'>>({});

    useEffect(() => {
        try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage unavailable, ignore */ }
    }, [settings]);

    const weekStart = useMemo(() => startOfWeek(new Date(), { weekStartsOn: 1 }), []);
    // Days shown in grid modes (everything but 'day'). Past days are always
    // dropped — stale info on a wall board, not useful:
    // - '3days': today + the next 2 days, a rolling window (not week-anchored).
    // - 'weekend': this week's Sat/Sun, whichever haven't passed yet.
    // - 'week': the rest of the current Mon-Sun week — shrinks as the week goes
    //   and resets to 7 days every Monday.
    const gridDays = useMemo(() => {
        const today = new Date();
        if (mode === '3days') return [0, 1, 2].map((i) => addDays(today, i));
        if (mode === 'weekend') return [addDays(weekStart, 5), addDays(weekStart, 6)].filter((d) => ymd(d) >= ymd(today));
        if (mode === 'week') return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)).filter((d) => ymd(d) >= ymd(today));
        return [];
    }, [mode, weekStart]);
    const rangeStart = mode === 'day' ? new Date() : gridDays[0] ?? new Date();
    const rangeEnd = mode === 'day' ? new Date() : gridDays[gridDays.length - 1] ?? new Date();
    // Planning ("qui est où") is queried per Mon-Sun week (it may carry that
    // week's specific-date overrides) — a rolling window like '3days' can spill
    // into the next calendar week, so fetch every distinct week touched and merge.
    const planningWeekStarts = useMemo(() => {
        if (mode === 'day') return [ymd(weekStart)];
        const starts = new Set(gridDays.map((d) => ymd(startOfWeek(d, { weekStartsOn: 1 }))));
        return Array.from(starts.size > 0 ? starts : [ymd(weekStart)]);
    }, [mode, gridDays, weekStart]);

    const loadAll = async () => {
        const start = `${ymd(rangeStart)}T00:00:00`;
        const end = `${ymd(rangeEnd)}T23:59:59`;
        try {
            const [apptRes, taskRes, mealRes, ...planRes] = await Promise.all([
                api.get<{ success: boolean; data: Appointment[] }>(`/api/appointments?start_date=${start}&end_date=${end}`),
                api.get<{ success: boolean; data: Task[] }>('/api/tasks'),
                api.get<{ success: boolean; data: MealPlan[] }>(`/api/meal-plans?start_date=${ymd(rangeStart)}&end_date=${ymd(rangeEnd)}`),
                ...planningWeekStarts.map((ws) => api.get<{ success: boolean; data: PlanningEntry[] }>(`/api/planning?week_start=${ws}`)),
            ]);
            if (apptRes.success) setAppointments(apptRes.data);
            if (taskRes.success) setTasks(taskRes.data);
            if (mealRes.success) setMeals(mealRes.data);
            const byId = new Map<string, PlanningEntry>();
            for (const res of planRes) if (res.success) for (const p of res.data) byId.set(p.id, p);
            setPlanning(Array.from(byId.values()));
        } catch (e) {
            console.error('FamilyBoard load error:', e);
        }
    };

    useEffect(() => {
        void loadAll();
        const id = setInterval(() => void loadAll(), 60_000);
        return () => clearInterval(id);
    }, [mode]);
    useWebSocketUpdates('appointments', () => void loadAll());
    useWebSocketUpdates('tasks', () => void loadAll());
    useWebSocketUpdates('meal-plans', () => void loadAll());
    useWebSocketUpdates('planning', () => void loadAll());

    // Bus times — refresh every 30s, independent of the view-mode toggle.
    useEffect(() => {
        const load = () => {
            fetchBusTimes(settings.busStops).then(setBuses).catch(() => setBuses('error'));
        };
        load();
        const id = setInterval(load, 30_000);
        return () => clearInterval(id);
    }, [settings.busStops]);

    // Live clock — updates every 15s (enough to flip the minute).
    useEffect(() => {
        const id = setInterval(() => setNow(new Date()), 15_000);
        return () => clearInterval(id);
    }, []);

    // Weather — refresh every 30 min; on failure just hide the card.
    useEffect(() => {
        const load = () => { fetchWeather(settings.weatherLocation).then(setWeather).catch(() => setWeather(null)); };
        load();
        const id = setInterval(load, 30 * 60_000);
        return () => clearInterval(id);
    }, [settings.weatherLocation]);

    // Settings overlay: city search (weather), debounced.
    useEffect(() => {
        if (!settingsOpen) return;
        const q = citySearch.trim();
        if (q.length < 2) { setCityResults([]); return; }
        const id = setTimeout(() => {
            fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=fr&format=json`)
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
                .then((d: { results?: GeoResult[] }) => setCityResults(d.results || []))
                .catch(() => setCityResults([]));
        }, 350);
        return () => clearTimeout(id);
    }, [citySearch, settingsOpen]);

    // Settings overlay: bus stop search, debounced.
    useEffect(() => {
        if (!settingsOpen) return;
        const q = stationSearch.trim();
        if (q.length < 2) { setStationResults([]); return; }
        const id = setTimeout(() => {
            fetch(`https://transport.opendata.ch/v1/locations?query=${encodeURIComponent(q)}`)
                .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
                .then((d: { stations?: Array<{ id: string | null; name: string; icon?: string }> }) =>
                    setStationResults((d.stations || []).filter((s): s is StationResult => Boolean(s.id) && s.icon === 'bus').map((s) => ({ id: s.id as string, name: s.name })))
                )
                .catch(() => setStationResults([]));
        }, 350);
        return () => clearTimeout(id);
    }, [stationSearch, settingsOpen]);

    // Discover which lines/directions actually serve a stop, so the family picks
    // from real observed options instead of typing a line number blind.
    const loadRoutesFor = (stationId: string) => {
        setAvailableRoutes((prev) => ({ ...prev, [stationId]: 'loading' }));
        fetch(`https://transport.opendata.ch/v1/stationboard?id=${stationId}&limit=50`)
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then((d: { stationboard: Array<{ number: string; to: string }> }) => {
                const seen = new Set<string>();
                const routes: BusRoute[] = [];
                for (const e of d.stationboard) {
                    const key = `${e.number}→${e.to}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    routes.push({ number: e.number, to: e.to });
                }
                setAvailableRoutes((prev) => ({ ...prev, [stationId]: routes }));
            })
            .catch(() => setAvailableRoutes((prev) => ({ ...prev, [stationId]: 'error' })));
    };

    // Adding a new stop to the list (the family can have several nearby).
    const addStation = (s: StationResult) => {
        if (settings.busStops.some((stop) => stop.stationId === s.id)) { setStationSearch(''); setStationResults([]); return; }
        setSettings((prev) => ({ ...prev, busStops: [...prev.busStops, { stationId: s.id, stationName: s.name, routes: [] }] }));
        setStationSearch('');
        setStationResults([]);
        loadRoutesFor(s.id);
    };

    const removeStation = (stationId: string) => {
        setSettings((prev) => ({ ...prev, busStops: prev.busStops.filter((s) => s.stationId !== stationId) }));
    };

    // Opening settings: load routes for every already-configured stop that
    // hasn't been fetched yet, so each one's chips can be reviewed/edited.
    useEffect(() => {
        if (!settingsOpen) return;
        for (const stop of settings.busStops) {
            if (!(stop.stationId in availableRoutes)) loadRoutesFor(stop.stationId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settingsOpen, settings.busStops]);

    const toggleRoute = (stationId: string, route: BusRoute) => {
        setSettings((prev) => ({
            ...prev,
            busStops: prev.busStops.map((stop) => {
                if (stop.stationId !== stationId) return stop;
                const exists = stop.routes.some((r) => r.number === route.number && r.to === route.to);
                return {
                    ...stop,
                    routes: exists
                        ? stop.routes.filter((r) => !(r.number === route.number && r.to === route.to))
                        : [...stop.routes, route],
                };
            }),
        }));
    };

    // Fullscreen (wall-tablet display) — same pattern as the built-in Kiosk view.
    useEffect(() => {
        const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
        document.addEventListener('fullscreenchange', onChange);
        return () => document.removeEventListener('fullscreenchange', onChange);
    }, []);
    const toggleFullscreen = () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => {});
    };

    const completeTask = (task: Task) => {
        setTasks((prev) => prev.map((x) => (x.id === task.id ? { ...x, is_completed: true } : x)));
        setDoneTasks((prev) => [...prev.filter((d) => d.id !== task.id), { id: task.id, title: task.title }]);
        window.setTimeout(() => setDoneTasks((prev) => prev.filter((d) => d.id !== task.id)), 5_000);
        api.put(`/api/tasks/${task.id}`, { is_completed: true }).catch(() => void loadAll());
    };
    const undoTask = (id: string) => {
        setDoneTasks((prev) => prev.filter((d) => d.id !== id));
        setTasks((prev) => prev.map((x) => (x.id === id ? { ...x, is_completed: false } : x)));
        api.put(`/api/tasks/${id}`, { is_completed: false }).catch(() => void loadAll());
    };

    const pendingTasks = useMemo(() => tasks.filter((t) => !t.is_completed).slice(0, 10), [tasks]);
    const dayLabelShort = (d: Date) => new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', day: 'numeric' }).format(d);

    const apptsByDay = useMemo(() => {
        const map = new Map<string, Appointment[]>();
        for (const a of appointments) push(map, a.start_time.slice(0, 10), a);
        for (const list of map.values()) list.sort((a, b) => a.start_time.localeCompare(b.start_time));
        return map;
    }, [appointments]);

    const mealsByDay = useMemo(() => {
        const map = new Map<string, MealPlan[]>();
        for (const m of meals) push(map, m.date, m);
        for (const list of map.values()) list.sort((a, b) => MEAL_ORDER.indexOf(a.meal_type) - MEAL_ORDER.indexOf(b.meal_type));
        return map;
    }, [meals]);

    const tasksByDay = useMemo(() => {
        const map = new Map<string, Task[]>();
        for (const t of tasks) {
            if (t.is_completed || !t.due_date) continue;
            push(map, t.due_date.slice(0, 10), t);
        }
        return map;
    }, [tasks]);

    const planningByDay = useMemo(() => {
        const map = new Map<number, PlanningEntry[]>();
        for (const p of planning) push(map, p.day_of_week, p);
        for (const list of map.values()) list.sort((a, b) => a.start_time.localeCompare(b.start_time));
        return map;
    }, [planning]);

    // Grid modes: rendez-vous + horaire (qui est où) merged into one spanning
    // timeline per day — each block covers its real start→end duration, laid
    // out side-by-side when several overlap (see layoutBlocks above). Memoized
    // per visible day: this runs on every clock tick otherwise (the 15s "now"
    // update re-renders the whole page), redoing the same sort/cluster for
    // days whose data hasn't changed.
    const blocksByDay = useMemo(() => {
        const map = new Map<string, LaidBlock[]>();
        for (const d of gridDays) {
            const key = ymd(d);
            const raw: RawBlock[] = [];
            for (const a of apptsByDay.get(key) || []) {
                const start = toFractionalHour(a.start_time.slice(11, 16));
                const end = a.end_time ? toFractionalHour(a.end_time.slice(11, 16)) : Math.min(GRID_END, start + 1);
                if (end <= GRID_START || start >= GRID_END || end <= start) continue;
                const members = a.family_members_data || [];
                raw.push({
                    id: a.id,
                    type: 'rdv',
                    chipLabel: `${hhmm(a.start_time)} ${a.title}`,
                    title: a.title,
                    timeLabel: a.end_time ? `${hhmm(a.start_time)}–${hhmm(a.end_time)}` : hhmm(a.start_time),
                    meta: [a.location, members.map((m) => m.name).join(', ') || undefined].filter(Boolean).join(' · ') || undefined,
                    color: members[0]?.color,
                    startHour: start,
                    endHour: end,
                });
            }
            if (planningEnabled) {
                for (const p of planningByDay.get(getISODay(d)) || []) {
                    const start = toFractionalHour(p.start_time);
                    const end = toFractionalHour(p.end_time);
                    if (end <= GRID_START || start >= GRID_END || end <= start) continue;
                    const firstName = p.family_member_name.split(' ')[0];
                    raw.push({
                        id: p.id,
                        type: 'planning',
                        chipLabel: `${firstName} · ${p.title}`,
                        title: p.title,
                        timeLabel: `${p.start_time.slice(0, 5)}–${p.end_time.slice(0, 5)}`,
                        meta: p.family_member_name,
                        color: p.family_member_color,
                        startHour: start,
                        endHour: end,
                    });
                }
            }
            map.set(key, layoutBlocks(raw));
        }
        return map;
    }, [gridDays, apptsByDay, planningByDay, planningEnabled]);

    // Derived once from `now` (state, ticks every 15s) rather than fresh `new
    // Date()` calls scattered through render — one source of truth per render.
    const todayKey = ymd(now);
    const nowHour = now.getHours() + now.getMinutes() / 60;
    const todayPlanning = planningByDay.get(getISODay(now)) || [];
    const todayMeals = mealsByDay.get(todayKey) || [];
    // One place deciding the bus widget's placeholder text — the header badge
    // and the detail dialog both render it the same way.
    const busNote = buses === 'error' ? 'Bus indisponible' : buses === null ? 'Bus…' : buses.length === 0 ? 'Aucun bus' : null;
    const busList = Array.isArray(buses) ? buses : [];

    const topButtonClass = 'rounded-input border border-border bg-card p-2.5 text-muted-foreground transition-colors hover:text-foreground hover:border-border-strong';
    const clock = hhmm(now.toISOString());

    return (
        <div className="flex h-screen flex-col overflow-hidden bg-background px-6 py-6 text-foreground lg:px-12 lg:py-8">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                    <span className="font-serif text-[clamp(1.8rem,3.4vw,2.6rem)] font-semibold tabular-nums text-foreground">{clock}</span>
                    {weather && (
                        <span className="flex items-center gap-1.5 text-body text-muted-foreground">
                            {weatherIcon(weather.code, weather.isDay, 'h-5 w-5 text-primary')}
                            {Math.round(weather.temp)}°
                        </span>
                    )}
                    {settings.busStops.some((s) => s.routes.length > 0) && (
                        busNote ? (
                            <span className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-body text-muted-foreground">
                                <Bus className="h-4 w-4 text-primary" /> {busNote}
                            </span>
                        ) : (
                            busList.slice(0, 3).map((b) => {
                                const lineColor = busLineColor(b);
                                return (
                                    <button
                                        key={`${b.stationName}-${b.time}`}
                                        type="button"
                                        onClick={() => setBusDialogOpen(true)}
                                        className={cn(
                                            'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-body text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground',
                                            !lineColor && 'border-border bg-card'
                                        )}
                                        style={lineColor ? { borderColor: lineColor, backgroundColor: withAlpha(lineColor, 0.1) } : undefined}
                                    >
                                        <Bus className={cn('h-4 w-4', !lineColor && 'text-primary')} style={lineColor ? { color: lineColor } : undefined} />
                                        <span className="font-semibold tabular-nums text-foreground">
                                            {b.minutesUntil <= 0 ? 'maintenant' : `${b.minutesUntil} min`}
                                        </span>
                                        → Bus n°{b.number}
                                    </button>
                                );
                            })
                        )
                    )}
                </div>
                <div className="flex items-center gap-3">
                    <div className="inline-flex overflow-hidden rounded-input border border-border">
                        {([
                            ['day', 'Jour'],
                            ['3days', '3 jours'],
                            ['weekend', 'Weekend'],
                            ['week', 'Semaine'],
                        ] as [ViewMode, string][]).map(([m, label], i) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setMode(m)}
                                className={cn(
                                    'px-4 py-2 text-caption font-medium transition-colors',
                                    i > 0 && 'border-l border-border',
                                    mode === m ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-surface-2'
                                )}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    <button type="button" onClick={() => setSettingsOpen(true)} aria-label="Réglages" className={topButtonClass}>
                        <SettingsIcon className="h-5 w-5" />
                    </button>
                    <button type="button" onClick={toggleFullscreen} aria-label={isFullscreen ? 'Quitter le plein écran' : 'Plein écran'} className={topButtonClass}>
                        {isFullscreen ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
                    </button>
                    <Link to="/" aria-label="Quitter" className={topButtonClass}>
                        <X className="h-5 w-5" />
                    </Link>
                </div>
            </div>            {mode === 'day' ? (
                <div className="mt-4 grid flex-1 grid-cols-1 gap-6 overflow-y-auto lg:grid-cols-3">
                    {/* Schedule */}
                    <section className="rounded-card border border-border bg-card p-6 lg:col-span-2">
                        <SectionTitle icon={<Calendar className="h-5 w-5 text-primary" />}>Rendez-vous</SectionTitle>
                        {appointments.length === 0 ? (
                            <p className="py-6 text-center text-body text-muted-foreground">Rien de prévu aujourd'hui.</p>
                        ) : (
                            <div className="divide-y divide-border">
                                {appointments.map((a) => (
                                    <div key={a.id} className="grid grid-cols-[90px_1fr] items-baseline gap-4 py-3">
                                        <span className="font-serif text-xl tabular-nums text-muted-foreground">{hhmm(a.start_time)}</span>
                                        <div className="min-w-0">
                                            <p className="truncate font-semibold">{a.title}</p>
                                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
                                                {a.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{a.location}</span>}
                                                {(a.family_members_data || []).map((m) => (
                                                    <span key={m.id} className="inline-flex items-center gap-1.5">
                                                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: m.color }} />{m.name}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    <div className="flex flex-col gap-6">
                        {/* Who's where */}
                        {planningEnabled && (
                            <section className="rounded-card border border-border bg-card p-5">
                                <SectionTitle icon={<Users className="h-5 w-5 text-primary" />} tight>Qui est où</SectionTitle>
                                {todayPlanning.length === 0 ? (
                                    <p className="py-3 text-center text-body text-muted-foreground">Rien de prévu.</p>
                                ) : (
                                    <ul className="space-y-2">
                                        {todayPlanning.map((p) => (
                                            <li key={p.id} className="flex items-center gap-3">
                                                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: p.family_member_color }} />
                                                <span className="font-medium">{p.family_member_name}</span>
                                                <span className="min-w-0 flex-1 truncate text-muted-foreground">{p.title}</span>
                                                <span className="shrink-0 tabular-nums text-caption text-muted-foreground">{p.start_time.slice(0, 5)}–{p.end_time.slice(0, 5)}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        )}

                        {/* Tasks — tap to complete */}
                        <section className="rounded-card border border-border bg-card p-5">
                            <SectionTitle icon={<CheckSquare className="h-5 w-5 text-primary" />} tight>À faire</SectionTitle>
                            {pendingTasks.length === 0 && doneTasks.length === 0 ? (
                                <p className="py-3 text-center text-body text-muted-foreground">Rien à faire !</p>
                            ) : (
                                <ul className="space-y-1">
                                    {doneTasks.map((d) => (
                                        <li key={`done-${d.id}`} className="flex items-center gap-3 rounded-input bg-success/10 px-3 py-2.5 text-success">
                                            <Check className="h-5 w-5 shrink-0" />
                                            <span className="min-w-0 flex-1 truncate line-through">{d.title}</span>
                                            <button type="button" onClick={() => undoTask(d.id)} className="flex shrink-0 items-center gap-1.5 rounded-input px-2.5 py-1.5 text-caption font-medium underline-offset-2 active:underline">
                                                <Undo2 className="h-4 w-4" /> Annuler
                                            </button>
                                        </li>
                                    ))}
                                    {pendingTasks.map((task) => (
                                        <li key={task.id}>
                                            <button type="button" onClick={() => completeTask(task)} className="flex w-full items-center gap-3 rounded-input px-3 py-2.5 text-left transition-colors active:bg-surface-2">
                                                <span className="h-5 w-5 shrink-0 rounded-full border-2 border-muted-foreground/50" />
                                                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                                                {(task.points ?? 0) > 0 && <span className="shrink-0 text-caption text-amber-500">⭐ {task.points}</span>}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>

                        {/* Meals */}
                        {mealsEnabled && (
                            <section className="rounded-card border border-border bg-card p-5">
                                <SectionTitle icon={<UtensilsCrossed className="h-5 w-5 text-primary" />} tight>Repas</SectionTitle>
                                {todayMeals.length === 0 ? (
                                    <p className="py-3 text-center text-body text-muted-foreground">Rien de prévu.</p>
                                ) : (
                                    <ul className="space-y-2">
                                        {todayMeals.map((m) => (
                                            <li key={m.id} className="flex items-baseline justify-between gap-3">
                                                <span className="text-caption uppercase tracking-wide text-muted-foreground">{m.meal_type}</span>
                                                <span className="min-w-0 flex-1 truncate text-right font-medium">{m.recipe?.name || m.custom_meal}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </section>
                        )}
                    </div>
                </div>
            ) : (
                /* Grid modes (3 jours / weekend / semaine) — one row per day, hours
                   running left→right, the only difference between them being which
                   days end up in `gridDays`. Reads more naturally on a wide landscape
                   wall tablet than a narrow per-day column would. Repas + à faire sit
                   as fixed-width side cells so the hour axis stays aligned across every row. */
                <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-x-auto rounded-card border border-border bg-card">
                    <div className="flex min-h-full min-w-[900px] flex-1 flex-col">
                        {/* Hour header — labels sit on their tick line (7h at the 7:00 line), the
                            last one (22h) hangs off the right edge. */}
                        <div className="flex shrink-0 border-b border-border bg-surface-2">
                            <div style={{ width: ROW_LABEL_W + ROW_SIDE_W }} className="shrink-0" />
                            <div className="relative h-6 flex-1">
                                {GRID_TICKS.map((h) => (
                                    <span
                                        key={h}
                                        className={cn(
                                            'absolute top-1 whitespace-nowrap text-micro tabular-nums text-muted-foreground',
                                            h === GRID_END ? '-translate-x-full pr-1' : 'pl-1'
                                        )}
                                        style={{ left: `${hourPct(h)}%` }}
                                    >
                                        {h}h
                                    </span>
                                ))}
                            </div>
                            <div style={{ width: ROW_SIDE_W }} className="shrink-0 border-l border-border/40 py-1 text-center text-micro text-muted-foreground">
                                À faire
                            </div>
                        </div>

                        {/* Day rows */}
                        <div className="flex min-h-0 flex-1 flex-col divide-y divide-border">
                            {gridDays.map((d) => {
                                const key = ymd(d);
                                const dayMeals = mealsByDay.get(key) || [];
                                const dayTasks = tasksByDay.get(key) || [];
                                const blocks = blocksByDay.get(key) || [];
                                const laneCount = Math.max(1, ...blocks.map((b) => b.lanes));
                                const isToday = key === todayKey;
                                const showNow = isToday && nowHour >= GRID_START && nowHour <= GRID_END;
                                const dayForecast = weather?.daily.find((f) => f.date === key);
                                return (
                                    <div key={key} className={cn('flex flex-1 items-stretch', isToday && 'bg-primary/5')}>
                                        {/* Day label + mini forecast */}
                                        <div
                                            style={{ width: ROW_LABEL_W }}
                                            className={cn('flex shrink-0 flex-col items-center justify-center gap-0.5 whitespace-nowrap border-r border-border px-1 text-caption font-semibold capitalize', isToday ? 'text-primary' : 'text-foreground')}
                                        >
                                            {dayLabelShort(d)}
                                            {dayForecast && (
                                                <span className="flex items-center gap-1 text-micro font-normal text-muted-foreground">
                                                    {weatherIcon(dayForecast.code, true, 'h-3.5 w-3.5 text-primary')}
                                                    {Math.round(dayForecast.max)}°
                                                </span>
                                            )}
                                        </div>

                                        {/* Repas — les 4 types différenciés */}
                                        <div style={{ width: ROW_SIDE_W }} className="shrink-0 space-y-0.5 border-r border-border px-2 py-1.5">
                                            {mealsEnabled && dayMeals.length > 0 ? (
                                                dayMeals.map((m) => (
                                                    <p key={m.id} className="flex items-baseline gap-1 truncate text-micro">
                                                        <span className="shrink-0 font-semibold text-primary">{MEAL_SHORT_LABEL[m.meal_type] ?? m.meal_type}</span>
                                                        <span className="truncate text-muted-foreground">{m.recipe?.name || m.custom_meal}</span>
                                                    </p>
                                                ))
                                            ) : (
                                                <p className="text-micro text-muted-foreground/60">—</p>
                                            )}
                                        </div>

                                        {/* Horaire 7h-22h : rendez-vous + planning fusionnés. Chaque bloc
                                            occupe toute sa durée ; les chevauchements s'empilent en bandes
                                            de hauteur fixe, centrées verticalement dans la ligne. */}
                                        <div className="relative flex min-w-0 flex-1 items-center border-r border-border/40 py-1">
                                            {/* Hour gridlines: 15 one-hour cells, a line at the start of each */}
                                            <div className="pointer-events-none absolute inset-0 flex">
                                                {GRID_CELLS.map((h) => <div key={h} className="flex-1 border-l border-border/25" />)}
                                            </div>
                                            {/* Today: shade the hours already gone + a "now" marker */}
                                            {showNow && (
                                                <>
                                                    <div className="pointer-events-none absolute inset-y-0 left-0 bg-background/40" style={{ width: `${hourPct(nowHour)}%` }} />
                                                    <div className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-primary" style={{ left: `${hourPct(nowHour)}%` }} />
                                                </>
                                            )}
                                            <div className="relative w-full" style={{ height: `min(100%, ${laneCount * LANE_H}px)` }}>
                                                {blocks.map((b) => (
                                                    <button
                                                        key={b.id}
                                                        type="button"
                                                        onClick={() => setSelectedBlock(b)}
                                                        className={cn(
                                                            'absolute flex items-center overflow-hidden whitespace-nowrap rounded-[4px] border-l-[3px] px-1.5 py-px text-left text-caption leading-tight transition-opacity active:opacity-70',
                                                            b.type === 'rdv' ? 'font-medium text-foreground' : 'text-foreground/90',
                                                            !b.color && (b.type === 'rdv' ? 'border-primary bg-primary/15' : 'border-border bg-surface-2')
                                                        )}
                                                        style={{
                                                            left: `${hourPct(b.startHour)}%`,
                                                            width: `${hourPct(b.endHour) - hourPct(b.startHour)}%`,
                                                            top: `${(b.lane / b.lanes) * 100}%`,
                                                            height: `${(1 / b.lanes) * 100}%`,
                                                            ...(b.color ? { borderLeftColor: b.color, backgroundColor: withAlpha(b.color, 0.18) } : {}),
                                                        }}
                                                    >
                                                        <span className="truncate">{b.chipLabel}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>

                                        {/* À faire */}
                                        <div style={{ width: ROW_SIDE_W }} className="shrink-0 space-y-0.5 border-l border-border px-2 py-1.5">
                                            {dayTasks.length > 0 ? (
                                                dayTasks.map((t) => (
                                                    <p key={t.id} className="flex items-center gap-1 truncate text-micro text-muted-foreground">
                                                        <CheckSquare className="h-3 w-3 shrink-0" />
                                                        <span className="truncate">{t.title}</span>
                                                    </p>
                                                ))
                                            ) : (
                                                <p className="text-micro text-muted-foreground/60">—</p>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {/* Block detail — tap-to-expand, since hover tooltips don't exist on a
                touchscreen and the week-view chips truncate long titles. */}
            <Dialog
                open={selectedBlock !== null}
                onOpenChange={(open) => !open && setSelectedBlock(null)}
                title={selectedBlock?.title ?? ''}
                description={selectedBlock?.timeLabel}
            >
                {selectedBlock && (
                    <div className="space-y-3">
                        <p className="flex items-center gap-2 text-body text-muted-foreground">
                            {selectedBlock.type === 'rdv' ? <Calendar className="h-4 w-4 shrink-0 text-primary" /> : <Users className="h-4 w-4 shrink-0 text-primary" />}
                            {selectedBlock.type === 'rdv' ? 'Rendez-vous' : 'Planning'}
                        </p>
                        {selectedBlock.meta && (
                            <p className="flex items-center gap-2 text-body">
                                {selectedBlock.color && <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: selectedBlock.color }} />}
                                {selectedBlock.type === 'rdv' && <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />}
                                {selectedBlock.meta}
                            </p>
                        )}
                    </div>
                )}
            </Dialog>

            {/* Bus detail — the header badge only shows up to 3 departures; tap it
                for the full list (moved out of a dedicated section to give the
                calendar more vertical room, especially in the grid views). */}
            <Dialog
                open={busDialogOpen}
                onOpenChange={setBusDialogOpen}
                title="Prochains bus"
                description={settings.busStops.map((s) => s.stationName).join(' · ') || undefined}
            >
                {busNote ? (
                    <p className="text-body text-muted-foreground">{busNote}</p>
                ) : (
                    // Grouped by stop (not one flat chronological list) — with several
                    // stops and lines interleaved, a single grid of same-sized cards
                    // became a wall of near-identical boxes. Each row's left accent
                    // matches its line's color badge in the header, for the same
                    // at-a-glance line recognition.
                    <div className="space-y-4">
                        {settings.busStops.map((stop) => {
                            const stopBuses = busList.filter((b) => b.stationName === stop.stationName);
                            if (stopBuses.length === 0) return null;
                            return (
                                <div key={stop.stationId}>
                                    <p className="mb-1.5 text-caption font-medium text-muted-foreground">{stop.stationName}</p>
                                    <div className="space-y-1.5">
                                        {stopBuses.map((b) => {
                                            const lineColor = busLineColor(b);
                                            return (
                                                <div
                                                    key={b.time}
                                                    className={cn('flex items-center gap-3 rounded-input border-l-[3px] bg-surface-2 py-2 pl-3 pr-4', !lineColor && 'border-primary')}
                                                    style={lineColor ? { borderLeftColor: lineColor } : undefined}
                                                >
                                                    <span className="w-16 shrink-0 font-serif text-lg font-semibold tabular-nums">
                                                        {b.minutesUntil <= 0 ? 'maintenant' : `${b.minutesUntil} min`}
                                                    </span>
                                                    <span className="text-caption text-muted-foreground">Départ {hhmm(b.time)}</span>
                                                    <span className="ml-auto shrink-0 text-caption font-medium" style={lineColor ? { color: lineColor } : undefined}>
                                                        Bus n°{b.number}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </Dialog>

            {/* Per-device settings: bus stop/line and weather town. */}
            {settingsOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSettingsOpen(false)} />
                    <div className="relative max-h-[85vh] w-full max-w-md overflow-y-auto rounded-card border border-border bg-card p-6 shadow-lg">
                        <div className="mb-5 flex items-center justify-between gap-3">
                            <h2 className="font-serif text-h2">Réglages du tableau</h2>
                            <button type="button" onClick={() => setSettingsOpen(false)} aria-label="Fermer" className="rounded-input p-2 text-muted-foreground active:bg-surface-2">
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        {/* Bus stops + lines — the family can have several nearby stops */}
                        <div className="space-y-4">
                            <p className="text-caption font-medium">Arrêts de bus</p>

                            {settings.busStops.map((stop) => {
                                const routes = availableRoutes[stop.stationId];
                                return (
                                    <div key={stop.stationId} className="space-y-2 rounded-input border border-border bg-surface-2 p-3">
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="inline-flex min-w-0 items-center gap-2">
                                                <Bus className="h-4 w-4 shrink-0 text-primary" />
                                                <span className="truncate font-medium">{stop.stationName}</span>
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => removeStation(stop.stationId)}
                                                aria-label={`Supprimer ${stop.stationName}`}
                                                className="shrink-0 rounded-input p-1 text-muted-foreground active:bg-surface-2"
                                            >
                                                <X className="h-4 w-4" />
                                            </button>
                                        </div>
                                        {routes === undefined || routes === 'loading' ? (
                                            <p className="text-caption text-muted-foreground">Chargement des lignes…</p>
                                        ) : routes === 'error' ? (
                                            <p className="text-caption text-muted-foreground">Impossible de charger les lignes de cet arrêt.</p>
                                        ) : routes.length === 0 ? (
                                            <p className="text-caption text-muted-foreground">Aucune ligne trouvée pour cet arrêt.</p>
                                        ) : (
                                            <div className="flex flex-wrap gap-2">
                                                {routes.map((r) => {
                                                    const active = stop.routes.some((x) => x.number === r.number && x.to === r.to);
                                                    return (
                                                        <button
                                                            key={`${r.number}→${r.to}`}
                                                            type="button"
                                                            onClick={() => toggleRoute(stop.stationId, r)}
                                                            className={cn(
                                                                'rounded-full border px-3 py-1.5 text-caption transition-colors',
                                                                active ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-muted-foreground hover:text-foreground'
                                                            )}
                                                        >
                                                            {r.number} → {r.to}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            <SearchPicker
                                value={stationSearch}
                                onChange={setStationSearch}
                                placeholder="Ajouter un arrêt…"
                                results={stationResults}
                                getKey={(s) => s.id}
                                onPick={addStation}
                                renderResult={(s) => (
                                    <>
                                        <MapPin className="h-4 w-4 shrink-0 text-primary" />
                                        <span className="truncate">{s.name}</span>
                                    </>
                                )}
                            />
                        </div>

                        {/* Weather town */}
                        <div className="mt-6 space-y-2">
                            <p className="text-caption font-medium">Météo</p>
                            <div className="flex items-center justify-between gap-3 rounded-input border border-border bg-surface-2 px-3 py-2.5">
                                <span className="inline-flex min-w-0 items-center gap-2">
                                    <MapPin className="h-4 w-4 shrink-0 text-primary" />
                                    <span className="truncate font-medium">{settings.weatherLocation.name}</span>
                                </span>
                            </div>
                            <SearchPicker
                                value={citySearch}
                                onChange={setCitySearch}
                                placeholder="Changer de ville…"
                                results={cityResults}
                                getKey={(r) => String(r.id)}
                                onPick={(r) => {
                                    setSettings((s) => ({ ...s, weatherLocation: { name: r.name, lat: r.latitude, lon: r.longitude } }));
                                    setCitySearch('');
                                    setCityResults([]);
                                }}
                                renderResult={(r) => (
                                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                                        <span className="font-medium">{r.name}</span>
                                        <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{[r.admin1, r.country].filter(Boolean).join(', ')}</span>
                                    </span>
                                )}
                            />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default FamilyBoard;
