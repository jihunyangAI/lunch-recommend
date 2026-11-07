"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import type { AiResult, PriceLevel, Restaurant } from "@/lib/types";
import { distanceMeters, formatDistance, PRICE_TEXT, priceSteps, walkMinutes } from "@/lib/format";
import { useFavorites } from "@/lib/favorites";

const API_KEY = process.env.NEXT_PUBLIC_MAPS_API_KEY ?? "";
const MAP_ID = process.env.NEXT_PUBLIC_MAPS_MAP_ID || "DEMO_MAP_ID";
const FALLBACK = { lat: 37.5665, lng: 126.978 }; // 서울시청

const RADIUS_OPTIONS = [
  { meters: 500, label: "도보 5분", icon: "walk" },
  { meters: 800, label: "도보 10분", icon: "walk" },
  { meters: 2000, label: "차량 5분", icon: "car" },
] as const;
type RadiusMeters = (typeof RADIUS_OPTIONS)[number]["meters"];
const DEFAULT_RADIUS: RadiusMeters = 500;

type LatLng = { lat: number; lng: number };
type Status = "locating" | "searching" | "ready" | "error";
type Sort = "distance" | "rating";
type View = "nearby" | "favorites";

/**
 * Frame the radius circle. fitBounds snaps to whole zoom levels (often leaving
 * the circle tiny), so compute a fractional zoom instead — vector maps support it.
 */
function frameCircle(map: google.maps.Map, el: HTMLElement, center: LatLng, radius: number) {
  const visibleH = el.clientHeight - 20; // bottom sheet overlaps the map by 20px
  const fitPx = Math.min(visibleH, el.clientWidth) - 56;
  const metersPerPxAtZ0 = 156543.03392 * Math.cos((center.lat * Math.PI) / 180);
  const zoom = Math.log2((metersPerPxAtZ0 * fitPx) / (radius * 2));
  map.moveCamera({ center, zoom: Math.min(18, zoom) });
  map.panBy(0, 10); // keep the circle centered in the part above the sheet
}

let mapsConfigured = false;
function configureMaps() {
  if (mapsConfigured) return;
  setOptions({ key: API_KEY, v: "weekly", language: "ko", region: "KR" });
  mapsConfigured = true;
}

function getPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) return reject(new Error("unsupported"));
    // The API's own timeout doesn't run while the permission prompt is open,
    // so give up on our own after 12s and let the caller fall back.
    const timer = setTimeout(() => reject(new Error("timeout")), 12000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
}

