//! `window_id`, `reset_at`, and `window_remaining` math (design §4.6), plus the
//! strictly-additive jittered TTL (§4.5).
//!
//! Everything the counter store needs to be deterministic is computed here, in
//! UTC, so every node derives the same key from the same wall clock with no
//! coordination. The pure boundary math ([`compute_window`]) is deliberately
//! separated from the randomized TTL ([`jittered_ttl`]) so the former stays
//! trivially unit-testable, including month/leap-year boundaries.

use chrono::{DateTime, Datelike, Duration, TimeZone, Timelike, Utc};

use crate::pb::common::TimeUnit;

/// The fixed window a `(customer, limit)` falls into at instant `now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Window {
    /// Boundary-aligned id embedded in the Redis key (`cnt:<window_id>`).
    pub window_id: String,
    /// Instant the window closes (start of the next window). Returned as `reset_at`.
    pub reset_at: DateTime<Utc>,
    /// Seconds from `now` to `reset_at` — the base for the TTL (§4.5).
    pub remaining_secs: i64,
}

/// Compute the window for `now` under `unit`, aligned to the UTC boundary.
///
/// MONTH is calendar-aware (28/29/30/31-day months, leap years) — never a fixed
/// `30*86400` (design §4.6). Returns `None` for `TIME_UNIT_UNSPECIFIED`.
pub fn compute_window(now: DateTime<Utc>, unit: TimeUnit) -> Option<Window> {
    let (window_id, reset_at) = match unit {
        TimeUnit::Minute => {
            let start = Utc
                .with_ymd_and_hms(now.year(), now.month(), now.day(), now.hour(), now.minute(), 0)
                .single()?;
            let id = format!(
                "{:04}{:02}{:02}{:02}{:02}",
                now.year(),
                now.month(),
                now.day(),
                now.hour(),
                now.minute()
            );
            (id, start + Duration::minutes(1))
        }
        TimeUnit::Day => {
            let start = Utc
                .with_ymd_and_hms(now.year(), now.month(), now.day(), 0, 0, 0)
                .single()?;
            let id = format!("{:04}{:02}{:02}", now.year(), now.month(), now.day());
            (id, start + Duration::days(1))
        }
        TimeUnit::Month => {
            let (ny, nm) = if now.month() == 12 {
                (now.year() + 1, 1)
            } else {
                (now.year(), now.month() + 1)
            };
            let id = format!("{:04}{:02}", now.year(), now.month());
            // reset is the 1st of the next month at 00:00 UTC — calendar-aware.
            let reset = Utc.with_ymd_and_hms(ny, nm, 1, 0, 0, 0).single()?;
            (id, reset)
        }
        TimeUnit::Unspecified => return None,
    };

    let remaining_secs = (reset_at - now).num_seconds().max(0);
    Some(Window {
        window_id,
        reset_at,
        remaining_secs,
    })
}

/// Strictly-additive jittered TTL: `window_remaining + grace + rand(0, jitter_max)`
/// (design §4.5). Additive so it can never drop below `window_remaining` — a live
/// key is never at risk of early expiry. Floored at 1 so `EXPIRE` is always valid.
pub fn jittered_ttl(remaining_secs: i64, grace_secs: i64, jitter_max_secs: i64) -> i64 {
    let jitter = if jitter_max_secs > 0 {
        // Compute the modulo in u64 space; casting a u64 to i64 first can go
        // negative and would shorten the TTL — the exact thing additive jitter
        // must never do.
        (rand::random::<u64>() % (jitter_max_secs as u64 + 1)) as i64
    } else {
        0
    };
    (remaining_secs + grace_secs + jitter).max(1)
}

/// Per-unit jitter cap (design §4.5: ≤ 30 s for minute windows, minutes for
/// day/month).
pub fn jitter_cap_secs(unit: TimeUnit) -> i64 {
    match unit {
        TimeUnit::Minute => 30,
        TimeUnit::Day | TimeUnit::Month => 300,
        TimeUnit::Unspecified => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn minute_window_aligns_and_ids() {
        let w = compute_window(at("2026-07-12T14:30:25Z"), TimeUnit::Minute).unwrap();
        assert_eq!(w.window_id, "202607121430");
        assert_eq!(w.reset_at, at("2026-07-12T14:31:00Z"));
        assert_eq!(w.remaining_secs, 35);
    }

    #[test]
    fn day_window_aligns_to_midnight_utc() {
        let w = compute_window(at("2026-07-12T14:30:00Z"), TimeUnit::Day).unwrap();
        assert_eq!(w.window_id, "20260712");
        assert_eq!(w.reset_at, at("2026-07-13T00:00:00Z"));
        assert_eq!(w.remaining_secs, (9 * 3600 + 30 * 60));
    }

    #[test]
    fn month_window_is_calendar_aware() {
        // July has 31 days: reset is Aug 1, not now + 30d.
        let w = compute_window(at("2026-07-12T00:00:00Z"), TimeUnit::Month).unwrap();
        assert_eq!(w.window_id, "202607");
        assert_eq!(w.reset_at, at("2026-08-01T00:00:00Z"));
    }

    #[test]
    fn month_window_rolls_year() {
        let w = compute_window(at("2026-12-31T23:59:59Z"), TimeUnit::Month).unwrap();
        assert_eq!(w.window_id, "202612");
        assert_eq!(w.reset_at, at("2027-01-01T00:00:00Z"));
        assert_eq!(w.remaining_secs, 1);
    }

    #[test]
    fn february_leap_year() {
        // 2028 is a leap year: February has 29 days, reset is Mar 1.
        let w = compute_window(at("2028-02-15T12:00:00Z"), TimeUnit::Month).unwrap();
        assert_eq!(w.window_id, "202802");
        assert_eq!(w.reset_at, at("2028-03-01T00:00:00Z"));
    }

    #[test]
    fn february_non_leap_year() {
        // 2027 is not a leap year: February has 28 days.
        let w = compute_window(at("2027-02-15T12:00:00Z"), TimeUnit::Month).unwrap();
        assert_eq!(w.reset_at, at("2027-03-01T00:00:00Z"));
    }

    #[test]
    fn unspecified_unit_is_none() {
        assert!(compute_window(at("2026-07-12T14:30:00Z"), TimeUnit::Unspecified).is_none());
    }

    #[test]
    fn jitter_is_additive_and_bounded() {
        for _ in 0..1000 {
            let ttl = jittered_ttl(35, 5, 30);
            assert!(ttl >= 40, "ttl {ttl} below window_remaining+grace");
            assert!(ttl <= 70, "ttl {ttl} above window_remaining+grace+jitter");
        }
    }

    #[test]
    fn jitter_floors_at_one() {
        assert_eq!(jittered_ttl(0, 0, 0), 1);
    }
}
