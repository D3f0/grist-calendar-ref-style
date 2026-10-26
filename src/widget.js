// Calendar widget whose event style comes from a Reference (foreign key) column.
//
// The official Grist calendar widget styles events from a `Choice`/`ChoiceList`
// column, reading colors out of that column's `choiceOptions`. This widget maps a
// `Ref`/`RefList` column instead: the referenced row (in another table) carries the
// style, so categories live in their own table and can be reused across documents.
//
// Timezone/date math, event rendering, selection highlighting, and CRUD mirror the
// official widget. The styling source is the only behavioral change.

let calendarHandler;

const CALENDAR_NAME = 'refStyleCalendar';

const urlParams = new URLSearchParams(window.location.search);
const isReadOnly = urlParams.get('readonly') === 'true' ||
  (urlParams.has('access') && urlParams.get('access') !== 'full');
const docTimeZone = urlParams.get('timeZone');

// Capture ToastUI's TZDate constructor once the calendar is built.
let TZDate = null;

// Expose a few variables for tests/harness.
window.gristCalendar = {calendarHandler, CALENDAR_NAME, dataVersion: Date.now()};

// Initial-view linking logic, same approach as the official widget.
let isInitialLoad = true;
let linkingResolved = false;
let linkingInfo;
let pendingInitialRecord = null;

// Last payload seen, so we can re-render after style-option or mapping changes.
let lastRecords = null;
let lastMappings = null;

// Style-column overrides, persisted in widget options under `styleColumns`.
let styleOverrides = {};

function isDrivenByLink() {
  return !linkingInfo || linkingInfo.asTarget !== null;
}

function ready(fn) {
  if (document.readyState !== 'loading') { fn(); }
  else { document.addEventListener('DOMContentLoaded', fn); }
}

function isRecordValid(record) {
  const hasStartDate = record.startDate instanceof Date;
  const maybeHasEndDate = record.endDate === undefined || record.endDate === null ||
    record.endDate instanceof Date;
  const hasTitle = typeof record.title === 'string';
  const maybeHasIsAllDay = record.isAllDay === undefined || typeof record.isAllDay === 'boolean';
  return hasStartDate && maybeHasEndDate && hasTitle && maybeHasIsAllDay;
}

function getMonthName() {
  return calendarHandler.calendar.getDate().toDate()
    .toLocaleString(navigator.language || 'en', {month: 'long', year: 'numeric'});
}

function getFirstDayOfWeek() {
  try {
    const locale = new Intl.Locale(urlParams.get('culture') ?? navigator.language ?? 'en');
    const weekInfo = locale.getWeekInfo?.() ?? locale.weekInfo;
    if (weekInfo?.firstDay !== undefined) {
      return weekInfo.firstDay === 7 ? 0 : weekInfo.firstDay;
    }
  } catch (e) { /* Intl week info unsupported */ }
  return 0;
}

class CalendarHandler {
  _mainColor = 'var(--grist-theme-input-readonly-border, #CDD0D7)';
  _calendarBackgroundColor = 'var(--grist-theme-page-panels-main-panel-bg, #FFFFFF)';
  _selectedColor = 'var(--grist-theme-top-bar-button-primary-fg, #FFFFFF)';
  _borderStyle = '1px solid var(--grist-theme-table-body-border, #E8E8E8)';
  _accentColor = 'var(--grist-theme-accent-text, #16B378)';
  _textColor = 'var(--grist-theme-text, #262633)';
  _selectionColor = 'var(--grist-theme-selection, rgba(22,179,120,0.15))';

