/* ================================================================
   MMM-ECWeatherAlerts
   Environment Canada Weather Alerts for MagicMirror²

   Displays active weather alerts from Environment Canada's
   Common Alerting Protocol (CAP) feed. Designed for Canadian
   households — no API key required, uses EC's free public data.

   Features:
   - 3-tier colour system matching EC's own classification:
     🔴 Red    — Very dangerous, possibly life-threatening
     🟠 Orange — Severe, significant damage likely
     🟡 Yellow — Hazardous, moderate/localized impacts
   - Condensed single-row layout for ambient displays
   - Auto-hides when no active alerts
   - Extracts "What:" section from EC descriptions for concise display
   - Multiple simultaneous alerts combined into one bar

   Configuration:
   {
     module: "MMM-ECWeatherAlerts",
     position: "top_bar",
     config: {
       area: "Sudbury",        // Your EC forecast area name
       office: "CWTO",         // EC issuing office code
       updateInterval: 300000, // 5 minutes (default)
       maxAlerts: 3,           // Max alerts to display
       alertTypes: ["warning", "watch", "statement"]
     }
   }

   Finding your area and office:
   1. Visit https://weather.gc.ca and search your city
   2. Your area name is in the forecast title (e.g. "Greater Sudbury")
      Use the short form: "Sudbury", "Toronto", "Ottawa", etc.
   3. Office codes by region:
      CWTO — Ontario (Toronto Storm Prediction Centre)
      CWMW — Quebec (Montreal)
      CWNT — Prairie/Arctic (Edmonton)
      CWVR — Pacific/Yukon (Vancouver)
      CWHX — Atlantic (Halifax)

   Author: Franco Raso
   License: MIT
   ================================================================ */

