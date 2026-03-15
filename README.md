# MMM-ECWeatherAlerts

Environment Canada weather alerts for [MagicMirror²](https://magicmirror.builders/).

Displays active weather warnings, watches, advisories, and statements from Environment Canada's free public [CAP](https://eccc-msc.github.io/open-data/msc-data/alerts/readme_en/) (Common Alerting Protocol) data feed. No API key required.

## Features

- **3-tier colour system** matching EC's official classification:
  - 🔴 **Red** — Very dangerous, possibly life-threatening
  - 🟠 **Orange** — Severe, significant damage likely
  - 🟡 **Yellow** — Hazardous, moderate/localized impacts
- Extracts the "What:" section from EC descriptions for concise display
- Multiple simultaneous alerts combined into one compact bar
- Auto-hides when no active alerts
- Configurable alert types (warnings only, or include watches/statements)
- No API key needed — uses EC's free public data servers

## Screenshot

When a weather warning is active:

```
⚠ Winter Storm Warning
Total snowfall and ice pellet accumulations of 10 to 20 cm...
[WARNING]                          Mar 15, 10:00 AM – 1:46 PM
```

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/MrRonco/MMM-ECWeatherAlerts.git
```

No `npm install` needed — this module has no dependencies.

## Configuration

Add to your `config/config.js`:

```js
{
  module: "MMM-ECWeatherAlerts",
  position: "top_bar",
  config: {
    area: "Sudbury",        // Your EC forecast area name
    office: "CWTO"          // EC issuing office code
  }
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `area` | `""` | **Required.** Your EC forecast area name (e.g. `"Sudbury"`, `"Toronto"`, `"Vancouver"`) |
| `office` | `"CWTO"` | **Required.** EC issuing office code (see table below) |
| `updateInterval` | `300000` | How often to check for new alerts, in milliseconds (default: 5 minutes) |
| `maxAlerts` | `3` | Maximum number of alerts to display simultaneously |
| `alertTypes` | `["warning", "watch", "statement"]` | Which alert tiers to fetch. Remove types you don't want. |
| `animationSpeed` | `1000` | DOM update animation speed in milliseconds |

### Finding Your Area and Office

1. Visit [weather.gc.ca](https://weather.gc.ca) and search your city
2. Your **area** name is in the forecast title (e.g. "Greater Sudbury" → use `"Sudbury"`)
3. Your **office** code depends on your region:

| Code | Region | Covers |
|------|--------|--------|
| `CWTO` | Ontario | Storm Prediction Centre — Toronto |
| `CWMW` | Quebec | Montreal Weather Centre |
| `CWNT` | Prairies & Arctic | Edmonton Weather Centre |
| `CWVR` | Pacific & Yukon | Vancouver Weather Centre |
| `CWHX` | Atlantic | Halifax Weather Centre |

### Examples

**Ontario — show only warnings:**
```js
config: {
  area: "Toronto",
  office: "CWTO",
  alertTypes: ["warning"]
}
```

**British Columbia — all alert types:**
```js
config: {
  area: "Vancouver",
  office: "CWVR"
}
```

**Alberta — warnings and watches only:**
```js
config: {
  area: "Calgary",
  office: "CWNT",
  alertTypes: ["warning", "watch"]
}
```

## Styling

The module uses CSS classes prefixed with `ec-` for easy customization:

- `.ec-alerts-bar` — Main container
- `.ec-color-red` / `.ec-color-yellow` / `.ec-color-grey` — Tier colours
- `.ec-alert-icon` — Warning triangle icon
- `.ec-alert-event` — Alert title(s)
- `.ec-alert-description` — Description text
- `.ec-tier-badge` — Severity badge (WARNING / WATCH / STATEMENT)

Override these in your `css/custom.css` to match your dashboard theme.

## How It Works

1. Fetches the CAP file directory from EC's data servers (`dd.weather.gc.ca`)
2. Scans the most recent 6 hours for alert files (T_WW, T_WO, T_WS)
3. Downloads and parses each CAP XML file
4. Filters for alerts matching your configured area
5. Extracts the English info block with event type, severity, and description
6. Deduplicates by event type, keeping the most recent version
7. Displays results sorted by tier (warnings first)

## Data Sources

The module tries these sources in order:

1. `dd.weather.gc.ca` — EC's production data server (24/7, redundant)
2. `hpfx.collab.science.gc.ca` — High-performance feed (best-effort)

Both today's and yesterday's directories are checked for coverage across midnight.

## License

MIT

## Credits

- Weather data: [Environment and Climate Change Canada](https://weather.gc.ca)
- CAP format: [OASIS Common Alerting Protocol](http://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2.html)
- Built for the [MagicMirror²](https://magicmirror.builders/) platform
