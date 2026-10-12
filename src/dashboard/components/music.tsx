// Home's music pieces: the hero cover, covers (with the navy missing-art tile), track rows and
// artist avatars. Art URLs come from HomeData.art (absent or "" = the placeholder). Images sit next
// to their text, so their alt is empty.

import { trackUrl } from "../../email/layout";
import type { TrackItem } from "../home-data";
import { Meter } from "./charts";
import { playsText } from "./format";

export interface CoverProps {
  url?: string;
  /** Rendered size in px (the image's width and height). */
  size: number;
  /** Round (artists) instead of a rounded square (albums). */
  round?: boolean;
}

/**
 * Album or artist art, lazy-loaded; the missing-art tile (a music note on navy) when there's none.
 * The tile is the cover's CSS background, so an image that fails to load (alt="", fixed size) shows
 * the tile too.
 */
export function Cover({ url, size, round }: CoverProps) {
  const cls = `cover cover-${size}${round ? " round" : ""}`;
  if (url) return <img class={cls} src={url} width={size} height={size} loading="lazy" decoding="async" alt="" />;
  return <span class={`${cls} art-missing`} aria-hidden="true"></span>;
}

export interface HeroCoverProps {
  /** The song's album cover; the missing-art tile (its CSS background) when absent. */
  cover?: string;
}

/** The hero's square album cover. Decorative: the track's name is next to it. */
export function HeroCover({ cover }: HeroCoverProps) {
  return (
    <div class="hero-cover" aria-hidden="true">
      {cover ? <img src={cover} width="280" height="280" alt="" decoding="async" /> : null}
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

/** A round artist photo, or their initial on a navy disc when there's no photo. */
export function ArtistAvatar({ name, url, size = 40 }: ArtistAvatarProps) {
  if (url) return <img class={`avatar cover-${size}`} src={url} width={size} height={size} loading="lazy" decoding="async" alt="" />;
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return (
    <span class={`avatar avatar-blank cover-${size}`} aria-hidden="true">
      {initial}
    </span>
  );
}
