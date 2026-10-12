// TSX building blocks for dashboard views: Card, Facts, Pill, PostButton, LinkButton, Notice,
// Rows/Row and Chip, styled by the shared classes in styles/base.ts. JSX escapes text props;
// props typed `Child` take elements, or raw() for HTML that is already escaped.

import type { Child } from "hono/jsx";
import type { ButtonVariant, Notice as NoticeProps, Tone } from "../layout";

export type { NoticeProps };

export interface CardProps {
  title: string;
  /** The section's id; the <h2> gets `<id>-title` and labels the section. */
  id?: string;
  /** Next to the title, e.g. a Pill. */
  head?: Child;
  /** A row of buttons under the body. */
  actions?: Child;
  children?: Child;
}

/** A card: <section class="card"> with an <h2> title, the children, and an optional row of actions. */
export function Card({ title, id, head, actions, children }: CardProps) {
  const titleId = id ? `${id}-title` : undefined;
  return (
    <section class="card" id={id || undefined} aria-labelledby={titleId}>
      <div class="card-head">
        <h2 id={titleId}>{title}</h2>
        {head}
      </div>
      {children}
      {actions ? <div class="actions">{actions}</div> : null}
    </section>
  );
}

export interface FactsProps {
  /** Label/value pairs; a value is text or elements (links, pills, a muted <span class="sub">). */
  rows: Array<[label: string, value: Child]>;
}

/** Label/value rows (<dl class="facts">). */
export function Facts({ rows }: FactsProps) {
  return (
    <dl class="facts">
      {rows.map(([label, value]) => (
        <>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </>
      ))}
    </dl>
  );
}

export interface PillProps {
  tone: Tone;
  text: string;
}

/** A status pill. Its text carries the meaning; colour is never the only signal. */
export function Pill({ tone, text }: PillProps) {
  return <span class={`pill pill-${tone}`}>{text}</span>;
}

export interface PostButtonProps {
  action: string;
  label: string;
  /** Hidden inputs, name -> value. */
  fields?: Record<string, string>;
  variant?: ButtonVariant;
  small?: boolean;
  ariaLabel?: string;
}

/** A one-button POST form (state changes never happen on GET; the router checks Origin). */
export function PostButton({ action, label, fields = {}, variant = "secondary", small, ariaLabel }: PostButtonProps) {
  return (
    <form class="inline" method="post" action={action}>
      {Object.entries(fields).map(([name, value]) => (
        <input type="hidden" name={name} value={value} />
      ))}
      <button type="submit" class={`btn btn-${variant}${small ? " btn-small" : ""}`} aria-label={ariaLabel || undefined}>
        {label}
      </button>
    </form>
  );
}

export interface LinkButtonProps {
  href: string;
  label: string;
  variant?: ButtonVariant;
}

/** A link that looks like a button. */
export function LinkButton({ href, label, variant = "secondary" }: LinkButtonProps) {
  return (
    <a class={`btn btn-${variant}`} href={href}>
      {label}
    </a>
  );
}

/** A flash message: role=status (ok, warn) or role=alert (error). */
export function Notice({ kind, text }: NoticeProps) {
  return (
    <div class={`notice notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {text}
    </div>
  );
}

export interface RowsProps {
  /** Row elements. */
  children?: Child;
}

/** A list of rows (activity, playlists, problems). */
export function Rows({ children }: RowsProps) {
  return <ul class="rows">{children}</ul>;
}

export interface RowProps {
  /** On the right, e.g. a Pill. */
  side?: Child;
  /** Buttons under the main text. */
  actions?: Child;
  /** The main text (e.g. an <h3> and a <span class="meta">). */
  children?: Child;
}

/** A list row: the main text on the left, `side` on the right, `actions` under the text. */
export function Row({ side, actions, children }: RowProps) {
  return (
    <li>
      <div class="main">
        {children}
        {actions ? <div class="row-actions">{actions}</div> : null}
      </div>
      {side ? <div class="side">{side}</div> : null}
    </li>
  );
}

export interface ChipProps {
  tone: Tone;
  text: string;
  href: string;
}

/** A status chip that links to the details (e.g. Home's status -> /settings). Its text carries the meaning. */
export function Chip({ tone, text, href }: ChipProps) {
  return (
    <a class={`chip chip-${tone}`} href={href}>
      {text}
    </a>
  );
}
