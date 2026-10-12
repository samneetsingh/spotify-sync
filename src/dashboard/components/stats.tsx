// Stat tiles: a big number, its label, the change against the previous period, said in text
// ("↑ 12%", read as "up 12%"), never by colour alone, and a decorative icon square.

import { fmt } from "../../email/layout";
import { Icon, type IconName } from "./icons";

export interface Delta {
  dir: "up" | "down" | "same";
  /** "12%", "from 0", "Same". */
  text: string;
}

/** The change from `prev` to `cur` as a rounded percentage ("from 0" when there was nothing before). */
export function delta(cur: number, prev: number): Delta {
  if (cur === prev) return { dir: "same", text: "Same" };
  if (prev === 0) return { dir: "up", text: "from 0" };
  const change = Math.round(((cur - prev) / prev) * 100);
  if (change === 0) return { dir: "same", text: "Same" };
  return { dir: change > 0 ? "up" : "down", text: `${fmt(Math.abs(change))}%` };
}

const ARROW = { up: "↑", down: "↓", same: "=" } as const;
const SAID = { up: "up ", down: "down ", same: "" } as const;

export function DeltaText({ d }: { d: Delta }) {
  return (
    <span class={`delta delta-${d.dir}`}>
      <span aria-hidden="true">{ARROW[d.dir]} </span>
      <span class="vh">{SAID[d.dir]}</span>
      {d.text}
    </span>
  );
}

export interface StatTileProps {
  label: string;
  /** Already formatted, e.g. "1,204" or "4.2". */
  value: string;
  delta?: Delta;
  /** The icon in the tile's blue square (hidden from screen readers). */
  icon?: IconName;
}

/** One figure in a `.tiles` list: its label, the value, the delta, and an icon square on the right. */
export function StatTile({ label, value, delta: d, icon }: StatTileProps) {
  return (
    <div class="tile">
      <dt>{label}</dt>
      <dd class="tile-value num">{value}</dd>
      {d ? (
        <dd class="tile-delta">
          <DeltaText d={d} />
        </dd>
      ) : null}
      {icon ? (
        <dd class="tile-icon" aria-hidden="true">
          <Icon name={icon} />
        </dd>
      ) : null}
    </div>
  );
}