  _calendarTheme() {
    return {
      common: {
        backgroundColor: this._calendarBackgroundColor,
        border: this._borderStyle,
        holiday: {color: this._textColor},
        gridSelection: {
          backgroundColor: this._selectionColor,
          border: `1px solid ${this._selectionColor}`,
        },
        dayName: {color: this._textColor},
        today: {color: this._textColor},
        saturday: {color: this._textColor},
      },
      week: {
        timeGrid: {borderRight: this._borderStyle},
        timeGridLeft: {borderRight: this._borderStyle},
        panelResizer: {border: this._borderStyle},
        dayName: {borderBottom: this._borderStyle, borderTop: this._borderStyle},
        dayGrid: {borderRight: this._borderStyle},
        dayGridLeft: {borderRight: this._borderStyle},
        timeGridHourLine: {borderBottom: this._borderStyle},
        gridSelection: this._accentColor,
        pastTime: {color: this._textColor},
        futureTime: {color: this._textColor},
        today: {color: this._textColor, backgroundColor: 'inherit'},
      },
      month: {
        dayName: {borderLeft: this._borderStyle, backgroundColor: 'inherit'},
        dayExceptThisMonth: {color: this._textColor},
        holidayExceptThisMonth: {color: this._textColor},
      },
    };
  }

  _getCalendarOptions() {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return {
      week: {taskView: false, startDayOfWeek: getFirstDayOfWeek(), dayNames},
      month: {startDayOfWeek: getFirstDayOfWeek(), dayNames},
      usageStatistics: false,
      theme: this._calendarTheme(),
      defaultView: 'week',
      isReadOnly,
      template: {
        time(event) {
          const emoji = event.raw?.emoji ? event.raw.emoji + ' ' : '';
          const sanitized = String(emoji + event.title).replaceAll('"', '&quot;').trim();
          return `<span title="${sanitized}">${emoji}${event.title}</span>`;
        },
        allday(event) {
          const emoji = event.raw?.emoji ? event.raw.emoji + ' ' : '';
          const sanitized = String(emoji + event.title).replaceAll('"', '&quot;').trim();
          return `<span title="${sanitized}">${emoji}${event.title}</span>`;
        },
      },
      calendars: [{
        id: CALENDAR_NAME,
        name: 'Events',
        backgroundColor: this._mainColor,
        color: this._textColor,
        borderColor: this._mainColor,
      }],
      useFormPopup: !isReadOnly,
      useDetailPopup: false,
      gridSelection: {enableDblClick: true, enableClick: false},
    };
  }

  constructor() {
    const container = document.getElementById('calendar');
    if (isReadOnly) { container.classList.add('readonly'); }
    this.calendar = new tui.Calendar(container, this._getCalendarOptions());
    TZDate = this.calendar.getDate().constructor;

    this.calendar.on('clickEvent', async (info) => {
      focusWidget();
      await grist.setCursorPos({rowId: info.event.id});
    });
    this.calendar.on('selectDateTime', () => {
      this.calendar.clearGridSelections();
      setTimeout(() => container.querySelector('input[name=title]')?.focus(), 0);
    });
    this.calendar.on('beforeCreateEvent', (eventInfo) => upsertEvent(eventInfo));
    this.calendar.on('beforeUpdateEvent', (update) => upsertEvent({id: update.event.id, ...update.changes}));
    this.calendar.on('beforeDeleteEvent', (eventInfo) => deleteEvent(eventInfo));

    container.addEventListener('mousedown', () => {
      focusWidget();
      this.calendar.clearGridSelections();
    });
    container.addEventListener('mouseup', () => {
      setTimeout(() => {
        if (this.calendar.getStoreState('dnd').draggingState !== 0) {
          this.calendar.getStoreDispatchers('dnd').cancelDrag();
        }
      }, 0);
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        this.calendar.getStoreDispatchers('popup').hideFormPopup();
        this.calendar.getStoreDispatchers('popup').hideDetailPopup();
      } else if (ev.key === 'Enter') {
        container.querySelector('button.toastui-calendar-edit-button')?.click();
        container.querySelector('button.toastui-calendar-popup-confirm')?.click();
      }
    });

