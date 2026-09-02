---
name: Historical forecast evidence
description: Safety and transparency rules for historical-pattern probability guidance.
---

Historical forecasts are read-only decision support, not a live trading signal or order trigger. They must use completed, clean historical candles; use only past windows as analogs; purge any candidate whose labelled outcome overlaps the current reference pattern; and embargo selected analogs so their input-plus-outcome spans do not overlap.

Walk-forward calibration must preserve every point-in-time call in its audit trail but count only calls with non-overlapping forward outcome windows as independent evidence.

**Why:** Overlapping analog or validation windows inflate the effective sample, and current-period leakage creates misleading confidence. A small, dependent, or invalid sample should not be converted into a precise-looking probability.

**How to apply:** Keep a clearly visible historical-conditional-probability label and no-guarantee statement. Withhold directional probabilities when the separated match count is below the minimum; gate calibration on outcome-separated calls; show data limitations; and keep forecasts independent from automated trading/confluence decisions.