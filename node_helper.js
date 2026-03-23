/* ================================================================
   MMM-ECWeatherAlerts — Node Helper
   Environment Canada CAP Weather Alerts

   Fetches Common Alerting Protocol (CAP) XML files from
   Environment Canada's HPFX/DD data servers. Parses English
   alert blocks matching the configured area and returns
   structured alert data to the frontend.

   Data sources (tried in order):
   1. dd.weather.gc.ca — Production, 24/7 redundant
   2. hpfx.collab.science.gc.ca — Best-effort, higher bandwidth

   EC CAP reference:
   https://eccc-msc.github.io/open-data/msc-data/alerts/readme_en/

   File naming convention:
   T_WW = Warnings (most severe)
   T_WO = Watches / Advisories
   T_WS = Statements (informational)
   ================================================================ */

const NodeHelper = require("node_helper");
const https = require("https");

module.exports = NodeHelper.create({

  start: function () {
    console.log("[MMM-ECWeatherAlerts] Node helper started");
  },

  socketNotificationReceived: function (notification, payload) {
    if (notification === "FETCH_EC_ALERTS") {
      this.fetchAlerts(payload);
    }
  },

  /**
   * Main entry point — fetch EC CAP alerts for the configured area.
   * Tries today's directory first, falls back to yesterday's.
   */
  fetchAlerts: function (config) {
    var self = this;
    var area = config.area;
    var office = config.office;

    if (!area || !office) {
      console.error("[MMM-ECWeatherAlerts] area and office are required");
      self.sendSocketNotification("EC_ALERTS_ERROR", "Missing area or office config");
      return;
    }

    var now = new Date();
    var today = now.toISOString().slice(0, 10).replace(/-/g, "");
    var yesterday = new Date(now - 86400000).toISOString().slice(0, 10).replace(/-/g, "");

    var urls = [
      "https://dd.weather.gc.ca/" + today + "/WXO-DD/alerts/cap/" + today + "/" + office + "/",
      "https://dd.weather.gc.ca/" + yesterday + "/WXO-DD/alerts/cap/" + yesterday + "/" + office + "/",
      "https://hpfx.collab.science.gc.ca/" + today + "/WXO-DD/alerts/cap/" + today + "/" + office + "/",
      "https://hpfx.collab.science.gc.ca/" + yesterday + "/WXO-DD/alerts/cap/" + yesterday + "/" + office + "/"
    ];

    self.tryNextUrl(urls, 0, area, config.alertTypes, function (err, alerts) {
      if (err || !alerts) {
        console.error("[MMM-ECWeatherAlerts] All sources failed:", err);
        self.sendSocketNotification("EC_ALERTS_ERROR", err || "No data");
      } else {
        console.log("[MMM-ECWeatherAlerts] Found " + alerts.length + " active alert(s) for " + area);
        self.sendSocketNotification("EC_ALERTS_DATA", alerts);
      }
    });
  },

  /**
   * Try CAP directory URLs in order until one succeeds.
   */
  tryNextUrl: function (urls, index, area, alertTypes, callback) {
    var self = this;
    if (index >= urls.length) {
      callback("All CAP sources exhausted", null);
      return;
    }

    var url = urls[index];
    console.log("[MMM-ECWeatherAlerts] Trying: " + url);

    self.httpGet(url, function (err, html) {
      if (!err && html) {
        self.scanDirectory(url, html, area, alertTypes, callback);
      } else {
        self.tryNextUrl(urls, index + 1, area, alertTypes, callback);
      }
    });
  },

  /**
   * Scan an EC date directory for hourly subdirectories,
   * then collect CAP files from the most recent hours.
   */
  scanDirectory: function (baseUrl, dirHtml, area, alertTypes, callback) {
    var self = this;

    // Extract hour directories (00, 01, ..., 23)
    var hourDirs = [];
    var dirMatches = dirHtml.matchAll(/href="(\d{2})\/"/g);
    for (var m of dirMatches) hourDirs.push(m[1]);

    // Scan most recent 6 hours for coverage
    var recentHours = hourDirs.slice(-6);
    if (recentHours.length === 0) {
      callback("No hour directories found", null);
      return;
    }

    // Build file type pattern from alertTypes config
    // T_WW = warnings, T_WO = watches/advisories, T_WS = statements
    var typePattern = "T_W[";
    if (alertTypes.includes("warning")) typePattern += "W";
    if (alertTypes.includes("watch")) typePattern += "O";
    if (alertTypes.includes("statement")) typePattern += "S";
    typePattern += "]";

    var dirsChecked = 0;
    var allCapFiles = [];

    recentHours.forEach(function (hour) {
      self.httpGet(baseUrl + hour + "/", function (err, hourHtml) {
        dirsChecked++;
        if (!err && hourHtml) {
          var regex = new RegExp('href="(' + typePattern + '[^"]+\\.cap)"', "g");
          var fileMatch;
          while ((fileMatch = regex.exec(hourHtml)) !== null) {
            allCapFiles.push(baseUrl + hour + "/" + fileMatch[1]);
          }
        }
        if (dirsChecked === recentHours.length) {
          self.fetchAndFilterCAPs(allCapFiles, area, callback);
        }
      });
    });
  },

  /**
   * Download each CAP file, parse it, and filter for our area.
   * Deduplicates by event type, keeping the most recent.
   * Filters out expired and ended alerts.
   */
  fetchAndFilterCAPs: function (capUrls, area, callback) {
    var self = this;

    if (capUrls.length === 0) {
      callback(null, []);
      return;
    }

    // Deduplicate by filename
    var seen = {};
    var uniqueUrls = capUrls.filter(function (url) {
      var fname = url.split("/").pop();
      if (seen[fname]) return false;
      seen[fname] = true;
      return true;
    });

    var fetched = 0;
    var entries = [];

    uniqueUrls.forEach(function (url) {
      self.httpGet(url, function (err, xml) {
        fetched++;
        if (!err && xml && xml.toLowerCase().includes(area.toLowerCase())) {
          var parsed = self.parseCAP(xml, area);
          if (parsed && self.isAlertActive(parsed, xml)) {
            entries.push(parsed);
          }
        }
        if (fetched === uniqueUrls.length) {
          // Deduplicate by event type — keep most recent
          var byEvent = {};
          entries.forEach(function (e) {
            var key = e.event.toLowerCase();
            if (!byEvent[key] || e.sent > byEvent[key].sent) {
              byEvent[key] = e;
            }
          });

          var result = Object.values(byEvent);

          // Sort by tier: warning > watch > statement
          var tierOrder = { warning: 0, watch: 1, advisory: 1, statement: 2 };
          result.sort(function (a, b) {
            return (tierOrder[a.tier] || 2) - (tierOrder[b.tier] || 2);
          });

          callback(null, result);
        }
      });
    });
  },

  /**
   * Check whether a parsed CAP alert is still active.
   * Filters out:
   *   - AllClear / Cancel responseTypes (EC sends these when alerts end)
   *   - Alerts with urgency "Past"
   *   - Alerts whose <expires> timestamp is in the past
   *   - Alerts whose headline contains "ended"
   *   - Alerts with Alert_Location_Status "ended"
   */
  isAlertActive: function (parsed, xml) {
    // Check responseType — AllClear and Cancel mean the alert is over
    var responseMatch = xml.match(/<responseType>([^<]+)<\/responseType>/);
    if (responseMatch) {
      var responseType = responseMatch[1].trim();
      if (responseType === "AllClear" || responseType === "Cancel") {
        return false;
      }
    }

    // Check urgency — "Past" means the event has ended
    if (parsed.urgency && parsed.urgency.toLowerCase() === "past") {
      return false;
    }

    // Check expires timestamp
    if (parsed.expires) {
      var expiresDate = new Date(parsed.expires);
      if (!isNaN(expiresDate.getTime()) && expiresDate < new Date()) {
        return false;
      }
    }

    // Check headline for "ended"
    if (parsed.headline && parsed.headline.toLowerCase().includes("ended")) {
      return false;
    }

    // Check EC-specific Alert_Location_Status parameter
    var statusMatch = xml.match(/<valueName>layer:EC-MSC-SMC:1\.0:Alert_Location_Status<\/valueName>\s*<value>([^<]+)<\/value>/);
    if (statusMatch && statusMatch[1].trim().toLowerCase() === "ended") {
      return false;
    }

    return true;
  },

  /**
   * Parse a CAP XML file. Finds the English <info> block
   * matching the target area and extracts all relevant fields.
   *
   * EC CAP headlines follow the pattern:
   *   "[colour] [type] in effect for [area]"
   *   e.g. "winter storm warning in effect for Greater Sudbury"
   *
   * Colour mapping (EC standard — effective 2025):
   *   red    → Very dangerous, possibly life-threatening
   *   orange → Severe, significant damage likely
   *   yellow → Hazardous, moderate/localized impacts
   * All three colours apply to Warnings, Advisories, and Watches.
   */
  parseCAP: function (xml, area) {
    // Split into <info> blocks, find English one for our area
    var infoBlocks = xml.split("<info>").slice(1);
    var areaLower = area.toLowerCase();
    var enBlock = null;

    for (var i = 0; i < infoBlocks.length; i++) {
      var block = infoBlocks[i];
      if (block.includes("<language>en-CA</language>") && block.toLowerCase().includes(areaLower)) {
        enBlock = block.substring(0, block.indexOf("</info>"));
        break;
      }
    }
    if (!enBlock) return null;

    // Helper to extract XML tag content
    var getTag = function (tag) {
      var match = enBlock.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
      return match ? match[1].trim() : "";
    };

    var event = getTag("event");
    var headline = getTag("headline");
    var description = getTag("description");
    var severity = getTag("severity");
    var certainty = getTag("certainty");
    var urgency = getTag("urgency");
    var onset = getTag("onset");
    var expires = getTag("expires");
    var senderName = getTag("senderName");
    var sent = xml.match(/<sent>([^<]+)<\/sent>/);
    sent = sent ? sent[1] : "";

    // Determine EC colour from headline
    // EC headlines: "yellow warning", "orange advisory", "red warning", etc.
    var color = "yellow"; // default
    var tier = "warning";  // default
    var headlineLower = headline.toLowerCase();

    if (headlineLower.match(/\bred\b/)) color = "red";
    else if (headlineLower.match(/\borange\b/)) color = "orange";
    else if (headlineLower.match(/\byellow\b/)) color = "yellow";

    // Determine alert tier from headline or CAP file type
    if (headlineLower.includes("statement")) tier = "statement";
    else if (headlineLower.includes("advisory") || headlineLower.includes("watch")) tier = "watch";
    else if (headlineLower.includes("warning")) tier = "warning";

    // Extract "What:" section from description
    var whatMatch = description.match(
      /What\s*:\s*\n?([\s\S]*?)(?=\n\s*(?:When|Where|Discussion|Remarks|Impact|Additional information|Please)\s*:|\n\s*###)/i
    );
    var what = whatMatch ? whatMatch[1].trim().replace(/\n/g, " ") : "";

    // Build clean display title: "Winter Storm Warning"
    var title = event.replace(/\b\w/g, function (c) { return c.toUpperCase(); });

    return {
      title: title,
      event: event,
      headline: headline,
      description: description,
      what: what,
      color: color,
      tier: tier,
      severity: severity,
      certainty: certainty,
      urgency: urgency,
      onset: onset,
      expires: expires,
      sent: sent,
      senderName: senderName || "Environment Canada"
    };
  },

  /**
   * HTTPS GET with redirect support.
   */
  httpGet: function (url, callback) {
    https.get(url, function (response) {
      if (response.statusCode === 301 || response.statusCode === 302) {
        https.get(response.headers.location, function (res2) {
          var data = "";
          res2.on("data", function (chunk) { data += chunk; });
          res2.on("end", function () { callback(null, data); });
        }).on("error", function (e) { callback(e, null); });
        return;
      }
      var data = "";
      response.on("data", function (chunk) { data += chunk; });
      response.on("end", function () {
        if (response.statusCode === 200) {
          callback(null, data);
        } else {
          callback("HTTP " + response.statusCode, null);
        }
      });
    }).on("error", function (error) {
      callback(error, null);
    });
  }
});
