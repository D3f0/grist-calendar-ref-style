# Calendar (reference styling) widget

A Grist custom calendar widget that draws its event colors and fonts from a
**Reference (foreign key) column** instead of a `Choice`/`ChoiceList` column.

The [official Grist calendar widget](https://github.com/gristlabs/grist-widget/tree/master/calendar)
maps a `type` column of type `Choice,ChoiceList` and reads the per-choice style out of that
column's `choiceOptions` (`fillColor`, `textColor`, `fontBold`, …). This variant maps a
`category` column of type `Ref,RefList`: the referenced row — in a separate categories table —
carries the style. Categories then live in their own table and are reusable.

Everything else (timezone/date math, event create/update/delete, selection highlight,
cursor linking, day/week/month views) matches the official widget.

## Column mapping

| Mapping      | Type           | Required | Purpose                                                      |
|--------------|----------------|----------|--------------------------------------------------------------|
| `startDate`  | `Date,DateTime`| yes      | event start                                                  |
| `endDate`    | `Date,DateTime`| no       | event end (defaults to start)                                |
| `isAllDay`   | `Bool`         | no       | all-day flag                                                 |
| `title`      | `Text`         | yes      | event title                                                  |
| `category`   | `Ref,RefList`  | no       | foreign key to the row that carries the event style          |
| `background` | `Text`         | no       | per-event CSS background / shade; **overrides** the category |
| `image`      | `Text`         | no       | per-event image URL (background); **overrides** the category |

For a `RefList`, the first referenced row provides the style. `background` and
`image` resolve from the event's own column when set, otherwise from the
category row (see below).

## How styling is resolved

1. The widget reads the `category` column's type from Grist metadata to find the referenced
   table (`Ref:<Table>` / `RefList:<Table>`). This needs **full access**.
2. It fetches that table and builds a `rowId → style` map.
3. Each event takes the style of its referenced category row.

### Style columns on the referenced table

The referenced table supplies style through its own columns. Column IDs are auto-detected by
name (first match wins); defaults can be overridden in the widget's **⚙ Style settings** panel.

| Attribute      | Auto-detected column IDs                                             | Cell value              |
|----------------|---------------------------------------------------------------------|-------------------------|
| fill color     | `fillColor`, `backgroundColor`, `background`, `color`               | CSS color string        |
| text color     | `textColor`, `fontColor`                                            | CSS color string        |
| bold           | `fontBold`, `bold`                                                  | truthy (`Bool`)         |
| italic         | `fontItalic`, `italic`                                              | truthy (`Bool`)         |
| underline      | `fontUnderline`, `underline`                                        | truthy (`Bool`)         |
| strikethrough  | `fontStrikethrough`, `strikethrough`                               | truthy (`Bool`)         |
| emoji          | `emoji`, `icon`, `symbol`                                          | text, prefixed to title |
| background     | `backgroundShade`, `shade`, `gradient`                            | CSS background value    |
| image          | `image`, `picture`, `photo`, `imageUrl`                           | image URL (http/data)   |

The `emoji` value is prepended to the event label as plain text (a safe,
script-free way to tag a category); it is display-only and is never written
back into the Grist title when an event is edited.

`background` accepts any CSS background (e.g. `linear-gradient(135deg,#e3f2fd,#90caf9)`);
`image` takes an `http(s)`/`data:` URL rendered as the event's background behind a
legibility scrim (white text unless a text color is set). Both can be supplied once
on the category row, or mapped per event — the event's own value wins.

Example categories table:

| id | Name    | fillColor | textColor | fontBold | emoji |
|----|---------|-----------|-----------|----------|-------|
| 1  | Work    | `#4287f5` | `#ffffff` | true     | 🔵    |
| 2  | Personal| `#16b378` | `#ffffff` | false    | 🟢    |

An event whose `category` references row `1` renders blue with white bold text,
labeled `🔵 <title>`.

Overrides are persisted per widget via `grist.setOption('styleColumns', …)`.

## Try it

```sh
cd demo && docker compose up -d   # Grist on :8484, widget on :8788
```
Then add a Custom widget in Grist pointing at `http://localhost:8788/index.html`.
Full walkthrough: [`demo/README.md`](demo/README.md).

## Host on GitHub Pages

The widget is plain static files, so GitHub Pages can serve it as the public
widget URL (no `localhost`). The workflow
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes it:

1. Push this repo to GitHub.
2. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
3. The workflow copies `src/` to the Pages site root and generates `manifest.json`,
   replacing the `__PAGES_BASE__` token with your real Pages URL.

Then wire Grist to it either way:

- Gallery: set `GRIST_WIDGET_LIST_URL=https://<owner>.github.io/<repo>/manifest.json`
  and pick **Calendar (reference styling)** from the custom-widget list.
- Custom URL: add a Custom widget with `https://<owner>.github.io/<repo>/index.html`.

For manual hosting without the workflow, edit `__PAGES_BASE__` in `manifest.json`
to your host's base URL.

## Files

```
widget.json        manifest (schemaVersion 1); maps category as Ref,RefList, accessLevel "full"
manifest.json      Grist widget-list entry for GRIST_WIDGET_LIST_URL (uses __PAGES_BASE__)
src/index.html     entrypoint; loads ToastUI Calendar + grist-plugin-api
src/widget.js      calendar logic + foreign-key style resolver
src/style.css      toolbar / settings-panel styles
demo/compose.yml   pinned Grist + static widget server for a local try
.github/workflows/pages.yml   GitHub Pages deploy (fills __PAGES_BASE__ at build)
```

## Access level

`accessLevel` is `full`: resolving the referenced table requires reading Grist metadata tables
(`_grist_Tables`, `_grist_Tables_column`) and the categories table. Without full access the
calendar still renders, but events fall back to the default color.