export default function LunchApp() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const meMarker = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const circleRef = useRef<google.maps.Circle | null>(null);
  const markers = useRef(new Map<string, google.maps.marker.AdvancedMarkerElement>());
  const markerCtor = useRef<typeof google.maps.marker.AdvancedMarkerElement | null>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const viewRef = useRef<View>("nearby");
  // Latest search center/radius for map listeners registered once at init.
  const centerRef = useRef<{ position: LatLng | null; radius: number }>({ position: null, radius: DEFAULT_RADIUS });

  const [status, setStatus] = useState<Status>("locating");
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<LatLng | null>(null);
  /** Where the search center came from: GPS, the Seoul City Hall fallback, or a spot picked on the map. */
  const [origin, setOrigin] = useState<"gps" | "fallback" | "picked">("gps");
  /** Right-click on the map → "search here?" prompt anchored at the clicked point. */
  /** Map was panned away from the search center → show "search this area". */
  const [movedAway, setMovedAway] = useState(false);
  const [pending, setPending] = useState<{ lat: number; lng: number; x: number; y: number; w: number } | null>(null);
  const [restaurants, setRestaurants] = useState<Restaurant[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("distance");
  const [radius, setRadius] = useState<RadiusMeters>(DEFAULT_RADIUS);
  const radiusLabel = RADIUS_OPTIONS.find((o) => o.meters === radius)!.label;
  const [view, setView] = useState<View>("nearby");
  const [mapsReady, setMapsReady] = useState(false);
  const { favorites, isFavorite, toggle: toggleFavorite } = useFavorites();

  const [mood, setMood] = useState("");
  const [ai, setAi] = useState<AiResult | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const select = useCallback((id: string, from: "map" | "list") => {
    setSelectedId(id);
    if (from === "map") {
      cardRefs.current.get(id)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, []);

  // 1) Detect location
  const locate = useCallback(async () => {
    setStatus("locating");
    setError(null);
    setPending(null);
    try {
      setPosition(await getPosition());
      setOrigin("gps");
    } catch {
      setPosition({ ...FALLBACK });
      setOrigin("fallback");
    }
  }, []);

  useEffect(() => {
    let off = false;
    getPosition()
      .then((p) => {
        if (off) return;
        setPosition(p);
        setOrigin("gps");
      })
      .catch(() => {
        if (off) return;
        setPosition({ ...FALLBACK });
        setOrigin("fallback");
      });
    return () => {
      off = true;
    };
  }, []);

  // 2) Map + nearby search whenever the position or radius changes
  useEffect(() => {
    if (!position || !mapDiv.current || !API_KEY) return;
    let cancelled = false;

    (async () => {
      try {
        configureMaps();
        setStatus("searching");
        const [{ Map }, { AdvancedMarkerElement }, { Place, SearchNearbyRankPreference }] = await Promise.all([
          importLibrary("maps"),
          importLibrary("marker"),
          importLibrary("places"),
        ]);
        if (cancelled || !mapDiv.current) return;
        markerCtor.current = AdvancedMarkerElement;

        if (!mapRef.current) {
          mapRef.current = new Map(mapDiv.current, {
            center: position,
            zoom: 16,
            mapId: MAP_ID,
            disableDefaultUI: true,
            zoomControl: true,
            clickableIcons: false,
            gestureHandling: "greedy",
          });
          const m = mapRef.current;
          // Right-click (or long-press on touch) → ask before searching there.
          m.addListener("contextmenu", (e: google.maps.MapMouseEvent) => {
            if (!e.latLng || !mapDiv.current) return;
            const rect = mapDiv.current.getBoundingClientRect();
            const de = e.domEvent as Partial<MouseEvent>;
            const x = typeof de.clientX === "number" ? de.clientX - rect.left : rect.width / 2;
            const y = typeof de.clientY === "number" ? de.clientY - rect.top : rect.height / 2;
            setPending({ lat: e.latLng.lat(), lng: e.latLng.lng(), x, y, w: rect.width });
          });
          // The prompt is pinned to screen pixels, so drop it once the map moves.
          const dismiss = () => setPending(null);
          m.addListener("click", dismiss);
          m.addListener("dragstart", dismiss);
          m.addListener("zoom_changed", dismiss);
          // Touch-friendly alternative to right-click: once the map has been moved
          // well away from the current search center, offer "search this area".
          m.addListener("idle", () => {
            const c = m.getCenter();
            const { position: p, radius: r } = centerRef.current;
            if (!c || !p || viewRef.current !== "nearby") return setMovedAway(false);
            setMovedAway(distanceMeters(p, { lat: c.lat(), lng: c.lng() }) > Math.max(150, r * 0.4));
          });
        } else {
          mapRef.current.panTo(position);
        }
        const map = mapRef.current;

        // Search-center marker: blue "you are here" dot, or a flag for a picked spot.
        const centerTitle = origin === "picked" ? "지정한 위치" : "현재 위치";
        if (!meMarker.current) {
          meMarker.current = new AdvancedMarkerElement({
            map,
            position,
            content: document.createElement("div"),
            title: centerTitle,
            zIndex: 1,
          });
        } else {
          meMarker.current.position = position;
          meMarker.current.title = centerTitle;
        }
        (meMarker.current.content as HTMLElement).className = origin === "picked" ? "origin-pin" : "me-dot";

        // Search-radius circle
        if (!circleRef.current) {
          circleRef.current = new google.maps.Circle({
            map,
            center: position,
            radius,
            strokeColor: "#ff6b57",
            strokeOpacity: 0.9,
            strokeWeight: 2,
            fillColor: "#ff6b57",
            fillOpacity: 0.07,
            clickable: false,
          });
        } else {
          circleRef.current.setCenter(position);
          circleRef.current.setRadius(radius);
        }
        if (viewRef.current === "nearby") frameCircle(map, mapDiv.current, position, radius);
        setMapsReady(true);

        const { places } = await Place.searchNearby({
          fields: [
            "id",
            "displayName",
            "location",
            "primaryTypeDisplayName",
            "rating",
            "userRatingCount",
            "priceLevel",
            "formattedAddress",
            "googleMapsURI",
          ],
          locationRestriction: { center: position, radius },
          includedTypes: ["restaurant"],
          maxResultCount: 20,
          rankPreference: SearchNearbyRankPreference.POPULARITY,
          language: "ko",
          region: "kr",
        });
        if (cancelled) return;

        const list: Restaurant[] = places
          .filter((p) => p.location)
          .map((p) => {
            const lat = p.location!.lat();
            const lng = p.location!.lng();
            return {
              id: p.id,
              no: 0,
              name: p.displayName ?? "이름 없음",
              type: p.primaryTypeDisplayName ?? "음식점",
              lat,
              lng,
              distance: distanceMeters(position, { lat, lng }),
              rating: p.rating ?? null,
              ratingCount: p.userRatingCount ?? 0,
              priceLevel: (p.priceLevel as PriceLevel | null | undefined) ?? null,
              address: p.formattedAddress ?? null,
              mapsUrl: p.googleMapsURI ?? null,
            };
          })
          .sort((a, b) => a.distance - b.distance)
          .map((r, i) => ({ ...r, no: i + 1 }));

        setRestaurants(list);
        setSelectedId(null);
        setAi(null);
        setAiError(null);
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        console.error(e);
        setStatus("error");
        setError("주변 식당을 불러오지 못했어요. API 키의 허용 주소(현재 주소 포함 여부)와 Places API (New) 사용 설정을 확인해 주세요.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [position, radius, origin]);

  useEffect(() => {
    centerRef.current = { position, radius };
  }, [position, radius]);

  const searchMapCenter = () => {
    const c = mapRef.current?.getCenter();
    if (!c) return;
    setMovedAway(false);
    setPending(null);
    setSelectedId(null);
    setOrigin("picked");
    setPosition({ lat: c.lat(), lng: c.lng() });
  };

  const searchPicked = () => {
    if (!pending) return;
    setPending(null);
    viewRef.current = "nearby";
    setView("nearby");
    setSelectedId(null);
    setOrigin("picked");
    setPosition({ lat: pending.lat, lng: pending.lng });
  };

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPending(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  // Favorites, numbered nearest-first from the current position.
  const favoriteList = useMemo<Restaurant[]>(
    () =>
      favorites
        .map((f) => ({ ...f, no: 0, distance: position ? distanceMeters(position, f) : 0 }))
        .sort((a, b) => a.distance - b.distance)
        .map((r, i) => ({ ...r, no: i + 1 })),
    [favorites, position],
  );
  const shown = view === "nearby" ? restaurants : favoriteList;

  // 3) Markers for whatever list is on screen
  useEffect(() => {
    const map = mapRef.current;
    const Marker = markerCtor.current;
    if (!mapsReady || !map || !Marker) return;

    markers.current.forEach((m) => (m.map = null));
    markers.current.clear();
    for (const r of shown) {
      const pin = document.createElement("div");
      pin.className = view === "favorites" ? "pin is-fav" : "pin";
      pin.textContent = String(r.no);
      const marker = new Marker({
        map,
        position: { lat: r.lat, lng: r.lng },
        content: pin,
        title: r.name,
        gmpClickable: true,
        zIndex: 10,
      });
      marker.addEventListener("gmp-click", () => select(r.id, "map"));
      markers.current.set(r.id, marker);
    }

    if (view === "favorites" && shown.length > 0) {
      const bounds = new google.maps.LatLngBounds();
      shown.forEach((r) => bounds.extend({ lat: r.lat, lng: r.lng }));
      if (position) bounds.extend(position);
      map.fitBounds(bounds, { top: 112, right: 40, bottom: 40, left: 40 });
      google.maps.event.addListenerOnce(map, "idle", () => {
        if ((map.getZoom() ?? 0) > 17) map.setZoom(17);
      });
    }
  }, [shown, view, mapsReady, position, select]);

  const switchView = (v: View) => {
    if (v === view) return;
    viewRef.current = v;
    setView(v);
    setSelectedId(null);
    setMovedAway(false);
    if (v === "nearby" && mapRef.current && mapDiv.current && position) {
      frameCircle(mapRef.current, mapDiv.current, position, radius);
    }
  };

  // 4) Reflect selection / AI picks on markers
  const aiIds = useMemo(() => new Set(ai?.picks.map((p) => p.id) ?? []), [ai]);
  useEffect(() => {
    markers.current.forEach((marker, id) => {
      const el = marker.content as HTMLElement | null;
      if (!el) return;
      const active = id === selectedId;
      el.classList.toggle("is-active", active);
      el.classList.toggle("is-ai", aiIds.has(id));
      marker.zIndex = active ? 100 : aiIds.has(id) ? 50 : 10;
    });
    const r = shown.find((x) => x.id === selectedId);
    if (r && mapRef.current) mapRef.current.panTo({ lat: r.lat, lng: r.lng });
  }, [selectedId, aiIds, shown]);

  const sorted = useMemo(() => {
    const list = [...shown];
    if (sort === "rating") list.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.ratingCount - a.ratingCount);
    return list;
  }, [shown, sort]);

  const askAi = async () => {
    if (restaurants.length === 0 || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mood,
          restaurants: restaurants.map((r) => ({
            id: r.id,
            name: r.name,
            type: r.type,
            distance: Math.round(r.distance),
            rating: r.rating,
            ratingCount: r.ratingCount,
            priceLevel: r.priceLevel,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "AI 추천에 실패했어요.");
      setAi(data as AiResult);
      if (data.picks?.[0]) select(data.picks[0].id, "list");
    } catch (e) {
      setAi(null);
      setAiError(e instanceof Error ? e.message : "AI 추천에 실패했어요.");
    } finally {
      setAiLoading(false);
    }
  };

  const byId = useMemo(() => new Map(restaurants.map((r) => [r.id, r])), [restaurants]);

  if (!API_KEY) {
    return (
      <p className="m-6 rounded-2xl bg-white p-4 text-sm text-coral-deep ring-1 ring-line">
        NEXT_PUBLIC_MAPS_API_KEY가 설정되지 않았어요. .env.local을 확인하고 개발 서버를 다시 시작해 주세요.
      </p>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-surface">
      {/* ── Map ── */}
      <section className="relative h-[44dvh] min-h-[260px] shrink-0">
        <div
          ref={mapDiv}
          onContextMenu={(e) => e.preventDefault()}
          className="h-full w-full bg-[#eceef1]"
          aria-label="주변 식당 지도 (마우스 오른쪽 클릭으로 조회 위치 지정)"
        />

        {pending && (
          <>
            {/* clicked spot */}
            <span
              className="pointer-events-none absolute z-20 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-coral shadow-[0_0_0_6px_rgba(255,107,87,0.25)]"
              style={{ left: pending.x, top: pending.y }}
            />
            <div
              role="dialog"
              aria-label="조회 위치 확인"
              className="absolute z-30 w-[220px] rounded-2xl bg-white p-3.5 shadow-[0_12px_32px_rgba(20,20,30,0.18)] ring-1 ring-line"
              style={{
                // Prefer above the point; flip below when too close to the top. Clamp horizontally.
                left: Math.min(Math.max(pending.x, 122), pending.w - 122),
                top: pending.y,
                transform: pending.y < 150 ? "translate(-50%, 16px)" : "translate(-50%, calc(-100% - 16px))",
              }}
            >
              <p className="text-sm font-semibold text-ink">지정한 위치에서 조회할까요?</p>
              <p className="mt-0.5 text-[11px] text-muted">
                이 지점을 중심으로 {radiusLabel}({radius >= 1000 ? `${radius / 1000}km` : `${radius}m`}) 안의 식당을 찾아요.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setPending(null)}
                  className="flex-1 rounded-xl bg-surface py-2 text-xs font-semibold text-muted transition hover:text-ink"
                >
                  아니오
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={searchPicked}
                  className="flex-1 rounded-xl bg-coral py-2 text-xs font-semibold text-white shadow-[0_4px_12px_rgba(255,107,87,0.35)] transition hover:bg-coral-deep"
                >
                  예
                </button>
              </div>
            </div>
          </>
        )}

        <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-4">
          <div className="pointer-events-auto rounded-2xl bg-white/95 px-4 py-2.5 shadow-[0_6px_24px_rgba(20,20,30,0.10)] backdrop-blur">
            <h1 className="text-[17px] font-bold tracking-tight text-ink">
              오늘 뭐 먹지<span className="text-coral">?</span>
            </h1>
            <p className="text-[11px] font-medium text-muted">AI 맛집 추천</p>
          </div>
          <button
            type="button"
            onClick={locate}
            className="pointer-events-auto grid h-11 w-11 place-items-center rounded-full bg-white text-coral shadow-[0_6px_24px_rgba(20,20,30,0.12)] transition hover:scale-105 active:scale-95"
            aria-label="현재 위치로 다시 검색"
            title="현재 위치로 다시 검색"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <circle cx="12" cy="12" r="3.5" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
          </button>
        </header>

        {/* Radius picker */}
        <div
          role="radiogroup"
          aria-label="검색 반경"
          className="absolute left-4 top-[84px] flex gap-1 rounded-full bg-white/95 p-1 shadow-[0_6px_24px_rgba(20,20,30,0.10)] backdrop-blur"
        >
          {RADIUS_OPTIONS.map((o) => {
            const on = o.meters === radius;
            return (
              <button
                key={o.meters}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={status === "locating" || status === "searching"}
                onClick={() => setRadius(o.meters)}
                className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold transition disabled:cursor-wait ${
                  on ? "bg-coral text-white shadow-[0_4px_12px_rgba(255,107,87,0.35)]" : "text-muted hover:text-ink"
                }`}
              >
                {o.icon === "walk" ? (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                    <circle cx="13" cy="4" r="2" />
                    <path d="M10.6 8.2 8 9.6V13h2v-2.2l1.3-.6-1.1 5.3L7.6 20l1.6 1.2 2.9-4 1.2 2.3V22h2v-3l-1.6-3.2.6-2.7 1 1.4H18v-2h-2.6l-1.7-2.6c-.5-.8-1.4-1.1-2.3-.9l-.8.2Z" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
                    <path d="M5 11l1.6-4.4A2 2 0 0 1 8.5 5.3h7a2 2 0 0 1 1.9 1.3L19 11a2 2 0 0 1 1 1.7V17a1 1 0 0 1-1 1h-1v1.5a1.5 1.5 0 0 1-3 0V18H9v1.5a1.5 1.5 0 0 1-3 0V18H5a1 1 0 0 1-1-1v-4.3A2 2 0 0 1 5 11Zm2.2-.5h9.6l-1.2-3.3a.5.5 0 0 0-.5-.3H8.9a.5.5 0 0 0-.5.3L7.2 10.5ZM7 15.2a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Zm10 0a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4Z" />
                  </svg>
                )}
                <span>{o.label}</span>
                <span className={on ? "text-white/80" : "text-muted/70"}>
                  {o.meters >= 1000 ? `${o.meters / 1000}km` : `${o.meters}m`}
                </span>
              </button>
            );
          })}
        </div>

        {movedAway && view === "nearby" && status === "ready" && !pending && (
          <button
            type="button"
            onClick={searchMapCenter}
            className="absolute bottom-9 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-ink px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_8px_24px_rgba(20,20,30,0.25)] transition hover:bg-black active:scale-95"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 text-coral" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
            </svg>
            이 지역에서 다시 검색
          </button>
        )}

        {(status === "locating" || status === "searching") && (
          <div className="absolute inset-0 grid place-items-center bg-white/40 backdrop-blur-[1px]">
            <div className="flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-medium text-ink shadow">
              <span className="h-2 w-2 animate-ping rounded-full bg-coral" />
              {status === "locating" ? "현재 위치 확인 중…" : "주변 식당 찾는 중…"}
            </div>
          </div>
        )}
      </section>

      {/* ── List ── */}
      <section className="relative -mt-5 flex min-h-0 flex-1 flex-col rounded-t-[28px] bg-surface shadow-[0_-8px_30px_rgba(20,20,30,0.08)]">
        <div className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-4 pb-8 pt-3 sm:px-6">
          <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line" />

          {origin === "fallback" && (
            <p className="mb-3 rounded-xl bg-white px-3 py-2 text-xs text-muted ring-1 ring-line">
              위치 권한이 없어 <b className="text-ink">서울시청</b> 기준으로 보여드려요. 브라우저에서 위치 권한을 허용하고 ⌖ 버튼을 눌러 주세요.
            </p>
          )}
          {origin === "picked" && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl bg-coral-soft px-3 py-2 text-xs text-ink">
              <span>
                <b>지도에서 지정한 위치</b> 기준으로 보여드려요. 거리도 이 위치에서 잰 값이에요.
              </span>
              <button
                type="button"
                onClick={locate}
                className="shrink-0 rounded-full bg-white px-3 py-1 font-semibold text-coral ring-1 ring-coral/30 transition hover:bg-coral hover:text-white"
              >
                내 위치로
              </button>
            </div>
          )}
          {origin !== "picked" && status === "ready" && (
            <p className="mb-3 text-[11px] text-muted/80">
              Tip. 지도를 움직인 뒤 <b className="font-semibold text-ink">이 지역에서 다시 검색</b>을 누르거나
              <span className="hidden sm:inline">, 지도에서 마우스 오른쪽 버튼을 눌러</span> 원하는 위치를 기준으로 조회할 수 있어요.
            </p>
          )}

          {/* AI box (recommends from nearby search results) */}
          {view === "nearby" && (
          <div className="mb-5 rounded-2xl bg-white p-4 ring-1 ring-line">
            <div className="mb-2 flex items-center gap-2">
              <span className="rounded-md bg-coral-soft px-1.5 py-0.5 text-[11px] font-bold text-coral">AI</span>
              <p className="text-sm font-semibold text-ink">오늘 기분이나 먹고 싶은 걸 알려주세요</p>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                askAi();
              }}
            >
              <input
                value={mood}
                onChange={(e) => setMood(e.target.value)}
                maxLength={100}
                placeholder="예: 해장하고 싶어, 가볍게 혼밥, 만원 이하"
                className="min-w-0 flex-1 rounded-xl bg-surface px-3.5 py-2.5 text-sm text-ink outline-none ring-1 ring-transparent placeholder:text-muted/70 focus:bg-white focus:ring-coral/50"
              />
              <button
                type="submit"
                disabled={status !== "ready" || restaurants.length === 0 || aiLoading}
                className="shrink-0 rounded-xl bg-coral px-4 text-sm font-semibold text-white shadow-[0_6px_16px_rgba(255,107,87,0.35)] transition hover:bg-coral-deep disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
              >
                {aiLoading ? "고르는 중…" : "추천받기"}
              </button>
            </form>

            {aiError && <p className="mt-3 text-xs text-coral-deep">{aiError}</p>}

            {ai && (
              <div className="mt-4 space-y-2">
                <p className="text-sm text-ink">{ai.summary}</p>
                <ol className="space-y-2">
                  {ai.picks.map((p, i) => {
                    const r = byId.get(p.id);
                    if (!r) return null;
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => select(p.id, "map")}
                          className="flex w-full items-start gap-3 rounded-xl bg-coral-soft/60 p-3 text-left transition hover:bg-coral-soft"
                        >
                          <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-coral text-xs font-bold text-white">
                            {i + 1}
                          </span>
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold text-ink">{r.name}</span>
                            <span className="block text-xs leading-relaxed text-muted">{p.reason}</span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
                <p className="text-right text-[10px] text-muted/70">{ai.model}</p>
              </div>
            )}
          </div>
          )}

          {/* List header: nearby / favorites tabs */}
          <div className="mb-3 flex items-end justify-between gap-3">
            <div className="min-w-0">
              <div role="tablist" aria-label="식당 목록" className="flex items-center gap-4">
                {(
                  [
                    ["nearby", "주변 식당", restaurants.length],
                    ["favorites", "즐겨찾기", favorites.length],
                  ] as const
                ).map(([key, label, count]) => {
                  const on = view === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => switchView(key)}
                      className={`relative flex items-center gap-1 pb-1 text-base font-bold transition ${
                        on ? "text-ink" : "text-muted/70 hover:text-muted"
                      }`}
                    >
                      {key === "favorites" && <HeartIcon filled={on} className="h-4 w-4 text-coral" />}
                      {label}
                      <span className={`text-xs font-semibold ${on ? "text-coral" : ""}`}>{count}</span>
                      {on && <span className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-coral" />}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-muted">
                {view === "nearby"
                  ? `${radiusLabel} · 반경 ${radius >= 1000 ? `${radius / 1000}km` : `${radius}m`}`
                  : "이 브라우저에 저장돼요 · 현재 위치에서 가까운 순 번호"}
              </p>
            </div>
            <div className="flex rounded-full bg-white p-1 ring-1 ring-line">
              {(
                [
                  ["distance", "거리순"],
                  ["rating", "평점순"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSort(key)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${
                    sort === key ? "bg-ink text-white" : "text-muted hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {view === "nearby" && status === "error" && (
            <p className="rounded-2xl bg-white p-4 text-sm text-coral-deep ring-1 ring-line">{error}</p>
          )}
          {view === "nearby" && status === "ready" && restaurants.length === 0 && (
            <p className="rounded-2xl bg-white p-6 text-center text-sm text-muted ring-1 ring-line">
              {radiusLabel} 거리 안에서 식당을 찾지 못했어요. 반경을 넓혀 보세요.
            </p>
          )}
          {view === "favorites" && favorites.length === 0 && (
            <div className="rounded-2xl bg-white px-6 py-10 text-center ring-1 ring-line">
              <HeartIcon filled={false} className="mx-auto mb-3 h-8 w-8 text-coral/50" />
              <p className="text-sm font-semibold text-ink">아직 즐겨찾기한 식당이 없어요</p>
              <p className="mt-1 text-xs text-muted">주변 식당 카드의 하트를 눌러 자주 가는 곳을 모아 보세요.</p>
              <button
                type="button"
                onClick={() => switchView("nearby")}
                className="mt-4 rounded-full bg-coral px-4 py-2 text-xs font-semibold text-white transition hover:bg-coral-deep"
              >
                주변 식당 보기
              </button>
            </div>
          )}
          {view === "nearby" && (status === "locating" || status === "searching") && restaurants.length === 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-[108px] animate-pulse rounded-2xl bg-white ring-1 ring-line" />
              ))}
            </div>
          )}

          <ul className="grid gap-3 md:grid-cols-2">
            {sorted.map((r) => (
              <li key={r.id}>
                <RestaurantCard
                  r={r}
                  active={r.id === selectedId}
                  aiRank={ai && view === "nearby" ? ai.picks.findIndex((p) => p.id === r.id) : -1}
                  favorite={isFavorite(r.id)}
                  onToggleFavorite={() => toggleFavorite(r)}
                  onSelect={() => select(r.id, "list")}
                  refCb={(el) => {
                    if (el) cardRefs.current.set(r.id, el);
                    else cardRefs.current.delete(r.id);
                  }}
                />
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

/**
 * Link to the restaurant's own Google Maps place page (pin + details).
 * Prefer the URI Places returns; otherwise build a Maps URL from the place ID.
 * https://developers.google.com/maps/documentation/urls/get-started#search-action
 */
function googleMapsLink(r: Restaurant): string {
  if (r.mapsUrl) return r.mapsUrl;
  const q = new URLSearchParams({ api: "1", query: r.name, query_place_id: r.id });
  return `https://www.google.com/maps/search/?${q}`;
}

function HeartIcon({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.6 4.5 7.1 4.5c2 0 3.6 1.1 4.9 2.8 1.3-1.7 2.9-2.8 4.9-2.8 3.5 0 5.7 3.5 4.4 6.8-1.8 4.6-9.3 9.2-9.3 9.2Z" />
    </svg>
  );
}

function RestaurantCard({
  r,
  active,
  aiRank,
  favorite,
  onToggleFavorite,
  onSelect,
  refCb,
}: {
  r: Restaurant;
  active: boolean;
  aiRank: number;
  favorite: boolean;
  onToggleFavorite: () => void;
  onSelect: () => void;
  refCb: (el: HTMLElement | null) => void;
}) {
  const steps = priceSteps(r.priceLevel);
  return (
    <article
      ref={refCb}
      onClick={onSelect}
      className={`group cursor-pointer rounded-2xl bg-white p-4 transition ${
        active
          ? "ring-2 ring-coral shadow-[0_10px_30px_rgba(255,107,87,0.18)]"
          : "ring-1 ring-line hover:-translate-y-0.5 hover:shadow-[0_10px_24px_rgba(20,20,30,0.07)]"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${
            active ? "bg-coral text-white" : "bg-surface text-ink"
          }`}
        >
          {r.no}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[15px] font-bold text-ink">{r.name}</h3>
            {aiRank >= 0 && (
              <span className="shrink-0 rounded-md bg-coral px-1.5 py-0.5 text-[10px] font-bold text-white">
                AI 추천 {aiRank + 1}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">{r.type}</p>

          <dl className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            <div className="flex items-center gap-1">
              <dt className="sr-only">거리</dt>
              <dd className="font-semibold text-ink">{formatDistance(r.distance)}</dd>
              <dd className="text-muted">· 도보 {walkMinutes(r.distance)}분</dd>
            </div>
            <div className="flex items-center gap-1">
              <dt className="sr-only">평점</dt>
              {r.rating != null ? (
                <>
                  <dd className="text-coral">★</dd>
                  <dd className="font-semibold text-ink">{r.rating.toFixed(1)}</dd>
                  <dd className="text-muted">({r.ratingCount.toLocaleString()})</dd>
                </>
              ) : (
                <dd className="text-muted">평점 없음</dd>
              )}
            </div>
            <div className="flex items-center gap-1">
              <dt className="sr-only">가격대</dt>
              {steps == null ? (
                <dd className="text-muted">가격 정보 없음</dd>
              ) : steps === 0 ? (
                <dd className="font-semibold text-ink">무료</dd>
              ) : (
                <dd className="font-semibold tracking-tight" title={PRICE_TEXT[r.priceLevel!]}>
                  <span className="text-ink">{"₩".repeat(steps)}</span>
                  <span className="text-line">{"₩".repeat(4 - steps)}</span>
                </dd>
              )}
            </div>
          </dl>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          aria-pressed={favorite}
          aria-label={favorite ? `${r.name} 즐겨찾기 해제` : `${r.name} 즐겨찾기 추가`}
          title={favorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
          className={`-m-1.5 grid h-9 w-9 shrink-0 place-items-center rounded-full transition active:scale-90 ${
            favorite ? "text-coral hover:bg-coral-soft" : "text-muted/60 hover:bg-surface hover:text-coral"
          }`}
        >
          <HeartIcon filled={favorite} className="h-5 w-5" />
        </button>
      </div>

      <a
        href={googleMapsLink(r)}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        aria-label={`${r.name} Google Maps에서 보기 (새 탭)`}
        className="mt-3 flex items-center justify-center gap-1.5 rounded-xl bg-surface py-2 text-xs font-semibold text-ink transition hover:bg-coral-soft hover:text-coral-deep"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-coral" fill="currentColor" aria-hidden>
          <path d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z" />
        </svg>
        Google Maps에서 보기
        <svg viewBox="0 0 24 24" className="h-3 w-3 text-muted" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M7 17 17 7M9 7h8v8" />
        </svg>
      </a>
    </article>
  );
}
