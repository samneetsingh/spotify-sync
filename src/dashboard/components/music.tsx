// Home's music pieces: the vinyl hero, covers (with the apricot missing-art tile), track rows and
// artist avatars. Art URLs come from HomeData.art (absent or "" = the placeholder). Images sit next
// to their text, so their alt is empty.

import { trackUrl } from "../../email/layout";
import type { TrackItem } from "../home-data";
import { Meter } from "./charts";
import { playsText } from "./format";

/** The record from the digest emails (public/email/vinyl.png; bump ?v= when it changes). */
export const VINYL_SRC = "/email/vinyl.png?v=1";

/** A small decorative record: the missing-art mark and the empty-state icon. */
export function MiniVinyl({ class: cls = "mini-vinyl" }: { class?: string }) {
  return (
    <svg class={cls} viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      <circle class="mv-disc" cx="12" cy="12" r="11" />
      <circle class="mv-groove" cx="12" cy="12" r="8.5" />
      <circle class="mv-groove" cx="12" cy="12" r="6.5" />
      <circle class="mv-label" cx="12" cy="12" r="4" />
      <circle class="mv-hole" cx="12" cy="12" r="1" />
    </svg>
  );
}

export interface CoverProps {
  url?: string;
  /** Rendered size in px (the image's width and height). */
  size: number;
  /** Round (artists) instead of a rounded square (albums). */
  round?: boolean;
}

/**
 * Album or artist art, lazy-loaded; the apricot missing-art tile when there's none. The tile is the
 * cover's CSS background, so an image that fails to load (alt="", fixed size) shows the tile too.
 */
export function Cover({ url, size, round }: CoverProps) {
  const cls = `cover cover-${size}${round ? " round" : ""}`;
  if (url) return <img class={cls} src={url} width={size} height={size} loading="lazy" decoding="async" alt="" />;
  return <span class={`${cls} art-missing`} aria-hidden="true"></span>;
}

export interface VinylProps {
  /** The album cover shown through the label window; the apricot label when absent. */
  cover?: string;
}

/**
 * The hero record: the vinyl PNG over the cover, which shows through its see-through label window
 * (81px at 67.5, 59.5 on the 216px disc; the cover is a little larger, 86px at 65, 57, so no seam
 * shows). Positions are percentages, so it scales. One slow settle rotation on load, none when the
 * visitor prefers reduced motion. Decorative: the track's name is next to it.
 */
export function Vinyl({ cover }: VinylProps) {
  return (
    <div class="vinyl" aria-hidden="true">
      <div class="vinyl-spin">
        {cover ? <img class="vinyl-cover" src={cover} width="86" height="86" alt="" decoding="async" /> : <span class="vinyl-cover vinyl-blank"></span>}
        <img class="vinyl-disc" src={VINYL_SRC} width="216" height="216" alt="" />
      </div>
    </div>
  );
}

export interface TrackRowProps {
  rank: number;
  track: TrackItem;
  art?: string;
  /** The top count in the list (the meter's full length). */
  max: number;
}

/** A ranked track: rank, cover, title (a Spotify link), artists, and a meter with the play count. */
export function TrackRow({ rank, track, art, max }: TrackRowProps) {
  return (
    <li class="track">
      <span class="track-rank num" aria-hidden="true">
        {rank}
      </span>
      <Cover url={art || undefined} size={48} />
      <div class="track-text">
        <a class="track-name" href={trackUrl(track.id)}>
          <span class="vh">{rank}. </span>
          {track.name}
        </a>
        <span class="track-artist">{track.artists}</span>
        <div class="track-meter">
          <Meter value={track.plays} max={max} />
          <span class="track-plays num">{playsText(track.plays)}</span>
        </div>
      </div>
    </li>
  );
}

export interface ArtistAvatarProps {
  name: string;
  url?: string;
  size?: 40 | 56 | 72;
}

/** A round artist photo, or their initial on a raised disc when there's no photo. */
export function ArtistAvatar({ name, url, size = 40 }: ArtistAvatarProps) {
  if (url) return <img class={`avatar cover-${size}`} src={url} width={size} height={size} loading="lazy" decoding="async" alt="" />;
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span class={`avatar avatar-blank cover-${size}`} aria-hidden="true">
      {initial}
    </span>
  );
}
