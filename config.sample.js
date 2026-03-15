/* ================================================================
   MMM-ECWeatherAlerts — Sample Configuration

   Add this block to the modules array in your
   ~/MagicMirror/config/config.js file.

   See README.md for full configuration options and
   how to find your area name and office code.
   ================================================================ */

// --- Minimal configuration (most common) ---

{
  module: "MMM-ECWeatherAlerts",
  position: "top_bar",
  config: {
    area: "Toronto",       // Your EC forecast area name
    office: "CWTO"         // Your EC issuing office code
  }
},

// --- Full configuration with all options ---

/*
{
  module: "MMM-ECWeatherAlerts",
  position: "top_bar",
  config: {
    area: "Toronto",           // REQUIRED: EC forecast area (e.g. "Toronto", "Vancouver", "Calgary")
    office: "CWTO",            // REQUIRED: EC issuing office code (see table below)
    updateInterval: 300000,    // Check for alerts every 5 minutes (default)
    maxAlerts: 3,              // Show up to 3 simultaneous alerts (default)
    alertTypes: [              // Which CAP file types to fetch:
      "warning",               //   T_WW — warnings
      "watch"                  //   T_WO — watches & advisories
      // "statement"            //   T_WS — informational (uncomment to include)
    ],
    animationSpeed: 1000,      // DOM update fade speed in ms (default)
    backgroundOpacity: 0.25,   // Alert bar background opacity, 0–1 (default)
    textDimming: 0.8           // Description text opacity, 0–1 (default); time is 75% of this
  }
},
*/

// --- EC Issuing Office Codes ---
//
// CWTO — Ontario (Toronto Storm Prediction Centre)
// CWMW — Quebec (Montreal Weather Centre)
// CWNT — Prairies & Arctic (Edmonton Weather Centre)
// CWVR — Pacific & Yukon (Vancouver Weather Centre)
// CWHX — Atlantic (Halifax Weather Centre)
//
// --- Example: British Columbia ---
//
// {
//   module: "MMM-ECWeatherAlerts",
//   position: "top_bar",
//   config: {
//     area: "Vancouver",
//     office: "CWVR"
//   }
// },
//
// --- Example: Alberta, warnings only ---
//
// {
//   module: "MMM-ECWeatherAlerts",
//   position: "top_bar",
//   config: {
//     area: "Calgary",
//     office: "CWNT",
//     alertTypes: ["warning"]
//   }
// },
