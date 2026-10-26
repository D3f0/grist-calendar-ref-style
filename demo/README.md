# Try the widget in Docker

Runs a pinned Grist (`1.7.19`) plus a static server for the widget, so you can
exercise reference-based event styling end-to-end.

## Start

```sh
cd widgets/calendar-ref-style/demo
docker compose up -d
```

- Grist: <http://localhost:8484>
- Widget URL (used below): `http://localhost:8788/index.html`

Wait until `docker compose ps` shows the `grist` service `healthy` (a few seconds).

The first-run boot/setup wizard is skipped (`GRIST_IN_SERVICE=true`), so the home
screen opens immediately. You can work on a throwaway document as the anonymous
user, or click **Sign in** (dev login) as `you@example.com` for a document that
persists in the `grist-data` volume.

> Needs internet from your browser: the widget loads ToastUI Calendar and the
> Grist Plugin API from CDNs. Fully offline? See [Offline](#offline).

## Build the data

1. **Create a document** → open it.
2. **Categories table** (the foreign-key target that carries style). Create a
   table `Categories` with columns:
   - `Name` — Text
   - `fillColor` — Text
   - `textColor` — Text
   - `fontBold` — Toggle
   - `emoji` — Text

   Add rows:

   | Name     | fillColor | textColor | fontBold | emoji |
   |----------|-----------|-----------|----------|-------|
   | Work     | `#4287f5` | `#ffffff` | ✓        | 🔵    |
   | Personal | `#16b378` | `#ffffff` |          | 🟢    |

3. **Events table.** Create a table `Events` with columns:
   - `Title` — Text
   - `Start` — Date/Time
   - `End` — Date/Time
   - `Category` — **Reference** → `Categories` (show column `Name`)

   Add a few events with a `Start`, `End`, and a `Category`.

## Add the widget

1. In the `Events` view, click **Add New → Add Widget to Page**.
2. Choose **Custom**, pick the **Events** table as the data, click **Add Widget**.
3. In the creator panel (right), under **Custom** choose **Custom URL** and enter:

   ```
   http://localhost:8788/index.html
   ```

4. When asked, grant **Full document access** (needed to read the referenced
   `Categories` table and column metadata). See [Why full access](../README.md#access-level).
5. Map the columns:
   - Start Date → `Start`
   - End Date → `End`
   - Title → `Title`
   - Category → `Category`

Events now render in the color of their referenced `Categories` row: blue/bold
for *Work*, green for *Personal*. Change a row's `Category` and the event
recolors. Edit `fillColor` in `Categories` and every event of that category
updates.

If your category table uses different column names, open the widget's **⚙**
panel and enter the exact column IDs for fill/text/bold/italic/underline/strike.

## Stop

```sh
docker compose down -v      # -v also deletes the grist-data volume
```

## Offline

The committed `src/index.html` loads the Plugin API from `docs.getgrist.com`.
This Grist serves a version-matched copy at `http://localhost:8484/grist-plugin-api.js`;
point the widget's first `<script src=...>` there to run without reaching
`docs.getgrist.com`. ToastUI Calendar assets would still need a local mirror.

## Notes

- `GRIST_SANDBOX_FLAVOR=unsandboxed` is for this laptop demo only; a shared
  server MUST sandbox formulas (`gvisor`).
- The widget is served on a different port (origin) than Grist, so it is a
  cross-origin custom widget and is not blocked by Grist's same-origin rule.
- Image pinned by digest to match the mcp-gryster compatibility matrix.
