import {landingPageUrl} from './ad-links';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { searchPublicAds, useQuery } from "wasp/client/operations";
import {
  ArrowRight,
  Bookmark,
  BookOpen,
  Check,
  ChevronDown,
  FileText,
  Gamepad2,
  Info,
  RefreshCw,
  Search,
  ShoppingBag,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  canEdit,
  CommandButton,
  Empty,
  Field,
  Loading,
  Status,
  useApp,
  workspaceHref,
} from "./App";
import { HealthNotice, WorkspaceRequired } from "./WorkspacePages";
import { useWorkspaceLocale } from "./workspace-i18n/locale";
import type { AdView, MediaView, SearchFilters, SearchResult } from "./types";
import {
  adSearchParams,
  readAdSearchFilters,
  sourceDateLabel,
  startedDateRange,
} from "./ad-search-params";
import {
  advertiserName,
  createMediaRefreshGate,
  mediaUrl,
  previewMedia,
} from "./ad-media";
import { adContentState } from "../ads/content";
import { MediaPlayer } from "./AdMedia";
import { AdvertiserLogo, AdPlatformLogos, PlatformLogo } from "./AdIdentity";
export { MediaPlayer } from "./AdMedia";
import "./workspace-content.css";
import "./ads-library.css";
import "./ads-discovery.css";

const platforms = [
  ["facebook", "Facebook"],
  ["instagram", "Instagram"],
  ["google", "Google"],
  ["youtube", "YouTube"],
  ["tiktok", "TikTok"],
  ["pinterest", "Pinterest"],
  ["snapchat", "Snapchat"],
] as const;
const businesses = [
  ["ECOMMERCE", "ads.ecommerce", ShoppingBag],
  ["GAMES", "ads.library.games", Gamepad2],
  ["COMICS", "ads.library.comics", BookOpen],
  ["GENERAL", "ads.library.content", FileText],
] as const;
const formats = [
  ["", "ads.library.all"],
  ["TEXT", "ads.library.textAds"],
  ["IMAGE", "ads.library.imageAds"],
  ["VIDEO", "ads.library.videoAds"],
] as const;
const countries =
  "AE AR AT AU BE BG BR CA CH CL CN CO CZ DE DK EG ES FI FR GB GR HK HR HU ID IE IL IN IS IT JP KR LT LU LV MA MX MY NG NL NO NZ PE PH PK PL PT RO RS RU SA SE SG SK TH TR TW UA US VN ZA".split(
    " ",
  );
type SavedFilter = { label: string; query: string };

export function AdsPage() {
  const { state } = useApp();
  return state.selectedWorkspace ? (
    <AdsContent
      key={state.selectedWorkspace.id}
      workspaceId={state.selectedWorkspace.id}
    />
  ) : (
    <WorkspaceRequired />
  );
}

