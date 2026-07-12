//! Integration tests for the Redis counter store against a real local Redis
//! (design §13.1 correctness + §13.2 concurrency): charge→negative, refund
//! floor-at-0 with TTL PRESERVED, TTL-set-once, missing-key=0, and bounded
//! concurrent overshoot with no lost updates.

mod common;

use common::*;
use quotaenforcer::store::counter_key;

#[tokio::test]
async fn charge_applies_and_goes_negative() {
    let Some(store) = store_or_skip().await else {
        return;
    };
    let mut conn = redis_conn().await;
    let key = counter_key(&unique("svc"), "cust", "rl", "w");

    assert_eq!(store.charge(&key, 8, 10, 100).await.unwrap(), 2); // remaining 2
    assert_eq!(store.charge(&key, 5, 10, 100).await.unwrap(), -3); // overshoot: -3

    // A subsequent check correctly denies while remaining < 0.
    let r = store.check(&key, 10, 1).await.unwrap();
    assert!(!r.allowed);
    assert_eq!(r.remaining, -3);

    del(&mut conn, &key).await;
}

#[tokio::test]
async fn refund_floors_at_zero_and_preserves_ttl() {
    let Some(store) = store_or_skip().await else {
        return;
    };
    let mut conn = redis_conn().await;
    let key = counter_key(&unique("svc"), "cust", "rl", "w");

    // Charge sets the TTL once.
    store.charge(&key, 3, 10, 100).await.unwrap();
    let ttl_before = ttl(&mut conn, &key).await;
    assert!(ttl_before > 0, "charge should have set a TTL, got {ttl_before}");

    // Refund more than consumed: consumed floors to 0, remaining back to limit.
    assert_eq!(store.refund(&key, 5, 10).await.unwrap(), 10);
    assert_eq!(get_int(&mut conn, &key).await, Some(0), "consumed floored to 0");

    // The key must STILL have a TTL — the INCRBY-not-SET invariant (§4.2).
    let ttl_after = ttl(&mut conn, &key).await;
    assert!(
        ttl_after > 0,
        "TTL must be preserved through the floor, got {ttl_after}"
    );

    del(&mut conn, &key).await;
}

#[tokio::test]
async fn ttl_is_set_once_not_re_extended() {
    let Some(store) = store_or_skip().await else {
        return;
    };
    let mut conn = redis_conn().await;
    let key = counter_key(&unique("svc"), "cust", "rl", "w");

    store.charge(&key, 1, 100, 50).await.unwrap();
    let ttl1 = ttl(&mut conn, &key).await;
    assert!(ttl1 > 0 && ttl1 <= 50);

    // A later charge passes a huge TTL; it must NOT be applied (set once, §4.2).
    store.charge(&key, 1, 100, 5000).await.unwrap();
    let ttl2 = ttl(&mut conn, &key).await;
    assert!(
        ttl2 <= 50,
        "TTL must not be re-extended on later charges, got {ttl2}"
    );

    del(&mut conn, &key).await;
}

#[tokio::test]
async fn missing_key_is_full_quota() {
    let Some(store) = store_or_skip().await else {
        return;
    };
    let key = counter_key(&unique("svc"), "cust", "rl", "w"); // never written

    let r = store.check(&key, 100, 1).await.unwrap();
    assert!(r.allowed);
    assert_eq!(r.remaining, 100, "missing key => consumed 0 => full quota");
    assert_eq!(store.consumed(&key).await.unwrap(), 0);
}

#[tokio::test]
async fn concurrent_charges_are_atomic_bounded_overshoot() {
    let Some(store) = store_or_skip().await else {
        return;
    };
    let mut conn = redis_conn().await;
    let key = counter_key(&unique("svc"), "cust", "rl", "w");

    // 200 concurrent unit charges against a limit of 100.
    let mut handles = Vec::new();
    for _ in 0..200 {
        let store = store.clone();
        let key = key.clone();
        handles.push(tokio::spawn(
            async move { store.charge(&key, 1, 100, 100).await },
        ));
    }
    for h in handles {
        h.await.unwrap().unwrap();
    }

    // Exactly 200 applied (no lost updates): remaining = 100 - 200 = -100.
    let r = store.check(&key, 100, 1).await.unwrap();
    assert_eq!(r.remaining, -100, "atomic: every charge applied exactly once");
    assert!(!r.allowed);

    del(&mut conn, &key).await;
}
