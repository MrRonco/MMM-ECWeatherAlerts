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
    this.fetching = false;
    this.fetchWatchdog = null;
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

    // One fetch cycle at a time — during outages a hung cycle must not
    // stack new request batches every updateInterval.
    if (self.fetching) return;
    self.fetching = true;

    // Safety net: if a cycle somehow never completes, re-arm after 2 min
    clearTimeout(self.fetchWatchdog);
    self.fetchWatchdog = setTimeout(function () { self.fetching = false; }, 120000);

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
      self.fetching = false;
      clearTimeout(self.fetchWatchdog);
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
    var fetchErrors = 0;

    recentHours.forEach(function (hour) {
      self.httpGet(baseUrl + hour + "/", function (err, hourHtml) {
        dirsChecked++;
        if (!err && hourHtml) {
          var regex = new RegExp('href="(' + typePattern + '[^"]+\\.cap)"', "g");
          var fileMatch;
          while ((fileMatch = regex.exec(hourHtml)) !== null) {
            allCapFiles.push(baseUrl + hour + "/" + fileMatch[1]);
          }
        } else {
          fetchErrors++;
        }
        if (dirsChecked === recentHours.length) {
          self.fetchAndFilterCAPs(allCapFiles, area, callback, fetchErrors);
        }
      });
    });
  },

  /**
   * Download each CAP file, parse it, and filter for our area.
   * Deduplicates by event type, keeping the most recent.
   * Filters out expired and ended alerts.
   */
  fetchAndFilterCAPs: function (capUrls, area, callback, priorErrors) {
    var self = this;
    var fetchErrors = priorErrors || 0;

    if (capUrls.length === 0) {
      if (fetchErrors > 0) {
        // A partial scan that found nothing is NOT "no alerts" — the
        // failed requests may have held the active warnings. Report an
        // error so the frontend keeps its previous state.
        callback("Partial scan: " + fetchErrors + " request(s) failed, no alert data", null);
      } else {
        callback(null, []);
      }
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
        if (err) {
          fetchErrors++;
        } else if (xml && xml.toLowerCase().includes(area.toLowerCase())) {
          var parsed = self.parseCAP(xml, area);
          if (parsed) {
            entries.push(parsed);
          }
        }
        if (fetched === uniqueUrls.length) {
          // Deduplicate by event type — keep most recent.
          // This MUST happen before the active check, because EC publishes
          // multiple CAP files for the same event across hours. An earlier
          // file may show "in effect" for our area while the latest shows
          // "ended". If we filter first, we'd drop the ended one and keep
          // the stale active one.
          var byEvent = {};
          entries.forEach(function (e) {
            var key = e.event.toLowerCase();
            if (!byEvent[key] || e.sent > byEvent[key].sent) {
              byEvent[key] = e;
            }
          });

          // Now filter: only keep alerts that are still active
          var result = Object.values(byEvent).filter(function (e) {
            return self.isAlertActive(e);
          });

          // Sort by tier: warning > watch > statement
          var tierOrder = { warning: 0, watch: 1, advisory: 1, statement: 2 };
          result.sort(function (a, b) {
            return (tierOrder[a.tier] || 2) - (tierOrder[b.tier] || 2);
          });

          if (result.length === 0 && fetchErrors > 0) {
            // Same partial-scan rule as above: empty + errors ≠ all clear.
            callback("Partial scan: " + fetchErrors + " request(s) failed, no alert data", null);
            return;
          }
          if (fetchErrors > 0) {
            console.warn("[MMM-ECWeatherAlerts] Partial scan: " + fetchErrors + " request(s) failed; showing " + result.length + " alert(s) found");
          }
          callback(null, result);
        }
      });
    });
  },

  /**
   * Check whether a parsed CAP alert is still active.
   * All fields are extracted from the matched <info> block by parseCAP,
   * so they reflect the status for our specific area — not other areas
   * in the same CAP file.
   *
   * Filters out:
   *   - AllClear / Cancel responseTypes (EC sends these when alerts end)
   *   - Alerts with urgency "Past"
   *   - Alerts whose <expires> timestamp is in the past
   *   - Alerts whose headline contains "ended"
   *   - Alerts with Alert_Location_Status "ended"
   */
  isAlertActive: function (parsed) {
    // Check responseType — AllClear and Cancel mean the alert is over
    if (parsed.responseType) {
      var rt = parsed.responseType.trim();
      if (rt === "AllClear" || rt === "Cancel") {
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

    // Check EC-specific Alert_Location_Status
    if (parsed.locationStatus && parsed.locationStatus.toLowerCase() === "ended") {
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
    var responseType = getTag("responseType");
    var onset = getTag("onset");
    var expires = getTag("expires");
    var senderName = getTag("senderName");
    var sent = xml.match(/<sent>([^<]+)<\/sent>/);
    sent = sent ? sent[1] : "";

    // Extract Alert_Location_Status from this info block
    var statusMatch = enBlock.match(/<valueName>layer:EC-MSC-SMC:1\.0:Alert_Location_Status<\/valueName>\s*<value>([^<]+)<\/value>/);
    var locationStatus = statusMatch ? statusMatch[1].trim() : "";

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
      responseType: responseType,
      locationStatus: locationStatus,
      onset: onset,
      expires: expires,
      sent: sent,
      senderName: senderName || "Environment Canada"
    };
  },

  /**
   * HTTPS GET with redirect support and a hard 15s timeout.
   * A hung EC connection must fail fast so the completion counters
   * upstream always resolve — otherwise the alert bar silently
   * freezes with stale data. Callback fires exactly once.
   */
  httpGet: function (url, callback, redirected) {
    var self = this;
    var done = false;
    var killTimer = null;
    var finish = function (err, data) {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      callback(err, data);
    };

    var req = https.get(url, function (response) {
      if (
        (response.statusCode === 301 || response.statusCode === 302) &&
        response.headers.location &&
        !redirected
      ) {
        response.resume(); // discard body, follow redirect (once)
        self.httpGet(response.headers.location, finish, true);
        return;
      }
      var data = "";
      response.on("data", function (chunk) { data += chunk; });
      response.on("end", function () {
        if (response.statusCode === 200) {
          finish(null, data);
        } else {
          finish("HTTP " + response.statusCode, null);
        }
      });
    });

    // Wall-clock timer, NOT req.setTimeout(): node's idle-timeout fires
    // prematurely when the socket stalls in a slow DNS lookup phase.
    killTimer = setTimeout(function () {
      req.destroy(new Error("Request timeout"));
    }, 30000);
    req.on("error", function (error) {
      finish(error, null);
    });
  }
});