    this._allEvents = new Map();
    this._visibleEventIds = new Set();
  }

  _isMultidayInMonthViewEvent(rec) {
    const start = rec.start.toDate();
    const end = rec.end.toDate();
    const isMonthView = this.calendar.getViewName() === 'month';
    const isMultiDay = start.getDate() !== end.getDate() ||
      start.getMonth() !== end.getMonth() ||
      start.getFullYear() !== end.getFullYear();
    return isMonthView && !isMultiDay;
  }

  // Builds a ToastUI event from a mapped Grist record, using the foreign-key style map.
  buildEvent(record, startType, endType, styleMap) {
    let {startDate: start, endDate: end, isAllDay: isAllday} = record;
    endType = endType || startType;
    start = getAdjustedDate(start, startType);
    end = end ? getAdjustedDate(end, endType) : start;
    if (end < start) { end = start; }
    if (startType === 'Date' && endType === 'Date') { isAllday = true; }
    if (!isAllday && end.valueOf() === start.valueOf() && isZeroTime(end) && isZeroTime(start)) {
      end = new TZDate(end).addHours(1);
    }

    // Resolve style from the referenced (foreign-key) row instead of a Choice column.
    const ref = firstRef(record.category);
    const style = (ref != null) ? styleMap.get(ref) : null;
    // Background shade / image: the event's own mapped value wins over the
    // category's. An image is rendered as the event's background with a
    // legibility scrim; a background is any CSS background value (e.g. gradient).
    const bgCss = firstText(record.background) ?? style?.background;
    const imageUrl = firstText(record.image) ?? style?.image;
    const hasImage = typeof imageUrl === 'string' && /^(https?:|data:)/i.test(imageUrl);

    // Colors paint the event; the emoji is display-only (see the title template)
    // so editing an event never writes the emoji back into the Grist title.
    const textColor = style?.textColor ?? (hasImage ? '#ffffff' : undefined);
    const colorRaw = clean({backgroundColor: style?.fillColor, color: textColor});
    const emoji = style?.emoji;
    const fontWeight = style?.fontBold ? '800' : 'normal';
    const fontStyle = style?.fontItalic ? 'italic' : 'normal';
    let textDecoration = style?.fontUnderline ? 'underline' : 'none';
    if (style?.fontStrikethrough) {
      textDecoration = textDecoration === 'underline' ? 'line-through underline' : 'line-through';
    }

    const bgStyle = {};
    if (hasImage) {
      const safe = imageUrl.replace(/["\\]/g, '');  // guard the url("...") literal
      bgStyle.backgroundImage =
        `linear-gradient(rgba(0,0,0,0.35), rgba(0,0,0,0.35)), url("${safe}")`;
      bgStyle.backgroundSize = 'cover';
      bgStyle.backgroundPosition = 'center';
      bgStyle.backgroundRepeat = 'no-repeat';
    } else if (typeof bgCss === 'string' && bgCss) {
      bgStyle.background = bgCss;
    }

    return {
      id: record.id,
      calendarId: CALENDAR_NAME,
      title: record.title,
      start,
      end,
      isAllday,
      category: 'time',
      state: 'Free',
      color: this._textColor,
      backgroundColor: this._mainColor,
      dragBackgroundColor: 'var(--grist-theme-hover, rgba(0,0,0,0.08))',
      raw: {...colorRaw, emoji},  // colors for highlight revert + display-only emoji
      ...colorRaw,                // paint the event (colors only)
      borderColor: colorRaw.backgroundColor,
      customStyle: {fontStyle, fontWeight, textDecoration, textWrap: 'auto', ...bgStyle},
    };
  }

  async selectRecord(record, navigate = true) {
    if (!isRecordValid(record) || this._selectedRecordId === record.id) { return; }
    if (this._selectedRecordId) { this._clearHighlightEvent(this._selectedRecordId); }
    this._selectedRecordId = record.id;
    if (!navigate) { this.refreshSelectedRecord(); return; }

    const [startType] = await meta.getStartEndTypes();
    this.calendar.setDate(getAdjustedDate(record.startDate, startType));
    updateUIAfterNavigation();

    if (!record.isAllday && this.calendar.getViewName() !== 'month') {
      setTimeout(() => {
        const event = this.calendar.getElement(record.id, CALENDAR_NAME);
        if (!event) { return; }
        const scroller = event.closest('.toastui-calendar-time');
        if (!scroller) { return; }
        const top = scroller.scrollTop;
        const bottom = top + scroller.clientHeight;
        const eTop = event.offsetTop;
        const eBottom = eTop + event.clientHeight;
        if (!(eTop >= top && eBottom <= bottom)) { event.scrollIntoView({behavior: 'smooth'}); }
      }, 0);
    }
  }

  _highlightEvent(eventId) {
    const event = this.calendar.getEvent(eventId, CALENDAR_NAME);
    if (!event) { return; }
    const partToColor = this._isMultidayInMonthViewEvent(event) ? 'backgroundColor' : 'borderColor';
    this.calendar.updateEvent(eventId, CALENDAR_NAME, {
      borderColor: event.raw?.['backgroundColor'] ?? this._mainColor,
      backgroundColor: event.raw?.['backgroundColor'] ?? this._mainColor,
      [partToColor]: this._selectedColor,
    });
  }

  _clearHighlightEvent(eventId) {
    const event = this.calendar.getEvent(eventId, CALENDAR_NAME);
    if (!event) { return; }
    this.calendar.updateEvent(eventId, CALENDAR_NAME, {
      borderColor: event.raw?.['backgroundColor'] ?? this._mainColor,
      backgroundColor: event.raw?.['backgroundColor'] ?? this._mainColor,
    });
  }

  changeView(view) { this.calendar.changeView(view); updateUIAfterNavigation(); }
  calendarPrevious() { this.calendar.prev(); updateUIAfterNavigation(); }
  calendarNext() { this.calendar.next(); updateUIAfterNavigation(); }
  calendarToday() { this.calendar.today(); updateUIAfterNavigation(); }

  refreshSelectedRecord() {
    if (this._selectedRecordId) { this._highlightEvent(this._selectedRecordId); }
  }

  getEvents() { return this._allEvents; }
  setEvents(events) { this._allEvents = events; }

  renderVisibleEvents() {
    const newVisible = new Set();
    const rangeStart = this.calendar.getDateRangeStart();
    const rangeEnd = this.calendar.getDateRangeEnd().setHours(23, 99, 99, 999);
    for (const event of this._allEvents.values()) {
      const inRange =
        (event.start >= rangeStart && event.start <= rangeEnd) ||
        (event.end >= rangeStart && event.end <= rangeEnd) ||
        (event.start < rangeStart && event.end > rangeEnd);
      if (!inRange) { continue; }
      if (!this.calendar.getEvent(event.id, CALENDAR_NAME)) {
        this.calendar.createEvents([event]);
      } else {
        this.calendar.updateEvent(event.id, CALENDAR_NAME, event);
      }
      newVisible.add(event.id);
    }
    for (const eventId of this._visibleEventIds) {
      if (!newVisible.has(eventId)) { this.calendar.deleteEvent(eventId, CALENDAR_NAME); }
    }
    this._visibleEventIds = newVisible;
  }
}

// ---------------------------------------------------------------------------
// Foreign-key style resolution.
// ---------------------------------------------------------------------------

// Candidate column IDs for each style attribute in the referenced table.
const STYLE_CANDIDATES = {
  fill: ['fillColor', 'FillColor', 'backgroundColor', 'BackgroundColor', 'background', 'Background', 'color', 'Color'],
  text: ['textColor', 'TextColor', 'fontColor', 'FontColor'],
  bold: ['fontBold', 'FontBold', 'bold', 'Bold'],
  italic: ['fontItalic', 'FontItalic', 'italic', 'Italic'],
  underline: ['fontUnderline', 'FontUnderline', 'underline', 'Underline'],
  strike: ['fontStrikethrough', 'FontStrikethrough', 'strikethrough', 'Strikethrough'],
  emoji: ['emoji', 'Emoji', 'icon', 'Icon', 'symbol', 'Symbol'],
  background: ['backgroundShade', 'BackgroundShade', 'shade', 'Shade', 'backgroundCss', 'BackgroundCss', 'gradient', 'Gradient'],
  image: ['image', 'Image', 'imageUrl', 'ImageUrl', 'imageURL', 'picture', 'Picture', 'photo', 'Photo', 'backgroundImage', 'BackgroundImage'],
};

function pickCol(names, candidates, override) {
  if (override && names.includes(override)) { return override; }
  return candidates.find((c) => names.includes(c)) || null;
}

function normColor(v) {
  return (typeof v === 'string' && v.trim()) ? v.trim() : undefined;
}

// Builds a lookup from a referenced table's columnar data. Grist delivers a Ref
// cell as its *display value* (the visible column), not the rowId, so we key the
// map by both the rowId and the display-column value when known.
function buildStyleMap(data, overrides = {}, displayColId = null) {
  const names = Object.keys(data);
  const ids = data.id || [];
  const cols = {
    fill: pickCol(names, STYLE_CANDIDATES.fill, overrides.fill),
    text: pickCol(names, STYLE_CANDIDATES.text, overrides.text),
    bold: pickCol(names, STYLE_CANDIDATES.bold, overrides.bold),
    italic: pickCol(names, STYLE_CANDIDATES.italic, overrides.italic),
    underline: pickCol(names, STYLE_CANDIDATES.underline, overrides.underline),
    strike: pickCol(names, STYLE_CANDIDATES.strike, overrides.strike),
    emoji: pickCol(names, STYLE_CANDIDATES.emoji, overrides.emoji),
    background: pickCol(names, STYLE_CANDIDATES.background, overrides.background),
    image: pickCol(names, STYLE_CANDIDATES.image, overrides.image),
  };
  const display = (displayColId && data[displayColId]) ? data[displayColId] : null;
  const map = new Map();
  for (let i = 0; i < ids.length; i++) {
    const style = {
      fillColor: cols.fill ? normColor(data[cols.fill][i]) : undefined,
      textColor: cols.text ? normColor(data[cols.text][i]) : undefined,
      fontBold: cols.bold ? !!data[cols.bold][i] : false,
      fontItalic: cols.italic ? !!data[cols.italic][i] : false,
      fontUnderline: cols.underline ? !!data[cols.underline][i] : false,
      fontStrikethrough: cols.strike ? !!data[cols.strike][i] : false,
      emoji: cols.emoji ? normColor(data[cols.emoji][i]) : undefined,
      background: cols.background ? normColor(data[cols.background][i]) : undefined,
      image: cols.image ? normColor(data[cols.image][i]) : undefined,
    };
    map.set(ids[i], style);               // numeric rowId
    if (display) {
      const dv = display[i];
      if (dv != null && dv !== '') { map.set(dv, style); }  // display value
    }
  }
  return map;
}

// Grist delivers a Ref cell as a display value (or rowId), and a RefList as
// ['L', v1, v2, ...]. We style from the first referenced value.
function firstRef(v) {
  if (v == null || v === 0 || v === '') { return null; }
  if (Array.isArray(v)) {
    const items = v[0] === 'L' ? v.slice(1) : v;
    return items.length ? items[0] : null;
  }
  return v;
}

// Returns a trimmed non-empty string from a mapped cell (per-event background/image),
// or undefined so the category value is used as the fallback.
function firstText(v) {
  if (Array.isArray(v)) { v = v[0] === 'L' ? v[1] : v[0]; }
  return (typeof v === 'string' && v.trim()) ? v.trim() : undefined;
}

// Resolves a column reference (numeric colRef) to its colId, for finding the
// visible/display column of a Reference column.
async function colIdByRef(colRef) {
  if (!colRef) { return null; }
  const columns = await grist.docApi.fetchTable('_grist_Tables_column');
  const i = columns.id.indexOf(colRef);
  return i === -1 ? null : columns.colId[i];
}

// Fetches column records (from Grist metadata tables) for the given colIds.
async function fetchColRecords(tableId, colIds) {
  const tables = await grist.docApi.fetchTable('_grist_Tables');
  const columns = await grist.docApi.fetchTable('_grist_Tables_column');
  const fields = Object.keys(columns);
  const tableRef = tables.id[tables.tableId.indexOf(tableId)];
  const out = {};
  for (const colId of colIds) {
    if (!colId) { continue; }
    const index = columns.id.findIndex((id, i) => columns.parentId[i] === tableRef && columns.colId[i] === colId);
    out[colId] = index === -1 ? null : Object.fromEntries(fields.map((f) => [f, columns[f][index]]));
  }
  return out;
}

// Resolves start/end column types and the foreign-key referenced table's style map.
// Column-type and ref-table discovery need full access to metadata tables.
class MetaFetcher {
  constructor() {
    this._tableId = null;
    this._mappings = null;
    this._accessLevel = 'full';
    this._cols = null;
    this._colsKey = null;
  }
  setAccessLevel(a) { this._accessLevel = a; }
  setTableId(id) { if (this._tableId !== id) { this._tableId = id; this._cols = null; } }
  setMappings(m) { this._mappings = m; }

  // Resolve the selected table's ID via the Plugin API. This is robust to the
  // order in which onRecords/onOptions/message arrive; setTableId() is only a
  // fast-path hint.
  async _ensureTableId() {
    if (this._tableId) { return this._tableId; }
    try {
      const ops = grist.selectedTable ?? grist.getTable();
      this._tableId = await ops.getTableId();
    } catch (e) { /* leave null; styling falls back to default color */ }
    return this._tableId;
  }

  async _ensureCols() {
    await this._ensureTableId();
    if (this._accessLevel !== 'full' || !this._tableId || !this._mappings) { return null; }
    const m = this._mappings;
    const key = `${this._tableId}|${m.startDate}|${m.endDate}|${m.category}`;
    if (this._cols && this._colsKey === key) { return this._cols; }
    this._cols = await fetchColRecords(this._tableId, [m.startDate, m.endDate, m.category]);
    this._colsKey = key;
    return this._cols;
  }

  async getStartEndTypes() {
    const cols = await this._ensureCols();
    if (!cols) { return [null, null]; }
    const m = this._mappings;
    return [cols[m.startDate]?.type ?? null, cols[m.endDate]?.type ?? null];
  }

  // Returns a style lookup for the referenced table of the `category` column,
  // keyed by both rowId and the Reference's visible (display) column value.
  async getStyleMap(overrides) {
    const cols = await this._ensureCols();
    const catId = this._mappings?.category;
    if (!cols || !catId) { return new Map(); }
    const catRec = cols[catId];
    const type = catRec?.type || '';
    const match = /^Ref(?:List)?:(.+)$/.exec(type);
    if (!match) { return new Map(); }
    try {
      const displayColId = await colIdByRef(catRec.visibleCol);
      const data = await grist.docApi.fetchTable(match[1]);
      return buildStyleMap(data, overrides, displayColId);
    } catch (e) {
      return new Map();
    }
  }
}

const meta = new MetaFetcher();

// ---------------------------------------------------------------------------
// Grist wiring.
// ---------------------------------------------------------------------------

ready(async () => {
  calendarHandler = new CalendarHandler();
  window.gristCalendar.calendarHandler = calendarHandler;
  configureGristSettings();
});

function getGristOptions() {
  return [
    {name: 'startDate', title: 'Start Date', optional: false, type: 'Date,DateTime',
      description: 'starting point of event', allowMultiple: false, strictType: true},
    {name: 'endDate', title: 'End Date', optional: true, type: 'Date,DateTime',
      description: 'ending point of event', allowMultiple: false, strictType: true},
    {name: 'isAllDay', title: 'Is All Day', optional: true, type: 'Bool',
      description: 'is event all day long', strictType: true},
    {name: 'title', title: 'Title', optional: false, type: 'Text',
      description: 'title of event', allowMultiple: false},
    {name: 'category', title: 'Category', optional: true, type: 'Ref,RefList',
      description: 'foreign key to a table whose row carries the event style', allowMultiple: false},
    {name: 'background', title: 'Background', optional: true, type: 'Text',
      description: 'per-event CSS background / shade (e.g. a gradient); overrides the category', allowMultiple: false},
    {name: 'image', title: 'Image URL', optional: true, type: 'Text',
      description: 'per-event image URL shown as the event background; overrides the category', allowMultiple: false},
  ];
}

function configureGristSettings() {
  grist.onRecords(updateCalendar);
  grist.onRecord(gristSelectedRecordChanged);
  grist.onOptions(onGristSettingsChanged);
  grist.on('message', (e) => { if (e.tableId) { meta.setTableId(e.tableId); } });
  grist.enableKeyboardShortcuts?.();
  grist.ready({requiredAccess: 'full', columns: getGristOptions(), allowSelectBy: true});
}

function updateUIAfterNavigation() {
  calendarHandler.renderVisibleEvents();
  document.getElementById('calendar-title').innerText = getMonthName();
  calendarHandler.refreshSelectedRecord();
}

async function updateCalendar(records, mappings) {
  lastRecords = records;
  lastMappings = mappings;
  if (mappings) { meta.setMappings(mappings); }
  const mapped = grist.mapColumnNames(records, mappings);
  if (mapped) {
    const [startType, endType] = await meta.getStartEndTypes();
    const styleMap = await meta.getStyleMap(styleOverrides);
    const events = mapped
      .filter(isRecordValid)
      .map((r) => calendarHandler.buildEvent(r, startType, endType, styleMap));
    calendarHandler.setEvents(new Map(events.map((e) => [e.id, e])));
    updateUIAfterNavigation();
  }
  window.gristCalendar.dataVersion = Date.now();
}

function gristSelectedRecordChanged(record, mappings) {
  const mapped = grist.mapColumnNames(record, mappings);
  if (!mapped || !calendarHandler) { return; }
  if (isInitialLoad) {
    pendingInitialRecord = mapped;
    applyInitialView();
    return;
  }
  calendarHandler.selectRecord(mapped, isDrivenByLink());
}

function applyInitialView() {
  if (!isInitialLoad || !calendarHandler) { return; }
  if (!linkingResolved || !pendingInitialRecord) { return; }
  isInitialLoad = false;
  const record = pendingInitialRecord;
  pendingInitialRecord = null;
  const linked = isDrivenByLink();
  if (!linked) { calendarHandler.calendarToday(); }
  calendarHandler.selectRecord(record, linked);
}

function onGristSettingsChanged(options, settings) {
  changeCalendarView(options?.calendarViewPerspective ?? 'week');
  meta.setAccessLevel(settings.accessLevel);
  linkingInfo = settings?.linking;
  linkingResolved = true;

  styleOverrides = options?.styleColumns ?? {};
  loadSettingsForm(styleOverrides);
  // Re-render with the (possibly new) style overrides.
  if (lastRecords) { updateCalendar(lastRecords, lastMappings); }

  applyInitialView();
}

async function calendarViewChanges(radio) {
  changeCalendarView(radio.value);
  if (!isReadOnly) { await grist.setOption('calendarViewPerspective', radio.value); }
}

function changeCalendarView(view) {
  selectRadioButton(view);
  calendarHandler.changeView(view);
}

function selectRadioButton(value) {
  for (const el of document.getElementsByName('calendar-view')) {
    const active = el.value === value;
    el.checked = active;
    el.parentElement.classList.toggle('active', active);
  }
}

// ---------------------------------------------------------------------------
// Style-column settings panel.
// ---------------------------------------------------------------------------

function toggleSettings() {
  const panel = document.getElementById('settings-panel');
  panel.hidden = !panel.hidden;
}

function loadSettingsForm(overrides) {
  document.getElementById('opt-fill').value = overrides.fill ?? '';
  document.getElementById('opt-text').value = overrides.text ?? '';
  document.getElementById('opt-bold').value = overrides.bold ?? '';
  document.getElementById('opt-italic').value = overrides.italic ?? '';
  document.getElementById('opt-underline').value = overrides.underline ?? '';
  document.getElementById('opt-strike').value = overrides.strike ?? '';
  document.getElementById('opt-emoji').value = overrides.emoji ?? '';
  document.getElementById('opt-background').value = overrides.background ?? '';
  document.getElementById('opt-image').value = overrides.image ?? '';
}

async function saveSettings() {
  const next = clean({
    fill: document.getElementById('opt-fill').value.trim() || undefined,
    text: document.getElementById('opt-text').value.trim() || undefined,
    bold: document.getElementById('opt-bold').value.trim() || undefined,
    italic: document.getElementById('opt-italic').value.trim() || undefined,
    underline: document.getElementById('opt-underline').value.trim() || undefined,
    strike: document.getElementById('opt-strike').value.trim() || undefined,
    emoji: document.getElementById('opt-emoji').value.trim() || undefined,
    background: document.getElementById('opt-background').value.trim() || undefined,
    image: document.getElementById('opt-image').value.trim() || undefined,
  });
  styleOverrides = next;
  if (!isReadOnly) { await grist.setOption('styleColumns', next); }
  if (lastRecords) { await updateCalendar(lastRecords, lastMappings); }
  toggleSettings();
}

// ---------------------------------------------------------------------------
// Grist record read/write + timezone math (unchanged from the official widget).
// ---------------------------------------------------------------------------

async function upsertGristRecord(gristEvent) {
  try {
    const mapped = grist.mapColumnNamesBack(gristEvent);
    if (!mapped) { return; }
    delete mapped.id;
    const filtered = Object.fromEntries(Object.entries(mapped).filter(([, v]) => v !== undefined));
    if (Object.keys(filtered).length === 0) { return; }
    const table = await grist.getTable();
    if (gristEvent.id) {
      await table.update({id: gristEvent.id, fields: filtered});
    } else {
      const {id} = await table.create({id: gristEvent.id, fields: filtered});
      await grist.setCursorPos({rowId: id});
    }
  } catch (err) {
    console.error(err);
  }
}

const secondsPerDay = 24 * 60 * 60;

function makeGristDateTime(tzDate, colType) {
  let unixTime = Math.floor(tzDate.valueOf() / 1000);
  const localOffsetMin = -tzDate.getTimezoneOffset();
  const docOffsetMin = !docTimeZone ? localOffsetMin : tzDate.tz(docTimeZone).getTimezoneOffset();
  if (colType === 'Date') {
    const secondsSinceEpoch = unixTime + localOffsetMin * 60;
    return Math.floor(secondsSinceEpoch / secondsPerDay) * secondsPerDay;
  }
  unixTime += (localOffsetMin - docOffsetMin) * 60;
  return unixTime;
}

async function upsertEvent(tuiEvent) {
  const [startType, endType] = await meta.getStartEndTypes();
  const gristEvent = {
    id: tuiEvent.id,
    startDate: tuiEvent.start ? makeGristDateTime(tuiEvent.start, startType) : undefined,
    endDate: tuiEvent.end ? makeGristDateTime(tuiEvent.end, endType) : undefined,
    isAllDay: tuiEvent.isAllday !== undefined ? (tuiEvent.isAllday ? 1 : 0) : undefined,
    title: tuiEvent.title !== undefined ? (tuiEvent.title || 'New Event') : undefined,
  };
  upsertGristRecord(gristEvent);
}

async function deleteEvent(event) {
  try {
    const table = await grist.getTable();
    await table.destroy(event.id);
  } catch (e) {
    console.error(e);
  }
}

function getAdjustedDate(date, colType) {
  if (docTimeZone && docTimeZone !== date.timezone && String(colType).startsWith('DateTime')) {
    return new TZDate(date).tz(docTimeZone);
  }
  if (colType !== 'Date') { return date; }
  const ms = date.valueOf() + (date.getTimezoneOffset() * 60000);
  return new Date(ms);
}

function focusWidget() { window.focus(); }

function isZeroTime(date) {
  return date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

// HACK: show the Record Card popup on dblclick (detail popup is disabled above).
document.addEventListener('dblclick', async (ev) => {
  if (!ev.target || !calendarHandler?.calendar) { return; }
  const eventDom = ev.target.closest('[data-event-id]');
  if (!eventDom) { return; }
  const eventId = Number(eventDom.dataset.eventId);
  if (!eventId || Number.isNaN(eventId)) { return; }
  const event = calendarHandler.calendar.getEventModel(eventId, CALENDAR_NAME);
  if (!event) { return; }
  await grist.setCursorPos({rowId: event.id});
  await grist.commandApi?.run('viewAsCard');
});

// Exposed for the test harness.
window.gristCalendar.buildStyleMap = buildStyleMap;
window.gristCalendar.firstRef = firstRef;