function AdsContent({ workspaceId }: { workspaceId: string }) {
  const { state } = useApp();
  const { locale, t, date, error } = useWorkspaceLocale();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const filters = readAdSearchFilters(params, workspaceId);
  const google = filters.source === "google";
  const query = useQuery(searchPublicAds, filters, {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const data = query.data as SearchResult | undefined;
  const filterKey = JSON.stringify(filters);
  const refreshMedia = useMemo(
    () =>
      createMediaRefreshGate(
        async () => (await query.refetch({ cancelRefetch: false })).isSuccess,
      ),
    [filterKey, query.refetch],
  );
  const [mobileFilters, setMobileFilters] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [excludeOpen, setExcludeOpen] = useState(Boolean(filters.exclude));
  const formRef = useRef<HTMLFormElement>(null);
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [notice, setNotice] = useState("");
  const storageKey = `adtrender:filters:${state.user?.id ?? workspaceId}:${workspaceId}`;
  useEffect(() => {
    setSaved([]);
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || "[]");
      if (Array.isArray(value))
        setSaved(
          value
            .filter(
              (v) =>
                typeof v?.label === "string" && typeof v?.query === "string",
            )
            .slice(0, 8),
        );
    } catch {}
  }, [storageKey]);
  const apply = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    next.delete("cursor");
    for (const [key, value] of Object.entries(changes))
      value ? next.set(key, value) : next.delete(key);
    next.set("workspace", workspaceId);
    next.set("lang", locale);
    setParams(next);
  };
  const choosePlatform = (platform: string) =>
    apply({
      platform,
      source: platform === "google" ? "google" : undefined,
      channel: undefined,
      media: platform === "google" ? "TEXT" : undefined,
      content: undefined,
    });
  const reset = () =>
    setParams({
      workspace: workspaceId,
      lang: locale,
      ...(google
        ? { source: "google", platform: "google", media: "TEXT" }
        : {}),
    });
  const save = () => {
    if (!formRef.current) return;
    const next = adSearchParams(
      new FormData(formRef.current),
      workspaceId,
      locale,
    );
    next.delete("workspace");
    next.delete("lang");
    const value = next.toString();
    const rows = [
      {
        label:
          next.get("q") ||
          `${google ? "Google" : t("ads.title")} · ${new Intl.DateTimeFormat(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date())}`,
        query: value,
      },
      ...saved.filter((row) => row.query !== value),
    ].slice(0, 8);
    try {
      localStorage.setItem(storageKey, JSON.stringify(rows));
      setSaved(rows);
      setNotice(t("ads.library.filterSaved"));
    } catch {
      setNotice(t("ads.library.filterSaveFailed"));
    }
  };
  const countryNames = new Intl.DisplayNames([locale], { type: "region" });
  const countryName = (code: string) => {
    try {
      return countryNames.of(code) || code;
    } catch {
      return code;
    }
  };
  const active = [
    "q",
    "business",
    "category",
    "platform",
    "domain",
    "channel",
    "country",
    "content",
    "from",
    "to",
    "exclude",
    "exact",
  ].filter((key) => params.get(key));
  const tagLabels: Record<string, string> = {
    q: t("ads.search"),
    business: t("ads.library.business"),
    category: t("ads.library.category"),
    platform: t("ads.platform"),
    domain: t("ads.library.domain"),
    channel: t("ads.library.channel"),
    country: t("ads.library.observedRegion"),
    content: t("ads.library.contentState"),
    from: t("ads.observedFrom"),
    to: t("ads.observedTo"),
    exclude: t("ads.library.exclude"),
    exact: t("ads.library.exact"),
  };
  const tagValue = (key: string) =>
    key === "business"
      ? t(
          businesses.find((row) => row[0] === params.get(key))?.[1] ||
            "ads.library.unclassified",
        )
      : key === "content"
        ? t(`ads.library.${params.get(key)}` as any)
        : key === "exact"
          ? t("ads.library.exact")
          : params.get(key);
  const number = (value?: number) =>
    value == null ? "—" : value.toLocaleString(locale);
  return (
    <div
      className={`ws-ads-page library-page${google ? " library-google" : ""}`}
    >
      <div className="library-title">
        <h1>{google ? t("ads.library.googleTitle") : t("ads.title")}</h1>
        <p>{t("ads.description")}</p>
      </div>
      <form
        ref={formRef}
        className={`search-form ws-search-form library-filters${mobileFilters ? " library-mobile-open" : ""}`}
        key={filterKey}
        onSubmit={(event) => {
          event.preventDefault();
          setParams(
            adSearchParams(
              new FormData(event.currentTarget),
              workspaceId,
              locale,
            ),
          );
        }}
      >
        {filters.source && (
          <input type="hidden" name="source" value={filters.source} />
        )}
        <input type="hidden" name="business" value={filters.business || ""} />
        <input
          type="hidden"
          name="media"
          value={filters.mediaType || (google ? "ALL" : "")}
        />
        <div className="library-search-modes">
          <span className="selected">{t("ads.library.infoSearch")}</span>
          <button type="button" disabled title={t("ads.library.comingSoon")}>
            {t("ads.library.featureSearch")}
          </button>
          <button type="button" disabled title={t("ads.library.comingSoon")}>
            {t("ads.library.visualSearch")}
          </button>
        </div>
        <div className="library-search-line">
          <span>
            {t("ads.library.infoSearch")}
            <ChevronDown size={13} />
          </span>
          <input
            aria-label={t("ads.searchLabel")}
            name="q"
            maxLength={200}
            defaultValue={filters.query}
            placeholder={t("ads.searchPlaceholder")}
          />
          <button className="button primary" type="submit">
            <Search size={14} />
            {t("ads.search")}
          </button>
          <button
            type="button"
            className="library-exclude"
            aria-expanded={excludeOpen}
            onClick={() => setExcludeOpen(!excludeOpen)}
          >
            {t("ads.library.exclude")}
          </button>
          <label className="library-check">
            <input
              type="checkbox"
              name="exact"
              value="true"
              defaultChecked={filters.exact}
            />
            {t("ads.library.exact")}
          </label>
        </div>
        <div className="library-filter-row library-common-row">
          <strong>{t("ads.library.common")}</strong>
          <div
            className="library-business"
            title={t("ads.library.seedClassification")}
          >
            <button
              type="button"
              aria-pressed={!filters.business}
              onClick={() =>
                apply({ business: undefined, category: undefined })
              }
            >
              {t("ads.library.all")}
            </button>
            {businesses.map(([value, key, Icon]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filters.business === value}
                onClick={() => apply({ business: value, category: undefined })}
              >
                <Icon size={15} />
                {t(key)}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={filters.business === "UNCLASSIFIED"}
              onClick={() =>
                apply({ business: "UNCLASSIFIED", category: undefined })
              }
            >
              {t("ads.library.unclassified")}
            </button>
          </div>
          <Field label={t("ads.library.observedTime")}>
            <input
              type="date"
              name="from"
              aria-label={t("ads.observedFrom")}
              defaultValue={filters.observedFrom}
              max={filters.observedTo}
            />
            <span className="library-range-arrow">→</span>
            <input
              type="date"
              name="to"
              aria-label={t("ads.observedTo")}
              defaultValue={filters.observedTo}
              min={filters.observedFrom}
            />
          </Field>
          <button
            type="button"
            className="text-button"
            onClick={() => {
              const range = startedDateRange(7);
              apply({ from: range.from, to: range.to });
            }}
          >
            {t("ads.last7Days")}
          </button>
        </div>
        <div className="library-filter-row library-category-row">
          <strong>{t("ads.library.category")}</strong>
          <button
            type="button"
            className="library-pill"
            aria-pressed={!filters.category}
            onClick={() => apply({ category: undefined })}
          >
            {t("ads.library.all")}
          </button>
          <select
            className="library-category"
            name="category"
            aria-label={t("ads.library.category")}
            defaultValue={filters.category || ""}
          >
            <option value="">{t("ads.allCategories")}</option>
            {Array.from(
              new Set([
                ...(data?.categoryOptions || []),
                ...(filters.category ? [filters.category] : []),
              ]),
            ).map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
          <span className="library-row-hint">
            {t("ads.library.seedClassification")}
          </span>
        </div>
        <div className="library-filter-row library-platform-row">
          <strong>{t("ads.library.networks")}</strong>
          <button
            type="button"
            className="library-pill"
            aria-pressed={!filters.platform}
            onClick={() => choosePlatform("")}
          >
            {t("ads.library.all")}
          </button>
          {platforms.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="library-pill"
              aria-pressed={filters.platform === value}
              onClick={() => choosePlatform(value)}
            >
              <PlatformLogo platform={value} decorative className="library-platform-icon" />
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="text-button library-mobile-filters"
          aria-expanded={mobileFilters}
          onClick={() => setMobileFilters(!mobileFilters)}
        >
          <SlidersHorizontal size={15} />
          {t(mobileFilters ? "ads.lessFilters" : "ads.moreFilters")}
        </button>
        <div className="library-filter-row library-main-fields">
          <strong>
            {google ? t("ads.library.googleFilters") : t("ads.library.basic")}
          </strong>
          <Field label={t("ads.advertiser")}>
            <input
              name="advertiser"
              maxLength={200}
              defaultValue={filters.advertiser}
              placeholder={t("ads.library.allAdvertisers")}
            />
          </Field>
          <Field label={t("ads.library.domain")}>
            <input
              name="domain"
              maxLength={253}
              defaultValue={filters.domain}
              placeholder={t("ads.library.domainPlaceholder")}
            />
          </Field>
          {google && (
            <Field label={t("ads.library.channel")}>
              <select name="channel" defaultValue={filters.channel || ""}>
                <option value="">{t("ads.library.all")}</option>
                <option value="SEARCH">{t("ads.library.searchChannel")}</option>
                <option value="YOUTUBE">YouTube</option>
                <option value="UNKNOWN">
                  {t("ads.library.unknownChannel")}
                </option>
              </select>
            </Field>
          )}
          <Field label={t("ads.library.observedRegion")}>
            <select name="country" defaultValue={filters.country || ""}>
              <option value="">{t("ads.countryFilterAll")}</option>
              {Array.from(
                new Set([
                  ...countries,
                  ...(filters.country && filters.country !== "ALL"
                    ? [filters.country]
                    : []),
                ]),
              ).map((code) => (
                <option key={code} value={code}>
                  {countryName(code)}
                </option>
              ))}
              <option value="ALL">{t("ads.globalQuery")}</option>
            </select>
          </Field>
          <Field label={t("ads.library.contentState")}>
            <select
              name="content"
              defaultValue={filters.contentStatus || "available"}
            >
              <option value="available">{t("ads.library.available")}</option>
              {(["parsed", "preview", "missing"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`ads.library.${value}`)}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            className="text-button library-more"
            aria-expanded={advanced}
            onClick={() => setAdvanced(!advanced)}
          >
            <SlidersHorizontal size={14} />
            {t(advanced ? "ads.lessFilters" : "ads.moreFilters")}
          </button>
        </div>
        <div className="library-advanced" hidden={!advanced}>
          <Field label={t("ads.platform")}>
            <select
              name="platform"
              defaultValue={filters.platform || ""}
              onChange={(event) => choosePlatform(event.target.value)}
            >
              <option value="">{t("ads.platformFilterAll")}</option>
              {[
                ["facebook", "Facebook"],
                ["instagram", "Instagram"],
                ["messenger", "Messenger"],
                ["audience_network", "Audience Network"],
                ["google", "Google"],
                ["youtube", "YouTube"],
                ["tiktok", "TikTok"],
                ["pinterest", "Pinterest"],
                ["snapchat", "Snapchat"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("ads.sourceStatus")}>
            <select name="status" defaultValue={filters.status || ""}>
              <option value="">{t("ads.statusFilterAll")}</option>
              <option value="ACTIVE">{t("ads.active")}</option>
              <option value="INACTIVE">{t("ads.inactive")}</option>
              <option value="UNKNOWN">{t("ads.unknown")}</option>
            </select>
          </Field>
          <Field label={t("ads.startedFrom")}>
            <input
              type="date"
              name="startedFrom"
              defaultValue={filters.startedFrom}
            />
          </Field>
          <Field label={t("ads.startedTo")}>
            <input
              type="date"
              name="startedTo"
              defaultValue={filters.startedTo}
            />
          </Field>
        </div>
        <div className="library-exclude-field" hidden={!excludeOpen}>
          <Field label={t("ads.library.exclude")}>
            <input
              name="exclude"
              maxLength={200}
              defaultValue={filters.exclude}
              placeholder={t("ads.library.excludeHint")}
            />
          </Field>
        </div>
        <div className="library-filter-row library-selected">
          <strong>{t("ads.library.selected")}</strong>
          <div className="library-tags">
            {active.length ? (
              active.map((key) => (
                <button
                  type="button"
                  key={key}
                  onClick={() =>
                    apply({
                      [key]: undefined,
                      ...(key === "platform"
                        ? { source: undefined, channel: undefined }
                        : {}),
                      ...(key === "business" ? { category: undefined } : {}),
                    })
                  }
                >
                  <span>
                    {tagLabels[key]}: {tagValue(key)}
                  </span>
                  <X size={12} />
                </button>
              ))
            ) : (
              <span className="muted">{t("ads.library.all")}</span>
            )}
          </div>
          <div className="library-filter-actions">
            <button type="button" className="button secondary" onClick={reset}>
              {t("ads.library.reset")}
            </button>
            <button type="button" className="button primary" onClick={save}>
              {t("ads.library.saveFilters")}
            </button>
            <select
              aria-label={t("ads.library.savedFilters")}
              value=""
              onChange={(event) => {
                const row = saved[Number(event.target.value)];
                if (!row) return;
                const safe = adSearchParams(
                  new FormData(formRef.current!),
                  workspaceId,
                  locale,
                );
                const old = new URLSearchParams(row.query);
                for (const key of [...safe.keys()])
                  if (key !== "workspace" && key !== "lang") safe.delete(key);
                for (const key of [
                  "q",
                  "platform",
                  "source",
                  "business",
                  "category",
                  "domain",
                  "channel",
                  "country",
                  "media",
                  "content",
                  "from",
                  "to",
                  "startedFrom",
                  "startedTo",
                  "status",
                  "exact",
                  "exclude",
                ]) {
                  const value = old.get(key);
                  if (value) safe.set(key, value);
                }
                setParams(safe);
              }}
            >
              <option value="">{t("ads.library.savedFilters")}</option>
              {saved.map((row, index) => (
                <option key={row.query} value={index}>
                  {row.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        {notice && (
          <p className="library-save-notice" role="status">
            {notice}
          </p>
        )}
        <div className="library-results-bar">
          <div
            className="library-format-tabs"
            role="group"
            aria-label={t("ads.mediaType")}
          >
            {formats.map(([value, key]) => (
              <button
                key={value}
                type="button"
                data-format={value || "ALL"}
                aria-pressed={
                  filters.contentStatus !== "missing" &&
                  (filters.mediaType || "") === value
                }
                onClick={() =>
                  apply({
                    media: value || (google ? "ALL" : undefined),
                    content: undefined,
                  })
                }
              >
                {t(key)}
              </button>
            ))}
            <button
              type="button"
              className="library-pending"
              aria-pressed={filters.contentStatus === "missing"}
              onClick={() =>
                apply({
                  content:
                    filters.contentStatus === "missing" ? undefined : "missing",
                  media:
                    filters.contentStatus === "missing"
                      ? google
                        ? "TEXT"
                        : undefined
                      : google
                        ? "ALL"
                        : undefined,
                })
              }
            >
              {t("ads.library.missing")}
            </button>
          </div>
          <div className="library-result-actions results-heading">
            <span>{t("ads.library.recent")}</span>
            <button
              type="button"
              className="text-button"
              title={t("ads.refreshMedia")}
              disabled={query.isFetching}
              onClick={() => void refreshMedia()}
            >
              <RefreshCw size={16} />
              <span className="sr-only">{t("ads.refreshMedia")}</span>
            </button>
          </div>
        </div>
      </form>
      {query.isLoading ? (
        <Loading label={t("ads.loading")} />
      ) : query.error || !data ? (
        <Empty
          title={t("ads.searchError")}
          action={
            <button
              className="button secondary"
              onClick={() => void query.refetch()}
            >
              {t("ads.retrySearch")}
            </button>
          }
        >
          {error(query.error)}
        </Empty>
      ) : (
        <>
          <div className="library-data-line">
            <span>
              {number(data.summary.total)} {t("ads.matches")}
            </span>
            <details className="ws-source-notes">
              <summary>
                <Info size={13} />
                {t("ads.library.sourceInfo")}
              </summary>
              <div>
                <HealthNotice health={data.sourceHealth} />
                <p>{t("ads.countryHint")}</p>
                <p>{t("ads.asOf", { date: date(data.summary.asOf, true) })}</p>
                <p>{t("ads.countNotes")}</p>
              </div>
            </details>
          </div>
          {data.ads.length ? (
            <div
              className={`ad-grid library-grid${filters.mediaType === "TEXT" ? " library-text-grid" : ""}`}
            >
              {data.ads.map((ad) => (
                <AdCard
                  key={ad.id}
                  ad={ad}
                  workspaceId={workspaceId}
                  returnTo={location.search}
                  mediaRevision={query.dataUpdatedAt}
                />
              ))}
            </div>
          ) : (
            <Empty
              title={t("ads.emptyTitle")}
              action={
                <button className="button secondary" onClick={reset}>
                  {t("ads.clearFilters")}
                </button>
              }
            >
              {t("ads.emptyBody")}
            </Empty>
          )}
          <div className="pagination">
            <span>{t("ads.paginationNote")}</span>
            {filters.cursor && (
              <button
                className="button secondary"
                onClick={() => apply({ cursor: undefined })}
              >
                {t("ads.firstPage")}
              </button>
            )}
            <button
              className="button secondary"
              disabled={query.isFetching || !data.nextCursor}
              onClick={() => {
                if (!data.nextCursor) return;
                const next = new URLSearchParams(params);
                next.set("cursor", data.nextCursor);
                setParams(next);
                window.scrollTo({ top: 0, behavior: "instant" });
              }}
            >
              {t("ads.nextPage")}
              <ArrowRight size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function AdCard({
  ad,
  workspaceId,
  returnTo,
  mediaRevision,
}: {
  ad: AdView;
  workspaceId: string;
  returnTo: string;
  mediaRevision: number;
}) {
  const { state } = useApp();
  const { t, href, date, locale } = useWorkspaceLocale();
  const [failed, setFailed] = useState<string[]>([]);
  const sourceKey = (media: MediaView) =>
    `${media.id}:${media.displayUrl ?? ""}`;
  const onUnavailable = useCallback((media: MediaView) => {
    const key = sourceKey(media);
    setFailed((current) =>
      current.includes(key) ? current : [...current, key],
    );
  }, []);
  useEffect(() => setFailed([]), [mediaRevision]);
  const usable = ad.media?.filter(
    (media) => !failed.includes(sourceKey(media)),
  );
  const media = previewMedia(usable);
  const to = href(
    `${workspaceHref(`/app/ads/${encodeURIComponent(ad.id)}`, workspaceId)}&returnTo=${encodeURIComponent(returnTo)}`,
  );
  const name = advertiserName(ad.advertiserName);
  const landing = landingPageUrl(ad.landingPageUrl);
  const domain = landing
    ? new URL(landing).hostname.replace(/^www\./, "")
    : null;
  const text = ad.mediaType?.toUpperCase() === "TEXT";
  const hasCopy = [ad.headline, ad.copy, ad.description].some((value) =>
    Boolean(value?.trim()),
  );
  const content = adContentState({ ...ad, media: usable });
  const status = ad.status?.toUpperCase();
  const source = mediaUrl(ad.sourceUrl);
  const platform =
    ad.publisherPlatforms.join(" · ") || t("ads.library.unknownChannel");
  return (
    <article
      className={`ad-card library-card${text ? " library-text-card" : ""}`}
    >
      <header className="ws-card-header">
        <AdvertiserLogo name={name} url={ad.advertiserAvatarUrl} />
        <div className="ad-card-heading">
          <Link to={to}>
            {name ? (
              <h3>{name}</h3>
            ) : (
              <span>{t("ads.library.unknownChannel")}</span>
            )}
          </Link>
          {!text && (
            <span className="library-destination">
              {domain || t("ads.notProvided")}
            </span>
          )}
        </div>
        <AdPlatformLogos platforms={ad.publisherPlatforms} sourceKey={ad.dataSourceKey} unknownLabel={t("ads.library.unknownChannel")} />
        <CommandButton
          command={{ type: "SAVE_AD", workspaceId, adId: ad.id }}
          disabled={!canEdit(state) || ad.saved}
          className="text-button ws-card-save"
        >
          {ad.saved ? <Check size={17} /> : <Bookmark size={17} />}
          <span className="sr-only">
            {t(ad.saved ? "ads.saved" : "ads.save")}
          </span>
        </CommandButton>
      </header>
      {text ? (
        <div className="library-text-creative">
          {hasCopy ? (
            <div className="ad-card-text">
              <Link className="library-native-title" to={to}>
                {ad.headline || t("ads.library.noTitle")}
              </Link>
              {landing ? (
                <a
                  className="library-native-domain"
                  href={landing}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {domain}
                  <ArrowRight size={12} />
                </a>
              ) : (
                <span className="library-native-domain missing">
                  {t("ads.notProvided")}
                </span>
              )}
              <p>{ad.description || ad.copy}</p>
            </div>
          ) : media ? (
            <Link
              className="ad-card-media ad-card-original-preview"
              to={to}
              aria-label={
                name
                  ? t("ads.viewAd", { advertiser: name })
                  : t("ads.viewDetails")
              }
            >
              <MediaPlayer
                media={media}
                compact
                revision={mediaRevision}
                onUnavailable={onUnavailable}
              />
            </Link>
          ) : (
            <div className="library-copy-pending">
              <FileText size={22} />
              <span>{t("ads.library.pendingCopy")}</span>
            </div>
          )}
        </div>
      ) : (
        <>
          <Link
            className="ad-card-media library-media"
            to={to}
            aria-label={
              name
                ? t("ads.viewAd", { advertiser: name })
                : t("ads.viewDetails")
            }
          >
            <MediaPlayer
              media={media}
              compact
              revision={mediaRevision}
              onUnavailable={onUnavailable}
            />
            <span className="library-source-badge">
              <Status
                value={
                  status === "ACTIVE"
                    ? "active"
                    : status === "INACTIVE"
                      ? "inactive"
                      : "unknown"
                }
              />
            </span>
            {ad.sourceStartedAt && (
              <span className="library-source-date">
                {sourceDateLabel(ad.sourceStartedAt, locale, "—")}
              </span>
            )}
          </Link>
          <div className="ad-card-body">
            <p className="ad-copy excerpt">
              {ad.copy || ad.headline || t("ads.library.pendingCopy")}
            </p>
            <span className="library-destination">{platform}</span>
            <div className="library-card-facts">
              <div>
                <span>{t("ads.firstObserved")}</span>
                <strong>{date(ad.firstObservedAt)}</strong>
              </div>
              <div>
                <span>{t("ads.lastObserved")}</span>
                <strong>{date(ad.lastObservedAt)}</strong>
              </div>
              <div>
                <span>{t("ads.sourceStatus")}</span>
                <strong>
                  {t(
                    status === "ACTIVE"
                      ? "ads.active"
                      : status === "INACTIVE"
                        ? "ads.inactive"
                        : "ads.unknown",
                  )}
                </strong>
              </div>
            </div>
          </div>
        </>
      )}
      <footer className="library-card-footer">
        <span>{t(`ads.library.${content}`)}</span>
        {text && (
          <span>
            {t("ads.lastObserved")} {date(ad.lastObservedAt)}
          </span>
        )}
        {source ? (
          <a href={source} target="_blank" rel="noopener noreferrer">
            {t("ads.library.source")}
            <ArrowRight size={12} />
          </a>
        ) : (
          <Link to={to}>{t("ads.viewDetails")}</Link>
        )}
      </footer>
    </article>
  );
}
export { AdDetailPage } from "./AdDetailPage";