Module.register("MMM-ECWeatherAlerts", {

  /* ── Default Configuration ─────────────────────────────────────
     Override any of these in your config.js module entry.        */
  defaults: {
    area: "",               // REQUIRED: EC forecast area (e.g. "Sudbury")
    office: "CWTO",         // REQUIRED: EC issuing office code
    updateInterval: 300000, // How often to check for alerts (ms) — default 5 min
    maxAlerts: 3,           // Maximum number of alerts to show
    alertTypes: [           // Which CAP file types to fetch:
      "warning",            //   T_WW files — warnings
      "watch"               //   T_WO files — watches & advisories
    ],                      //   Add "statement" for T_WS (informational)
    animationSpeed: 1000,   // DOM update fade speed (ms)
    backgroundOpacity: 0.25,// Background opacity of the alert bar (0–1)
    textDimming: 0.8        // Opacity for description text (0–1), time is 75% of this
  },

  /* ── Module Lifecycle ──────────────────────────────────────── */

  start: function () {
    Log.info("[MMM-ECWeatherAlerts] Starting module");
    this.alerts = [];
    this.loaded = false;
    this.alertsActive = false;
    this.requestAlerts();
    this.scheduleUpdate();
  },

  getStyles: function () {
    return ["MMM-ECWeatherAlerts.css"];
  },

  /* ── DOM Generation ────────────────────────────────────────── */

  getDom: function () {
    var wrapper = document.createElement("div");
    wrapper.className = "ec-alerts-bar";

    // No alerts — hide the bar
    if (!this.alerts || this.alerts.length === 0) {
      wrapper.style.display = "none";
      return wrapper;
    }

    // Apply configurable opacity via CSS custom properties
    wrapper.style.setProperty("--ec-bg-opacity", this.config.backgroundOpacity);
    wrapper.style.setProperty("--ec-text-dimming", this.config.textDimming);
    wrapper.style.setProperty("--ec-time-dimming", Math.round(this.config.textDimming * 0.75 * 100) / 100);

    // Apply colour class from the highest-tier alert
    var topAlert = this.alerts[0];
    wrapper.classList.add("ec-color-" + topAlert.color);

    // Limit to maxAlerts
    var alerts = this.alerts.slice(0, this.config.maxAlerts);

    // Build single-row layout
    var row = document.createElement("div");
    row.className = "ec-alert-row";

    // Warning icon with tier-coloured glass effect
    var icon = document.createElement("div");
    icon.className = "ec-alert-icon ec-icon-" + topAlert.color;
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor">' +
      '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';
    row.appendChild(icon);

    // Details: event names + description + meta
    var details = document.createElement("div");
    details.className = "ec-alert-details";

    // Combined event names: "Winter Storm Warning | Fog Advisory"
    var eventEl = document.createElement("div");
    eventEl.className = "ec-alert-event";
    var names = [];
    alerts.forEach(function (a) {
      if (names.indexOf(a.title) === -1) names.push(a.title);
    });
    eventEl.textContent = names.join("  |  ");
    details.appendChild(eventEl);

    // Description for each alert
    var self = this;
    alerts.forEach(function (alert) {
      var descText = alert.what || alert.description.split("\n").slice(0, 2).map(function (l) {
        return l.trim();
      }).filter(Boolean).join(" ");
      if (descText) {
        var desc = document.createElement("div");
        desc.className = "ec-alert-description";
        desc.textContent = descText;
        details.appendChild(desc);
      }
    });

    // Meta line: tier badges + time range for each alert
    var meta = document.createElement("div");
    meta.className = "ec-alert-meta";

    alerts.forEach(function (alert) {
      var badge = document.createElement("span");
      badge.className = "ec-tier-badge ec-badge-" + alert.color;
      badge.textContent = alert.tier.toUpperCase();
      meta.appendChild(badge);
    });

    // Time range from earliest onset to latest expiry
    var earliest = alerts.reduce(function (min, a) {
      return a.onset && (!min || a.onset < min) ? a.onset : min;
    }, null);
    var latest = alerts.reduce(function (max, a) {
      return a.expires && (!max || a.expires > max) ? a.expires : max;
    }, null);
    if (earliest || latest) {
      var time = document.createElement("span");
      time.className = "ec-alert-time";
      var parts = [];
      if (earliest) parts.push(self.formatTime(earliest));
      if (latest) parts.push(self.formatTime(latest));
      time.textContent = parts.join(" – ");
      meta.appendChild(time);
    }

    details.appendChild(meta);
    row.appendChild(details);
    wrapper.appendChild(row);

    return wrapper;
  },

  /* ── Socket Communication ──────────────────────────────────── */

  socketNotificationReceived: function (notification, payload) {
    if (notification === "EC_ALERTS_DATA") {
      this.alerts = payload || [];
      this.loaded = true;

      var hadAlerts = this.alertsActive;
      this.alertsActive = this.alerts.length > 0;

      if (this.alertsActive && !hadAlerts) {
        this.show(300);
      } else if (!this.alertsActive && hadAlerts) {
        this.hide(300);
      } else if (!this.alertsActive) {
        this.hide(0);
      }

      this.updateDom(this.config.animationSpeed);
      this.updateAlertHeight();

    } else if (notification === "EC_ALERTS_ERROR") {
      Log.error("[MMM-ECWeatherAlerts] Error: " + payload);
      this.loaded = true;

      if (this.alertsActive) {
        this.alertsActive = false;
        this.hide(300);
      }
      this.updateAlertHeight();
    }
  },

  notificationReceived: function (notification) {
    if (notification === "ALL_MODULES_STARTED" && !this.alertsActive) {
      this.hide(0);
      this.updateAlertHeight();
    }
  },

  /* ── Helpers ───────────────────────────────────────────────── */

  /**
   * Measure the rendered alert bar height and publish it as a CSS
   * custom property so other zones can position below it dynamically.
   * Sets --alert-bar-height on :root (0px when no alerts visible).
   */
  updateAlertHeight: function () {
    var self = this;
    // Wait for DOM to render + show() animation to complete
    setTimeout(function () {
      var height = 0;
      var el = document.querySelector(".MMM-ECWeatherAlerts:not(.hidden) .ec-alerts-bar");
      if (el && el.getBoundingClientRect().height > 0) {
        height = el.getBoundingClientRect().height;
      }
      var gap = height > 0 ? 20 : 0;
      document.documentElement.style.setProperty(
        "--alert-bar-height",
        Math.ceil(height + gap) + "px"
      );
      Log.info("[MMM-ECWeatherAlerts] Alert bar height: " + Math.ceil(height) + "px, var set to: " + Math.ceil(height + gap) + "px");
    }, 1500); // 1.5s — enough for show(300) animation + updateDom(1000)
  },

  requestAlerts: function () {
    this.sendSocketNotification("FETCH_EC_ALERTS", {
      area: this.config.area,
      office: this.config.office,
      alertTypes: this.config.alertTypes
    });
  },

  scheduleUpdate: function () {
    var self = this;
    setInterval(function () {
      self.requestAlerts();
    }, this.config.updateInterval);
  },

  formatTime: function (timestamp) {
    if (!timestamp) return "";
    var date = new Date(timestamp);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true
    });
  }
});
