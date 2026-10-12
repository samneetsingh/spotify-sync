// The dashboard's one stylesheet, inlined by renderPage in a <style nonce> element. Split by page group so
// parts can change independently; base comes first, so later parts can override it.

import { BASE_CSS } from "./base";
import { HOME_CSS } from "./home";
import { IMPORT_CSS } from "./import";
import { PAGES_CSS } from "./pages";

export const CSS = BASE_CSS + HOME_CSS + PAGES_CSS + IMPORT_CSS;
