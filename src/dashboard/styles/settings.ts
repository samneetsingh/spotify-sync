// The settings page's dashboard layout: problems (and the Spotify card while it needs the owner) on
// top, the everyday settings in a grid (Playlists two columns wide with its settings in two columns,
// Emails beside it), then a row of the rarer cards (General, Spotify, Account), then the save bar
// (shown by public/settings-form.js once something changed). Account's parts (History import,
// sign-in) are separated by a hairline. The cards' and fieldsets' own look is in base.ts.

export const SETTINGS_CSS = `
.dash{display:grid;gap:20px;margin:0 0 20px}
.dash>.card,.dash>fieldset{margin:0;min-width:0}
.savebar[hidden]{display:none}
.card-part+.card-part{margin-top:20px;padding-top:20px;border-top:1px solid rgba(255,255,255,.09)}
.part-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.part-head h3{margin:0}
.settings-list>.setting:first-child{border-top:0}
@media (min-width:900px){
.dash-top,.dash-more{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
}
@media (min-width:1024px){
.dash-form{grid-template-columns:repeat(3,minmax(0,1fr));align-items:start}
.dash-form>.group-playlists{grid-column:span 2}
.group-playlists .settings-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:32px}
.group-playlists .settings-list>.setting:nth-child(2){border-top:0}
}
`;
