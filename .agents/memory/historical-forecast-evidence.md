---
name: Historical forecast evidence
description: Safety and transparency rules for historical-pattern probability guidance.
---

Historical forecasts are read-only decision support, not a live trading signal or order trigger. They must use completed, clean historical candles; use only past windows as analogs; purge any candidate whose labelled outcome overlaps the current reference pattern; and embargo selected analogs so their input-plus-outcome spans do not overlap.

**Why:** Overlapping windows inflate the effective sample and let current-period information bleed into historical labels, creating misleading confidence. A small or invalid sample should not be converted into a precise-looking probability.

**How to apply:** Keep a clearly visible historical-conditional-probability label and no-guarantee statement. Withhold directional probabilities when the separated match count is below the minimum, show the data limitation instead, and keep the forecast independent from automated trading/confluence decisions.