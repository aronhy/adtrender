export type AdContentState = "parsed" | "preview" | "missing";
type Creative = {
  mediaType?: string | null;
  body?: string | null;
  copy?: string | null;
  headline?: string | null;
  description?: string | null;
  media?: Array<{ type: string; status: string }>;
};
/** Text screenshots are previews; missing visual assets never imply a text format. */
export function adContentState(ad: Creative): AdContentState {
  const text = [ad.body, ad.copy, ad.headline, ad.description].some(
    (value) => typeof value === "string" && Boolean(value.trim()),
  );
  const ready = (ad.media ?? []).some((media) =>
    ["READY", "CACHED"].includes(media.status),
  );
  if (text && (ad.mediaType?.toUpperCase() === "TEXT" || ready))
    return "parsed";
  return ready ? "preview" : "missing";
}
